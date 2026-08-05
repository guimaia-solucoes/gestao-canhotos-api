// ============================================================
//  routes/mapaCargas.routes.js
//  Mapa consolidado de ordens de carga — Entrega Fácil
// ============================================================
//
//  GET /api/mapa-cargas?inicio=&fim=&motorista=&veiculo=&status=
//
//  Registro no index.js:
//    const mapaCargasRoutes = require('./routes/mapaCargas.routes');
//    app.use('/api/mapa-cargas', mapaCargasRoutes);
//
//  ── CUIDADO COM O TAMANHO DO PAYLOAD ───────────────────────
//
//  A geometria do OSRM tem centenas de pontos por rota. Vinte
//  cargas num período podem passar de 5 MB de JSON — o que no
//  Flutter Web significa segundos de parse travando a interface.
//
//  Por isso o parâmetro `rotas`: por padrão as linhas NÃO vêm.
//  A tela pede a geometria só das cargas que o usuário marcou
//  para exibir.
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

const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;

function data(v, padrao) {
  return typeof v === 'string' && RE_DATA.test(v) ? v : padrao;
}

function nulo(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' || s === 'null' ? null : s;
}

function hoje() {
  return new Date().toISOString().slice(0, 10);
}

function seteDiasAtras() {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString().slice(0, 10);
}

// ── Consolidado ─────────────────────────────────────────────

router.get('/', async (req, res) => {
  const empresas = empresasFiltradas(req);

  const inicio = data(req.query.inicio, seteDiasAtras());
  const fim = data(req.query.fim, hoje());

  if (inicio > fim) {
    return res.status(400).json({ erro: 'Data inicial maior que a final.' });
  }

  // Lista de OCs cuja geometria deve vir. Vazio = nenhuma.
  const rotasPedidas = nulo(req.query.rotas)
    ? String(req.query.rotas)
        .split(',')
        .map((s) => Number(s.trim()))
        .filter(Number.isInteger)
    : [];

  const motorista = nulo(req.query.motorista);
  const veiculo = nulo(req.query.veiculo);
  const status = nulo(req.query.status);

  try {
    // ── Romaneios ───────────────────────────────────────────
    const { rows: romaneios } = await pool.query(
      `SELECT r.ocromaneio, r.codemp, r.data_entregasaida, r.data_criacao,
              r.status, r.kmest, r.duracaoest, r.obs,
              COALESCE(r.qtdentregas, 0)    AS qtdentregas,
              COALESCE(r.qtdfinalizadas, 0) AS qtdfinalizadas,
              COALESCE(m.nomecomp, m.nomeusu, r.motorista, '') AS motorista,
              r.codmotorista,
              COALESCE(v.placa, '') AS placa,
              TRIM(COALESCE(v.marca,'') || ' ' || COALESCE(v.modelo,'')) AS veiculo,
              r.codveiculo,
              COALESCE(e.nomefantasia, e.razaosocial, '') AS empresa_nome,
              COALESCE(e.latitude, 0)  AS origem_latitude,
              COALESCE(e.longitude, 0) AS origem_longitude,
              -- A geometria só viaja quando pedida. Ver nota do
              -- topo do arquivo sobre o tamanho do payload.
              CASE WHEN r.ocromaneio = ANY($4::int[])
                   THEN r.coordenadas END AS coordenadas,
              (r.coordenadas IS NOT NULL) AS tem_rota
         FROM public.romaneios r
         LEFT JOIN public.motoristas m ON m.codmotorista = r.codmotorista
         LEFT JOIN public.veiculos   v ON v.codveiculo   = r.codveiculo
         LEFT JOIN public.empresas   e ON e.codemp       = r.codemp
        WHERE r.codemp = ANY($1::int[])
          AND r.data_entregasaida >= $2::date
          AND r.data_entregasaida <  ($3::date + 1)
          AND ($5::int  IS NULL OR r.codmotorista = $5::int)
          AND ($6::int  IS NULL OR r.codveiculo   = $6::int)
          AND ($7::text IS NULL OR r.status       = $7::text)
        ORDER BY r.data_entregasaida DESC, r.ocromaneio DESC`,
      [
        empresas, inicio, fim, rotasPedidas,
        motorista ? Number(motorista) : null,
        veiculo ? Number(veiculo) : null,
        status,
      ]
    );

    if (romaneios.length === 0) {
      return res.json({
        periodo: { inicio, fim },
        romaneios: [],
        entregas: [],
        totais: { cargas: 0, entregas: 0, finalizadas: 0 },
      });
    }

    // ── Entregas ────────────────────────────────────────────
    // Só as que têm coordenada: sem lat/lng não há o que
    // desenhar, e trazê-las inflaria o payload à toa.
    const ocs = romaneios.map((r) => r.ocromaneio);

    const { rows: entregas } = await pool.query(
      `SELECT e.id, e.codemp, e.ordemcarga, e.numnota,
              COALESCE(e.razaosocial, e.nomeparc, '') AS razaosocial,
              COALESCE(e.cidade, '')     AS cidade,
              COALESCE(e.estado, '')     AS estado,
              COALESCE(e.nomebairro, '') AS nomebairro,
              COALESCE(e.endereco, '')   AS endereco,
              COALESCE(e.numend, '')     AS numend,
              e.latitude, e.longitude,
              COALESCE(e.seqcarga, 0)    AS seqcarga,
              e.data_entrega, e.checkindh, e.checkoutdh,
              e.tempodescarga, e.distancia_checkin,
              (e.checkoutdh IS NOT NULL) AS entregue,
              EXISTS (SELECT 1 FROM public.entregas_ocorrencias o
                       WHERE o.id = e.id) AS tem_ocorrencia
         FROM public.entregas e
        WHERE e.ordemcarga = ANY($1::int[])
          AND e.codemp = ANY($2::int[])
          AND e.latitude  IS NOT NULL AND e.latitude  <> 0
          AND e.longitude IS NOT NULL AND e.longitude <> 0
        ORDER BY e.ordemcarga, COALESCE(e.seqcarga, 0), e.id`,
      [ocs, empresas]
    );

    // ── Totais ──────────────────────────────────────────────
    const totais = {
      cargas: romaneios.length,
      entregas: romaneios.reduce((s, r) => s + Number(r.qtdentregas || 0), 0),
      finalizadas:
          romaneios.reduce((s, r) => s + Number(r.qtdfinalizadas || 0), 0),
      // Quantas entregas ficaram de fora do mapa por falta de
      // geocodificação. A tela avisa: mapa com menos pontos que
      // o total confunde quem está conferindo.
      semCoordenada:
          romaneios.reduce((s, r) => s + Number(r.qtdentregas || 0), 0)
          - entregas.length,
      comRota: romaneios.filter((r) => r.tem_rota).length,
    };

    res.json({
      periodo: { inicio, fim },
      romaneios,
      entregas,
      totais,
    });
  } catch (err) {
    console.error('[mapa-cargas]', err);
    res.status(500).json({ erro: 'Erro ao carregar o mapa de cargas.' });
  }
});

// ── Geometria sob demanda ───────────────────────────────────
//
//  Chamada quando o usuário liga a rota de uma carga específica
//  na grade. Devolve só a linha, sem repetir o resto.

router.get('/rota/:ocromaneio', async (req, res) => {
  const oc = Number(req.params.ocromaneio);
  if (!Number.isInteger(oc) || oc <= 0) {
    return res.status(400).json({ erro: 'Ordem de carga inválida.' });
  }

  const empresas = empresasFiltradas(req);

  try {
    const { rows } = await pool.query(
      `SELECT ocromaneio, coordenadas, kmest, duracaoest
         FROM public.romaneios
        WHERE ocromaneio = $1 AND codemp = ANY($2::int[])
        LIMIT 1`,
      [oc, empresas]
    );

    if (rows.length === 0) {
      return res.status(404).json({ erro: 'Ordem de carga não encontrada.' });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('[mapa-cargas/rota]', err);
    res.status(500).json({ erro: 'Erro ao carregar a rota.' });
  }
});

module.exports = router;
