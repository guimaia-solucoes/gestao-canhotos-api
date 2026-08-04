// ============================================================
//  routes/comprovacao.routes.js
//  Kanban de comprovação de entregas — Entrega Fácil
// ============================================================
//
//  Registro no index.js:
//    const comprovacaoRoutes = require('./routes/comprovacao.routes');
//    app.use('/api/comprovacoes', comprovacaoRoutes);
//
//  ── PRINCÍPIOS DESTE MÓDULO ────────────────────────────────
//
//  1. O BACKEND É A FONTE DAS REGRAS. O front esconde botão por
//     conveniência; quem recusa é aqui.
//
//  2. CONTROLE DE VERSÃO. Toda escrita exige a `versao` que o
//     cliente leu. Diferente → 409. Sem isso, dois analistas
//     abrindo o mesmo card sobrescrevem um ao outro em silêncio.
//
//  3. HISTÓRICO SEMPRE. Nenhuma alteração de estado acontece
//     sem linha em comprov_historico, na mesma transação.
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

// ════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════

const SITUACOES = ['PENDENTE', 'RECEBIDO', 'ANALISE',
                   'CORRECAO', 'APROVADO', 'REJEITADO'];

function nulo(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' || s === 'null' ? null : s;
}

function inteiro(v) {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

/** Dados de auditoria da requisição. */
function auditoria(req) {
  return {
    origem: 'WEB',
    ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
        || req.socket?.remoteAddress
        || null,
    dispositivo: (req.headers['user-agent'] || '').slice(0, 200),
  };
}

/**
 * Grava o histórico. Recebe o client da transação em curso: se
 * a operação falhar depois, o histórico volta atrás junto.
 */
async function registrarHistorico(client, req, dados) {
  const a = auditoria(req);

  await client.query(
    `INSERT INTO public.comprov_historico
       (idcomprov, acao, codetapa_anterior, codetapa_nova,
        situacao_anterior, situacao_nova, codusu, nomeusu,
        observacao, codmotivo, origem, ip, dispositivo,
        dados_anteriores, dados_novos)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      dados.idcomprov,
      dados.acao,
      dados.etapaAnterior ?? null,
      dados.etapaNova ?? null,
      dados.situacaoAnterior ?? null,
      dados.situacaoNova ?? null,
      req.usuario?.codusu ?? null,
      req.usuario?.nomeusu ?? req.usuario?.email ?? null,
      dados.observacao ?? null,
      dados.codmotivo ?? null,
      a.origem, a.ip, a.dispositivo,
      dados.antes ? JSON.stringify(dados.antes) : null,
      dados.depois ? JSON.stringify(dados.depois) : null,
    ]
  );
}

/**
 * Carrega o card com trava de linha e valida escopo e versão.
 *
 * O `FOR UPDATE` segura a linha até o fim da transação — é o
 * que impede duas aprovações simultâneas passarem as duas.
 */
async function carregarCard(client, id, empresas, versaoCliente) {
  const { rows } = await client.query(
    `SELECT c.*, et.nome AS etapa_nome, et.permite_aprovar,
            et.permite_rejeitar, et.exige_comprovante, et.etapa_final
       FROM public.comprov_entregas c
       JOIN public.comprov_etapas et ON et.codetapa = c.codetapa
      WHERE c.id = $1
        AND c.codemp = ANY($2::int[])
      FOR UPDATE OF c`,
    [id, empresas]
  );

  if (rows.length === 0) {
    return { erro: { status: 404, msg: 'Comprovação não encontrada.' } };
  }

  const card = rows[0];

  if (versaoCliente != null && Number(versaoCliente) !== card.versao) {
    return {
      erro: {
        status: 409,
        msg: 'Este registro foi alterado por outro usuário. '
             + 'Atualize a tela antes de continuar.',
        versaoAtual: card.versao,
      },
    };
  }

  return { card };
}

/** Etapa de destino por nome semântico, dentro da conta. */
async function etapaPor(client, codconta, filtro) {
  const { rows } = await client.query(
    `SELECT codetapa FROM public.comprov_etapas
      WHERE codconta = $1 AND ativo AND ${filtro}
      ORDER BY ordem LIMIT 1`,
    [codconta]
  );
  return rows[0]?.codetapa ?? null;
}

// ════════════════════════════════════════════════════════════
//  CATÁLOGOS
// ════════════════════════════════════════════════════════════

router.get('/etapas', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT codetapa, nome, descricao, cor, icone, ordem,
              etapa_inicial, etapa_final, permite_aprovar,
              permite_rejeitar, exige_comprovante, exige_motivo,
              limite_horas, ativo
         FROM public.comprov_etapas
        WHERE codconta = $1 AND ativo
        ORDER BY ordem, codetapa`,
      [req.escopo.codconta]
    );
    res.json(rows);
  } catch (err) {
    console.error('[comprov/etapas]', err);
    res.status(500).json({ erro: 'Erro ao carregar as etapas.' });
  }
});

router.get('/motivos', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT codmotivo, descricao, tipo, exige_descricao, ordem
         FROM public.comprov_motivos
        WHERE codconta = $1 AND ativo
        ORDER BY ordem, descricao`,
      [req.escopo.codconta]
    );
    res.json(rows);
  } catch (err) {
    console.error('[comprov/motivos]', err);
    res.status(500).json({ erro: 'Erro ao carregar os motivos.' });
  }
});

// ════════════════════════════════════════════════════════════
//  KANBAN
// ════════════════════════════════════════════════════════════
//
//  GET /kanban?inicio=&fim=&numnota=&parceiro=&motorista=&placa=
//              &ordemcarga=&cidade=&situacao=&etapa=&prioridade=
//              &responsavel=&somentePendentes=1&comOcorrencia=1
//              &comComprovante=1&semComprovante=1&atrasados=1
//              &ordenar=data|prazo|prioridade|parceiro|tempo
//              &pagina=1&porPagina=50
//
//  Devolve os cards agrupados por etapa. A paginação é POR
//  COLUNA: uma etapa com 800 cards não pode arrastar as outras.

function montarFiltros(req, empresas) {
  const where = [
    'c.codemp = ANY($1::int[])',
  ];
  const params = [empresas];
  let i = 2;

  const add = (sql, valor) => {
    where.push(sql.replace('$$', `$${i}`));
    params.push(valor);
    i++;
  };

  const q = req.query;

  if (nulo(q.inicio)) add('e.data_entrega >= $$::date', q.inicio);
  if (nulo(q.fim)) add('e.data_entrega < ($$::date + 1)', q.fim);
  if (nulo(q.numnota)) add('e.numnota::text = $$', String(q.numnota).trim());
  if (inteiro(q.identrega)) add('e.id = $$', inteiro(q.identrega));
  if (nulo(q.cgccpf)) add('e.cgccpf = $$', q.cgccpf);
  if (nulo(q.parceiro)) {
    add('(unaccent(lower(e.razaosocial)) LIKE unaccent(lower($$)) '
        + 'OR unaccent(lower(e.nomeparc)) LIKE unaccent(lower($$)))',
        `%${q.parceiro}%`);
    // O LIKE aparece duas vezes; repõe o mesmo valor.
    params.push(`%${q.parceiro}%`);
    where[where.length - 1] = where[where.length - 1]
      .replace(/\$(\d+)\)\)$/, `$${i})）`.replace('）', ')'));
    i++;
  }
  if (nulo(q.motorista)) {
    add('unaccent(lower(r.motorista)) LIKE unaccent(lower($$))',
        `%${q.motorista}%`);
  }
  if (nulo(q.placa)) add('v.placa = $$', String(q.placa).toUpperCase());
  if (inteiro(q.ordemcarga)) add('e.ordemcarga = $$', inteiro(q.ordemcarga));
  if (nulo(q.cidade)) {
    add('unaccent(lower(e.cidade)) LIKE unaccent(lower($$))', `%${q.cidade}%`);
  }
  if (nulo(q.situacao) && SITUACOES.includes(q.situacao)) {
    add('c.situacao = $$', q.situacao);
  }
  if (inteiro(q.etapa)) add('c.codetapa = $$', inteiro(q.etapa));
  if (inteiro(q.prioridade)) add('c.prioridade = $$', inteiro(q.prioridade));
  if (inteiro(q.responsavel)) {
    add('c.codusu_responsavel = $$', inteiro(q.responsavel));
  }
  if (inteiro(q.codemp)) add('c.codemp = $$', inteiro(q.codemp));

  // Filtros booleanos
  if (q.somentePendentes === '1') {
    where.push("c.situacao NOT IN ('APROVADO','REJEITADO')");
  }
  if (q.semResponsavel === '1') {
    where.push('c.codusu_responsavel IS NULL');
  }
  if (q.comOcorrencia === '1') {
    where.push('EXISTS (SELECT 1 FROM public.entregas_ocorrencias o '
               + 'WHERE o.id = e.id)');
  }
  if (q.comComprovante === '1') {
    where.push('EXISTS (SELECT 1 FROM public.entregas_fotos f '
               + 'WHERE f.id = e.id)');
  }
  if (q.semComprovante === '1') {
    where.push('NOT EXISTS (SELECT 1 FROM public.entregas_fotos f '
               + 'WHERE f.id = e.id)');
  }
  if (q.atrasados === '1') {
    where.push('c.prazo_comprovante < now() '
               + "AND c.situacao NOT IN ('APROVADO','REJEITADO')");
  }

  return { where: where.join(' AND '), params, proximo: i };
}

const ORDENACOES = {
  data: 'e.data_entrega DESC',
  prazo: 'c.prazo_comprovante ASC NULLS LAST',
  prioridade: 'c.prioridade DESC, c.dh_entrada_etapa ASC',
  parceiro: 'e.razaosocial ASC',
  tempo: 'c.dh_entrada_etapa ASC',
  nota: 'e.numnota DESC',
};

router.get('/kanban', async (req, res) => {
  const empresas = empresasFiltradas(req);
  const porPagina = Math.min(Number(req.query.porPagina) || 40, 100);
  const pagina = Math.max(Number(req.query.pagina) || 1, 1);
  const ordem = ORDENACOES[req.query.ordenar] || ORDENACOES.prioridade;

  try {
    const f = montarFiltros(req, empresas);

    // ROW_NUMBER por etapa: pagina cada coluna separadamente,
    // numa consulta só. Uma etapa com 800 cards não atrasa o
    // carregamento das outras.
    const sql = `
      WITH base AS (
        SELECT c.id, c.identrega, c.codemp, c.codetapa, c.situacao,
               c.prioridade, c.dh_entrada_etapa, c.prazo_comprovante,
               c.codusu_responsavel, c.versao, c.ultima_atualizacao,
               c.dh_aprovacao,
               e.numnota, e.razaosocial, e.nomeparc, e.cidade, e.estado,
               e.data_entrega, e.checkoutdh, e.ordemcarga,
               COALESCE(r.motorista, '') AS motorista,
               COALESCE(v.placa, '')     AS placa,
               COALESCE(u.nomecomp, u.nomeusu, '') AS responsavel_nome,
               emp.nomefantasia AS empresa_nome,
               (SELECT COUNT(*) FROM public.entregas_fotos f
                 WHERE f.id = e.id)::int AS qtd_comprovantes,
               (SELECT COUNT(*) FROM public.entregas_ocorrencias o
                 WHERE o.id = e.id)::int AS qtd_ocorrencias,
               (c.prazo_comprovante < now()
                AND c.situacao NOT IN ('APROVADO','REJEITADO')) AS atrasado,
               EXTRACT(EPOCH FROM (now() - c.dh_entrada_etapa))::bigint
                 AS segundos_na_etapa,
               ROW_NUMBER() OVER (PARTITION BY c.codetapa ORDER BY ${ordem})
                 AS linha,
               COUNT(*) OVER (PARTITION BY c.codetapa)::int AS total_etapa
          FROM public.comprov_entregas c
          JOIN public.entregas e     ON e.id = c.identrega
          LEFT JOIN public.romaneios r ON r.ocromaneio = e.ordemcarga
                                      AND r.codemp = e.codemp
          LEFT JOIN public.veiculos v  ON v.codveiculo = r.codveiculo
          LEFT JOIN public.usuarios u  ON u.codusu = c.codusu_responsavel
          LEFT JOIN public.empresas emp ON emp.codemp = c.codemp
         WHERE ${f.where}
      )
      SELECT * FROM base
       WHERE linha > $${f.proximo} AND linha <= $${f.proximo + 1}
       ORDER BY codetapa, linha
    `;

    const params = [...f.params, (pagina - 1) * porPagina, pagina * porPagina];
    const { rows } = await pool.query(sql, params);

    // Agrupa por etapa e informa o total de cada coluna, para o
    // front saber se ainda há o que carregar.
    const colunas = {};
    for (const r of rows) {
      const chave = r.codetapa;
      if (!colunas[chave]) {
        colunas[chave] = { codetapa: chave, total: r.total_etapa, cards: [] };
      }
      colunas[chave].cards.push(r);
    }

    res.json({
      pagina,
      porPagina,
      colunas: Object.values(colunas),
    });
  } catch (err) {
    console.error('[comprov/kanban]', err);
    res.status(500).json({ erro: 'Erro ao carregar o kanban.' });
  }
});

// ════════════════════════════════════════════════════════════
//  INDICADORES
// ════════════════════════════════════════════════════════════

router.get('/indicadores', async (req, res) => {
  const empresas = empresasFiltradas(req);

  try {
    const f = montarFiltros(req, empresas);

    const { rows } = await pool.query(`
      WITH base AS (
        SELECT c.*, e.data_entrega, e.numnota, e.razaosocial, e.nomeparc,
               e.cidade, e.checkoutdh, e.ordemcarga, e.cgccpf, e.id AS eid
          FROM public.comprov_entregas c
          JOIN public.entregas e ON e.id = c.identrega
          LEFT JOIN public.romaneios r ON r.ocromaneio = e.ordemcarga
                                      AND r.codemp = e.codemp
          LEFT JOIN public.veiculos v ON v.codveiculo = r.codveiculo
         WHERE ${f.where}
      )
      SELECT
        COUNT(*)::int                                          AS total,
        COUNT(*) FILTER (WHERE situacao = 'PENDENTE')::int      AS pendentes,
        COUNT(*) FILTER (WHERE situacao = 'RECEBIDO')::int      AS recebidos,
        COUNT(*) FILTER (WHERE situacao = 'ANALISE')::int       AS analise,
        COUNT(*) FILTER (WHERE situacao = 'CORRECAO')::int      AS correcao,
        COUNT(*) FILTER (WHERE situacao = 'APROVADO')::int      AS aprovados,
        COUNT(*) FILTER (WHERE situacao = 'REJEITADO')::int     AS rejeitados,
        COUNT(*) FILTER (WHERE prazo_comprovante < now()
                           AND situacao NOT IN ('APROVADO','REJEITADO'))::int
                                                                AS atrasados,
        COUNT(*) FILTER (WHERE codusu_responsavel IS NULL
                           AND situacao NOT IN ('APROVADO','REJEITADO'))::int
                                                                AS sem_responsavel,
        COUNT(*) FILTER (WHERE prioridade >= 3
                           AND situacao NOT IN ('APROVADO','REJEITADO'))::int
                                                                AS prioridade_alta,
        -- Percentual sobre o que já foi decidido: incluir os
        -- pendentes no denominador daria um número que só cai.
        COALESCE(ROUND(
          COUNT(*) FILTER (WHERE situacao = 'APROVADO')::numeric * 100
          / NULLIF(COUNT(*) FILTER
              (WHERE situacao IN ('APROVADO','REJEITADO')), 0), 1), 0)
                                                                AS pct_aprovacao,
        COALESCE(ROUND(AVG(
          EXTRACT(EPOCH FROM (dh_aprovacao - checkoutdh)) / 3600
        ) FILTER (WHERE dh_aprovacao IS NOT NULL), 1), 0)
                                                       AS horas_medias_aprovacao
      FROM base
    `, f.params);

    res.json(rows[0]);
  } catch (err) {
    console.error('[comprov/indicadores]', err);
    res.status(500).json({ erro: 'Erro ao calcular os indicadores.' });
  }
});

// ════════════════════════════════════════════════════════════
//  DETALHE
// ════════════════════════════════════════════════════════════

router.get('/:id', async (req, res) => {
  const id = inteiro(req.params.id);
  if (!id) return res.status(400).json({ erro: 'Id inválido.' });

  const empresas = empresasFiltradas(req);

  try {
    const { rows } = await pool.query(
      `SELECT c.*, et.nome AS etapa_nome, et.cor AS etapa_cor,
              et.permite_aprovar, et.permite_rejeitar, et.etapa_final,
              e.numnota, e.tipodoc, e.chavenfe, e.vlrnota, e.cgccpf,
              e.razaosocial, e.nomeparc, e.endereco, e.numend,
              e.nomebairro, e.cidade, e.estado, e.telefone,
              e.data_entrega, e.dtinicial_entrega, e.checkindh,
              e.assinadodh, e.checkoutdh, e.ordemcarga, e.seqcarga,
              e.ad_apprecebedor, e.ad_appdocrecebedor,
              e.ad_apptipdocrecebedor, e.latitude, e.longitude,
              COALESCE(r.motorista, '') AS motorista,
              COALESCE(v.placa, '')     AS placa,
              COALESCE(u.nomecomp, u.nomeusu, '') AS responsavel_nome,
              emp.nomefantasia AS empresa_nome,
              m.descricao AS motivo_descricao
         FROM public.comprov_entregas c
         JOIN public.comprov_etapas et ON et.codetapa = c.codetapa
         JOIN public.entregas e ON e.id = c.identrega
         LEFT JOIN public.romaneios r ON r.ocromaneio = e.ordemcarga
                                     AND r.codemp = e.codemp
         LEFT JOIN public.veiculos v ON v.codveiculo = r.codveiculo
         LEFT JOIN public.usuarios u ON u.codusu = c.codusu_responsavel
         LEFT JOIN public.empresas emp ON emp.codemp = c.codemp
         LEFT JOIN public.comprov_motivos m ON m.codmotivo = c.codmotivo
        WHERE c.id = $1 AND c.codemp = ANY($2::int[])`,
      [id, empresas]
    );

    if (rows.length === 0) {
      return res.status(404).json({ erro: 'Comprovação não encontrada.' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('[comprov/detalhe]', err);
    res.status(500).json({ erro: 'Erro ao carregar o detalhe.' });
  }
});

router.get('/:id/comprovantes', async (req, res) => {
  const id = inteiro(req.params.id);
  const empresas = empresasFiltradas(req);

  try {
    // Nunca traz `conteudo`: o binário só sai por rota própria,
    // sob demanda. Aqui vai só o metadado e a miniatura.
    const { rows } = await pool.query(
      `SELECT f.id AS identrega, f.seq, f.tipo, f.url, f.url_miniatura,
              f.nome_arquivo, f.mimetype, f.bytes, f.dhinclusao,
              f.latitude, f.longitude,
              f.aprovado, f.dh_aprovacao, f.motivo_rejeicao,
              (f.conteudo IS NOT NULL) AS tem_binario
         FROM public.entregas_fotos f
         JOIN public.comprov_entregas c ON c.identrega = f.id
        WHERE c.id = $1 AND c.codemp = ANY($2::int[])
        ORDER BY f.seq`,
      [id, empresas]
    );
    res.json(rows);
  } catch (err) {
    console.error('[comprov/comprovantes]', err);
    res.status(500).json({ erro: 'Erro ao carregar os comprovantes.' });
  }
});

router.get('/:id/historico', async (req, res) => {
  const id = inteiro(req.params.id);
  const empresas = empresasFiltradas(req);

  try {
    const { rows } = await pool.query(
      `SELECT h.id, h.acao, h.dh, h.nomeusu, h.observacao,
              h.situacao_anterior, h.situacao_nova,
              h.origem, h.ip, h.dispositivo,
              h.dados_anteriores, h.dados_novos,
              ea.nome AS etapa_anterior_nome,
              en.nome AS etapa_nova_nome,
              m.descricao AS motivo_descricao
         FROM public.comprov_historico h
         JOIN public.comprov_entregas c ON c.id = h.idcomprov
         LEFT JOIN public.comprov_etapas ea ON ea.codetapa = h.codetapa_anterior
         LEFT JOIN public.comprov_etapas en ON en.codetapa = h.codetapa_nova
         LEFT JOIN public.comprov_motivos m ON m.codmotivo = h.codmotivo
        WHERE h.idcomprov = $1 AND c.codemp = ANY($2::int[])
        ORDER BY h.dh DESC, h.id DESC`,
      [id, empresas]
    );
    res.json(rows);
  } catch (err) {
    console.error('[comprov/historico]', err);
    res.status(500).json({ erro: 'Erro ao carregar o histórico.' });
  }
});

router.get('/:id/observacoes', async (req, res) => {
  const id = inteiro(req.params.id);
  const empresas = empresasFiltradas(req);

  try {
    const { rows } = await pool.query(
      `SELECT o.id, o.texto, o.importante, o.nomeusu, o.dh
         FROM public.comprov_observacoes o
         JOIN public.comprov_entregas c ON c.id = o.idcomprov
        WHERE o.idcomprov = $1 AND c.codemp = ANY($2::int[])
        ORDER BY o.dh DESC`,
      [id, empresas]
    );
    res.json(rows);
  } catch (err) {
    console.error('[comprov/observacoes]', err);
    res.status(500).json({ erro: 'Erro ao carregar as observações.' });
  }
});

// ════════════════════════════════════════════════════════════
//  APROVAR
// ════════════════════════════════════════════════════════════

router.post('/:id/aprovar', async (req, res) => {
  const id = inteiro(req.params.id);
  if (!id) return res.status(400).json({ erro: 'Id inválido.' });

  const empresas = empresasFiltradas(req);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { card, erro } = await carregarCard(
      client, id, empresas, req.body.versao
    );
    if (erro) {
      await client.query('ROLLBACK');
      return res.status(erro.status).json(erro);
    }

    // Idempotência: reapertar o botão não gera segundo registro.
    if (card.situacao === 'APROVADO') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        erro: 'Este comprovante já foi aprovado.',
        jaAprovado: true,
      });
    }

    if (!card.permite_aprovar) {
      await client.query('ROLLBACK');
      return res.status(422).json({
        erro: `A etapa "${card.etapa_nome}" não permite aprovação.`,
      });
    }

    // Regra central do módulo: sem comprovante, não há o que
    // aprovar. Vale mesmo que o front tenha deixado passar.
    const { rows: fotos } = await client.query(
      `SELECT COUNT(*)::int AS n FROM public.entregas_fotos
        WHERE id = $1`,
      [card.identrega]
    );

    if (fotos[0].n === 0) {
      await client.query('ROLLBACK');
      return res.status(422).json({
        erro: 'Não é possível aprovar: a entrega não tem comprovante anexado.',
      });
    }

    const destino = await etapaPor(
      client, req.escopo.codconta, "etapa_final AND permite_aprovar = false "
      + "AND nome ILIKE '%aprovad%'"
    ) ?? card.codetapa;

    const { rows } = await client.query(
      `UPDATE public.comprov_entregas
          SET situacao = 'APROVADO',
              codetapa = $1,
              dh_entrada_etapa = now(),
              dh_aprovacao = now(),
              codusu_aprovacao = $2,
              obs_aprovacao = $3,
              versao = versao + 1,
              ultima_atualizacao = now()
        WHERE id = $4
      RETURNING *`,
      [destino, req.usuario.codusu, nulo(req.body.observacao), id]
    );

    // Marca todos os comprovantes ainda sem decisão.
    await client.query(
      `UPDATE public.entregas_fotos
          SET aprovado = true, dh_aprovacao = now(),
              codusu_aprovacao = $1
        WHERE id = $2 AND aprovado IS DISTINCT FROM false`,
      [req.usuario.codusu, card.identrega]
    );

    await registrarHistorico(client, req, {
      idcomprov: id,
      acao: 'APROVACAO',
      etapaAnterior: card.codetapa,
      etapaNova: destino,
      situacaoAnterior: card.situacao,
      situacaoNova: 'APROVADO',
      observacao: nulo(req.body.observacao),
      antes: { situacao: card.situacao, codetapa: card.codetapa },
      depois: { situacao: 'APROVADO', codetapa: destino },
    });

    await client.query('COMMIT');
    res.json({ ok: true, card: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[comprov/aprovar]', err);
    res.status(500).json({ erro: 'Erro ao aprovar o comprovante.' });
  } finally {
    client.release();
  }
});

// ════════════════════════════════════════════════════════════
//  REJEITAR E SOLICITAR CORREÇÃO
// ════════════════════════════════════════════════════════════

/** Compartilha o corpo entre rejeição e correção. */
async function recusar(req, res, { acao, situacao, filtroEtapa }) {
  const id = inteiro(req.params.id);
  if (!id) return res.status(400).json({ erro: 'Id inválido.' });

  const codmotivo = inteiro(req.body.codmotivo);
  const descricao = nulo(req.body.descricao);

  if (!codmotivo) {
    return res.status(422).json({ erro: 'Informe o motivo.' });
  }

  const empresas = empresasFiltradas(req);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { card, erro } = await carregarCard(
      client, id, empresas, req.body.versao
    );
    if (erro) {
      await client.query('ROLLBACK');
      return res.status(erro.status).json(erro);
    }

    if (card.situacao === 'APROVADO') {
      await client.query('ROLLBACK');
      return res.status(422).json({
        erro: 'Comprovante já aprovado. Reabra antes de recusar.',
      });
    }

    // Motivo tem de ser da conta e, se exigir texto, o texto
    // precisa vir — senão o motorista recebe "corrija" sem saber o quê.
    const { rows: motivos } = await client.query(
      `SELECT descricao, exige_descricao FROM public.comprov_motivos
        WHERE codmotivo = $1 AND codconta = $2 AND ativo`,
      [codmotivo, req.escopo.codconta]
    );

    if (motivos.length === 0) {
      await client.query('ROLLBACK');
      return res.status(422).json({ erro: 'Motivo inválido.' });
    }

    if (motivos[0].exige_descricao && !descricao) {
      await client.query('ROLLBACK');
      return res.status(422).json({
        erro: `O motivo "${motivos[0].descricao}" exige uma descrição.`,
      });
    }

    const destino = await etapaPor(client, req.escopo.codconta, filtroEtapa)
                    ?? card.codetapa;

    const { rows } = await client.query(
      `UPDATE public.comprov_entregas
          SET situacao = $1,
              codetapa = $2,
              dh_entrada_etapa = now(),
              dh_rejeicao = now(),
              codusu_rejeicao = $3,
              codmotivo = $4,
              desc_rejeicao = $5,
              versao = versao + 1,
              ultima_atualizacao = now()
        WHERE id = $6
      RETURNING *`,
      [situacao, destino, req.usuario.codusu, codmotivo, descricao, id]
    );

    // Marca os comprovantes como recusados, para o app do
    // motorista saber quais precisam ser reenviados.
    await client.query(
      `UPDATE public.entregas_fotos
          SET aprovado = false,
              motivo_rejeicao = $1
        WHERE id = $2 AND aprovado IS NOT TRUE`,
      [`${motivos[0].descricao}${descricao ? ': ' + descricao : ''}`,
       card.identrega]
    );

    await registrarHistorico(client, req, {
      idcomprov: id,
      acao,
      etapaAnterior: card.codetapa,
      etapaNova: destino,
      situacaoAnterior: card.situacao,
      situacaoNova: situacao,
      observacao: descricao,
      codmotivo,
      antes: { situacao: card.situacao, codetapa: card.codetapa },
      depois: { situacao, codetapa: destino, codmotivo },
    });

    await client.query('COMMIT');
    res.json({ ok: true, card: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`[comprov/${acao}]`, err);
    res.status(500).json({ erro: 'Erro ao registrar a recusa.' });
  } finally {
    client.release();
  }
}

router.post('/:id/rejeitar', (req, res) =>
  recusar(req, res, {
    acao: 'REJEICAO',
    situacao: 'REJEITADO',
    filtroEtapa: "etapa_final AND nome ILIKE '%rejeitad%'",
  })
);

router.post('/:id/solicitar-correcao', (req, res) =>
  recusar(req, res, {
    acao: 'CORRECAO',
    situacao: 'CORRECAO',
    filtroEtapa: "nome ILIKE '%correç%' OR nome ILIKE '%correc%'",
  })
);

// ════════════════════════════════════════════════════════════
//  MOVIMENTAÇÃO MANUAL
// ════════════════════════════════════════════════════════════

router.patch('/:id/etapa', async (req, res) => {
  const id = inteiro(req.params.id);
  const codetapa = inteiro(req.body.codetapa);

  if (!id || !codetapa) {
    return res.status(400).json({ erro: 'Id e etapa são obrigatórios.' });
  }

  const empresas = empresasFiltradas(req);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { card, erro } = await carregarCard(
      client, id, empresas, req.body.versao
    );
    if (erro) {
      await client.query('ROLLBACK');
      return res.status(erro.status).json(erro);
    }

    const { rows: destinos } = await client.query(
      `SELECT * FROM public.comprov_etapas
        WHERE codetapa = $1 AND codconta = $2 AND ativo`,
      [codetapa, req.escopo.codconta]
    );

    if (destinos.length === 0) {
      await client.query('ROLLBACK');
      return res.status(422).json({ erro: 'Etapa de destino inválida.' });
    }

    const destino = destinos[0];

    // Regras de entrada da etapa. Espelham o que a spec pede e
    // valem mesmo que o drag-and-drop do front tenha permitido.
    if (destino.exige_comprovante) {
      const { rows: f } = await client.query(
        `SELECT COUNT(*)::int AS n FROM public.entregas_fotos WHERE id = $1`,
        [card.identrega]
      );
      if (f[0].n === 0) {
        await client.query('ROLLBACK');
        return res.status(422).json({
          erro: `A etapa "${destino.nome}" exige comprovante anexado.`,
        });
      }
    }

    if (destino.exige_motivo && !inteiro(req.body.codmotivo)) {
      await client.query('ROLLBACK');
      return res.status(422).json({
        erro: `A etapa "${destino.nome}" exige um motivo.`,
      });
    }

    // Sair de aprovado é reabertura: exige permissão própria.
    if (card.situacao === 'APROVADO' && !destino.etapa_final) {
      const admin = req.escopo.perfis[card.codemp] === 'ADMIN';
      if (!admin) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          erro: 'Somente administradores podem reabrir um comprovante aprovado.',
        });
      }
    }

    const { rows } = await client.query(
      `UPDATE public.comprov_entregas
          SET codetapa = $1,
              dh_entrada_etapa = now(),
              versao = versao + 1,
              ultima_atualizacao = now()
        WHERE id = $2
      RETURNING *`,
      [codetapa, id]
    );

    await registrarHistorico(client, req, {
      idcomprov: id,
      acao: card.situacao === 'APROVADO' ? 'REABERTURA' : 'MOVIMENTACAO',
      etapaAnterior: card.codetapa,
      etapaNova: codetapa,
      situacaoAnterior: card.situacao,
      situacaoNova: card.situacao,
      observacao: nulo(req.body.observacao),
      codmotivo: inteiro(req.body.codmotivo),
      antes: { codetapa: card.codetapa },
      depois: { codetapa },
    });

    await client.query('COMMIT');
    res.json({ ok: true, card: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[comprov/etapa]', err);
    res.status(500).json({ erro: 'Erro ao mover o card.' });
  } finally {
    client.release();
  }
});

// ════════════════════════════════════════════════════════════
//  RESPONSÁVEL E PRIORIDADE
// ════════════════════════════════════════════════════════════

/** Campos simples: mesma mecânica, muda só a coluna. */
function patchSimples(campo, acao, validar) {
  return async (req, res) => {
    const id = inteiro(req.params.id);
    if (!id) return res.status(400).json({ erro: 'Id inválido.' });

    const valor = validar(req.body);
    if (valor === undefined) {
      return res.status(422).json({ erro: 'Valor inválido.' });
    }

    const empresas = empresasFiltradas(req);
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const { card, erro } = await carregarCard(
        client, id, empresas, req.body.versao
      );
      if (erro) {
        await client.query('ROLLBACK');
        return res.status(erro.status).json(erro);
      }

      const { rows } = await client.query(
        `UPDATE public.comprov_entregas
            SET ${campo} = $1, versao = versao + 1, ultima_atualizacao = now()
          WHERE id = $2
        RETURNING *`,
        [valor, id]
      );

      await registrarHistorico(client, req, {
        idcomprov: id,
        acao,
        situacaoAnterior: card.situacao,
        situacaoNova: card.situacao,
        antes: { [campo]: card[campo] },
        depois: { [campo]: valor },
      });

      await client.query('COMMIT');
      res.json({ ok: true, card: rows[0] });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`[comprov/${campo}]`, err);
      res.status(500).json({ erro: 'Erro ao atualizar.' });
    } finally {
      client.release();
    }
  };
}

router.patch('/:id/responsavel', patchSimples(
  'codusu_responsavel', 'RESPONSAVEL',
  (body) => body.codusu === null ? null : (inteiro(body.codusu) ?? undefined)
));

router.patch('/:id/prioridade', patchSimples(
  'prioridade', 'PRIORIDADE',
  (body) => {
    const p = inteiro(body.prioridade);
    return p >= 1 && p <= 4 ? p : undefined;
  }
));

// ════════════════════════════════════════════════════════════
//  OBSERVAÇÃO
// ════════════════════════════════════════════════════════════

router.post('/:id/observacao', async (req, res) => {
  const id = inteiro(req.params.id);
  const texto = nulo(req.body.texto);

  if (!id || !texto) {
    return res.status(400).json({ erro: 'Texto da observação é obrigatório.' });
  }

  const empresas = empresasFiltradas(req);

  try {
    const { rowCount } = await pool.query(
      `SELECT 1 FROM public.comprov_entregas
        WHERE id = $1 AND codemp = ANY($2::int[])`,
      [id, empresas]
    );

    if (rowCount === 0) {
      return res.status(404).json({ erro: 'Comprovação não encontrada.' });
    }

    const { rows } = await pool.query(
      `INSERT INTO public.comprov_observacoes
         (idcomprov, texto, importante, codusu, nomeusu)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, texto, req.body.importante === true,
       req.usuario.codusu, req.usuario.nomeusu ?? req.usuario.email ?? null]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[comprov/observacao]', err);
    res.status(500).json({ erro: 'Erro ao registrar a observação.' });
  }
});

// ════════════════════════════════════════════════════════════
//  APROVAÇÃO EM LOTE
// ════════════════════════════════════════════════════════════
//
//  Cada card em sua própria transação: uma falha no meio não
//  pode desfazer as aprovações que já passaram. A resposta traz
//  o resultado item a item.

router.post('/aprovar-lote', async (req, res) => {
  const ids = Array.isArray(req.body.ids)
    ? req.body.ids.map(inteiro).filter(Boolean)
    : [];

  if (ids.length === 0) {
    return res.status(400).json({ erro: 'Informe os registros.' });
  }
  if (ids.length > 200) {
    return res.status(422).json({ erro: 'Máximo de 200 por vez.' });
  }

  const empresas = empresasFiltradas(req);
  const resultado = { ok: [], erro: [] };

  for (const id of ids) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { card, erro } = await carregarCard(client, id, empresas, null);
      if (erro) {
        await client.query('ROLLBACK');
        resultado.erro.push({ id, motivo: erro.msg });
        continue;
      }

      if (card.situacao === 'APROVADO') {
        await client.query('ROLLBACK');
        resultado.erro.push({ id, motivo: 'Já aprovado.' });
        continue;
      }

      if (!card.permite_aprovar) {
        await client.query('ROLLBACK');
        resultado.erro.push({
          id, motivo: `Etapa "${card.etapa_nome}" não permite aprovação.`,
        });
        continue;
      }

      const { rows: f } = await client.query(
        `SELECT COUNT(*)::int AS n FROM public.entregas_fotos WHERE id = $1`,
        [card.identrega]
      );
      if (f[0].n === 0) {
        await client.query('ROLLBACK');
        resultado.erro.push({ id, motivo: 'Sem comprovante anexado.' });
        continue;
      }

      const destino = await etapaPor(
        client, req.escopo.codconta,
        "etapa_final AND nome ILIKE '%aprovad%'"
      ) ?? card.codetapa;

      await client.query(
        `UPDATE public.comprov_entregas
            SET situacao = 'APROVADO', codetapa = $1,
                dh_entrada_etapa = now(), dh_aprovacao = now(),
                codusu_aprovacao = $2, obs_aprovacao = $3,
                versao = versao + 1, ultima_atualizacao = now()
          WHERE id = $4`,
        [destino, req.usuario.codusu, nulo(req.body.observacao), id]
      );

      await client.query(
        `UPDATE public.entregas_fotos
            SET aprovado = true, dh_aprovacao = now(), codusu_aprovacao = $1
          WHERE id = $2 AND aprovado IS DISTINCT FROM false`,
        [req.usuario.codusu, card.identrega]
      );

      await registrarHistorico(client, req, {
        idcomprov: id,
        acao: 'APROVACAO',
        etapaAnterior: card.codetapa,
        etapaNova: destino,
        situacaoAnterior: card.situacao,
        situacaoNova: 'APROVADO',
        observacao: nulo(req.body.observacao),
      });

      await client.query('COMMIT');
      resultado.ok.push(id);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[comprov/lote]', id, err.message);
      resultado.erro.push({ id, motivo: err.message });
    } finally {
      client.release();
    }
  }

  res.json({
    total: ids.length,
    aprovados: resultado.ok.length,
    falhas: resultado.erro.length,
    ...resultado,
  });
});

module.exports = router;
