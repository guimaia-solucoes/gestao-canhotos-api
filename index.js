const express = require('express');
const cors = require('cors');    
const pool = require('./db/pool');

const nfeImportRoutes = require("./routes/nfeImport.routes");
const danfeService = require('./danfe.service');
const { buscarLatLongComDelay } = require('./services/geocoding.service');

const app = express();

const { execSync } = require('child_process');

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
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));
app.use(express.json());

// registra rota /api/nfe/importar-zip
app.use("/api", nfeImportRoutes);
danfeService.registerRoutes(app); 

const PORT = process.env.PORT || 3000;

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'ok',
      database: 'connected'
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      status: 'error',
      database: 'disconnected'
    });
  }
});


//CADASTRO USUÁRIOS 
//( POST, PUT, GET )
//Cadastrando usuários
app.post('/usuarios', async (req, res) => {
  try {
    const { codemp, nomeusu, senha, email, ativo, nomecomp } = req.body;

    // validação mínima (bem simples)
    if (!codemp || !nomeusu || !senha) {
      return res.status(400).json({
        error: 'codemp, nomeusu e senha são obrigatórios'
      });
    }

    const sql = `
      INSERT INTO usuarios (codemp, nomeusu, senha, email, ativo, nomecomp)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING codusu, codemp, nomeusu, email, ativo, nomecomp, dhinclusao
    `;

    const params = [
      codemp,
      nomeusu,
      senha,
      email || null,
      ativo || 'S',
      nomecomp || null
    ];

    const result = await pool.query(sql, params);

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao criar usuário:', error);
    return res.status(500).json({ error: 'Erro interno ao criar usuário' });
  }
});

//Consultar usuários
app.get('/usuarios', async (req, res) => {
  try {
    const sql = `
      SELECT codusu, codemp, nomeusu, email, ativo, nomecomp, dhinclusao
      FROM public.usuarios
	  WHERE dhexclusao IS NULL
      ORDER BY codusu 
    `;

    const result = await pool.query(sql);
    return res.json(result.rows);
  } catch (error) {
    console.error('Erro ao listar usuários:', error);
    return res.status(500).json({ error: 'Erro interno ao listar usuários' });
  }
});

app.get('/usuarios/:codusu', async (req, res) => {
  try {
    const codusu = Number(req.params.codusu);

    if (!Number.isInteger(codusu) || codusu <= 0) {
      return res.status(400).json({ error: 'codusu inválido' });
    }

    const sql = `
      SELECT codusu, codemp, nomeusu, email, ativo, nomecomp, dhinclusao
      FROM public.usuarios
      WHERE codusu = $1
      LIMIT 1
    `;

    const result = await pool.query(sql, [codusu]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    return res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao buscar usuário:', error);
    return res.status(500).json({ error: 'Erro interno ao buscar usuário' });
  }
});

//Alterando usuários (update)
app.put('/usuarios/:codusu', async (req, res) => {
  try {
    const codusu = Number(req.params.codusu);

    if (!Number.isInteger(codusu) || codusu <= 0) {
      return res.status(400).json({ error: 'codusu inválido' });
    }

    const { codemp, nomeusu, senha, email, ativo, nomecomp, dhexclusao } = req.body;

    // ✅ Monta update dinâmico: atualiza só o que veio no body
    const fields = [];
    const values = [];
    let idx = 1;

    if (codemp !== undefined) { fields.push(`codemp = $${idx++}`); values.push(codemp); }
    if (nomeusu !== undefined) { fields.push(`nomeusu = $${idx++}`); values.push(nomeusu); }
    if (senha !== undefined) { fields.push(`senha = $${idx++}`); values.push(senha); }
    if (email !== undefined) { fields.push(`email = $${idx++}`); values.push(email); }
    if (ativo !== undefined) { fields.push(`ativo = $${idx++}`); values.push(ativo); }
    if (nomecomp !== undefined) { fields.push(`nomecomp = $${idx++}`); values.push(nomecomp); }
	if (dhexclusao !== undefined) { fields.push(`dhexclusao = $${idx++}`); values.push(dhexclusao); }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    }

    // codusu sempre por último
    values.push(codusu);

    const sql = `
      UPDATE public.usuarios
      SET ${fields.join(', ')}
      WHERE codusu = $${idx}
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


//ENTREGAS
//( POST, PUT, GET )
//INSERIR AS ENTREGAS
app.post('/entregas', async (req, res) => {
  try {
    const { codemp, ordemcarga, numnota, cgccpf, endereco, numend, cidade, estado, chavenfe, vlrnota, nomeparc, razaosocial, nomebairro, telefone, dtinicial_entrega, assinado, checkinlatitude, checkinlongitude, checkindh, checkoutdh, assinadodh, latitude, longitude, logistica, assinatura, ad_apprecebedor, ad_appdocrecebedor, ad_apptipdocrecebedor, assinaturalatitude, assinaturalongitude, seqcarga, tipodoc, codmotorista, status, data_entrega, dhinclusao, codusuinclusao } = req.body;

    // validação mínima (bem simples)
    /*if (!codemp || !nomeusu || !senha) {
      return res.status(400).json({
        error: 'codemp, nomeusu e senha são obrigatórios'
      });
    }*/

    const sql = `
      INSERT INTO entregas (codemp, ordemcarga, numnota, cgccpf, endereco, numend, cidade, estado, chavenfe, vlrnota, nomeparc, razaosocial, nomebairro, telefone, dtinicial_entrega, assinado, checkinlatitude, checkinlongitude, checkindh, checkoutdh, assinadodh, latitude, longitude, logistica, assinatura, ad_apprecebedor, ad_appdocrecebedor, ad_apptipdocrecebedor, assinaturalatitude, assinaturalongitude, seqcarga, tipodoc, codmotorista, status, data_entrega, dhinclusao, codusuinclusao)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37)
      RETURNING id, codemp, ordemcarga, numnota, cgccpf, endereco, numend, cidade, estado, chavenfe, vlrnota, nomeparc, razaosocial, nomebairro, telefone, dtinicial_entrega, assinado, checkinlatitude, checkinlongitude, checkindh, checkoutdh, assinadodh, latitude, longitude, logistica, assinatura, ad_apprecebedor, ad_appdocrecebedor, ad_apptipdocrecebedor, assinaturalatitude, assinaturalongitude, seqcarga, tipodoc, codmotorista, status, data_entrega, dhinclusao, codusuinclusao
    `;

    const params = [
      codemp, 
	  ordemcarga, 
	  numnota, 
	  cgccpf, 
	  endereco, 
	  numend, 
	  cidade, 
	  estado,
	  chavenfe, 
	  vlrnota, 
	  nomeparc, 
	  razaosocial,
	  nomebairro, 
	  telefone, 
	  dtinicial_entrega, 
	  assinado, 
	  checkinlatitude, 
	  checkinlongitude, 
	  checkindh, 
	  checkoutdh, 
	  assinadodh, 
	  latitude,
	  longitude,
	  logistica,
	  assinatura,
	  ad_apprecebedor,
	  ad_appdocrecebedor,
	  ad_apptipdocrecebedor,
	  assinaturalatitude,
	  assinaturalongitude,
	  seqcarga,
	  tipodoc,
	  codmotorista,
	  status,
	  data_entrega,
	  dhinclusao,
	  codusuinclusao
    ];

    const result = await pool.query(sql, params);

    return res.status(201).json(result.rows[0]);
  } catch (error) {
  console.error('BODY RECEBIDO:', req.body);
  console.error('Erro ao criar entrega:', {
    message: error.message,
    code: error.code,
    detail: error.detail,
    constraint: error.constraint,
    table: error.table,
    column: error.column,
  });
  return res.status(500).json({
    error: 'Erro interno ao criar entrega',
    pg: {
      message: error.message,
      code: error.code,
      detail: error.detail,
      constraint: error.constraint,
      column: error.column,
    }
  });
}
});


//BUSCAR AS ENTREGAS
app.get('/entregas', async (req, res) => {
  try {
    const sql = `
      SELECT id, codemp, ordemcarga, numnota,cgccpf,endereco,numend,cidade,estado,chavenfe,vlrnota,nomeparc,razaosocial,nomebairro,telefone,dtinicial_entrega,assinado,checkinlatitude,checkinlongitude,checkindh,checkoutdh,assinadodh,COALESCE(latitude,0) as latitude ,COALESCE(longitude,0) as longitude,logistica,assinatura,ad_apprecebedor,ad_appdocrecebedor,ad_apptipdocrecebedor,assinaturalatitude,assinaturalongitude, COALESCE(seqcarga,0) as seqcarga,tipodoc,codmotorista, status, data_entrega
      FROM public.entregas
      ORDER BY id DESC
    `;

    const result = await pool.query(sql);
    return res.json(result.rows);
  } catch (error) {
    console.error('Erro ao listar entregas:', error);
    return res.status(500).json({ error: 'Erro interno ao listar usuários' });
  }
});


//IMPORTAR ENTREGAS VIA CSV, MODELO PADRÃO BAIXADO
app.post('/entregas/importar-csv', async (req, res) => {
  try {
    const {
      ordemcarga, numnota, cgccpf, endereco, numend,
      cidade, estado, chavenfe, vlrnota, nomeparc,
      razaosocial, nomebairro, telefone, latitude,
      longitude, logistica, data_entrega
    } = req.body;

    const sql = `
      INSERT INTO entregas (
        ordemcarga, numnota, cgccpf, endereco, numend,
        cidade, estado, chavenfe, vlrnota, nomeparc,
        razaosocial, nomebairro, telefone, latitude,
        longitude, logistica, data_entrega
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      RETURNING id
    `;

    const params = [
      ordemcarga || null,
      numnota || null,
      cgccpf || null,
      endereco || null,
      numend || null,
      cidade || null,
      estado || null,
      chavenfe || null,
      vlrnota ? Number(vlrnota) : null,
      nomeparc || null,
      razaosocial || null,
      nomebairro || null,
      telefone || null,
      latitude ? Number(latitude) : null,
      longitude ? Number(longitude) : null,
      logistica || null,
      data_entrega || null,
    ];

    const { rows } = await pool.query(sql, params);
    return res.status(201).json({ id: rows[0].id });

  } catch (error) {
    return res.status(500).json({
      error: 'Erro ao importar entrega',
      detail: error.message
    });
  }
});

//Alterando usuários (update)
app.put('/entregas/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Id. da entrega é inválida' });
    }

    const { ordemcarga  } = req.body;

    // ✅ Monta update dinâmico: atualiza só o que veio no body
    const fields = [];
    const values = [];
    let idx = 1;

    if (ordemcarga !== undefined) { fields.push(`ordemcarga = $${idx++}`); values.push(ordemcarga); }
 
    if (fields.length === 0) {
      return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    }

    // codusu sempre por último
    values.push(id);

    const sql = `
      UPDATE public.entregas
      SET ${fields.join(', ')}
      WHERE id = $${idx}
      RETURNING id
    `;

    const result = await pool.query(sql, values);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Entrega não encontrada' });
    }

    return res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao atualizar entrega:', error);
    return res.status(500).json({ error: 'Erro interno ao atualizar entrega' });
  }
});


app.post('/entregas/geocodificar/:ordemcarga', async (req, res) => {
  const { ordemcarga } = req.params;

  try {
    // Busca entregas da OC sem lat/long
    const { rows } = await pool.query(
      `SELECT id, endereco, numend, nomebairro, cidade, estado
       FROM public.entregas
       WHERE ordemcarga = $1
       AND (latitude IS NULL OR longitude IS NULL)`,
      [ordemcarga]
    );

    if (rows.length === 0) {
      return res.json({ ok: true, msg: 'Nenhuma entrega para geocodificar.', total: 0 });
    }

    let sucesso = 0;
    let semResultado = 0;

    for (const entrega of rows) {
      const { latitude, longitude } = await buscarLatLongComDelay(
        entrega.endereco,
        entrega.numend,
        entrega.nomebairro,
        entrega.cidade,
        entrega.estado
      );

      if (latitude && longitude) {
        await pool.query(
          `UPDATE public.entregas SET latitude = $1, longitude = $2 WHERE id = $3`,
          [latitude, longitude, entrega.id]
        );
        sucesso++;
      } else {
        semResultado++;
      }
    }

    return res.json({
      ok: true,
      total: rows.length,
      sucesso,
      semResultado,
    });

  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/*ROMANEIOS / ORDENS DE CARGAS*/
//BUSCA DE VEÍCULOS
app.get('/romaneios', async (req, res) => {
  try {
    const sql = `
      SELECT ocromaneio , data_criacao , TO_CHAR(data_entregasaida, 'DD/MM/YYYY') as data_entregasaida , motorista , duracaoest , kmest , status , qtdentregas , qtdfinalizadas , obs 
	  FROM public.romaneios
      order by ocromaneio desc	   
    `;

    const result = await pool.query(sql);
    return res.json(result.rows);
  } catch (error) {
    console.error('Erro ao listar veiculos:', error);
    return res.status(500).json({ error: 'Erro interno ao listar veiculos' });
  }
});

app.get('/romaneios/roteiro/:oc', async (req, res) => {
  try {
	  
	 const oc = Number(req.params.oc);

    if (!Number.isInteger(oc) || oc <= 0) {
      return res.status(400).json({ error: 'Ordem de Carga inválida' });
    }
	  	
    const sql = `
      SELECT id, codemp, ordemcarga, numnota,cgccpf,endereco,numend,cidade,estado,chavenfe,vlrnota,nomeparc,razaosocial,nomebairro,telefone,dtinicial_entrega,assinado,checkinlatitude,checkinlongitude,checkindh,checkoutdh,assinadodh,COALESCE(latitude,0) as latitude ,COALESCE(longitude,0) as longitude,logistica,assinatura,ad_apprecebedor,ad_appdocrecebedor,ad_apptipdocrecebedor,assinaturalatitude,assinaturalongitude, COALESCE(seqcarga,0) as seqcarga,tipodoc,codmotorista, status, data_entrega
      FROM public.entregas
	  WHERE ordemcarga = $1
      ORDER BY id DESC
    `;

     const result = await pool.query(sql, [oc]);

    /*if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Ordem de Carga/Romaneio sem entregas' });
    }*/
	
	
    return res.json(result.rows);
  } catch (error) {
    console.error('Erro ao listar entregas:', error);
    return res.status(500).json({ error: 'Erro interno ao listar usuários' });
  }
});

app.post('/romaneios/geocodificar/:ordemcarga', async (req, res) => {
  const { ordemcarga } = req.params;

  try {
    // Busca entregas da OC sem lat/long
    const { rows } = await pool.query(
      `SELECT id, endereco, numend, nomebairro, cidade, estado
       FROM public.entregas
       WHERE ordemcarga = $1
       AND (latitude IS NULL OR longitude IS NULL or latitude = 0 or longitude = 0)`,
      [ordemcarga]
    );

    if (rows.length === 0) {
      return res.json({ ok: true, msg: 'Nenhuma entrega para geocodificar.', total: 0 });
    }

    let sucesso = 0;
    let semResultado = 0;

    for (const entrega of rows) {
      const { latitude, longitude } = await buscarLatLongComDelay(
        entrega.endereco,
        entrega.numend,
        entrega.nomebairro,
        entrega.cidade,
        entrega.estado
      );

      if (latitude && longitude) {
        await pool.query(
          `UPDATE public.entregas SET latitude = $1, longitude = $2 WHERE id = $3`,
          [latitude, longitude, entrega.id]
        );
        sucesso++;
      } else {
        semResultado++;
      }
    }

    return res.json({
      ok: true,
      total: rows.length,
      sucesso,
      semResultado,
    });

  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

const http = require('http');

app.post('/romaneios/roteirizar/:ordemcarga', async (req, res) => {
			
  const { ordemcarga } = req.params;
  try {
    // 1) Busca empresa (ponto de partida)
    const { rows: empresa } = await pool.query(
      `SELECT latitude, longitude FROM public.empresas LIMIT 1`
    );
    if (!empresa.length || !empresa[0].latitude || !empresa[0].longitude) {
      return res.status(400).json({ ok: false, msg: 'Endereço da empresa sem coordenadas.' });
    }
    const origem = {
      latitude: parseFloat(empresa[0].latitude),
      longitude: parseFloat(empresa[0].longitude),
    };

    // 2) Busca entregas da OC com lat/long
    const { rows: entregas } = await pool.query(
      `SELECT id, latitude, longitude, nomeparc
       FROM public.entregas
       WHERE ordemcarga = $1
       AND latitude IS NOT NULL
       AND latitude <> 0
       AND longitude IS NOT NULL
       AND longitude <> 0
       ORDER BY id`,
      [ordemcarga]
    );
    if (entregas.length === 0) {
      return res.status(400).json({
        ok: false,
        msg: 'Nenhuma entrega com coordenadas encontrada. Execute "Buscar Latitude/Longitude" primeiro.',
      });
    }

    // 3) Monta coordenadas: origem + entregas + origem (destination=last)
    const todasCoordenadas = [
      origem,
      ...entregas.map(e => ({
        latitude: parseFloat(e.latitude),
        longitude: parseFloat(e.longitude),
      })),
      origem,
    ];
    const coordStr = todasCoordenadas
      .map(c => `${c.longitude},${c.latitude}`)
      .join(';');

    // 4) Chama OSRM Trip API
    const osrmUrl = `/trip/v1/driving/${coordStr}?source=first&destination=last&geometries=geojson`;
    const osrmResult = await new Promise((resolve, reject) => {
      const options = {
        hostname: '134.122.113.67',
        port: 5000,
        path: osrmUrl,
        method: 'GET',
      };
      http.get(options, (osrmRes) => {
        let data = '';
        osrmRes.on('data', chunk => data += chunk);
        osrmRes.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error('Erro ao parsear resposta do OSRM'));
          }
        });
      }).on('error', reject);
    });

    if (osrmResult.code !== 'Ok') {
      return res.status(500).json({ ok: false, msg: `OSRM retornou erro: ${osrmResult.code}` });
    }

    // 5) Atualiza seqcarga no banco — igual lógica Java
    // waypoints[0] = empresa (ignora), waypoints[1..N] = entregas na ordem da query
    const waypoints = osrmResult.waypoints;
    for (let i = 0; i < entregas.length; i++) {
      const wp = waypoints[i + 1]; // +1 pula a empresa
      if (!wp) continue;
      await pool.query(
        `UPDATE public.entregas SET seqcarga = $1 WHERE id = $2`,
        [wp.waypoint_index, entregas[i].id]
      );
    }
	
	// 6) Extrai distância, duração e coordenadas do resultado OSRM
	const trip = osrmResult.trips[0];
	const distanciaKm = (trip.distance / 1000).toFixed(2) + ' km';
	const duracaoMin = Math.round(trip.duration / 60) + ' min';
	const coordenadas = JSON.stringify(trip.geometry.coordinates);
	
	// 7) Atualiza romaneio com distância, duração e coordenadas
	await pool.query(
	  `UPDATE public.romaneios
	   SET kmest = $1, duracaoest = $2, coordenadas = $3
	   WHERE ocromaneio = $4`,
	  [distanciaKm, duracaoMin, coordenadas, ordemcarga]
	);
	

    return res.json({
	  ok: true,
	  total: entregas.length,
	  kmest: distanciaKm,
	  duracaoest: duracaoMin,
	});

  } catch (error) {
    console.error('[roteirizar]', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});


app.get('/romaneios/coordenada/:ordemcarga', async (req, res) => {
  const { ordemcarga } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT coordenadas FROM public.romaneios WHERE ocromaneio = $1`,
      [ordemcarga]
    );

    if (!rows.length || !rows[0].coordenadas) {
      return res.json({ ok: false, coordenadas: null });
    }

    return res.json({ ok: true, coordenadas: rows[0].coordenadas });

  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/*CADASTRO DE EMPRESAS*/
/*BUSCANDO EMPRESAS*/
app.get('/empresas', async (req, res) => {
  try {
    const sql = `
      SELECT codemp, cnpj, razaosocial, nomefantasia, inscricaoestadual, emailcontato, emailfinanceiro, cep, endereco, numero, bairro, cidade, estado, complemento, dhinclusao, ativo, latitude, longitude, dhexclusao
	  FROM public.empresas
      WHERE dhexclusao is null
	  order by razaosocial
	  
    `;

    const result = await pool.query(sql);
    return res.json(result.rows);
  } catch (error) {
    console.error('Erro ao listar empresas:', error);
    return res.status(500).json({ error: 'Erro interno ao listar empresas' });
  }
});

app.post('/empresas', async (req, res) => {
  try {
    const { cnpj, razaosocial, nomefantasia, inscricaoestadual, emailcontato, emailfinanceiro, cep, endereco, numero, bairro, cidade, estado, complemento, latitude, longitude } = req.body;

	if (cnpj.length != 14) {
      return res.status(400).json({ error: 'CNPJ deve possuir 14 caracteres.' });
    }
    
    const sql = `
      INSERT INTO empresas (cnpj, razaosocial, nomefantasia, inscricaoestadual, emailcontato, emailfinanceiro, cep, endereco, numero, bairro, cidade, estado, complemento, latitude, longitude)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING codemp
    `;

    const params = [
      cnpj,
	  razaosocial,
	  nomefantasia,
	  inscricaoestadual, 
	  emailcontato, 
	  emailfinanceiro, 
	  cep, 
	  endereco, 
	  numero, 
	  bairro, 
	  cidade, 
	  estado, 
	  complemento, 
	  latitude, 
	  longitude
    ];

    const result = await pool.query(sql, params);

    return res.status(201).json(result.rows[0]);
  } catch (error) {
  console.error('BODY RECEBIDO:', req.body);
  console.error('Erro ao criar empresa:', {
    message: error.message,
    code: error.code,
    detail: error.detail,
    constraint: error.constraint,
    table: error.table,
    column: error.column,
  });
  return res.status(500).json({
    error: 'Erro interno ao criar empresa',
    pg: {
      message: error.message,
      code: error.code,
      detail: error.detail,
      constraint: error.constraint,
      column: error.column,
    }
  });
}
});

//Alterando empresas (update)
app.put('/empresas/:codemp', async (req, res) => {
  try {
    const codemp = Number(req.params.codemp);

    if (!Number.isInteger(codemp) || codemp <= 0) {
      return res.status(400).json({ error: 'Código da empresa inválido' });
    }

    const { cnpj, razaosocial, nomefantasia, inscricaoestadual, emailcontato, emailfinanceiro, cep, endereco, numero, bairro, cidade, estado, complemento, latitude, longitude, dhexclusao } = req.body;

    // ✅ Monta update dinâmico: atualiza só o que veio no body
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

    // codusu sempre por último
    values.push(codemp);

    const sql = `
      UPDATE public.empresas
      SET ${fields.join(', ')}
      WHERE codemp = $${idx}
      RETURNING cnpj, razaosocial, nomefantasia, inscricaoestadual, emailcontato, emailfinanceiro, cep, endereco, numero, bairro, cidade, estado, complemento, latitude, longitude
    `;

    const result = await pool.query(sql, values);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Empresa não encontrada' });
    }

    return res.json(result.rows[0]);
  } catch (error) {
  console.error('BODY RECEBIDO:', req.body);
  console.error('Erro ao atualizar a empresa:', {
    message: error.message,
    code: error.code,
    detail: error.detail,
    constraint: error.constraint,
    table: error.table,
    column: error.column,
  });
  return res.status(500).json({
    error: 'Erro interno ao atualizar empresa',
    pg: {
      message: error.message,
      code: error.code,
      detail: error.detail,
      constraint: error.constraint,
      column: error.column,
    }
  });
}
});

app.get('/empresas/coordenadas', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT latitude, longitude FROM public.empresas LIMIT 1`
    );
    if (!rows.length) return res.json({ ok: false });
    return res.json({ ok: true, latitude: rows[0].latitude, longitude: rows[0].longitude });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/*CADASTRO DE MOTORISTAS*/
//BUSCA DE MOTORISTAS
app.get('/motoristas', async (req, res) => {
  try {
    const sql = `
      SELECT codmotorista, codemp, codappmotorista, nomeusu, senha, telefone, email, ativo, nomecomp, dhinclusao, dhexclusao
      FROM public.motoristas
      WHERE dhexclusao is null
	  order by nomeusu	  
    `;

    const result = await pool.query(sql);
    return res.json(result.rows);
  } catch (error) {
    console.error('Erro ao listar motoristas:', error);
    return res.status(500).json({ error: 'Erro interno ao listar empresas' });
  }
});

//Cadastrando MOTORISTAS
app.post('/motoristas', async (req, res) => {
  try {
    const { codemp, nomeusu, senha, telefone, email, ativo, nomecomp, codappmotorista } = req.body;

   
    const sql = `
      INSERT INTO motoristas (codemp, nomeusu, senha, telefone, email, ativo, nomecomp, codappmotorista)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8 )
      RETURNING codmotorista, codemp, nomeusu, senha, telefone, email, ativo, nomecomp, codappmotorista
    `;

    const params = [
      codemp,
      nomeusu,
      senha,
      telefone,
      email || null,
      ativo || 'S',
      nomecomp || null,
      codappmotorista
    ];

    const result = await pool.query(sql, params);

    return res.status(201).json(result.rows[0]);
  } catch (error) {
  console.error('BODY RECEBIDO:', req.body);
  console.error('Erro ao criar entrega:', {
    message: error.message,
    code: error.code,
    detail: error.detail,
    constraint: error.constraint,
    table: error.table,
    column: error.column,
  });
  return res.status(500).json({
    error: 'Erro interno ao criar entrega',
    pg: {
      message: error.message,
      code: error.code,
      detail: error.detail,
      constraint: error.constraint,
      column: error.column,
    }
  });
}
});

//Alterando motoristas (update)
app.put('/motoristas/:codmotorista', async (req, res) => {
  try {
    const codmotorista = Number(req.params.codmotorista);

    if (!Number.isInteger(codmotorista) || codmotorista <= 0) {
      return res.status(400).json({ error: 'Código do motorista inválido' });
    }

    const { nomeusu, senha, telefone, email, ativo, nomecomp, codappmotorista } = req.body;

    // ✅ Monta update dinâmico: atualiza só o que veio no body
    const fields = [];
    const values = [];
    let idx = 1;

    if (nomeusu !== undefined) { fields.push(`nomeusu = $${idx++}`); values.push(nomeusu); }
    if (senha !== undefined) { fields.push(`senha = $${idx++}`); values.push(senha); }
    if (telefone !== undefined) { fields.push(`telefone = $${idx++}`); values.push(telefone); }
    if (email !== undefined) { fields.push(`email = $${idx++}`); values.push(email); }
    if (ativo !== undefined) { fields.push(`ativo = $${idx++}`); values.push(ativo); }	
    if (nomecomp !== undefined) { fields.push(`nomecomp = $${idx++}`); values.push(nomecomp); }
	if (codappmotorista !== undefined) { fields.push(`codappmotorista = $${idx++}`); values.push(codappmotorista); }
	
    if (fields.length === 0) {
      return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    }

    // codusu sempre por último
    values.push(codmotorista);

    const sql = `
      UPDATE public.motoristas
      SET ${fields.join(', ')}
      WHERE codmotorista = $${idx}
      RETURNING codmotorista, nomeusu, senha, telefone, email, ativo, nomecomp, codappmotorista
    `;

    const result = await pool.query(sql, values);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Motorista não encontrado' });
    }

    return res.json(result.rows[0]);
  } catch (error) {
  console.error('BODY RECEBIDO:', req.body);
  console.error('Erro ao atualizar a motorista:', {
    message: error.message,
    code: error.code,
    detail: error.detail,
    constraint: error.constraint,
    table: error.table,
    column: error.column,
  });
  return res.status(500).json({
    error: 'Erro interno ao atualizar motorista',
    pg: {
      message: error.message,
      code: error.code,
      detail: error.detail,
      constraint: error.constraint,
      column: error.column,
    }
  });
}
});


/*CADASTRO DE VEÍCULOS*/
//BUSCA DE VEÍCULOS
app.get('/veiculos', async (req, res) => {
  try {
    const sql = `
      SELECT codveiculo, codemp, placa, renavam, chassi, tipo_veiculo, marca, modelo, ano_fabricacao, ano_modelo, cor, peso_maximo, volume_maximo, dhexclusao, dhinclusao
      FROM public.veiculos
      WHERE dhexclusao is null
	  order by placa	  
    `;

    const result = await pool.query(sql);
    return res.json(result.rows);
  } catch (error) {
    console.error('Erro ao listar veiculos:', error);
    return res.status(500).json({ error: 'Erro interno ao listar veiculos' });
  }
});

//Cadastrando VEÍCULOS
app.post('/veiculos', async (req, res) => {
  try {
    const { codemp, placa, renavam, chassi, tipo_veiculo, marca, modelo, ano_fabricacao, ano_modelo, cor, peso_maximo, volume_maximo } = req.body;

   
    const sql = `
      INSERT INTO veiculos (codemp, placa, renavam, chassi, tipo_veiculo, marca, modelo, ano_fabricacao, ano_modelo, cor, peso_maximo, volume_maximo)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12  )
      RETURNING codveiculo, codemp, placa, renavam, chassi, tipo_veiculo, marca, modelo, ano_fabricacao, ano_modelo, cor, peso_maximo, volume_maximo
    `;

    const params = [
      codemp, 
	  placa,
	  renavam,
	  chassi, 
	  tipo_veiculo, 
	  marca, 
	  modelo, 
	  ano_fabricacao, 
	  ano_modelo, 
	  cor, 
	  peso_maximo, 
	  volume_maximo
    ];

    const result = await pool.query(sql, params);

    return res.status(201).json(result.rows[0]);
  } catch (error) {
  console.error('BODY RECEBIDO:', req.body);
  console.error('Erro ao criar veículo:', {
    message: error.message,
    code: error.code,
    detail: error.detail,
    constraint: error.constraint,
    table: error.table,
    column: error.column,
  });
  return res.status(500).json({
    error: 'Erro interno ao criar veículo',
    pg: {
      message: error.message,
      code: error.code,
      detail: error.detail,
      constraint: error.constraint,
      column: error.column,
    }
  });
}
});

//Alterando motoristas (update)
app.put('/veiculos/:codveiculo', async (req, res) => {
  try {
    const codveiculo = Number(req.params.codveiculo);

    if (!Number.isInteger(codveiculo) || codveiculo <= 0) {
      return res.status(400).json({ error: 'Código do veículo inválido' });
    }

    const { placa, renavam, chassi, tipo_veiculo, marca, modelo, ano_fabricacao, ano_modelo, cor, peso_maximo, volume_maximo, dhexclusao } = req.body;

    // ✅ Monta update dinâmico: atualiza só o que veio no body
    const fields = [];
    const values = [];
    let idx = 1;

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

    // codusu sempre por último
    values.push(codveiculo);

    const sql = `
      UPDATE public.veiculos
      SET ${fields.join(', ')}
      WHERE codveiculo = $${idx}
      RETURNING codveiculo, placa, renavam, chassi, tipo_veiculo, marca, modelo, ano_fabricacao, ano_modelo, cor, peso_maximo, volume_maximo, dhexclusao
    `;

    const result = await pool.query(sql, values);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Veículo não encontrado' });
    }

    return res.json(result.rows[0]);
  } catch (error) {
  console.error('BODY RECEBIDO:', req.body);
  console.error('Erro ao atualizar a veículo:', {
    message: error.message,
    code: error.code,
    detail: error.detail,
    constraint: error.constraint,
    table: error.table,
    column: error.column,
  });
  return res.status(500).json({
    error: 'Erro interno ao atualizar veículo',
    pg: {
      message: error.message,
      code: error.code,
      detail: error.detail,
      constraint: error.constraint,
      column: error.column,
    }
  });
}
});





app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
