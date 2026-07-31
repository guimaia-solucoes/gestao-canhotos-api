const { Pool, types } = require('pg');

// ── Fuso ────────────────────────────────────────────────────
// 1184 = timestamptz. Sem isso, o pg devolve um objeto Date e o
// JSON.stringify do Express serializa sempre em UTC (o "...Z").
// Devolvendo a string crua, a API responde no fuso da sessão,
// já com o offset explícito: "2026-07-31 15:57:00-03".
types.setTypeParser(1184, (valor) => valor);

// 1082 = date (sem hora). Evita que uma data pura vire meia-noite
// UTC e apareça como o dia anterior no navegador.
types.setTypeParser(1082, (valor) => valor);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Rede de segurança: garante o fuso em toda conexão nova, mesmo que
// o ALTER DATABASE não pegue (usuário diferente, restore, réplica).
pool.on('connect', (client) => {
  client.query("SET TIME ZONE 'America/Sao_Paulo'");
});

pool.on('error', (err) => {
  console.error('[pool] erro em conexão ociosa:', err);
});

module.exports = pool;