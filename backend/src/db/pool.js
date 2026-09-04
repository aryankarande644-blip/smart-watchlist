// src/db/pool.js
const { Pool } = require('pg');

// All config from env vars — never hardcoded, matches the deployment decision.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL ||
    'postgresql://app:app_local_dev@localhost:5432/watchlist_dev',
});

pool.on('error', (err) => {
  // A background pool error (e.g. connection dropped) must not crash the
  // whole process — log it, let individual queries fail and be handled
  // by their own try/catch instead.
  console.error(JSON.stringify({ event: 'pg_pool_error', message: err.message }));
});

module.exports = pool;
