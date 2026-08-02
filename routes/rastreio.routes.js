const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// Dias após o checkout em que o link deixa de responder.
const DIAS_VALIDADE = 7;

// Limite simples de tentativas por IP, para dificultar varredura
// de tokens. Em memória: reinicia junto com o container, o que
// é aceitável para o volume atual.
const tentativas = new Map();
const JANELA_MS = 60 * 1000;
const MAX_POR_JANELA = 30;

function limitarTaxa(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket.remoteAddress
    || 'desconhecido';

  const agora = Date.now();
  const registro = tentativas.get(ip);

  if (!registro || agora - registro.inicio > JANELA_MS) {
    tentativas.set(ip, { inicio: agora, contagem: 1 });
    return next();
  }

  registro.contagem++;
  if (registro.contagem > MAX_POR_JANELA) {
    return res.status(429).json({ erro: 'Muitas consultas. Aguarde um minuto.' });
  }

  next();
}

// Limpeza periódica do mapa, para não crescer indefinidamente.
setInterval(() => {
  const agora = Date.now();
  for (const [ip, r] of tentativas) {
    if (agora - r.inicio > JANELA_MS) tentativas.delete(ip);
  }
}, 5 * 60 * 1000).unref();

// ── Helpers ─────────────────────────────────────────────────

/** Mostra só o primeiro nome + inicial do sobrenome. */
function nomeAbreviado(nome) {
  if (!nome) return '';
  const partes = String(nome).trim().split(/\s+/);
  if (partes.length === 1) return partes[0];
  return `${partes[0]} ${partes[partes.length - 1][0]}.`;
}

/**
 * Traduz o estado da entrega em algo que o destinatário entenda.
 * Nada de "checkoutdh preenchido" — a pessoa quer saber se chega hoje.
 */
function situacao(e) {
  if (e.checkoutdh) {
    return { codigo: 'ENTREGUE', titulo: 'Entrega concluída', etapa: 4 };
  }
  if (e.checkindh) {
    return { codigo: 'NO_LOCAL', titulo: 'O entregador chegou ao local', etapa: 3 };
  }
  if (e.dtinicial_entrega) {
    return { codigo: 'EM_ROTA', titulo: 'Saiu para entrega', etapa: 2 };
  }
  if (e.ordemcarga) {
    return { codigo: 'PREPARANDO', titulo: 'Preparando seu pedido', etapa: 1 };
  }
  return { codigo: 'RECEBIDO', titulo: 'Pedido recebido', etapa: 0 };
}

// ── Rota ────────────────────────────────────────────────────

router.get('/:token', limitarTaxa, async (req, res) => {
  const token = String(req.params.token || '').trim();

  // Formato conhecido: 32 hexadecimais. Descarta lixo antes do banco.
  if (!/^[0-9a-f]{32}$/i.test(token)) {
    return res.status(404).json({ erro: 'Rastreio não encontrado.' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT e.numnota,
              e.nomeparc, e.razaosocial,
              e.endereco, e.numend, e.nomebairro, e.cidade, e.estado,
              e.latitude, e.longitude,
              e.ordemcarga, e.data_entrega,
              e.dtinicial_entrega, e.checkindh, e.assinadodh, e.checkoutdh,
              e.ad_apprecebedor,
              e.logistica,
              r.motorista,
              emp.nomefantasia, emp.razaosocial AS emp_razaosocial,
              emp.emailcontato, emp.cidade AS emp_cidade
         FROM public.entregas e
         LEFT JOIN public.romaneios r  ON r.ocromaneio = e.ordemcarga
         LEFT JOIN public.empresas emp ON emp.codemp   = e.codemp
        WHERE e.token_rastreio = $1
        LIMIT 1`,
      [token]
    );

    if (rows.length === 0) {
      return res.status(404).json({ erro: 'Rastreio não encontrado.' });
    }

    const e = rows[0];

    // Expiração: o link some algum tempo depois de entregue.
    if (e.checkoutdh) {
      const fim = new Date(e.checkoutdh);
      const limite = new Date(fim.getTime() + DIAS_VALIDADE * 86400000);
      if (new Date() > limite) {
        return res.status(410).json({
          erro: 'Este link de rastreio expirou.',
          expirado: true,
        });
      }
    }

    const s = situacao(e);

    // ── Payload público ─────────────────────────────────────
    // Compare com o SELECT acima: telefone, cgccpf, vlrnota e
    // chavenfe NÃO entram aqui. Foram lidos apenas o que é usado.
    return res.json({
      pedido: {
        numero: e.numnota,
        destinatario: nomeAbreviado(e.nomeparc || e.razaosocial),
        observacao: e.logistica || null,
      },

      remetente: {
        nome: e.nomefantasia || e.emp_razaosocial || '',
        email: e.emailcontato || null,
        cidade: e.emp_cidade || null,
      },

      endereco: {
        logradouro: [e.endereco, e.numend].filter(Boolean).join(', '),
        bairro: e.nomebairro || '',
        cidade: e.cidade || '',
        estado: e.estado || '',
        latitude: e.latitude ? Number(e.latitude) : null,
        longitude: e.longitude ? Number(e.longitude) : null,
      },

      situacao: s,

      previsao: e.data_entrega,

      // Só os eventos já ocorridos. A tela desenha o restante
      // como etapas futuras.
      eventos: [
        { codigo: 'SAIU', titulo: 'Saiu para entrega', data: e.dtinicial_entrega },
        { codigo: 'CHEGOU', titulo: 'Entregador no local', data: e.checkindh },
        { codigo: 'ASSINOU', titulo: 'Comprovante assinado', data: e.assinadodh },
        { codigo: 'CONCLUIU', titulo: 'Entrega concluída', data: e.checkoutdh },
      ].filter((ev) => ev.data),

      entregue: e.checkoutdh
        ? {
            data: e.checkoutdh,
            recebedor: nomeAbreviado(e.ad_apprecebedor),
          }
        : null,

      motorista: e.motorista ? nomeAbreviado(e.motorista) : null,
    });
  } catch (err) {
    console.error('[rastreio]', err);
    return res.status(500).json({ erro: 'Erro ao consultar o rastreio.' });
  }
});

module.exports = router;
