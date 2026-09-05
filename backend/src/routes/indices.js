// src/routes/indices.js
const express = require('express');
const repo = require('../db/repository');
const { INDEX_BY_SYMBOL } = require('../marketData/indexSymbols');

// GET /indices — the top ticker strip's data. Public (mounted before the
// session middleware, like /health) so the strip can render on the login
// page too. Returns whatever the poller has cached in index_quote; the
// frontend never talks to Yahoo directly.
function createIndicesRouter() {
  const router = express.Router();

  router.get('/indices', async (req, res, next) => {
    try {
      const rows = await repo.getIndexQuotes();
      const indices = rows.map((row) => {
        const meta = INDEX_BY_SYMBOL[row.symbol] || {};
        return {
          symbol: row.symbol,
          label: meta.label || row.symbol,
          price: row.price === null ? null : Number(row.price),
          fetchedAt: row.fetched_at,
          isStale: row.is_stale,
          marketClosed: row.market_closed,
        };
      });
      res.json({ indices });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createIndicesRouter };