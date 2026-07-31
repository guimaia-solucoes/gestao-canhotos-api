// ============================================================
//  routes/dashboard.routes.js
//  Dashboard — Entrega Fácil
// ============================================================
//
//  GET /api/dashboard/resumo
//      ?inicio=2026-07-01&fim=2026-07-30
//      [&motorista=12][&veiculo=ABC1D23][&cidade=Jundiaí]
//
//  Serve o contrato consumido por dashboard_service.dart.
//  Tudo em uma única query com CTEs: um round-trip só, o que
//  importa no Railway (cold start).
//
//  Registro no index.js:
//    const dashboardRoutes = require('./routes/dashboard.routes');
//    app.use('/api/dashboard', dashboardRoutes);
// ============================================================

const express = require('express');
const router = express.Router();

const pool = require('../db/pool');
const { authMiddleware } = require('../middleware/auth.middleware');

router.use(authMiddleware);

// ── Pontos de ajuste ────────────────────────────────────────

// Coluna de public.ocorrencias que aponta para public.entregas.id.
// ⚠️ CONFIRMAR — é o único nome que eu não tenho do seu schema.
// Se a ligação for por ordemcarga + numnota, veja a nota no fim do arquivo.
const OCOR_FK = 'id';

// Data que ancora o período. `data_entrega` é a data prevista de entrega
// (vem da "Data prevista para saída" da OC no Sankhya). Se você preferir
// ancorar pela data de emissão, troque para 'dhinclusao'.
const COL_DATA = 'data_entrega';

// Quantas posições cada ranking devolve (a tela mostra 3).
const LIMITE_RANKING = 5;

// ── Helpers ─────────────────────────────────────────────────

const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;

function normalizarData(valor, padrao) {
  if (typeof valor === 'string' && RE_DATA.test(valor)) return valor;
  return padrao;
}

function hojeISO() {
  return new Date().toISOString().slice(0, 10);
}

function primeiroDiaDoMesISO() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}

/** '' e 'null' viram null, para o padrão ($n IS NULL OR ...) funcionar. */
function ouNulo(valor) {
  if (valor === undefined || valor === null) return null;
  const s = String(valor).trim();
  return s === '' || s === 'null' ? null : s;
}

// ── SQL ─────────────────────────────────────────────────────
//
//  $1 inicio   $2 fim   $3 codemp   $4 motorista   $5 veiculo   $6 cidade
//
//  periodo → filtra só por data e empresa. É a fonte das OPÇÕES dos
//            dropdowns; se filtrasse por motorista, escolher um motorista
//            derrubaria a lista para um item só.
//  base    → periodo + filtros de dimensão. Alimenta KPIs, rankings e evolução.

const SQL = `
WITH periodo AS (
  SELECT
    e.id,
    e.codmotorista,
    e.cidade,
    e.ordemcarga,
    e.${COL_DATA}::date                                        AS prevista,
    e.checkindh,
    e.checkoutdh,
    r.motorista                                                AS nome_motorista,
    (SELECT PLACA FROM VEICULOS V WHERE V.CODVEICULO =  r.codveiculo ) AS veiculo,
    (e.checkoutdh IS NOT NULL)                                 AS finalizada,
    (e.checkoutdh IS NULL AND e.dtinicial_entrega IS NOT NULL)         AS em_rota,
    (e.checkoutdh IS NULL AND e.checkindh IS NULL)             AS nao_iniciada,
    (e.checkoutdh IS NULL
      AND e.${COL_DATA}::date < CURRENT_DATE)                  AS atrasada,
    (e.checkoutdh IS NOT NULL
      AND e.checkoutdh::date <= e.${COL_DATA}::date)           AS no_prazo,
    (oc.achou IS NULL)                                         AS sem_ocorrencia
  FROM public.entregas e
  LEFT JOIN public.romaneios r
         ON r.ocromaneio = e.ordemcarga
  LEFT JOIN LATERAL (
    SELECT 1 AS achou
    FROM public.entregas_ocorrencias o
    WHERE o.${OCOR_FK} = e.id
    LIMIT 1
  ) oc ON TRUE
  WHERE e.${COL_DATA}::date BETWEEN $1::date AND $2::date
    AND ($3::text IS NULL OR e.codemp::text = $3::text)
),

base AS (
  SELECT *
  FROM periodo
  WHERE ($4::text IS NULL OR codmotorista::text = $4::text)
    AND ($5::text IS NULL OR veiculo = $5::text)
    AND ($6::text IS NULL OR cidade  = $6::text)
),

kpis AS (
  SELECT
    COUNT(*)::int                                 AS total,
    COUNT(*) FILTER (WHERE nao_iniciada)::int     AS "naoIniciadas",
    COUNT(*) FILTER (WHERE em_rota)::int          AS "emRota",
    COUNT(*) FILTER (WHERE atrasada)::int         AS atrasadas,
    COUNT(*) FILTER (WHERE finalizada)::int       AS finalizadas
  FROM base
),

rk_motoristas AS (
  SELECT
    codmotorista::text AS id,
    COALESCE(MAX(nome_motorista), 'Motorista ' || codmotorista::text) AS nome,
    COUNT(*)::int                            AS total,
    COUNT(*) FILTER (WHERE finalizada)::int  AS finalizadas,
    COALESCE(
      COUNT(*) FILTER (WHERE no_prazo)::numeric
      / NULLIF(COUNT(*) FILTER (WHERE finalizada), 0), 0)              AS pontualidade,
    COALESCE(
      COUNT(*) FILTER (WHERE finalizada AND sem_ocorrencia)::numeric
      / NULLIF(COUNT(*) FILTER (WHERE finalizada), 0), 0)              AS qualidade
  FROM base
  WHERE codmotorista IS NOT NULL
  GROUP BY codmotorista
  ORDER BY
    (COUNT(*) FILTER (WHERE finalizada)::numeric / NULLIF(COUNT(*), 0)) DESC NULLS LAST,
    COUNT(*) DESC
  LIMIT ${LIMITE_RANKING}
),

rk_cidades AS (
  SELECT
    cidade AS id,
    cidade AS nome,
    COUNT(*)::int                            AS total,
    COUNT(*) FILTER (WHERE finalizada)::int  AS finalizadas,
    COALESCE(
      COUNT(*) FILTER (WHERE no_prazo)::numeric
      / NULLIF(COUNT(*) FILTER (WHERE finalizada), 0), 0)              AS pontualidade,
    COALESCE(
      COUNT(*) FILTER (WHERE finalizada AND sem_ocorrencia)::numeric
      / NULLIF(COUNT(*) FILTER (WHERE finalizada), 0), 0)              AS qualidade
  FROM base
  WHERE cidade IS NOT NULL AND cidade <> ''
  GROUP BY cidade
  ORDER BY
    (COUNT(*) FILTER (WHERE finalizada)::numeric / NULLIF(COUNT(*), 0)) DESC NULLS LAST,
    COUNT(*) DESC
  LIMIT ${LIMITE_RANKING}
),

rk_veiculos AS (
  SELECT
    veiculo AS id,
    veiculo AS nome,
    COUNT(*)::int                            AS total,
    COUNT(*) FILTER (WHERE finalizada)::int  AS finalizadas,
    COALESCE(
      COUNT(*) FILTER (WHERE no_prazo)::numeric
      / NULLIF(COUNT(*) FILTER (WHERE finalizada), 0), 0)              AS pontualidade,
    COALESCE(
      COUNT(*) FILTER (WHERE finalizada AND sem_ocorrencia)::numeric
      / NULLIF(COUNT(*) FILTER (WHERE finalizada), 0), 0)              AS qualidade
  FROM base
  WHERE veiculo IS NOT NULL AND veiculo <> ''
  GROUP BY veiculo
  ORDER BY
    (COUNT(*) FILTER (WHERE finalizada)::numeric / NULLIF(COUNT(*), 0)) DESC NULLS LAST,
    COUNT(*) DESC
  LIMIT ${LIMITE_RANKING}
),

-- Um registro por dia do intervalo, mesmo nos dias sem movimento:
-- sem isso o gráfico "pula" datas e a linha mente sobre a tendência.
por_dia AS (
  SELECT
    prevista,
    COUNT(*)::int                            AS entregas,
    COUNT(*) FILTER (WHERE finalizada)::int  AS finalizadas,
    COUNT(*) FILTER (WHERE atrasada)::int    AS atrasadas
  FROM base
  GROUP BY prevista
),

ocor_dia AS (
  SELECT
    o.dhocor::date AS dia,
    COUNT(*)::int  AS ocorrencias
  FROM public.entregas_ocorrencias o
  JOIN base b ON b.id = o.${OCOR_FK}
  GROUP BY o.dhocor::date
),

evolucao AS (
  SELECT
    to_char(d::date, 'YYYY-MM-DD')     AS data,
    COALESCE(p.entregas, 0)            AS entregas,
    COALESCE(p.finalizadas, 0)         AS finalizadas,
    COALESCE(p.atrasadas, 0)           AS atrasadas,
    COALESCE(oc.ocorrencias, 0)        AS ocorrencias
  FROM generate_series($1::date, $2::date, interval '1 day') d
  LEFT JOIN por_dia  p  ON p.prevista = d::date
  LEFT JOIN ocor_dia oc ON oc.dia     = d::date
  ORDER BY d
),

opc_motoristas AS (
  SELECT DISTINCT
    codmotorista::text AS id,
    COALESCE(nome_motorista, 'Motorista ' || codmotorista::text) AS nome
  FROM periodo
  WHERE codmotorista IS NOT NULL
  ORDER BY 2
),

opc_veiculos AS (
  SELECT DISTINCT veiculo AS id, veiculo AS nome
  FROM periodo
  WHERE veiculo IS NOT NULL AND veiculo <> ''
  ORDER BY 2
),

opc_cidades AS (
  SELECT DISTINCT cidade AS id, cidade AS nome
  FROM periodo
  WHERE cidade IS NOT NULL AND cidade <> ''
  ORDER BY 2
)

SELECT
  (SELECT row_to_json(k) FROM kpis k)                                  AS kpis,
  (SELECT COALESCE(json_agg(m), '[]'::json) FROM rk_motoristas m)      AS "rankingMotoristas",
  (SELECT COALESCE(json_agg(c), '[]'::json) FROM rk_cidades c)         AS "rankingCidades",
  (SELECT COALESCE(json_agg(v), '[]'::json) FROM rk_veiculos v)        AS "rankingVeiculos",
  (SELECT COALESCE(json_agg(e), '[]'::json) FROM evolucao e)           AS evolucao,
  json_build_object(
    'motoristas', (SELECT COALESCE(json_agg(x), '[]'::json) FROM opc_motoristas x),
    'veiculos',   (SELECT COALESCE(json_agg(x), '[]'::json) FROM opc_veiculos   x),
    'cidades',    (SELECT COALESCE(json_agg(x), '[]'::json) FROM opc_cidades    x)
  )                                                                    AS opcoes;
`;

// ── Rota ────────────────────────────────────────────────────

router.get('/resumo', async (req, res) => {
  const inicio = normalizarData(req.query.inicio, primeiroDiaDoMesISO());
  const fim = normalizarData(req.query.fim, hojeISO());

  if (inicio > fim) {
    return res.status(400).json({ erro: 'A data inicial é posterior à data final.' });
  }

  // Isola por empresa quando o middleware expõe o usuário logado.
  // Ajuste o caminho conforme o que o seu auth.middleware coloca em req.
  const codemp =
    ouNulo(req.usuario?.codemp) ??
    ouNulo(req.user?.codemp) ??
    null;

  const params = [
    inicio,
    fim,
    codemp,
    ouNulo(req.query.motorista),
    ouNulo(req.query.veiculo),
    ouNulo(req.query.cidade),
  ];

  try {
    const { rows } = await pool.query(SQL, params);
    const r = rows[0];

    res.json({
      kpis: r.kpis || {
        total: 0,
        naoIniciadas: 0,
        emRota: 0,
        atrasadas: 0,
        finalizadas: 0,
      },
      rankingMotoristas: r.rankingMotoristas,
      rankingCidades: r.rankingCidades,
      rankingVeiculos: r.rankingVeiculos,
      evolucao: r.evolucao,
      opcoes: r.opcoes,
    });
  } catch (err) {
    console.error('[dashboard/resumo]', err);
    res.status(500).json({ erro: 'Falha ao montar o dashboard.' });
  }
});

module.exports = router;

// ============================================================
//  NOTAS
// ============================================================
//
//  1. LIGAÇÃO COM OCORRÊNCIAS
//     O arquivo assume public.ocorrencias.identrega → public.entregas.id.
//     Se na sua base a ligação for por ordem de carga + nota, troque os
//     dois pontos que usam OCOR_FK por:
//
//       -- no LEFT JOIN LATERAL:
//       WHERE o.ordemcarga = e.ordemcarga AND o.numnota = e.numnota
//
//       -- no CTE ocor_dia:
//       JOIN base b ON b.ordemcarga = o.ordemcarga AND b.numnota = o.numnota
//       (nesse caso inclua e.numnota na projeção do CTE periodo)
//
//  2. ÍNDICES
//     Sem eles a query varre a tabela inteira a cada troca de filtro:
//
//       CREATE INDEX IF NOT EXISTS idx_entregas_${COL_DATA}
//         ON public.entregas ((${COL_DATA}::date));
//       CREATE INDEX IF NOT EXISTS idx_entregas_ordemcarga
//         ON public.entregas (ordemcarga);
//       CREATE INDEX IF NOT EXISTS idx_entregas_codmotorista
//         ON public.entregas (codmotorista);
//       CREATE INDEX IF NOT EXISTS idx_ocorrencias_entrega
//         ON public.ocorrencias (${OCOR_FK});
//
//  3. RANKING COM POUCO VOLUME
//     Quem tem 1 entrega finalizada aparece com 100% e lidera. Se isso
//     incomodar, acrescente um piso no HAVING de cada ranking:
//
//       HAVING COUNT(*) >= 5
//
//  4. FUSO
//     `checkoutdh::date <= data_entrega::date` compara no fuso do banco.
//     Se o Postgres do Railway estiver em UTC e a operação for BRT,
//     entregas do fim da tarde podem cair no dia seguinte. Para corrigir:
//
//       (e.checkoutdh AT TIME ZONE 'America/Sao_Paulo')::date
//
//     Vale aplicar no `no_prazo` e no `atrasada` juntos, ou em nenhum.
