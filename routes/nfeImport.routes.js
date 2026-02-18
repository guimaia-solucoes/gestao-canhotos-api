const express = require("express");
const multer = require("multer");
const AdmZip = require("adm-zip");
const { XMLParser } = require("fast-xml-parser");
const pool = require("../db/pool"); // ajuste caminho se precisar

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

router.post("/nfe/importar-zip", upload.single("arquivo"), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, msg: "Arquivo ZIP não enviado." });

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
      const emit = infNFe?.emit;
      const dest = infNFe?.dest;
      const total = infNFe?.total?.ICMSTot;

      const dhEmi = ide?.dhEmi || ide?.dEmi || null;
      const nNF = ide?.nNF || null;
      const serie = ide?.serie || null;

      const emitCnpj = emit?.CNPJ || null;
      const emitNome = emit?.xNome || null;

      const destCnpjCpf = dest?.CNPJ || dest?.CPF || null;
      const destNome = dest?.xNome || null;

      const vNF = total?.vNF || null;

      const itens = extrairItens(infNFe);

      const enderDest = dest?.enderDest || {};

	  const registro = {
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
	};

      const jaExiste = await existeChaveNoBanco(chave);
      if (jaExiste) {
        resultado.duplicados++;
        continue;
      }

      const idNfe = await inserirEntregaNoBanco(registro);

      //if (itens.length > 0) {
     //   await inserirItensEntregaNoBanco(idNfe, itens);
     // }

      resultado.importados++;
    } catch (err) {
      resultado.erros.push({
        arquivo: e.entryName,
        erro: err?.message || String(err),
      });
    }
  }

  res.json({ ok: true, ...resultado });
});

// ===== FUNÇÕES DE BANCO (podem ficar aqui sim) =====

async function existeChaveNoBanco(chave) {
  const { rowCount } = await pool.query(
    "SELECT 1 FROM public.entregas WHERE chavenfe = $1 LIMIT 1",
    [chave]
  );
  return rowCount > 0;
}

async function inserirEntregaNoBanco(registro) {
  const sql = `
    INSERT INTO public.entregas (
      numnota, cgccpf, endereco, numend, cidade, estado,
      chavenfe, vlrnota, nomeparc, razaosocial, nomebairro, telefone
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    RETURNING id
  `;

  const params = [
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
      idEntrega,
      it.nItem,
      it.cProd,
      it.xProd,
      it.NCM,
      it.CEST,
      it.CFOP,
      it.uCom,
      it.qCom,
      it.vUnCom,
      it.vProd,
      it.cEAN,
      it.cEANTrib,
      it.uTrib,
      it.qTrib,
      it.vUnTrib,
      it.vFrete,
      it.vDesc,
      it.vOutro,
      it.indTot
    );

    const p = Array.from({ length: cols.length }, (_, k) => `$${base + k + 1}`);
    return `(${p.join(",")})`;
  });

  const sql = `INSERT INTO public.entregas_itens (${cols.join(",")}) VALUES ${placeholders.join(",")}`;
  await pool.query(sql, values);
}

module.exports = router;
