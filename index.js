const express = require('express');
const { Pool } = require('pg');

// 🔍 DEBUG GLOBAL (ANTES DE TUDO)
console.log('DATABASE_URL exists?', !!process.env.DATABASE_URL);
if (process.env.DATABASE_URL) {
  console.log(
    'DATABASE_URL prefix:',
    process.env.DATABASE_URL.split('://')[0]
  );
}

const app = express();
app.use(express.json());

// Porta obrigatória no Railway
const PORT = process.env.PORT || 3000;

// Pool de conexão com Postgres
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// 🔍 Rota de debug (TEMPORÁRIA)
app.get('/debug-env', (req, res) => {
  res.json({
    hasDatabaseUrl: !!process.env.DATABASE_URL,
    databaseUrlPrefix: process.env.DATABASE_URL
      ? process.env.DATABASE_URL.split('://')[0]
      : null
  });
});

// Health check
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
