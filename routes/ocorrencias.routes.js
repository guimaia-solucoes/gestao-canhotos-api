// ============================================================
//  routes/ocorrencias.routes.js
//  Cadastro de ocorrências — Entrega Fácil
// ============================================================
//
//  GET    /api/ocorrencias         lista
//  GET    /api/ocorrencias/:cod    uma
//  POST   /api/ocorrencias         cria
//  PUT    /api/ocorrencias/:cod    altera
//  DELETE /api/ocorrencias/:cod    exclui (lógico)
//
//  Registro no index.js:
//    const ocorrenciasRoutes = require('./routes/ocorrencias.routes');
//    app.use('/api/ocorrencias', ocorrenciasRoutes);
// ============================================================

const express = require('express');
const router = express.Router();

const pool = require('../db/pool');
const { authMiddleware } = require('../middleware/auth.middleware');
const {
  escopoMiddleware,
  empresasFiltradas,
} = require('../middleware/escopo.middleware');

router.use(authMiddleware, escopoMiddleware);

function inteiro(v) {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

function texto(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function bool(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

/**
 * Valida a empresa quando informada. NULL é válido e significa
 * "vale para todas as empresas da conta" — mesmo padrão de
 * motoristas e veículos.
 */
function empresaOpcional(req, res) {
  const bruto = req.body.codemp;
  if (bruto === undefined || bruto === null || bruto === '') {
    return { ok: true, codemp: null };
  }

  const codemp = inteiro(bruto);
  if (!codemp || !req.escopo.empresas.includes(codemp)) {
    res.status(403).json({ error: 'Empresa não permitida.' });
    return { ok: false };
  }
  return { ok: true, codemp };
}

// ── Listagem ────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const empresas = empresasFiltradas(req);

    const { rows } = await pool.query(
      `SELECT o.codocor, o.codconta, o.codemp, o.descricao, o.ordem,
              o.ativo, o.exige_foto, o.exige_observacao,
              o.finaliza_entrega, o.dhinc, o.codusuinc,
              COALESCE(e.nomefantasia, e.razaosocial, '') AS empresa_nome,
              (SELECT COUNT(*) FROM public.entregas_ocorrencias eo
                WHERE eo.codocor = o.codocor)::int AS qtd_usos
         FROM public.ocorrencias o
         LEFT JOIN public.empresas e ON e.codemp = o.codemp
        WHERE o.dhexclusao IS NULL
          AND o.codconta = $1
          AND (o.codemp IS NULL OR o.codemp = ANY($2::int[]))
        ORDER BY o.ordem, o.descricao`,
      [req.escopo.codconta, empresas]
    );

    res.json(rows);
  } catch (err) {
    console.error('[ocorrencias/listar]', err);
    res.status(500).json({ error: 'Erro ao listar as ocorrências.' });
  }
});

router.get('/:cod', async (req, res) => {
  const cod = inteiro(req.params.cod);
  if (!cod) return res.status(400).json({ error: 'Código inválido.' });

  try {
    const { rows } = await pool.query(
      `SELECT * FROM public.ocorrencias
        WHERE codocor = $1 AND codconta = $2 AND dhexclusao IS NULL
		 ORDER BY DESCRICAO`,
      [cod, req.escopo.codconta]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Ocorrência não encontrada.' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('[ocorrencias/buscar]', err);
    res.status(500).json({ error: 'Erro ao buscar a ocorrência.' });
  }
});

// ── Criação ─────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const descricao = texto(req.body.descricao);
  if (!descricao) {
    return res.status(400).json({ error: 'A descrição é obrigatória.' });
  }

  const emp = empresaOpcional(req, res);
  if (!emp.ok) return;

  try {
    const { rows } = await pool.query(
      `INSERT INTO public.ocorrencias
         (codconta, codemp, descricao, ordem, ativo,
          exige_foto, exige_observacao, finaliza_entrega, codusuinc)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        req.escopo.codconta,
        emp.codemp,
        descricao,
        inteiro(req.body.ordem) ?? 0,
        req.body.ativo === 'N' ? 'N' : 'S',
		req.body.exige_foto === 'N' ? 'N' : 'S',
        req.body.exige_observacao === 'N' ? 'N' : 'S',
		req.body.finaliza_entrega === 'N' ? 'N' : 'S',
        req.usuario?.codusu ?? null,
      ]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    // 23505 = violação de índice único. Mensagem própria, porque
    // o texto do Postgres não diz nada ao usuário final.
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'Já existe uma ocorrência com esta descrição.',
      });
    }
    console.error('[ocorrencias/criar]', err);
    res.status(500).json({ error: 'Erro ao criar a ocorrência.' });
  }
});

// ── Alteração ───────────────────────────────────────────────

router.put('/:cod', async (req, res) => {
  const cod = inteiro(req.params.cod);
  if (!cod) return res.status(400).json({ error: 'Código inválido.' });

  const campos = [];
  const valores = [];
  let i = 1;

  const add = (col, valor) => {
    campos.push(`${col} = $${i++}`);
    valores.push(valor);
  };

  if (req.body.descricao !== undefined) {
    const d = texto(req.body.descricao);
    if (!d) {
      return res.status(400).json({ error: 'A descrição é obrigatória.' });
    }
    add('descricao', d);
  }

  if (req.body.codemp !== undefined) {
    const emp = empresaOpcional(req, res);
    if (!emp.ok) return;
    add('codemp', emp.codemp);
  }

  if (req.body.ordem !== undefined) add('ordem', inteiro(req.body.ordem) ?? 0);
  if (req.body.ativo !== undefined) {
    add('ativo', req.body.ativo === 'N' ? 'N' : 'S');
  }
  if (req.body.exige_foto !== undefined) {
    add('exige_foto', req.body.exige_foto === 'N' ? 'N' : 'S');
  }
  if (req.body.exige_observacao !== undefined) {
    add('exige_observacao', req.body.exige_observacao === 'N' ? 'N' : 'S');
  }
  if (req.body.finaliza_entrega !== undefined) {
    add('finaliza_entrega', req.body.finaliza_entrega === 'N' ? 'N' : 'S');
  }

  if (campos.length === 0) {
    return res.status(400).json({ error: 'Nenhum campo para atualizar.' });
  }

  valores.push(cod);
  valores.push(req.escopo.codconta);

  try {
    const { rows } = await pool.query(
      `UPDATE public.ocorrencias
          SET ${campos.join(', ')}
        WHERE codocor = $${i} AND codconta = $${i + 1}
          AND dhexclusao IS NULL
      RETURNING *`,
      valores
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Ocorrência não encontrada.' });
    }
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'Já existe uma ocorrência com esta descrição.',
      });
    }
    console.error('[ocorrencias/alterar]', err);
    res.status(500).json({ error: 'Erro ao alterar a ocorrência.' });
  }
});

// ── Exclusão ────────────────────────────────────────────────

router.delete('/:cod', async (req, res) => {
  const cod = inteiro(req.params.cod);
  if (!cod) return res.status(400).json({ error: 'Código inválido.' });

  try {
    // Exclusão lógica sempre: ocorrências já registradas em
    // entregas apontam para este código. Apagar de verdade
    // deixaria o histórico com referência quebrada.
    const { rows: usos } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM public.entregas_ocorrencias
        WHERE codocor = $1`,
      [cod]
    );

    const { rows } = await pool.query(
      `UPDATE public.ocorrencias
          SET dhexclusao = now(), ativo = 'N'
        WHERE codocor = $1 AND codconta = $2 AND dhexclusao IS NULL
      RETURNING codocor`,
      [cod, req.escopo.codconta]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Ocorrência não encontrada.' });
    }

    res.json({
      ok: true,
      // Informa o histórico afetado: quem exclui merece saber
      // que a ocorrência já foi usada 47 vezes.
      registrosVinculados: usos[0].n,
    });
  } catch (err) {
    console.error('[ocorrencias/excluir]', err);
    res.status(500).json({ error: 'Erro ao excluir a ocorrência.' });
  }
});

module.exports = router;
