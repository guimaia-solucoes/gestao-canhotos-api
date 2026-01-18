const express = require('express');
const pool = require('./db/pool');

const app = express();
app.use(express.json());

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
      ORDER BY codusu DESC
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


app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
