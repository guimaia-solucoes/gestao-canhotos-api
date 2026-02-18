const express = require('express');
const cors = require('cors');    
const pool = require('./db/pool');
const nfeImportRoutes = require("./routes/nfeImport.routes");

const app = express();

app.use(cors({
  origin: '*', // depois a gente restringe
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));
app.use(express.json());

// registra rota /api/nfe/importar-zip
app.use("/api", nfeImportRoutes);

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


//USUÁRIOS 
//( POST, PUT, GET )
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

app.get('/usuarios', async (req, res) => {
  try {
    const sql = `
      SELECT codusu, codemp, nomeusu, email, ativo, nomecomp, dhinclusao
      FROM public.usuarios
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

app.put('/usuarios/:codusu', async (req, res) => {
  try {
    const codusu = Number(req.params.codusu);

    if (!Number.isInteger(codusu) || codusu <= 0) {
      return res.status(400).json({ error: 'codusu inválido' });
    }

    const { codemp, nomeusu, senha, email, ativo, nomecomp } = req.body;

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

    if (fields.length === 0) {
      return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    }

    // codusu sempre por último
    values.push(codusu);

    const sql = `
      UPDATE public.usuarios
      SET ${fields.join(', ')}
      WHERE codusu = $${idx}
      RETURNING codusu, codemp, nomeusu, email, ativo, nomecomp, dhinclusao
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
    console.error('Erro ao criar entregas:', error);
    return res.status(500).json({ error: 'Erro interno ao criar entregas' });
  }
});



app.get('/entregas', async (req, res) => {
  try {
    const sql = `
      SELECT id, codemp, ordemcarga, numnota,cgccpf,endereco,numend,cidade,estado,chavenfe,vlrnota,nomeparc,razaosocial,nomebairro,telefone,dtinicial_entrega,assinado,checkinlatitude,checkinlongitude,checkindh,checkoutdh,assinadodh,latitude,longitude,logistica,assinatura,ad_apprecebedor,ad_appdocrecebedor,ad_apptipdocrecebedor,assinaturalatitude,assinaturalongitude,seqcarga,tipodoc,codmotorista,status,data_entrega
      FROM public.entregas
      ORDER BY id DESC
    `;

    const result = await pool.query(sql);
    return res.json(result.rows);
  } catch (error) {
    console.error('Erro ao listar usuários: ' + $error, error);
    return res.status(500).json({ error: 'Erro interno ao listar usuários' });
  }
});


app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
