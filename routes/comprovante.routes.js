// ============================================================
//  routes/comprovante.routes.js
//  Comprovante de entrega (ficha) — Entrega Fácil
// ============================================================
//
//  GET /api/comprovante/:id          → PDF inline no navegador
//  GET /api/comprovante/:id?down=1   → força download
//
//  Registro no index.js:
//    const comprovanteRoutes = require('./routes/comprovante.routes');
//    app.use('/api/comprovante', comprovanteRoutes);
//
//  Mesmo padrão do DANFE: o Node monta um JSON com tudo que o
//  PDF precisa e passa por stdin para o Python/ReportLab.
// ============================================================

const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const { XMLParser } = require('fast-xml-parser');

const router = express.Router();
const pool = require('../db/pool');
const { authMiddleware } = require('../middleware/auth.middleware');

// Mesmo caminho usado pelo danfe.service.
const PYTHON = process.env.PYTHON_BIN
  || '/mise/installs/python/3.11.15/bin/python3';

const SCRIPT = path.join(__dirname, '..', 'scripts', 'comprovante.py');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
});

// ── Helpers ─────────────────────────────────────────────────

const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** Extrai produtos e duplicatas do XML da NFe. */
function lerXml(xml) {
  const vazio = { produtos: [], financeiro: [] };
  if (!xml) return vazio;

  try {
    const obj = parser.parse(xml);
    const infNFe = (obj?.nfeProc?.NFe ?? obj?.NFe)?.infNFe;
    if (!infNFe) return vazio;

    const produtos = arr(infNFe.det).map((d) => {
      const p = d?.prod || {};
      return {
        codigo: p.cProd?.toString() ?? '',
        descricao: p.xProd?.toString() ?? '',
        quantidade: num(p.qCom),
        unitario: num(p.vUnCom),
        total: num(p.vProd),
      };
    });

    const financeiro = arr(infNFe.cobr?.dup).map((d) => ({
      documento: d?.nDup?.toString() ?? '',
      vencimento: d?.dVenc?.toString() ?? '',
      valor: num(d?.vDup),
    }));

    // Sem duplicatas: mostra o total da nota como parcela única.
    if (financeiro.length === 0) {
      const vNF = num(infNFe.total?.ICMSTot?.vNF);
      if (vNF != null) {
        financeiro.push({ documento: '', vencimento: '', valor: vNF });
      }
    }

    return { produtos, financeiro };
  } catch (err) {
    console.warn('[comprovante] XML ilegível:', err.message);
    return vazio;
  }
}

// ── Rota ────────────────────────────────────────────────────

router.get('/:id', authMiddleware, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ erro: 'Id da entrega inválido.' });
  }

  const codemp = req.usuario?.codemp ?? null;

  try {
    // ── Entrega + romaneio ──────────────────────────────────
    const { rows: entregas } = await pool.query(
      `SELECT e.id, e.codemp, e.numnota, e.tipodoc, e.chavenfe, e.vlrnota,
              e.cgccpf, e.razaosocial, e.nomeparc,
              e.endereco, e.numend, e.nomebairro, e.cidade, e.estado, e.telefone,
              e.ordemcarga, e.data_entrega,
              e.dtinicial_entrega, e.checkindh, e.assinadodh, e.checkoutdh,
              e.ad_apprecebedor, e.ad_appdocrecebedor, e.ad_apptipdocrecebedor,
              e.assinatura,
              e.checkinlatitude, e.checkinlongitude,
              e.assinaturalatitude, e.assinaturalongitude,
              e.xml_nfe,
              r.motorista, v.placa
         FROM public.entregas e
         LEFT JOIN public.romaneios r ON r.ocromaneio = e.ordemcarga
         LEFT JOIN public.veiculos  v ON v.codveiculo = r.codveiculo
        WHERE e.id = $1
          AND ($2::int IS NULL OR e.codemp = $2::int)
        LIMIT 1`,
      [id, codemp]
    );

    if (entregas.length === 0) {
      return res.status(404).json({ erro: 'Entrega não encontrada.' });
    }
    const e = entregas[0];

    // ── Empresa emitente ────────────────────────────────────
    const { rows: empresas } = await pool.query(
      `SELECT razaosocial, nomefantasia, cnpj, emailcontato,
              endereco, numero, bairro, cidade, estado, cep
         FROM public.empresas
        WHERE codemp = $1
        LIMIT 1`,
      [e.codemp]
    );
    const emp = empresas[0] || {};

    // ── Ocorrências ─────────────────────────────────────────
    const { rows: ocorrencias } = await pool.query(
      `SELECT eo.seq, eo.dhocor, eo.descrocor, eo.codocor,
              COALESCE(o.descricao, o.tipo, '') AS tipo
         FROM public.entregas_ocorrencias eo
         LEFT JOIN public.ocorrencias o ON o.codocor = eo.codocor
        WHERE eo.id = $1
        ORDER BY eo.seq`,
      [id]
    ).catch(async () => {
      // Fallback: se public.ocorrencias tiver outro nome de coluna,
      // devolve só o que está na tabela de registro.
      return pool.query(
        `SELECT seq, dhocor, descrocor, codocor, '' AS tipo
           FROM public.entregas_ocorrencias
          WHERE id = $1
          ORDER BY seq`,
        [id]
      );
    });

    // ── Fotos ───────────────────────────────────────────────
    // Traz a URL e, só quando não houver URL, o binário em base64.
    // Nunca faça SELECT * aqui: `conteudo` pode ter megabytes.
    const { rows: fotos } = await pool.query(
      `SELECT seq, tipo, url,
              CASE WHEN url IS NULL AND conteudo IS NOT NULL
                   THEN encode(conteudo, 'base64') END AS base64
         FROM public.entregas_fotos
        WHERE id = $1
        ORDER BY seq
        LIMIT 8`,
      [id]
    ).catch(() => ({ rows: [] }));

    const { produtos, financeiro } = lerXml(e.xml_nfe);

    // ── Payload para o Python ───────────────────────────────
    const payload = {
      emitente: {
        razaosocial: emp.razaosocial || '',
        nomefantasia: emp.nomefantasia || '',
        cnpj: emp.cnpj || '',
        email: emp.emailcontato || '',
        endereco: [
          emp.endereco,
          emp.numero,
          emp.bairro,
          emp.cidade,
          emp.estado,
        ].filter(Boolean).join(', '),
      },
      documento: {
        nro_unico: e.id,
        nro_nf: e.numnota || '',
        tipodoc: e.tipodoc || '',
        chavenfe: e.chavenfe || '',
        ordemcarga: e.ordemcarga,
        motorista: e.motorista || '',
        placa: e.placa || '',
      },
      destinatario: {
        razaosocial: e.razaosocial || e.nomeparc || '',
        cgccpf: e.cgccpf || '',
        endereco: [e.endereco, e.numend].filter(Boolean).join(', '),
        bairro: e.nomebairro || '',
        cidade: e.cidade || '',
        estado: e.estado || '',
        telefone: e.telefone || '',
      },
      produtos,
      financeiro,
      ocorrencias: ocorrencias.map((o) => ({
        seq: o.seq,
        tipo: o.tipo || '',
        dhocor: o.dhocor,
        observacao: o.descrocor || '',
      })),
      fotos: fotos.map((f) => ({
        seq: f.seq,
        tipo: f.tipo || '',
        url: f.url || null,
        base64: f.base64 || null,
      })),
      atendimento: {
        dh_inicio: e.dtinicial_entrega,
        dh_checkin: e.checkindh,
        dh_assinatura: e.assinadodh,
        dh_checkout: e.checkoutdh,
        recebedor: e.ad_apprecebedor || '',
        tipo_documento: e.ad_apptipdocrecebedor || '',
        nro_documento: e.ad_appdocrecebedor || '',
        assinatura: e.assinatura || null,
        geo_checkin:
          e.checkinlatitude && e.checkinlongitude
            ? { lat: e.checkinlatitude, lng: e.checkinlongitude }
            : null,
        geo_assinatura:
          e.assinaturalatitude && e.assinaturalongitude
            ? { lat: e.assinaturalatitude, lng: e.assinaturalongitude }
            : null,
      },
    };

    // ── Executa o Python ────────────────────────────────────
    const py = spawn(PYTHON, [SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const chunks = [];
    let stderr = '';

    py.stdout.on('data', (c) => chunks.push(c));
    py.stderr.on('data', (c) => (stderr += c.toString()));

    py.on('error', (err) => {
      console.error('[comprovante] spawn falhou:', err);
      if (!res.headersSent) {
        res.status(500).json({ erro: 'Gerador de PDF indisponível.' });
      }
    });

    py.on('close', (code) => {
      if (code !== 0) {
        console.error('[comprovante] python saiu com', code, stderr);
        if (!res.headersSent) {
          res.status(500).json({ erro: 'Falha ao gerar o comprovante.' });
        }
        return;
      }

      const pdf = Buffer.concat(chunks);
      const nome = `comprovante-${e.numnota || e.id}.pdf`;
      const disp = req.query.down ? 'attachment' : 'inline';

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `${disp}; filename="${nome}"`);
      res.setHeader('Content-Length', pdf.length);
      res.end(pdf);
    });

    py.stdin.write(JSON.stringify(payload));
    py.stdin.end();
  } catch (err) {
    console.error('[comprovante]', err);
    res.status(500).json({ erro: 'Erro interno ao gerar o comprovante.' });
  }
});

module.exports = router;
