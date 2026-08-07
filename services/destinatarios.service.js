// ============================================================
//  destinatarios.service.js
//  Gravação do destinatário a partir da tag <dest> do XML
//  Caminho: services/destinatarios.service.js
// ============================================================

const pool = require('../db/pool');

// ── Leitura tolerante do XML ────────────────────────────────
//
// xml2js devolve array, fast-xml-parser devolve string ou
// objeto com '#text'. Em vez de amarrar o service a um parser,
// tudo passa por aqui.
function txt(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return txt(v[0]);
  if (typeof v === 'object') return txt(v._ ?? v['#text'] ?? null);
  const s = String(v).trim();
  return s === '' ? null : s;
}

const digitos = (v) => {
  const s = txt(v);
  return s ? s.replace(/\D/g, '') : null;
};

const inteiro = (v) => {
  const s = digitos(v);
  return s ? parseInt(s, 10) : null;
};

const corta = (v, n) => {
  const s = txt(v);
  return s ? s.slice(0, n) : null;
};

/**
 * Extrai os campos de <dest> no formato aceito pelo UPSERT.
 * Não toca no banco — dá para testar isolado.
 */
function lerDestinatario(dest) {
  if (!dest) return null;

  const ender = dest.enderDest ?? dest.enderdest ?? {};
  const e = Array.isArray(ender) ? ender[0] : ender;

  // O XML traz <CNPJ> ou <CPF>, nunca os dois.
  const cnpj = digitos(dest.CNPJ ?? dest.cnpj);
  const cpf = digitos(dest.CPF ?? dest.cpf);
  const documento = cnpj || cpf;

  if (!documento || (documento.length !== 14 && documento.length !== 11)) {
    return null; // exterior (idEstrangeiro) ou XML incompleto
  }

  const cep = digitos(e.CEP ?? e.cep);
  const fone = digitos(e.fone ?? dest.fone);

  return {
    cnpjcpf: documento,
    tipopessoa: documento.length === 14 ? 'J' : 'F',
    razaosocial: corta(dest.xNome ?? dest.xnome, 120),
    ie: corta(dest.IE ?? dest.ie, 20),
    indiedest: inteiro(dest.indIEDest ?? dest.indiedest),
    email: corta(dest.email, 120),
    // fone do XML vem sem máscara e com DDD; 11 dígitos é o teto.
    fone: fone ? fone.slice(0, 20) : null,

    logradouro: corta(e.xLgr ?? e.xlgr, 120),
    numero: corta(e.nro, 20),
    complemento: corta(e.xCpl ?? e.xcpl, 120),
    bairro: corta(e.xBairro ?? e.xbairro, 80),
    codmunicipio: inteiro(e.cMun ?? e.cmun),
    municipio: corta(e.xMun ?? e.xmun, 80),
    uf: corta(e.UF ?? e.uf, 2),
    cep: cep && cep.length === 8 ? cep : null,
    codpais: inteiro(e.cPais ?? e.cpais) ?? 1058,
    pais: corta(e.xPais ?? e.xpais, 60) ?? 'BRASIL',
  };
}
const MUDOU_ENDERECO_UPDATE = `
       cep        IS DISTINCT FROM NULLIF($16::text, '')
    OR logradouro IS DISTINCT FROM NULLIF($9::text, '')
    OR numero     IS DISTINCT FROM NULLIF($10::text, '')
`;

const SQL_UPDATE = `
  UPDATE public.destinatarios SET
    razaosocial  = COALESCE(NULLIF($4::text, ''),  razaosocial),
    ie           = COALESCE(NULLIF($5::text, ''),  ie),
    indiedest    = COALESCE($6::smallint,          indiedest),
    email        = COALESCE(NULLIF($7::text, ''),  email),
    fone         = COALESCE(NULLIF($8::text, ''),  fone),
    logradouro   = COALESCE(NULLIF($9::text, ''),  logradouro),
    numero       = COALESCE(NULLIF($10::text, ''), numero),
    complemento  = COALESCE(NULLIF($11::text, ''), complemento),
    bairro       = COALESCE(NULLIF($12::text, ''), bairro),
    codmunicipio = COALESCE($13::integer,          codmunicipio),
    municipio    = COALESCE(NULLIF($14::text, ''), municipio),
    uf           = COALESCE(NULLIF($15::text, ''), uf),
    cep          = COALESCE(NULLIF($16::text, ''), cep),
    codpais      = COALESCE($17::integer,          codpais),
    pais         = COALESCE(NULLIF($18::text, ''), pais),
    latitude = CASE
      WHEN coordenada_manual THEN latitude
      WHEN ${MUDOU_ENDERECO_UPDATE} THEN NULL
      ELSE latitude END,
    longitude = CASE
      WHEN coordenada_manual THEN longitude
      WHEN ${MUDOU_ENDERECO_UPDATE} THEN NULL
      ELSE longitude END
  WHERE codemp = $1 AND cnpjcpf = $2::text
  RETURNING *;
`;

const SQL_INSERT = `
  INSERT INTO public.destinatarios (
    codemp, cnpjcpf, tipopessoa, razaosocial, ie, indiedest, email, fone,
    logradouro, numero, complemento, bairro,
    codmunicipio, municipio, uf, cep, codpais, pais,
    codusuinclusao
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8,
    $9, $10, $11, $12,
    $13, $14, $15, $16, $17, $18,
    $19
  )
  ON CONFLICT (codemp, cnpjcpf) DO UPDATE SET
    razaosocial = COALESCE(NULLIF(EXCLUDED.razaosocial, ''), destinatarios.razaosocial)
  RETURNING *;
`;

/**
 * Grava (ou atualiza) o destinatário do XML.
 *
 * @param {object}  dest    conteúdo da tag <dest> já parseada
 * @param {number}  codemp  empresa do usuário logado (vem do JWT)
 * @param {number}  codusu  usuário logado (vem do JWT)
 * @param {object}  cliente conexão da transação; usa o pool se omitido
 * @returns {Promise<object|null>} a linha gravada
 */
async function salvarDestinatario(dest, { codemp, codusu }, cliente = pool) {
  const d = lerDestinatario(dest);
  if (!d) return null;

  // $1..$18 — o mesmo bloco serve às duas queries.
  const base = [
    codemp,
    d.cnpjcpf,
    d.tipopessoa,
    d.razaosocial,
    d.ie,
    d.indiedest,
    d.email,
    d.fone,
    d.logradouro,
    d.numero,
    d.complemento,
    d.bairro,
    d.codmunicipio,
    d.municipio,
    d.uf,
    d.cep,
    d.codpais,
    d.pais,
  ];

  // O UPDATE não recebe codusuinclusao: quem cadastrou primeiro
  // continua sendo quem cadastrou.
  const atualizado = await cliente.query(SQL_UPDATE, base);
  if (atualizado.rows[0]) return atualizado.rows[0];

  const inserido = await cliente.query(SQL_INSERT, [...base, codusu ?? null]);
  return inserido.rows[0] ?? null;
}





/** Endereço em uma linha, pronto para Nominatim ou Google. */
function enderecoParaGeocodificar(d) {
  return [
    [d.logradouro, d.numero].filter(Boolean).join(', '),
    d.bairro,
    d.municipio,
    d.uf,
    d.cep,
    d.pais || 'Brasil',
  ]
    .filter(Boolean)
    .join(' - ');
}

/** Fila de quem ainda não tem coordenada, para o job de geocoding. */
async function pendentesDeGeocodificacao(codemp, limite = 50) {
  const { rows } = await pool.query(
    `SELECT id, logradouro, numero, bairro, municipio, uf, cep, pais
       FROM public.destinatarios
      WHERE codemp = $1
        AND ativo = 'S'
        AND (latitude IS NULL OR longitude IS NULL)
      ORDER BY data_criacao
      LIMIT $2`,
    [codemp, limite]
  );
  return rows;
}

async function gravarCoordenada(id, { latitude, longitude, origem, manual = false }) {
  await pool.query(
    `UPDATE public.destinatarios
        SET latitude = $2,
            longitude = $3,
            origem_geocodificacao = $4,
            coordenada_manual = $5,
            geocodificado_em = NOW()
      WHERE id = $1`,
    [id, latitude, longitude, origem, manual]
  );
}

module.exports = {
  lerDestinatario,
  salvarDestinatario,
  enderecoParaGeocodificar,
  pendentesDeGeocodificacao,
  gravarCoordenada,
};
