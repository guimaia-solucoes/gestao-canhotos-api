const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// Porta obrigatoriamente assim (Railway)
const PORT = process.env.PORT || 3000;

// Pool de conexão com Postgres (Railway)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Health check da aplicação + banco
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'ok',
      database: 'connected'
    });
  } catch (error) {
    console.error('Erro ao conectar no banco:', error);
    res.status(500).json({
      status: 'error',
      database: 'disconnected'
    });
  }
});

// Start do servidor
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
