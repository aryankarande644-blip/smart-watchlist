// src/routes/health.js
const express = require('express');
const pool = require('../db/pool');
const { getDiagnostics, recordQuoteError } = require('../diagnostics');

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
    const { lastQuoteError, lastRouteError } = getDiagnostics();

    const healthy = dbOk && circuitState !== 'open';

    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      db: dbOk ? 'ok' : 'unreachable',
      poller: {
        lastSuccessfulPollAt: pollerStatus.lastSuccessfulPollAt,
        isCycleRunning: pollerStatus.isCycleRunning,
      },
      marketDataCircuit: circuitState,
      lastQuoteError,
      lastRouteError,
    });
  });

  // TEMPORARY DEBUG — provider isolation probe: executes from THIS server's
  // network (Render) so we can see the real Yahoo behavior remotely, then
  // remove the route once diagnosed.
  router.get('/debug/provider/:symbol', async (req, res) => {
    const symbol = String(req.params.symbol).toUpperCase();
    try {
      const quote = await marketDataClient.fetchQuote(symbol);
      const history = await marketDataClient.fetchHistorical(symbol, 20);
      res.json({
        ok: true,
        symbol,
        quote,
        historyCount: history.length,
        firstCandle: history[0],
        lastCandle: history[history.length - 1],
      });
    } catch (err) {
      const detail = recordQuoteError(err);
      res.status(200).json({
        ok: false,
        symbol,
        error: { name: err.name, message: err.message, code: err.code, stack: err.stack },
        recorded: detail,
      });
    }
  });

  return router;
}

module.exports = { createHealthRouter };
