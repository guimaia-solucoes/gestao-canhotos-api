const express = require('express');
const cors = require('cors');
const pool = require('./db/pool');

const nfeImportRoutes = require("./routes/nfeImport.routes");
const danfeService = require('./danfe.service');
const { buscarLatLongComDelay } = require('./services/geocoding.service');
const authRoutes = require('./routes/auth.routes');
const { authMiddleware } = require('./middleware/auth.middleware');
const {
  escopoMiddleware,
  empresasFiltradas,
  ehAdmin,
  exigirEscrita,
} = require('./middleware/escopo.middleware');
const dashboardRoutes = require('./routes/dashboard.routes');
const comprovanteRoutes = require('./routes/comprovante.routes');
const rastreioRoutes = require('./routes/rastreio.routes');
const logoRoutes = require('./routes/logo.routes');
const romaneioPdfRoutes = require('./routes/romaneioPdf.routes');
const appMotoristaRoutes = require('./routes/appMotorista.routes');
const comprovacaoRoutes = require('./routes/comprovacao.routes');
const ocorrenciasRoutes = require('./routes/ocorrencias.routes');

const app = express();

const { execSync } = require('child_process');
const http = require('http');

try {
  execSync(
    '/mise/installs/python/3.11.15/bin/python3 -m pip install reportlab --quiet',
    { stdio: 'inherit' }
  );
  console.log('[startup] reportlab OK');
} catch (e) {
  console.error('[startup] erro ao instalar reportlab:', e.message);
}

app.use(cors({
  origin: '*', // depois a gente restringe
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use("/api", nfeImportRoutes);
app.use('/api/dashboard', dashboardRoutes);
danfeService.registerRoutes(app);
app.use('/api/comprovante', comprovanteRoutes);
app.use('/api/rastreio', rastreioRoutes);
app.use('/api/empresas', logoRoutes);
app.use('/api/romaneio-pdf', romaneioPdfRoutes);
app.use('/api/app', appMotoristaRoutes);
app.use('/api/comprovacoes', comprovacaoRoutes);
app.use('/api/ocorrencias', ocorrenciasRoutes);


const PORT = process.env.PORT || 3000;

// ============================================================
//  HELPERS DE ESCOPO
// ============================================================

/**
 * Valida que a empresa informada no body pertence ao escopo do
 * usuário. Este é o ponto crítico do modelo multiempresa: na
 * escrita o codemp vem do cliente, então sem esta checagem
 * alguém forja o número e grava na conta de outro.
 *
 * Devolve o codemp validado, ou null (já tendo respondido 403).
 */
function empresaDoBody(req, res) {
  const codemp = Number(req.body.codemp);

  if (!Number.isInteger(codemp) || codemp <= 0) {
    res.status(400).json({ error: 'codemp é obrigatório.' });
    return null;
  }

  if (!req.escopo.empresas.includes(codemp)) {
    res.status(403).json({ error: 'Empresa não permitida para este usuário.' });
    return null;
  }

  return codemp;
}

/**
 * Para motoristas e veículos: codemp pode vir nulo, significando
 * "compartilhado com todas as empresas da conta".
 */
function empresaOpcionalDoBody(req, res) {
  const bruto = req.body.codemp;

  if (bruto === undefined || bruto === null || bruto === '') {
    return { ok: true, codemp: null };
  }

  const codemp = Number(bruto);
  if (!req.escopo.empresas.includes(codemp)) {
    res.status(403).json({ error: 'Empresa não permitida para este usuário.' });
    return { ok: false };
  }

  return { ok: true, codemp };
}

// ============================================================
//  HEALTH
// ============================================================

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', database: 'disconnected' });
  }
});

// ============================================================
//  USUÁRIOS
// ============================================================

app.post('/usuarios', authMiddleware, escopoMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const { nomeusu, senha, email, ativo, nomecomp } = req.body;
    const perfil = req.body.perfil || 'OPERADOR';

    const codemp = empresaDoBody(req, res);
    if (!codemp) return;

    if (!nomeusu || !senha) {
      return res.status(400).json({ error: 'nomeusu e senha são obrigatórios' });
    }

    if (!ehAdmin(req, codemp)) {
      return res.status(403).json({
        error: 'Apenas administradores podem criar usuários.',
      });
    }

    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO usuarios (codemp, codconta, nomeusu, senha, email, ativo, nomecomp)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING codusu, codemp, codconta, nomeusu, email, ativo, nomecomp, dhinclusao`,
      [
        codemp,
        req.escopo.codconta,
        nomeusu,
        senha,
        email || null,
        ativo || 'S',
        nomecomp || null,
      ]
    );

    const novo = rows[0];

    // Sem esta linha o usuário loga e leva 403: o acesso mora
    // em usuarios_empresas, não em usuarios.codemp.
    await client.query(
      `INSERT INTO public.usuarios_empresas (codusu, codemp, perfil)
       VALUES ($1, $2, $3)`,
      [novo.codusu, codemp, perfil]
    );

    await client.query('COMMIT');
    return res.status(201).json(novo);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Erro ao criar usuário:', error);
    return res.status(500).json({ error: 'Erro interno ao criar usuário' });
  } finally {
    client.release();
  }
});

app.get('/usuarios', authMiddleware, escopoMiddleware, async (req, res) => {
  try {
    const empresas = empresasFiltradas(req);

    // DISTINCT porque um usuário pode ter acesso a várias empresas
    // e apareceria repetido no join.
    const sql = `
      SELECT DISTINCT u.codusu, u.codemp, u.nomeusu, u.email, u.ativo,
             u.nomecomp, u.dhinclusao
        FROM public.usuarios u
        JOIN public.usuarios_empresas ue ON ue.codusu = u.codusu
       WHERE u.dhexclusao IS NULL
         AND ue.codemp = ANY($1::int[])
       ORDER BY u.codusu
    `;

    const result = await pool.query(sql, [empresas]);
    return res.json(result.rows);
  } catch (error) {
    console.error('Erro ao listar usuários:', error);
    return res.status(500).json({ error: 'Erro interno ao listar usuários' });
  }
});

app.get('/usuarios/:codusu', authMiddleware, escopoMiddleware, async (req, res) => {
  try {
    const codusu = Number(req.params.codusu);
    if (!Number.isInteger(codusu) || codusu <= 0) {
      return res.status(400).json({ error: 'codusu inválido' });
    }

    const empresas = empresasFiltradas(req);

    const result = await pool.query(
      `SELECT DISTINCT u.codusu, u.codemp, u.nomeusu, u.email, u.ativo,
              u.nomecomp, u.dhinclusao
         FROM public.usuarios u
         JOIN public.usuarios_empresas ue ON ue.codusu = u.codusu
        WHERE u.codusu = $1
          AND ue.codemp = ANY($2::int[])
        LIMIT 1`,
      [codusu, empresas]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    return res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao buscar usuário:', error);
    return res.status(500).json({ error: 'Erro interno ao buscar usuário' });
  }
});

app.put('/usuarios/:codusu', authMiddleware, escopoMiddleware, async (req, res) => {
  try {
    const codusu = Number(req.params.codusu);
    if (!Number.isInteger(codusu) || codusu <= 0) {
      return res.status(400).json({ error: 'codusu inválido' });
    }

    const empresas = empresasFiltradas(req);
    const { nomeusu, senha, email, ativo, nomecomp, dhexclusao } = req.body;

    // codemp só muda se a nova empresa estiver no escopo.
    let novoCodemp;
    if (req.body.codemp !== undefined) {
      novoCodemp = empresaDoBody(req, res);
      if (!novoCodemp) return;
    }

    const fields = [];
    const values = [];
    let idx = 1;

    if (novoCodemp !== undefined) { fields.push(`codemp = $${idx++}`); values.push(novoCodemp); }
    if (nomeusu !== undefined) { fields.push(`nomeusu = $${idx++}`); values.push(nomeusu); }
    if (senha !== undefined) { fields.push(`senha = $${idx++}`); values.push(senha); }
    if (email !== undefined) { fields.push(`email = $${idx++}`); values.push(email); }
    if (ativo !== undefined) { fields.push(`ativo = $${idx++}`); values.push(ativo); }
    if (nomecomp !== undefined) { fields.push(`nomecomp = $${idx++}`); values.push(nomecomp); }
    if (dhexclusao !== undefined) { fields.push(`dhexclusao = $${idx++}`); values.push(dhexclusao); }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    }

    values.push(codusu);
    values.push(empresas);

    // O EXISTS impede alterar usuário de outra conta passando o id na URL.
    const sql = `
      UPDATE public.usuarios u
         SET ${fields.join(', ')}
       WHERE u.codusu = $${idx}
         AND EXISTS (
           SELECT 1 FROM public.usuarios_empresas ue
            WHERE ue.codusu = u.codusu
              AND ue.codemp = ANY($${idx + 1}::int[])
         )
      RETURNING codusu, codemp, nomeusu, email, ativo, nomecomp, dhinclusao, dhexclusao
    `;

    const result = await pool.query(sql, values);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    return res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao atualizar usuário:', error);
    return res.status(500).json({ error: 'Erro interno ao atualizar usuário' });
  }
});

// ============================================================
//  ENTREGAS
// ============================================================

app.post('/entregas', authMiddleware, escopoMiddleware, async (req, res) => {
  try {
    const codemp = empresaDoBody(req, res);
    if (!codemp) return;
    if (!exigirEscrita(req, res, codemp)) return;

    const {
      ordemcarga, numnota, cgccpf, endereco, numend, cidade, estado, chavenfe,
      vlrnota, nomeparc, razaosocial, nomebairro, telefone, dtinicial_entrega,
      assinado, checkinlatitude, checkinlongitude, checkindh, checkoutdh,
      assinadodh, latitude, longitude, logistica, assinatura, ad_apprecebedor,
      ad_appdocrecebedor, ad_apptipdocrecebedor, assinaturalatitude,
      assinaturalongitude, seqcarga, tipodoc, codmotorista, status, data_entrega,
    } = req.body;

    const sql = `
      INSERT INTO entregas (
        codemp, ordemcarga, numnota, cgccpf, endereco, numend, cidade, estado,
        chavenfe, vlrnota, nomeparc, razaosocial, nomebairro, telefone,
        dtinicial_entrega, assinado, checkinlatitude, checkinlongitude, checkindh,
        checkoutdh, assinadodh, latitude, longitude, logistica, assinatura,
        ad_apprecebedor, ad_appdocrecebedor, ad_apptipdocrecebedor,
        assinaturalatitude, assinaturalongitude, seqcarga, tipodoc, codmotorista,
        status, data_entrega, codusuinclusao
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
              $20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36)
      RETURNING id, codemp, ordemcarga, numnota, data_entrega
    `;

    const params = [
      codemp, ordemcarga, numnota, cgccpf, endereco, numend, cidade, estado,
      chavenfe, vlrnota, nomeparc, razaosocial, nomebairro, telefone,
      dtinicial_entrega, assinado, checkinlatitude, checkinlongitude, checkindh,
      checkoutdh, assinadodh, latitude, longitude, logistica, assinatura,
      ad_apprecebedor, ad_appdocrecebedor, ad_apptipdocrecebedor,
      assinaturalatitude, assinaturalongitude, seqcarga, tipodoc, codmotorista,
      status, data_entrega, req.usuario?.codusu ?? null,
    ];

    const result = await pool.query(sql, params);
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao criar entrega:', {
      message: error.message, code: error.code, detail: error.detail,
      constraint: error.constraint, column: error.column,
    });
    return res.status(500).json({
      error: 'Erro interno ao criar entrega',
      pg: { message: error.message, detail: error.detail },
    });
  }
});

app.get('/entregas', authMiddleware, escopoMiddleware, async (req, res) => {
  try {
    const empresas = empresasFiltradas(req);

    const sql = `
      SELECT e.id, e.codemp, e.ordemcarga, e.numnota, e.cgccpf, e.endereco,
             e.numend, e.cidade, e.estado, e.chavenfe, e.vlrnota, e.nomeparc,
             e.razaosocial, e.nomebairro, e.telefone, e.dtinicial_entrega,
             e.assinado, e.checkinlatitude, e.checkinlongitude, e.checkindh,
             e.checkoutdh, e.assinadodh,
             COALESCE(e.latitude, 0)  AS latitude,
             COALESCE(e.longitude, 0) AS longitude,
             e.logistica, e.assinatura, e.ad_apprecebedor, e.ad_appdocrecebedor,
             e.ad_apptipdocrecebedor, e.assinaturalatitude, e.assinaturalongitude,
             COALESCE(e.seqcarga, 0) AS seqcarga,
             e.tipodoc, e.codmotorista, e.status, e.data_entrega,
             emp.nomefantasia AS empresa_nome, e.token_rastreio ,
			 (select mot.nomeusu from public.romaneios rom, public.motoristas mot where rom.codemp = e.codemp and rom.ocromaneio = e.ordemcarga and rom.codmotorista = mot.codmotorista) as motorista,
			 (select vei.placa from public.romaneios rom, public.veiculos vei where rom.codemp = e.codemp and rom.ocromaneio = e.ordemcarga and rom.codveiculo = vei.codveiculo) as veiculo,
             e.cep			 
        FROM public.entregas e
        JOIN public.empresas emp ON emp.codemp = e.codemp
       WHERE e.codemp = ANY($1::int[])
       ORDER BY e.id DESC
    `;

    const result = await pool.query(sql, [empresas]);
    return res.json(result.rows);
  } catch (error) {
    console.error('Erro ao listar entregas:', error);
    return res.status(500).json({ error: 'Erro interno ao listar entregas' });
  }
});

app.post('/entregas/importar-csv', authMiddleware, escopoMiddleware, async (req, res) => {
  try {
    const codemp = empresaDoBody(req, res);
    if (!codemp) return;
    if (!exigirEscrita(req, res, codemp)) return;

    const {
      ordemcarga, numnota, cgccpf, endereco, numend, cidade, estado, chavenfe,
      vlrnota, nomeparc, razaosocial, nomebairro, telefone, latitude, longitude,
      logistica, data_entrega,
    } = req.body;

    const sql = `
      INSERT INTO entregas (
        codemp, codusuinclusao, ordemcarga, numnota, cgccpf, endereco, numend,
        cidade, estado, chavenfe, vlrnota, nomeparc, razaosocial, nomebairro,
        telefone, latitude, longitude, logistica, data_entrega
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      RETURNING id
    `;

    const params = [
      codemp,
      req.usuario?.codusu ?? null,
      ordemcarga || null, numnota || null, cgccpf || null, endereco || null,
      numend || null, cidade || null, estado || null, chavenfe || null,
      vlrnota ? Number(vlrnota) : null,
      nomeparc || null, razaosocial || null, nomebairro || null, telefone || null,
      latitude ? Number(latitude) : null,
      longitude ? Number(longitude) : null,
      logistica || null, data_entrega || null,
    ];

    const { rows } = await pool.query(sql, params);
    return res.status(201).json({ id: rows[0].id });
  } catch (error) {
    return res.status(500).json({ error: 'Erro ao importar entrega', detail: error.message });
  }
});

app.put('/entregas/:id', authMiddleware, escopoMiddleware, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Id. da entrega é inválida' });
    }

    const empresas = empresasFiltradas(req);
    const { ordemcarga, seqcarga, data_entrega } = req.body;

    const fields = [];
    const values = [];
    let idx = 1;

    if (ordemcarga !== undefined) {
      fields.push(`ordemcarga = $${idx++}`);
      values.push(ordemcarga);

      // Herda a data prevista do romaneio quando o body não a trouxe.
      // COALESCE protege: OC sem data não apaga a data já existente.
      if (data_entrega === undefined) {
        fields.push(`data_entrega = COALESCE(
          (SELECT r.data_entregasaida FROM public.romaneios r
            WHERE r.ocromaneio = $${idx}
              AND r.codemp = ANY($${idx + 1}::int[])),
          data_entrega
        )`);
        values.push(ordemcarga);
        values.push(empresas);
        idx += 2;
      }
    }

    if (seqcarga !== undefined) {
      fields.push(`seqcarga = $${idx++}`);
      values.push(seqcarga);
    }

    if (data_entrega !== undefined) {
      fields.push(`data_entrega = $${idx++}`);
      values.push(data_entrega);
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    }

    values.push(id);
    values.push(empresas);

    const sql = `
      UPDATE public.entregas
         SET ${fields.join(', ')}
       WHERE id = $${idx}
         AND codemp = ANY($${idx + 1}::int[])
      RETURNING id, ordemcarga, seqcarga, data_entrega
    `;

    const result = await pool.query(sql, values);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Entrega não encontrada' });
    }
    return res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao atualizar entrega:', {
      message: error.message, code: error.code, detail: error.detail,
    });
    return res.status(500).json({
      error: 'Erro interno ao atualizar entrega',
      detail: error.message,
    });
  }
});

app.post('/entregas/geocodificar/:ordemcarga', authMiddleware, escopoMiddleware, async (req, res) => {
  const { ordemcarga } = req.params;
  try {
    const empresas = empresasFiltradas(req);

    const { rows } = await pool.query(
      `SELECT id, endereco, numend, nomebairro, cidade, estado
         FROM public.entregas
        WHERE ordemcarga = $1
          AND codemp = ANY($2::int[])
          AND (latitude IS NULL OR longitude IS NULL)`,
      [ordemcarga, empresas]
    );

    if (rows.length === 0) {
      return res.json({ ok: true, msg: 'Nenhuma entrega para geocodificar.', total: 0 });
    }

    let sucesso = 0;
    let semResultado = 0;

    for (const entrega of rows) {
      const { latitude, longitude } = await buscarLatLongComDelay(
        entrega.endereco, entrega.numend, entrega.nomebairro,
        entrega.cidade, entrega.estado
      );

      if (latitude && longitude) {
        await pool.query(
          `UPDATE public.entregas SET latitude = $1, longitude = $2
            WHERE id = $3 AND codemp = ANY($4::int[])`,
          [latitude, longitude, entrega.id, empresas]
        );
        sucesso++;
      } else {
        semResultado++;
      }
    }

    return res.json({ ok: true, total: rows.length, sucesso, semResultado });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================
//  ROMANEIOS / ORDENS DE CARGA
// ============================================================

app.post('/romaneios', authMiddleware, escopoMiddleware, async (req, res) => {
  try {
    const codemp = empresaDoBody(req, res);
    if (!codemp) return;
    if (!exigirEscrita(req, res, codemp)) return;

    const { data_entregasaida, codmotorista, codveiculo } = req.body;

    const result = await pool.query(
      `INSERT INTO romaneios (codemp, data_entregasaida, codmotorista, codveiculo)
       VALUES ($1, $2, $3, $4)
       RETURNING ocromaneio`,
      [codemp, data_entregasaida, codmotorista, codveiculo]
    );

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao criar romaneio:', {
      message: error.message, code: error.code, detail: error.detail,
    });
    return res.status(500).json({
      error: 'Erro interno ao criar romaneio',
      pg: { message: error.message, detail: error.detail },
    });
  }
});

app.get('/romaneios', authMiddleware, escopoMiddleware, async (req, res) => {
  try {
    const empresas = empresasFiltradas(req);

    const sql = `
      SELECT r.ocromaneio, r.codemp, r.data_criacao, r.data_entregasaida,
             r.motorista, r.duracaoest, r.kmest, r.status, r.qtdentregas,
             r.qtdfinalizadas, r.obs,
             emp.nomefantasia AS empresa_nome
        FROM public.romaneios r
        JOIN public.empresas emp ON emp.codemp = r.codemp
       WHERE r.codemp = ANY($1::int[])
       ORDER BY r.ocromaneio DESC
    `;

    const result = await pool.query(sql, [empresas]);
    return res.json(result.rows);
  } catch (error) {
    console.error('Erro ao listar romaneios:', error);
    return res.status(500).json({ error: 'Erro interno ao listar romaneios' });
  }
});

app.get('/romaneios/roteiro/:oc', authMiddleware, escopoMiddleware, async (req, res) => {
  try {
    const oc = Number(req.params.oc);
    if (!Number.isInteger(oc) || oc <= 0) {
      return res.status(400).json({ error: 'Ordem de Carga inválida' });
    }

    const empresas = empresasFiltradas(req);

    const sql = `
      SELECT id, codemp, ordemcarga, numnota, cgccpf, endereco, numend, cidade,
             estado, chavenfe, vlrnota, nomeparc, razaosocial, nomebairro,
             telefone, dtinicial_entrega, assinado, checkinlatitude,
             checkinlongitude, checkindh, checkoutdh, assinadodh,
             COALESCE(latitude, 0)  AS latitude,
             COALESCE(longitude, 0) AS longitude,
             logistica, assinatura, ad_apprecebedor, ad_appdocrecebedor,
             ad_apptipdocrecebedor, assinaturalatitude, assinaturalongitude,
             COALESCE(seqcarga, 0) AS seqcarga,
             tipodoc, codmotorista, status, data_entrega
        FROM public.entregas
       WHERE ordemcarga = $1
         AND codemp = ANY($2::int[])
       ORDER BY seqcarga, id
    `;

    const result = await pool.query(sql, [oc, empresas]);
    return res.json(result.rows);
  } catch (error) {
    console.error('Erro ao listar roteiro:', error);
    return res.status(500).json({ error: 'Erro interno ao listar roteiro' });
  }
});

app.post('/romaneios/geocodificar/:ordemcarga', authMiddleware, escopoMiddleware, async (req, res) => {
  const { ordemcarga } = req.params;
  try {
    const empresas = empresasFiltradas(req);

    const { rows } = await pool.query(
      `SELECT id, endereco, numend, nomebairro, cidade, estado
         FROM public.entregas
        WHERE ordemcarga = $1
          AND codemp = ANY($2::int[])
          AND (latitude IS NULL OR longitude IS NULL
               OR latitude = 0 OR longitude = 0)`,
      [ordemcarga, empresas]
    );

    if (rows.length === 0) {
      return res.json({ ok: true, msg: 'Nenhuma entrega para geocodificar.', total: 0 });
    }

    let sucesso = 0;
    let semResultado = 0;

    for (const entrega of rows) {
      const { latitude, longitude } = await buscarLatLongComDelay(
        entrega.endereco, entrega.numend, entrega.nomebairro,
        entrega.cidade, entrega.estado
      );

      if (latitude && longitude) {
        await pool.query(
          `UPDATE public.entregas SET latitude = $1, longitude = $2
            WHERE id = $3 AND codemp = ANY($4::int[])`,
          [latitude, longitude, entrega.id, empresas]
        );
        sucesso++;
      } else {
        semResultado++;
      }
    }

    return res.json({ ok: true, total: rows.length, sucesso, semResultado });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/romaneios/roteirizar/:ordemcarga', authMiddleware, escopoMiddleware, async (req, res) => {
  const { ordemcarga } = req.params;
  try {
    const empresas = empresasFiltradas(req);

    // 1) A origem é a empresa DO ROMANEIO, não a primeira da tabela.
    //    Com multiempresa, o LIMIT 1 anterior faria o roteiro sair
    //    do endereço da empresa errada.
    const { rows: origemRows } = await pool.query(
      `SELECT emp.latitude, emp.longitude
         FROM public.romaneios r
         JOIN public.empresas emp ON emp.codemp = r.codemp
        WHERE r.ocromaneio = $1
          AND r.codemp = ANY($2::int[])
        LIMIT 1`,
      [ordemcarga, empresas]
    );

    if (!origemRows.length) {
      return res.status(404).json({ ok: false, msg: 'Ordem de carga não encontrada.' });
    }
    if (!origemRows[0].latitude || !origemRows[0].longitude) {
      return res.status(400).json({ ok: false, msg: 'Endereço da empresa sem coordenadas.' });
    }

    const origem = {
      latitude: parseFloat(origemRows[0].latitude),
      longitude: parseFloat(origemRows[0].longitude),
    };

    // 2) Entregas da OC com coordenadas
    const { rows: entregas } = await pool.query(
      `SELECT id, latitude, longitude, nomeparc
         FROM public.entregas
        WHERE ordemcarga = $1
          AND codemp = ANY($2::int[])
          AND latitude IS NOT NULL AND latitude <> 0
          AND longitude IS NOT NULL AND longitude <> 0
        ORDER BY id`,
      [ordemcarga, empresas]
    );

    if (entregas.length === 0) {
      return res.status(400).json({
        ok: false,
        msg: 'Nenhuma entrega com coordenadas encontrada. Execute "Buscar Latitude/Longitude" primeiro.',
      });
    }

    // 3) origem + entregas + origem
    const todasCoordenadas = [
      origem,
      ...entregas.map((e) => ({
        latitude: parseFloat(e.latitude),
        longitude: parseFloat(e.longitude),
      })),
      origem,
    ];
    const coordStr = todasCoordenadas.map((c) => `${c.longitude},${c.latitude}`).join(';');

    // 4) OSRM Trip API
    const osrmUrl = `/trip/v1/driving/${coordStr}?source=first&destination=last&geometries=geojson`;
    const osrmResult = await new Promise((resolve, reject) => {
      http.get({ hostname: '134.122.113.67', port: 5000, path: osrmUrl, method: 'GET' },
        (osrmRes) => {
          let data = '';
          osrmRes.on('data', (chunk) => (data += chunk));
          osrmRes.on('end', () => {
            try { resolve(JSON.parse(data)); }
            catch { reject(new Error('Erro ao parsear resposta do OSRM')); }
          });
        }).on('error', reject);
    });

    if (osrmResult.code !== 'Ok') {
      return res.status(500).json({ ok: false, msg: `OSRM retornou erro: ${osrmResult.code}` });
    }

    // 5) seqcarga
    const waypoints = osrmResult.waypoints;
    for (let i = 0; i < entregas.length; i++) {
      const wp = waypoints[i + 1];
      if (!wp) continue;
      await pool.query(
        `UPDATE public.entregas SET seqcarga = $1
          WHERE id = $2 AND codemp = ANY($3::int[])`,
        [wp.waypoint_index, entregas[i].id, empresas]
      );
    }

    // 6) e 7) distância, duração e geometria
    const trip = osrmResult.trips[0];
    const distanciaKm = (trip.distance / 1000).toFixed(2) + ' km';
    const duracaoMin = Math.round(trip.duration / 60) + ' min';
    const coordenadas = JSON.stringify(trip.geometry.coordinates);

    await pool.query(
      `UPDATE public.romaneios
          SET kmest = $1, duracaoest = $2, coordenadas = $3
        WHERE ocromaneio = $4 AND codemp = ANY($5::int[])`,
      [distanciaKm, duracaoMin, coordenadas, ordemcarga, empresas]
    );

    return res.json({
      ok: true, total: entregas.length,
      kmest: distanciaKm, duracaoest: duracaoMin,
    });
  } catch (error) {
    console.error('[roteirizar]', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/romaneios/coordenada/:ordemcarga', authMiddleware, escopoMiddleware, async (req, res) => {
  const { ordemcarga } = req.params;
  try {
    const empresas = empresasFiltradas(req);

    const { rows } = await pool.query(
      `SELECT coordenadas, kmest, duracaoest, placa, motorista, status AS statusoc
         FROM public.romaneios
        WHERE ocromaneio = $1
          AND codemp = ANY($2::int[])`,
      [ordemcarga, empresas]
    );

    if (!rows.length) return res.json({ ok: false, coordenadas: null });

    return res.json({
      ok: true,
      coordenadas: rows[0].coordenadas,
      kmest: rows[0].kmest || '',
      duracaoest: rows[0].duracaoest || '',
      placa: rows[0].placa || '',
      motorista: rows[0].motorista || '',
      statusoc: rows[0].statusoc || '',
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.put('/romaneios/:ordemcarga', authMiddleware, escopoMiddleware, async (req, res) => {
  try {
    const ordemcarga = Number(req.params.ordemcarga);
    if (!Number.isInteger(ordemcarga) || ordemcarga <= 0) {
      return res.status(400).json({ error: 'Código da ordem de carga é inválido' });
    }

    const empresas = empresasFiltradas(req);
    const {
      data_entregasaida, motorista, duracaoest, kmest, status,
      qtdentregas, qtdfinalizadas, obs, coordenadas, codveiculo, codmotorista,
    } = req.body;

    const fields = [];
    const values = [];
    let idx = 1;

    if (data_entregasaida !== undefined) { fields.push(`data_entregasaida = $${idx++}`); values.push(data_entregasaida); }
    if (motorista !== undefined) { fields.push(`motorista = $${idx++}`); values.push(motorista); }
    if (duracaoest !== undefined) { fields.push(`duracaoest = $${idx++}`); values.push(duracaoest); }
    if (kmest !== undefined) { fields.push(`kmest = $${idx++}`); values.push(kmest); }
    if (status !== undefined) { fields.push(`status = $${idx++}`); values.push(status); }
    if (qtdentregas !== undefined) { fields.push(`qtdentregas = $${idx++}`); values.push(qtdentregas); }
    if (qtdfinalizadas !== undefined) { fields.push(`qtdfinalizadas = $${idx++}`); values.push(qtdfinalizadas); }
    if (obs !== undefined) { fields.push(`obs = $${idx++}`); values.push(obs); }
    if (coordenadas !== undefined) { fields.push(`coordenadas = $${idx++}`); values.push(coordenadas); }
    if (codveiculo !== undefined) { fields.push(`codveiculo = $${idx++}`); values.push(codveiculo); }
    if (codmotorista !== undefined) { fields.push(`codmotorista = $${idx++}`); values.push(codmotorista); }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    }

    values.push(ordemcarga);
    values.push(empresas);

    const sql = `
      UPDATE public.romaneios
         SET ${fields.join(', ')}
       WHERE ocromaneio = $${idx}
         AND codemp = ANY($${idx + 1}::int[])
      RETURNING ocromaneio, data_entregasaida, motorista, duracaoest, kmest,
                status, qtdentregas, qtdfinalizadas, obs, coordenadas,
                codveiculo, codmotorista
    `;

    const result = await pool.query(sql, values);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Ordem de carga não encontrada' });
    }

    // Propaga a data prevista para as entregas da OC. Sem isso, o
    // romaneio diz uma data e as entregas dizem outra, e o KPI de
    // atrasadas no dashboard passa a mentir.
    if (data_entregasaida !== undefined) {
      await pool.query(
        `UPDATE public.entregas
            SET data_entrega = $1
          WHERE ordemcarga = $2
            AND codemp = ANY($3::int[])`,
        [data_entregasaida, ordemcarga, empresas]
      );
    }

    return res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao atualizar a ordem de carga:', {
      message: error.message, code: error.code, detail: error.detail,
    });
    return res.status(500).json({
      error: 'Erro interno ao atualizar a ordem de carga',
      pg: { message: error.message, detail: error.detail },
    });
  }
});

// ============================================================
//  EMPRESAS
// ============================================================

app.get('/empresas', authMiddleware, escopoMiddleware, async (req, res) => {
  try {
    // Aqui usa req.escopo.empresas direto, não empresasFiltradas:
    // o seletor de empresa da tela precisa da lista completa para
    // poder filtrar as outras telas.
    const sql = `
      SELECT codemp, codconta, cnpj, razaosocial, nomefantasia, inscricaoestadual,
             emailcontato, emailfinanceiro, cep, endereco, numero, bairro, cidade,
             estado, complemento, dhinclusao, ativo, latitude, longitude, dhexclusao
        FROM public.empresas
       WHERE dhexclusao IS NULL
         AND codemp = ANY($1::int[])
       ORDER BY razaosocial
    `;

    const result = await pool.query(sql, [req.escopo.empresas]);
    return res.json(result.rows);
  } catch (error) {
    console.error('Erro ao listar empresas:', error);
    return res.status(500).json({ error: 'Erro interno ao listar empresas' });
  }
});

app.post('/empresas', authMiddleware, escopoMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!ehAdmin(req)) {
      return res.status(403).json({ error: 'Apenas administradores podem criar empresas.' });
    }

    const {
      cnpj, razaosocial, nomefantasia, inscricaoestadual, emailcontato,
      emailfinanceiro, cep, endereco, numero, bairro, cidade, estado,
      complemento, latitude, longitude,
    } = req.body;

    if (!cnpj || cnpj.length !== 14) {
      return res.status(400).json({ error: 'CNPJ deve possuir 14 caracteres.' });
    }

    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO empresas (codconta, cnpj, razaosocial, nomefantasia,
                             inscricaoestadual, emailcontato, emailfinanceiro,
                             cep, endereco, numero, bairro, cidade, estado,
                             complemento, latitude, longitude)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING codemp`,
      [
        req.escopo.codconta, cnpj, razaosocial, nomefantasia, inscricaoestadual,
        emailcontato, emailfinanceiro, cep, endereco, numero, bairro, cidade,
        estado, complemento, latitude, longitude,
      ]
    );

    const nova = rows[0];

    // Quem criou ganha acesso — senão a empresa nasce invisível
    // até alguém mexer direto no banco.
    await client.query(
      `INSERT INTO public.usuarios_empresas (codusu, codemp, perfil)
       VALUES ($1, $2, 'ADMIN')`,
      [req.usuario.codusu, nova.codemp]
    );

    await client.query('COMMIT');
    return res.status(201).json(nova);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Erro ao criar empresa:', {
      message: error.message, code: error.code, detail: error.detail,
    });
    return res.status(500).json({
      error: 'Erro interno ao criar empresa',
      pg: { message: error.message, detail: error.detail },
    });
  } finally {
    client.release();
  }
});

app.put('/empresas/:codemp', authMiddleware, escopoMiddleware, async (req, res) => {
  try {
    const codemp = Number(req.params.codemp);
    if (!Number.isInteger(codemp) || codemp <= 0) {
      return res.status(400).json({ error: 'Código da empresa inválido' });
    }

    if (!req.escopo.empresas.includes(codemp)) {
      return res.status(403).json({ error: 'Empresa não permitida para este usuário.' });
    }
    if (!ehAdmin(req, codemp)) {
      return res.status(403).json({ error: 'Apenas administradores podem alterar a empresa.' });
    }

    const {
      cnpj, razaosocial, nomefantasia, inscricaoestadual, emailcontato,
      emailfinanceiro, cep, endereco, numero, bairro, cidade, estado,
      complemento, latitude, longitude, dhexclusao,
    } = req.body;

    const fields = [];
    const values = [];
    let idx = 1;

    if (cnpj !== undefined) { fields.push(`cnpj = $${idx++}`); values.push(cnpj); }
    if (razaosocial !== undefined) { fields.push(`razaosocial = $${idx++}`); values.push(razaosocial); }
    if (nomefantasia !== undefined) { fields.push(`nomefantasia = $${idx++}`); values.push(nomefantasia); }
    if (inscricaoestadual !== undefined) { fields.push(`inscricaoestadual = $${idx++}`); values.push(inscricaoestadual); }
    if (emailcontato !== undefined) { fields.push(`emailcontato = $${idx++}`); values.push(emailcontato); }
    if (emailfinanceiro !== undefined) { fields.push(`emailfinanceiro = $${idx++}`); values.push(emailfinanceiro); }
    if (cep !== undefined) { fields.push(`cep = $${idx++}`); values.push(cep); }
    if (endereco !== undefined) { fields.push(`endereco = $${idx++}`); values.push(endereco); }
    if (numero !== undefined) { fields.push(`numero = $${idx++}`); values.push(numero); }
    if (bairro !== undefined) { fields.push(`bairro = $${idx++}`); values.push(bairro); }
    if (cidade !== undefined) { fields.push(`cidade = $${idx++}`); values.push(cidade); }
    if (estado !== undefined) { fields.push(`estado = $${idx++}`); values.push(estado); }
    if (complemento !== undefined) { fields.push(`complemento = $${idx++}`); values.push(complemento); }
    if (latitude !== undefined) { fields.push(`latitude = $${idx++}`); values.push(latitude); }
    if (longitude !== undefined) { fields.push(`longitude = $${idx++}`); values.push(longitude); }
    if (dhexclusao !== undefined) { fields.push(`dhexclusao = $${idx++}`); values.push(dhexclusao); }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    }

    values.push(codemp);
    values.push(req.escopo.codconta);

    const sql = `
      UPDATE public.empresas
         SET ${fields.join(', ')}
       WHERE codemp = $${idx}
         AND codconta = $${idx + 1}
      RETURNING codemp, cnpj, razaosocial, nomefantasia, inscricaoestadual,
                emailcontato, emailfinanceiro, cep, endereco, numero, bairro,
                cidade, estado, complemento, latitude, longitude
    `;

    const result = await pool.query(sql, values);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Empresa não encontrada' });
    }
    return res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao atualizar a empresa:', {
      message: error.message, code: error.code, detail: error.detail,
    });
    return res.status(500).json({
      error: 'Erro interno ao atualizar empresa',
      pg: { message: error.message, detail: error.detail },
    });
  }
});

// Coordenadas de UMA empresa específica (?codemp=4).
// Sem o parâmetro, devolve a primeira do escopo.
app.get('/empresas/coordenadas', authMiddleware, escopoMiddleware, async (req, res) => {
  try {
    const pedido = Number(req.query.codemp);
    const codemp = req.escopo.empresas.includes(pedido)
      ? pedido
      : req.escopo.empresas[0];

    const { rows } = await pool.query(
      `SELECT codemp, latitude, longitude
         FROM public.empresas
        WHERE codemp = $1 AND dhexclusao IS NULL`,
      [codemp]
    );

    if (!rows.length) return res.json({ ok: false });
    return res.json({
      ok: true,
      codemp: rows[0].codemp,
      latitude: rows[0].latitude,
      longitude: rows[0].longitude,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================================
//  MOTORISTAS
//  codemp NULL = compartilhado com todas as empresas da conta.
// ============================================================

app.get('/motoristas', authMiddleware, escopoMiddleware, async (req, res) => {
  try {
    const empresas = empresasFiltradas(req);

    const sql = `
      SELECT m.codmotorista, m.codemp, m.codconta, m.codappmotorista, m.nomeusu,
             m.telefone, m.email, m.ativo, m.nomecomp, m.dhinclusao, m.dhexclusao,
             emp.nomefantasia AS empresa_nome
        FROM public.motoristas m
        LEFT JOIN public.empresas emp ON emp.codemp = m.codemp
       WHERE m.dhexclusao IS NULL
         AND m.codconta = $1
         AND (m.codemp IS NULL OR m.codemp = ANY($2::int[]))
       ORDER BY m.nomeusu
    `;

    const result = await pool.query(sql, [req.escopo.codconta, empresas]);
    return res.json(result.rows);
  } catch (error) {
    console.error('Erro ao listar motoristas:', error);
    return res.status(500).json({ error: 'Erro interno ao listar motoristas' });
  }
});
// NOTA: `senha` saiu do SELECT. Não há motivo para trafegar a senha
// do motorista para a tela de listagem.

app.post('/motoristas', authMiddleware, escopoMiddleware, async (req, res) => {
  try {
    const emp = empresaOpcionalDoBody(req, res);
    if (!emp.ok) return;

    const { nomeusu, senha, telefone, email, ativo, nomecomp, codappmotorista } = req.body;

    const result = await pool.query(
      `INSERT INTO motoristas (codconta, codemp, nomeusu, senha, telefone,
                               email, ativo, nomecomp, codappmotorista)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING codmotorista, codconta, codemp, nomeusu, telefone, email,
                 ativo, nomecomp, codappmotorista`,
      [
        req.escopo.codconta, emp.codemp, nomeusu, senha, telefone,
        email || null, ativo || 'S', nomecomp || null, codappmotorista,
      ]
    );

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao criar motorista:', {
      message: error.message, code: error.code, detail: error.detail,
    });
    return res.status(500).json({
      error: 'Erro interno ao criar motorista',
      pg: { message: error.message, detail: error.detail },
    });
  }
});

app.put('/motoristas/:codmotorista', authMiddleware, escopoMiddleware, async (req, res) => {
  try {
    const codmotorista = Number(req.params.codmotorista);
    if (!Number.isInteger(codmotorista) || codmotorista <= 0) {
      return res.status(400).json({ error: 'Código do motorista inválido' });
    }

    const { nomeusu, senha, telefone, email, ativo, nomecomp,
            codappmotorista, dhexclusao } = req.body;

    let novoCodemp;
    if (req.body.codemp !== undefined) {
      const emp = empresaOpcionalDoBody(req, res);
      if (!emp.ok) return;
      novoCodemp = emp.codemp;
    }

    const fields = [];
    const values = [];
    let idx = 1;

    if (novoCodemp !== undefined) { fields.push(`codemp = $${idx++}`); values.push(novoCodemp); }
    if (nomeusu !== undefined) { fields.push(`nomeusu = $${idx++}`); values.push(nomeusu); }
    if (senha !== undefined) { fields.push(`senha = $${idx++}`); values.push(senha); }
    if (telefone !== undefined) { fields.push(`telefone = $${idx++}`); values.push(telefone); }
    if (email !== undefined) { fields.push(`email = $${idx++}`); values.push(email); }
    if (ativo !== undefined) { fields.push(`ativo = $${idx++}`); values.push(ativo); }
    if (nomecomp !== undefined) { fields.push(`nomecomp = $${idx++}`); values.push(nomecomp); }
    if (codappmotorista !== undefined) { fields.push(`codappmotorista = $${idx++}`); values.push(codappmotorista); }
    if (dhexclusao !== undefined) { fields.push(`dhexclusao = $${idx++}`); values.push(dhexclusao); }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    }

    values.push(codmotorista);
    values.push(req.escopo.codconta);

    const sql = `
      UPDATE public.motoristas
         SET ${fields.join(', ')}
       WHERE codmotorista = $${idx}
         AND codconta = $${idx + 1}
      RETURNING codmotorista, codemp, nomeusu, telefone, email, ativo,
                nomecomp, codappmotorista
    `;

    const result = await pool.query(sql, values);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Motorista não encontrado' });
    }
    return res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao atualizar motorista:', {
      message: error.message, code: error.code, detail: error.detail,
    });
    return res.status(500).json({
      error: 'Erro interno ao atualizar motorista',
      pg: { message: error.message, detail: error.detail },
    });
  }
});

// ============================================================
//  VEÍCULOS
//  Mesmo padrão dos motoristas: codemp NULL = compartilhado.
// ============================================================

app.get('/veiculos', authMiddleware, escopoMiddleware, async (req, res) => {
  try {
    const empresas = empresasFiltradas(req);

    const sql = `
      SELECT v.codveiculo, v.codemp, v.codconta, v.placa, v.renavam, v.chassi,
             v.tipo_veiculo, v.marca, v.modelo, v.ano_fabricacao, v.ano_modelo,
             v.cor, v.peso_maximo, v.volume_maximo, v.dhexclusao, v.dhinclusao,
             emp.nomefantasia AS empresa_nome
        FROM public.veiculos v
        LEFT JOIN public.empresas emp ON emp.codemp = v.codemp
       WHERE v.dhexclusao IS NULL
         AND v.codconta = $1
         AND (v.codemp IS NULL OR v.codemp = ANY($2::int[]))
       ORDER BY v.placa
    `;

    const result = await pool.query(sql, [req.escopo.codconta, empresas]);
    return res.json(result.rows);
  } catch (error) {
    console.error('Erro ao listar veiculos:', error);
    return res.status(500).json({ error: 'Erro interno ao listar veiculos' });
  }
});

app.post('/veiculos', authMiddleware, escopoMiddleware, async (req, res) => {
  try {
    const emp = empresaOpcionalDoBody(req, res);
    if (!emp.ok) return;

    const {
      placa, renavam, chassi, tipo_veiculo, marca, modelo,
      ano_fabricacao, ano_modelo, cor, peso_maximo, volume_maximo,
    } = req.body;

    const result = await pool.query(
      `INSERT INTO veiculos (codconta, codemp, placa, renavam, chassi,
                             tipo_veiculo, marca, modelo, ano_fabricacao,
                             ano_modelo, cor, peso_maximo, volume_maximo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING codveiculo, codconta, codemp, placa, renavam, chassi,
                 tipo_veiculo, marca, modelo, ano_fabricacao, ano_modelo,
                 cor, peso_maximo, volume_maximo`,
      [
        req.escopo.codconta, emp.codemp, placa, renavam, chassi,
        tipo_veiculo, marca, modelo, ano_fabricacao, ano_modelo,
        cor, peso_maximo, volume_maximo,
      ]
    );

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao criar veículo:', {
      message: error.message, code: error.code, detail: error.detail,
    });
    return res.status(500).json({
      error: 'Erro interno ao criar veículo',
      pg: { message: error.message, detail: error.detail },
    });
  }
});

app.put('/veiculos/:codveiculo', authMiddleware, escopoMiddleware, async (req, res) => {
  try {
    const codveiculo = Number(req.params.codveiculo);
    if (!Number.isInteger(codveiculo) || codveiculo <= 0) {
      return res.status(400).json({ error: 'Código do veículo inválido' });
    }

    const {
      placa, renavam, chassi, tipo_veiculo, marca, modelo, ano_fabricacao,
      ano_modelo, cor, peso_maximo, volume_maximo, dhexclusao,
    } = req.body;

    let novoCodemp;
    if (req.body.codemp !== undefined) {
      const emp = empresaOpcionalDoBody(req, res);
      if (!emp.ok) return;
      novoCodemp = emp.codemp;
    }

    const fields = [];
    const values = [];
    let idx = 1;

    if (novoCodemp !== undefined) { fields.push(`codemp = $${idx++}`); values.push(novoCodemp); }
    if (placa !== undefined) { fields.push(`placa = $${idx++}`); values.push(placa); }
    if (renavam !== undefined) { fields.push(`renavam = $${idx++}`); values.push(renavam); }
    if (chassi !== undefined) { fields.push(`chassi = $${idx++}`); values.push(chassi); }
    if (tipo_veiculo !== undefined) { fields.push(`tipo_veiculo = $${idx++}`); values.push(tipo_veiculo); }
    if (marca !== undefined) { fields.push(`marca = $${idx++}`); values.push(marca); }
    if (modelo !== undefined) { fields.push(`modelo = $${idx++}`); values.push(modelo); }
    if (ano_fabricacao !== undefined) { fields.push(`ano_fabricacao = $${idx++}`); values.push(ano_fabricacao); }
    if (ano_modelo !== undefined) { fields.push(`ano_modelo = $${idx++}`); values.push(ano_modelo); }
    if (cor !== undefined) { fields.push(`cor = $${idx++}`); values.push(cor); }
    if (peso_maximo !== undefined) { fields.push(`peso_maximo = $${idx++}`); values.push(peso_maximo); }
    if (volume_maximo !== undefined) { fields.push(`volume_maximo = $${idx++}`); values.push(volume_maximo); }
    if (dhexclusao !== undefined) { fields.push(`dhexclusao = $${idx++}`); values.push(dhexclusao); }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    }

    values.push(codveiculo);
    values.push(req.escopo.codconta);

    const sql = `
      UPDATE public.veiculos
         SET ${fields.join(', ')}
       WHERE codveiculo = $${idx}
         AND codconta = $${idx + 1}
      RETURNING codveiculo, codemp, placa, renavam, chassi, tipo_veiculo,
                marca, modelo, ano_fabricacao, ano_modelo, cor,
                peso_maximo, volume_maximo, dhexclusao
    `;

    const result = await pool.query(sql, values);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Veículo não encontrado' });
    }
    return res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao atualizar veículo:', {
      message: error.message, code: error.code, detail: error.detail,
    });
    return res.status(500).json({
      error: 'Erro interno ao atualizar veículo',
      pg: { message: error.message, detail: error.detail },
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
