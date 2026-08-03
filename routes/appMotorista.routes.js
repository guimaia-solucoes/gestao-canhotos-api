// ============================================================
//  routes/appMotorista.routes.js
//  API do aplicativo do motorista — Entrega Fácil
// ============================================================
//
//  GET /api/app/sincronizar[?dias=7]
//      → romaneios e entregas do motorista logado
//
//  Registro no index.js:
//    const appMotoristaRoutes = require('./routes/appMotorista.routes');
//    app.use('/api/app', appMotoristaRoutes);
//
//  Um endpoint só, e não dois: em conexão de campo cada
//  round-trip é uma chance de falhar no meio da sincronização
//  e deixar o celular com romaneio sem entrega.
// ============================================================

const express = require('express');
const router = express.Router();

const pool = require('../db/pool');
const { authMiddleware } = require('../middleware/auth.middleware');

/**
 * Recusa token da web. Sem isso, um token de gestão com codusu 5
 * seria lido aqui como codmotorista 5 — pessoas diferentes.
 */
function exigirMotorista(req, res, next) {
  if (req.usuario?.tipo !== 'MOTORISTA') {
    return res.status(403).json({
      success: false,
      message: 'Acesso restrito ao aplicativo do motorista.',
    });
  }
  next();
}

router.use(authMiddleware, exigirMotorista);

// ── Sincronização ───────────────────────────────────────────

router.get('/sincronizar', async (req, res) => {
  const codmotorista = Number(req.usuario.codmotorista);
  const codconta = Number(req.usuario.codconta);

  // Janela de dias para trás. Equivale à preferência
  // QTDDIASOCAPP do Sankhya.
  const dias = Math.min(Math.max(Number(req.query.dias) || 7, 0), 60);

  const client = await pool.connect();
  try {
    // Confere se o cadastro segue ativo. O token vale 30 dias;
    // sem esta checagem, um motorista desligado continuaria
    // baixando cargas até o token expirar.
    const { rows: mot } = await client.query(
      `SELECT codmotorista, nomecomp, nomeusu, ativo
         FROM public.motoristas
        WHERE codmotorista = $1
          AND codconta = $2
          AND dhexclusao IS NULL
        LIMIT 1`,
      [codmotorista, codconta]
    );

    if (mot.length === 0) {
      return res.status(403).json({
        success: false,
        code: 'MOTORISTA_REMOVIDO',
        message: 'Cadastro não encontrado. Procure o responsável.',
      });
    }

    const ativo = ['s', 'sim', 'true', '1', 'ativo']
      .includes((mot[0].ativo || '').toLowerCase());

    if (!ativo) {
      return res.status(403).json({
        success: false,
        code: 'MOTORISTA_INATIVO',
        message: 'Cadastro inativo. Procure o responsável.',
      });
    }

    // ── Romaneios ───────────────────────────────────────────
    const { rows: romaneios } = await client.query(
      `SELECT r.ocromaneio, r.codemp, r.data_entregasaida, r.data_criacao,
              r.status, r.obs, r.kmest, r.duracaoest, r.coordenadas,
              COALESCE(r.qtdentregas, 0)    AS qtdentregas,
              COALESCE(r.qtdfinalizadas, 0) AS qtdfinalizadas,
              COALESCE(v.placa, '')         AS placa,
              TRIM(COALESCE(v.marca, '') || ' ' || COALESCE(v.modelo, '')) AS veiculo,
              COALESCE(e.nomefantasia, e.razaosocial, '') AS empresa_nome,
              COALESCE(e.latitude, 0)  AS empresa_latitude,
              COALESCE(e.longitude, 0) AS empresa_longitude
         FROM public.romaneios r
         LEFT JOIN public.veiculos v ON v.codveiculo = r.codveiculo
         LEFT JOIN public.empresas e ON e.codemp     = r.codemp
        WHERE r.codmotorista = $1
          AND r.data_entregasaida >= (CURRENT_DATE - $2::int)
        ORDER BY r.data_entregasaida DESC, r.ocromaneio DESC`,
      [codmotorista, dias]
    );

    // ── Entregas ────────────────────────────────────────────
    // Vínculo por codemp + ordemcarga: sem o codemp, duas
    // empresas com a mesma numeração de OC misturariam cargas.
    const { rows: entregas } = await client.query(
      `SELECT e.id, e.codemp, e.ordemcarga, e.numnota, e.tipodoc,
              e.chavenfe, e.vlrnota, e.cgccpf,
              COALESCE(e.razaosocial, e.nomeparc, '') AS razaosocial,
              COALESCE(e.nomeparc, '')   AS nomeparc,
              COALESCE(e.endereco, '')   AS endereco,
              COALESCE(e.numend, '')     AS numend,
              COALESCE(e.nomebairro, '') AS nomebairro,
              COALESCE(e.cidade, '')     AS cidade,
              COALESCE(e.estado, '')     AS estado,
              COALESCE(e.telefone, '')   AS telefone,
              COALESCE(e.latitude, 0)    AS latitude,
              COALESCE(e.longitude, 0)   AS longitude,
              COALESCE(e.seqcarga, 0)    AS seqcarga,
              COALESCE(e.logistica, '')  AS logistica,
              e.data_entrega, e.dtinicial_entrega,
              e.checkindh, e.checkoutdh, e.assinadodh,
              e.checkinlatitude, e.checkinlongitude,
              e.assinaturalatitude, e.assinaturalongitude,
              COALESCE(e.assinado, '')               AS assinado,
              COALESCE(e.ad_apprecebedor, '')        AS ad_apprecebedor,
              COALESCE(e.ad_appdocrecebedor, '')     AS ad_appdocrecebedor,
              COALESCE(e.ad_apptipdocrecebedor, '')  AS ad_apptipdocrecebedor,
              e.token_rastreio
         FROM public.entregas e
         JOIN public.romaneios r
              ON r.ocromaneio = e.ordemcarga
             AND r.codemp     = e.codemp
        WHERE r.codmotorista = $1
          AND r.data_entregasaida >= (CURRENT_DATE - $2::int)
        ORDER BY e.ordemcarga, COALESCE(e.seqcarga, 0), e.id`,
      [codmotorista, dias]
    );

    // ── Catálogo de ocorrências ─────────────────────────────
    // Vai junto porque o motorista precisa dele offline, na hora
    // de registrar um problema sem sinal.
    let ocorrencias = [];
    try {
      const r = await client.query(
        `SELECT codocor, COALESCE(descricao, tipo, '') AS descricao
           FROM public.ocorrencias
          ORDER BY 2`
      );
      ocorrencias = r.rows;
    } catch (_) {
      // Nome de coluna diferente no catálogo: segue sem ele em
      // vez de derrubar a sincronização inteira.
      ocorrencias = [];
    }

    return res.json({
      success: true,
      sincronizado_em: new Date().toISOString(),
      motorista: {
        codmotorista: mot[0].codmotorista,
        nome: mot[0].nomecomp || mot[0].nomeusu,
      },
      romaneios,
      entregas,
      ocorrencias,
      totais: {
        romaneios: romaneios.length,
        entregas: entregas.length,
      },
    });
  } catch (err) {
    console.error('[app/sincronizar]', err);
    return res.status(500).json({
      success: false,
      message: 'Erro ao buscar os dados. Tente novamente.',
    });
  } finally {
    client.release();
  }
});


// -- Envio de informações
router.post('/enviar', async (req, res) => {
  const codmotorista = Number(req.usuario.codmotorista);
  const codconta = Number(req.usuario.codconta);

  const entregas = Array.isArray(req.body.entregas) ? req.body.entregas : [];
  const ocorrencias = Array.isArray(req.body.ocorrencias)
    ? req.body.ocorrencias : [];

  const resultado = {
    entregas: { ok: [], erro: [] },
    ocorrencias: { ok: [], erro: [] },
  };

  const client = await pool.connect();
  try {
    // ── Entregas ────────────────────────────────────────────
    //
    // Cada uma em sua própria transação, e não o lote inteiro
    // numa só: se a entrega 3 falhar por dado inválido, as
    // outras 20 já enviadas não podem voltar atrás — o motorista
    // teria de refazer tudo.
    for (const e of entregas) {
      const id = Number(e.id);
      if (!Number.isInteger(id) || id <= 0) {
        resultado.entregas.erro.push({ id: e.id, motivo: 'id inválido' });
        continue;
      }

      try {
        await client.query('BEGIN');

        // Monta update dinâmico: o app manda só o que mudou.
        const campos = [];
        const valores = [];
        let i = 1;

        const permitidos = [
          'dtinicial_entrega', 'checkindh', 'checkinlatitude',
          'checkinlongitude', 'assinadodh', 'assinado', 'assinatura',
          'ad_apprecebedor', 'ad_appdocrecebedor', 'ad_apptipdocrecebedor',
          'assinaturalatitude', 'assinaturalongitude', 'checkoutdh',
          'latitude', 'longitude',
        ];

        for (const campo of permitidos) {
          if (e[campo] !== undefined) {
            campos.push(`${campo} = $${i++}`);
            valores.push(e[campo] === '' ? null : e[campo]);
          }
        }

        if (campos.length === 0) {
          await client.query('ROLLBACK');
          resultado.entregas.erro.push({ id, motivo: 'nada a atualizar' });
          continue;
        }

        valores.push(id);
        valores.push(codmotorista);

        // O JOIN com romaneios é a trava de segurança: o
        // motorista só altera entrega de carga que é dele.
        const { rowCount } = await client.query(
          `UPDATE public.entregas e
              SET ${campos.join(', ')}
            WHERE e.id = $${i}
              AND EXISTS (
                SELECT 1 FROM public.romaneios r
                 WHERE r.ocromaneio = e.ordemcarga
                   AND r.codemp     = e.codemp
                   AND r.codmotorista = $${i + 1}
              )`,
          valores
        );

        if (rowCount === 0) {
          await client.query('ROLLBACK');
          resultado.entregas.erro.push({
            id, motivo: 'entrega não encontrada ou não pertence ao motorista',
          });
          continue;
        }

        await client.query('COMMIT');
        resultado.entregas.ok.push(id);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[app/enviar] entrega', id, err.message);
        resultado.entregas.erro.push({ id, motivo: err.message });
      }
    }

    // ── Ocorrências ─────────────────────────────────────────
    for (const o of ocorrencias) {
      const token = String(o.token_local || '').trim();
      const idEntrega = Number(o.id_entrega);

      if (!token) {
        resultado.ocorrencias.erro.push({
          token_local: o.token_local, motivo: 'token_local ausente',
        });
        continue;
      }

      try {
        await client.query('BEGIN');

        // Confere o vínculo antes de inserir.
        const { rows: dono } = await client.query(
          `SELECT e.id, e.codemp, e.numnota, e.ordemcarga
             FROM public.entregas e
             JOIN public.romaneios r
                  ON r.ocromaneio = e.ordemcarga
                 AND r.codemp     = e.codemp
            WHERE e.id = $1
              AND r.codmotorista = $2
            LIMIT 1`,
          [idEntrega, codmotorista]
        );

        if (dono.length === 0) {
          await client.query('ROLLBACK');
          resultado.ocorrencias.erro.push({
            token_local: token, motivo: 'entrega não pertence ao motorista',
          });
          continue;
        }

        const ent = dono[0];

        // ON CONFLICT DO NOTHING no token: reenviar depois de um
        // timeout não cria ocorrência duplicada. O `seq` fica a
        // cargo da trigger que já existe na tabela.
        await client.query(
          `INSERT INTO public.entregas_ocorrencias
             (id, codemp, codusuinc, dhocor, descrocor, codocor,
              numnota, ordemcarga, token_local)
           VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (token_local) DO NOTHING`,
          [
            ent.id,
            ent.codemp,
            o.dhocor || new Date().toISOString(),
            o.descrocor || null,
            Number(o.codocor) || null,
            ent.numnota,
            ent.ordemcarga,
            token,
          ]
        );

        await client.query('COMMIT');
        resultado.ocorrencias.ok.push(token);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[app/enviar] ocorrência', token, err.message);
        resultado.ocorrencias.erro.push({
          token_local: token, motivo: err.message,
        });
      }
    }

    return res.json({
      success: true,
      recebido_em: new Date().toISOString(),
      ...resultado,
    });
  } catch (err) {
    console.error('[app/enviar]', err);
    return res.status(500).json({
      success: false,
      message: 'Erro ao receber os dados.',
    });
  } finally {
    client.release();
  }
});

module.exports = router;
