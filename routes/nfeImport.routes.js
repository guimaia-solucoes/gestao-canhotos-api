// ============================================================
//  nfeImport.routes.js
//  Importação de XMLs de NF-e (ZIP) — Entrega Fácil
//  Caminho: routes/nfeImport.routes.js
// ============================================================

const express = require("express");
const multer = require("multer");
const AdmZip = require("adm-zip");
const { XMLParser } = require("fast-xml-parser");

const pool = require("../db/pool");
const { authMiddleware } = require("../middleware/auth.middleware");
const {
  salvarDestinatario,
  lerDestinatario,
} = require("../services/destinatarios.service");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// leadingZeros: false é obrigatório aqui.
//
// Sem isso o parser converte tag numérica em Number e come o
// zero à esquerda: CNPJ "01234567000199" chega com 13 dígitos e
// o CEP "07793870" com 7. O documento vira outro documento.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  numberParseOptions: { leadingZeros: false, hex: false, eNotation: false },
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

function toTexto(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
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

// ============================================================
//  LEITURA DO XML
// ============================================================

function extrairItens(infNFe) {
  const dets = toArray(infNFe?.det);

  return dets.map((d) => {
    const prod = d?.prod || {};
    const nItem = d?.["@_nItem"] || d?.nItem || null;

    return {
      nItem: nItem ? Number(nItem) : null,
      cProd: toTexto(prod?.cProd),
      xProd: toTexto(prod?.xProd),
      NCM: toTexto(prod?.NCM),
      CEST: toTexto(prod?.CEST),
      CFOP: toTexto(prod?.CFOP),
      uCom: toTexto(prod?.uCom),
      qCom: toNumber(prod?.qCom),
      vUnCom: toNumber(prod?.vUnCom),
      vProd: toNumber(prod?.vProd),
      cEAN: toTexto(prod?.cEAN),
      cEANTrib: toTexto(prod?.cEANTrib),
      uTrib: toTexto(prod?.uTrib),
      qTrib: toNumber(prod?.qTrib),
      vUnTrib: toNumber(prod?.vUnTrib),
      vFrete: toNumber(prod?.vFrete),
      vDesc: toNumber(prod?.vDesc),
      vOutro: toNumber(prod?.vOutro),
      indTot: toTexto(prod?.indTot),
    };
  });
}

/**
 * Monta o registro de entregas a partir do XML já parseado.
 *
 * O `destinatario` é o que voltou do cadastro: usar o documento
 * e o telefone dele em vez de reler o XML garante que a entrega
 * e o cadastro apontem para exatamente o mesmo cliente.
 */
function montarRegistroEntrega({ infNFe, chave, xml, codemp, codusu, destinatario }) {
  const ide = infNFe?.ide;
  const dest = infNFe?.dest;
  const enderDest = dest?.enderDest || {};
  const total = infNFe?.total?.ICMSTot;

  const nNF = ide?.nNF ?? null;
  const destNome = toTexto(dest?.xNome);

  return {
    codemp,
    codusuinclusao: codusu,
    numnota: nNF !== null ? String(nNF) : null,
    cgccpf: destinatario?.cnpjcpf ?? toTexto(dest?.CNPJ ?? dest?.CPF),
    endereco: toTexto(enderDest?.xLgr),
    numend: toTexto(enderDest?.nro),
    cidade: toTexto(enderDest?.xMun),
    estado: toTexto(enderDest?.UF),
    chavenfe: chave,
    vlrnota: toNumber(total?.vNF),
    nomeparc: destNome,
    razaosocial: destNome,
    nomebairro: toTexto(enderDest?.xBairro),
    // O <fone> mora dentro de <enderDest>, não em <dest>.
    // Antes lia do lugar errado e gravava sempre nulo.
    telefone: destinatario?.fone ?? toTexto(enderDest?.fone ?? dest?.fone),
    xml_nfe: xml || null,
  };
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
      return res
        .status(400)
        .json({ ok: false, msg: "Arquivo ZIP não enviado." });
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
      destinatarios: 0,
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
        if (!infNFe) {
          throw new Error("Estrutura XML inválida (infNFe não encontrado).");
        }

        const id = infNFe["@_Id"] || infNFe["Id"];
        const chave = String(id || "").replace(/^NFe/, "");
        if (chave.length !== 44) {
          throw new Error("Chave NFe inválida ou ausente.");
        }

        // ── Destinatário ──────────────────────────────────
        //
        // Roda antes da checagem de duplicidade de propósito:
        // reprocessar um ZIP já importado preenche o cadastro
        // de clientes retroativamente, sem duplicar nota.
        //
        // Erro aqui não derruba a nota — o cadastro é apoio, a
        // entrega é o que o usuário veio importar.
        let destinatario = null;
        try {
          destinatario = await salvarDestinatario(infNFe?.dest, {
            codemp,
            codusu,
          });
          if (destinatario) resultado.destinatarios++;
        } catch (errDest) {
          resultado.erros.push({
            arquivo: e.entryName,
            erro: `Destinatário: ${errDest?.message || String(errDest)}`,
          });
        }

        const jaExiste = await existeChaveNoBanco(chave, codemp);
        if (jaExiste) {
          resultado.duplicados++;
          continue;
        }

        const registro = montarRegistroEntrega({
          infNFe,
          chave,
          xml,
          codemp,
          codusu,
          // Se o cadastro falhou, cai na leitura direta do XML.
          destinatario: destinatario || lerDestinatario(infNFe?.dest),
        });

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

// ============================================================
//  FUNÇÕES DE BANCO
// ============================================================

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
