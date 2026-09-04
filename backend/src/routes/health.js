// src/routes/health.js
const express = require('express');
const pool = require('../db/pool');

function createHealthRouter({ poller, marketDataClient }) {
  const router = express.Router();

  router.get('/health', async (req, res) => {
    let dbOk = false;
    try {
      await pool.query('SELECT 1');
      dbOk = true;
    } catch (_) {
      dbOk = false;
    }

    const pollerStatus = poller.getStatus();
    const circuitState = marketDataClient.getCircuitState();

    const healthy = dbOk && circuitState !== 'open';

    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      db: dbOk ? 'ok' : 'unreachable',
      poller: {
        lastSuccessfulPollAt: pollerStatus.lastSuccessfulPollAt,
        isCycleRunning: pollerStatus.isCycleRunning,
      },
      marketDataCircuit: circuitState,
    });
  });

  return router;
}

module.exports = { createHealthRouter };
