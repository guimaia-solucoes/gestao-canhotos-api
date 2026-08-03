// ============================================================
//  routes/romaneioPdf.routes.js
//  Romaneio de carga (relatório) — Entrega Fácil
// ============================================================
//
//  GET /api/romaneio-pdf/:ordemcarga          → PDF inline
//  GET /api/romaneio-pdf/:ordemcarga?down=1   → download
//
//  Registro no index.js:
//    const romaneioPdfRoutes = require('./routes/romaneioPdf.routes');
//    app.use('/api/romaneio-pdf', romaneioPdfRoutes);
// ============================================================

const express = require('express');
const path = require('path');
const { spawn } = require('child_process');

const router = express.Router();
const pool = require('../db/pool');
const { authMiddleware } = require('../middleware/auth.middleware');
const { escopoMiddleware, empresasFiltradas } = require('../middleware/escopo.middleware');

const PYTHON = process.env.PYTHON_BIN
  || '/mise/installs/python/3.11.15/bin/python3';

const SCRIPT = path.join(__dirname, '..', 'scripts', 'romaneio.py');

router.get('/:ordemcarga', authMiddleware, escopoMiddleware, async (req, res) => {
  const oc = Number(req.params.ordemcarga);
  if (!Number.isInteger(oc) || oc <= 0) {
    return res.status(400).json({ erro: 'Ordem de carga inválida.' });
  }

  const empresas = empresasFiltradas(req);

  try {
    // ── Romaneio + veículo + motorista + empresa ────────────
    const { rows: romaneios } = await pool.query(
      `SELECT r.ocromaneio, r.codemp, r.data_criacao, r.data_entregasaida,
              r.status, r.obs, r.kmest, r.duracaoest,
              r.qtdentregas, r.qtdfinalizadas,
              COALESCE(v.placa, '')                          AS placa,
              COALESCE(v.marca, '') || ' ' ||
                COALESCE(v.modelo, '')                       AS veiculo_desc,
              COALESCE(m.nomecomp, m.nomeusu, r.motorista, '') AS motorista,
              COALESCE(m.telefone, '')                       AS motorista_fone,
              emp.razaosocial, emp.nomefantasia, emp.cnpj,
              emp.emailcontato, emp.endereco AS emp_endereco,
              emp.numero AS emp_numero, emp.bairro AS emp_bairro,
              emp.cidade AS emp_cidade, emp.estado AS emp_estado,
              emp.cep AS emp_cep,
              (emp.logo IS NOT NULL)                         AS tem_logo,
              CASE WHEN emp.logo IS NOT NULL
                   THEN encode(emp.logo, 'base64') END       AS logo_base64
         FROM public.romaneios r
         LEFT JOIN public.veiculos   v ON v.codveiculo   = r.codveiculo
         LEFT JOIN public.motoristas m ON m.codmotorista = r.codmotorista
         LEFT JOIN public.empresas emp ON emp.codemp     = r.codemp
        WHERE r.ocromaneio = $1
          AND r.codemp = ANY($2::int[])
        LIMIT 1`,
      [oc, empresas]
    );

    if (romaneios.length === 0) {
      return res.status(404).json({ erro: 'Ordem de carga não encontrada.' });
    }
    const r = romaneios[0];

    // ── Entregas da carga ──────────────────────────────────
    // O vínculo é codemp + ordemcarga: sem o codemp, duas
    // empresas com a mesma numeração de OC misturariam cargas.
    //
    // NOTA: public.entregas ainda não tem coluna `cep`. Quando
    // criar, troque o NULL abaixo por e.cep.
    const { rows: entregas } = await pool.query(
      `SELECT COALESCE(e.seqcarga, 0) AS seqcarga,
              e.numnota,
              COALESCE(e.razaosocial, e.nomeparc, '') AS razaosocial,
              COALESCE(e.endereco, '')   AS endereco,
              COALESCE(e.numend, '')     AS numend,
              COALESCE(e.nomebairro, '') AS nomebairro,
              COALESCE(e.cidade, '')     AS cidade,
              COALESCE(e.estado, '')     AS estado,
              NULL                       AS cep,
              e.vlrnota,
              e.checkoutdh
         FROM public.entregas e
        WHERE e.ordemcarga = $1
          AND e.codemp = $2
        ORDER BY COALESCE(e.seqcarga, 0), e.id`,
      [oc, r.codemp]
    );

    const totalValor = entregas.reduce(
      (soma, e) => soma + Number(e.vlrnota || 0), 0
    );

    const payload = {
      emitente: {
        razaosocial: r.razaosocial || '',
        nomefantasia: r.nomefantasia || '',
        cnpj: r.cnpj || '',
        email: r.emailcontato || '',
        endereco: [
          r.emp_endereco, r.emp_numero, r.emp_bairro,
          r.emp_cidade, r.emp_estado,
          r.emp_cep ? `CEP ${r.emp_cep}` : null,
        ].filter(Boolean).join(', '),
        logo_base64: r.logo_base64 || null,
      },

      romaneio: {
        numero: r.ocromaneio,
        placa: r.placa || '—',
        veiculo: (r.veiculo_desc || '').trim() || '—',
        motorista: r.motorista || '—',
        motorista_fone: r.motorista_fone || '',
        data_saida: r.data_entregasaida,
        data_criacao: r.data_criacao,
        status: r.status || '',
        kmest: r.kmest || '',
        duracaoest: r.duracaoest || '',
        obs: r.obs || '',
      },

      entregas: entregas.map((e) => ({
        seqcarga: e.seqcarga,
        numnota: e.numnota,
        razaosocial: e.razaosocial,
        endereco: e.endereco,
        numend: e.numend,
        nomebairro: e.nomebairro,
        cidade: e.cidade,
        estado: e.estado,
        cep: e.cep,
        vlrnota: e.vlrnota,
        finalizada: !!e.checkoutdh,
      })),

      totais: {
        entregas: entregas.length,
        valor: totalValor,
      },
    };

    // ── Python ──────────────────────────────────────────────
    const py = spawn(PYTHON, [SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });

    const chunks = [];
    let stderr = '';

    py.stdout.on('data', (c) => chunks.push(c));
    py.stderr.on('data', (c) => (stderr += c.toString()));

    py.on('error', (err) => {
      console.error('[romaneio-pdf] spawn falhou:', err);
      if (!res.headersSent) {
        res.status(500).json({ erro: 'Gerador de PDF indisponível.' });
      }
    });

    py.on('close', (code) => {
      if (code !== 0) {
        console.error('[romaneio-pdf] python saiu com', code, stderr);
        if (!res.headersSent) {
          res.status(500).json({ erro: 'Falha ao gerar o romaneio.' });
        }
        return;
      }

      const pdf = Buffer.concat(chunks);
      const disp = req.query.down ? 'attachment' : 'inline';

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition',
        `${disp}; filename="romaneio-${oc}.pdf"`);
      res.setHeader('Content-Length', pdf.length);
      res.end(pdf);
    });

    py.stdin.write(JSON.stringify(payload));
    py.stdin.end();
  } catch (err) {
    console.error('[romaneio-pdf]', err);
    res.status(500).json({ erro: 'Erro interno ao gerar o romaneio.' });
  }
});

module.exports = router;
