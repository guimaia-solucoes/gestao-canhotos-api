const express = require("express");
const multer = require("multer");
const AdmZip = require("adm-zip");
const { XMLParser } = require("fast-xml-parser");
const pool = require("../db/pool");
const { authMiddleware } = require("../middleware/auth.middleware");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
});

function toArray(maybeArray) {
  if (!maybeArray) return [];
  return Array.isArray(maybeArray) ? maybeArray : [maybeArray];
}

function toNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// ============================================================
//  IDENTIDADE DO USUÁRIO LOGADO
// ============================================================
//
//  Fonte da verdade é o token, nunca o corpo da requisição.
//  Se o payload do JWT já traz codemp, usa direto; senão busca
//  em usuarios pelo codusu — assim tokens antigos, emitidos antes
//  de o codemp entrar no payload, continuam funcionando.

function usuarioDoRequest(req) {
  return req.usuario || req.user || req.auth || {};
}

async function resolverCodemp(req) {
  const u = usuarioDoRequest(req);

  const direto = u.codemp ?? u.codEmp ?? u.cod_emp;
  if (direto !== undefined && direto !== null && direto !== "") {
    return Number(direto);
  }

  const codusu = u.codusu ?? u.id ?? u.sub;
  if (codusu === undefined || codusu === null) return null;

  const { rows } = await pool.query(
    "SELECT codemp FROM public.usuarios WHERE codusu = $1 LIMIT 1",
    [codusu]
  );
  return rows[0]?.codemp ?? null;
}

function resolverCodusu(req) {
  const u = usuarioDoRequest(req);
  const codusu = u.codusu ?? u.id ?? u.sub;
  return codusu === undefined || codusu === null ? null : Number(codusu);
}

function extrairItens(infNFe) {
  const dets = toArray(infNFe?.det);

  return dets.map((d) => {
    const prod = d?.prod || {};
    const nItem = d?.["@_nItem"] || d?.nItem || null;

    return {
      nItem: nItem ? Number(nItem) : null,
      cProd: prod?.cProd || null,
      xProd: prod?.xProd || null,
      NCM: prod?.NCM || null,
      CEST: prod?.CEST || null,
      CFOP: prod?.CFOP || null,
      uCom: prod?.uCom || null,
      qCom: toNumber(prod?.qCom),
      vUnCom: toNumber(prod?.vUnCom),
      vProd: toNumber(prod?.vProd),
      cEAN: prod?.cEAN || null,
      cEANTrib: prod?.cEANTrib || null,
      uTrib: prod?.uTrib || null,
      qTrib: toNumber(prod?.qTrib),
      vUnTrib: toNumber(prod?.vUnTrib),
      vFrete: toNumber(prod?.vFrete),
      vDesc: toNumber(prod?.vDesc),
      vOutro: toNumber(prod?.vOutro),
      indTot: prod?.indTot || null,
    };
  });
}

// ============================================================
//  IMPORTAÇÃO DE ZIP COM XMLs
// ============================================================

router.post(
  "/nfe/importar-zip",
  authMiddleware,
  upload.single("arquivo"),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ ok: false, msg: "Arquivo ZIP não enviado." });
    }

    const codemp = await resolverCodemp(req);
    if (!codemp) {
      return res.status(400).json({
        ok: false,
        msg: "Não foi possível identificar a empresa do usuário logado.",
      });
    }

    const codusu = resolverCodusu(req);

    const zip = new AdmZip(req.file.buffer);
    const entries = zip.getEntries();

    const resultado = {
      totalArquivos: entries.length,
      totalXml: 0,
      importados: 0,
      duplicados: 0,
      erros: [],
    };

    for (const e of entries) {
      if (e.isDirectory) continue;
      if (!e.entryName.toLowerCase().endsWith(".xml")) continue;

      resultado.totalXml++;

      try {
        const xml = e.getData().toString("utf-8");
        const obj = parser.parse(xml);

        const nfeRoot = obj?.nfeProc?.NFe ?? obj?.NFe;
        const infNFe = nfeRoot?.infNFe;
        if (!infNFe) throw new Error("Estrutura XML inválida (infNFe não encontrado).");

        const id = infNFe["@_Id"] || infNFe["Id"];
        const chave = (id || "").replace(/^NFe/, "");
        if (chave.length !== 44) throw new Error("Chave NFe inválida ou ausente.");

        const ide = infNFe?.ide;
        const dest = infNFe?.dest;
        const total = infNFe?.total?.ICMSTot;

        const nNF = ide?.nNF || null;
        const destCnpjCpf = dest?.CNPJ || dest?.CPF || null;
        const destNome = dest?.xNome || null;
        const vNF = total?.vNF || null;
        const enderDest = dest?.enderDest || {};

        const registro = {
          codemp,
          codusuinclusao: codusu,
          numnota: nNF ? String(nNF) : null,
          cgccpf: destCnpjCpf,
          endereco: enderDest?.xLgr || null,
          numend: enderDest?.nro || null,
          cidade: enderDest?.xMun || null,
          estado: enderDest?.UF || null,
          chavenfe: chave,
          vlrnota: vNF ? toNumber(vNF) : null,
          nomeparc: destNome || null,
          razaosocial: destNome || null,
          nomebairro: enderDest?.xBairro || null,
          telefone: dest?.fone || null,
          xml_nfe: xml || null,
        };

        const jaExiste = await existeChaveNoBanco(chave, codemp);
        if (jaExiste) {
          resultado.duplicados++;
          continue;
        }

        await inserirEntregaNoBanco(registro);
        resultado.importados++;
      } catch (err) {
        resultado.erros.push({
          arquivo: e.entryName,
          erro: err?.message || String(err),
        });
      }
    }

    res.json({ ok: true, ...resultado });
  }
);

// ===== FUNÇÕES DE BANCO =====

// Duplicidade é checada DENTRO da empresa. A chave da NFe é única no
// país, mas empresas diferentes na mesma base precisam poder importar
// o mesmo XML sem uma bloquear a outra.
async function existeChaveNoBanco(chave, codemp) {
  const { rowCount } = await pool.query(
    "SELECT 1 FROM public.entregas WHERE chavenfe = $1 AND codemp = $2 LIMIT 1",
    [chave, codemp]
  );
  return rowCount > 0;
}

async function inserirEntregaNoBanco(registro) {
  const sql = `
    INSERT INTO public.entregas (
      codemp, codusuinclusao,
      numnota, cgccpf, endereco, numend, cidade, estado,
      chavenfe, vlrnota, nomeparc, razaosocial, nomebairro, telefone, xml_nfe
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    RETURNING id
  `;

  const params = [
    registro.codemp,
    registro.codusuinclusao,
    registro.numnota,
    registro.cgccpf,
    registro.endereco,
    registro.numend,
    registro.cidade,
    registro.estado,
    registro.chavenfe,
    registro.vlrnota,
    registro.nomeparc,
    registro.razaosocial,
    registro.nomebairro,
    registro.telefone,
    registro.xml_nfe,
  ];

  const { rows } = await pool.query(sql, params);
  return rows[0].id;
}

async function inserirItensEntregaNoBanco(idEntrega, itens) {
  if (!itens?.length) return;

  const cols = [
    "id_entrega","n_item","c_prod","x_prod","ncm","cest","cfop","u_com",
    "q_com","v_un_com","v_prod","cean","cean_trib","u_trib","q_trib",
    "v_un_trib","v_frete","v_desc","v_outro","ind_tot",
  ];

  const values = [];
  const placeholders = itens.map((it, i) => {
    const base = i * cols.length;
    values.push(
      idEntrega, it.nItem, it.cProd, it.xProd, it.NCM, it.CEST, it.CFOP,
      it.uCom, it.qCom, it.vUnCom, it.vProd, it.cEAN, it.cEANTrib, it.uTrib,
      it.qTrib, it.vUnTrib, it.vFrete, it.vDesc, it.vOutro, it.indTot
    );

    const p = Array.from({ length: cols.length }, (_, k) => `$${base + k + 1}`);
    return `(${p.join(",")})`;
  });

  const sql = `INSERT INTO public.entregas_itens (${cols.join(",")}) VALUES ${placeholders.join(",")}`;
  await pool.query(sql, values);
}

module.exports = router;
