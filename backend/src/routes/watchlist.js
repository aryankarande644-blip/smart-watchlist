// src/routes/watchlist.js
const express = require('express');
const repo = require('../db/repository');
const { computeDiff } = require('../diffEngine');
const { computeBaselineForSymbol } = require('../baseline/computeBaseline');

function createWatchlistRouter({ marketDataClient }) {
const router = express.Router();

// Uniform error envelope across every endpoint — one code path on the frontend.
function errorResponse(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

// GET /watchlist — full joined view, diff computed per symbol, sorted by
// most-meaningful-first (the actual point of the product).
router.get('/watchlist', async (req, res, next) => {
  try {
    const rows = await repo.getWatchlistWithData(req.userId);

    // First pass: classify each row and compute the pieces needed for a
    // diff, without computing the diff itself yet — some rows need their
    // last_seen lazy-seeded first (see below) before a diff can be computed.
    const preComputed = rows.map((row) => {
      if (row.current_price === null) {
        return { row, noData: true };
      }

      const baseline = (row.baseline_status === 'ready' || row.baseline_status === 'low_confidence')
        ? {
            status: row.baseline_status,
            typicalDailyVolatility: Number(row.typical_daily_volatility),
            avgVolume: Number(row.avg_volume),
          }
        : { status: row.baseline_status };

      const lastSeenRaw = row.last_seen_price !== null
        ? { price: Number(row.last_seen_price), volume: row.last_seen_volume, timestamp: row.last_seen_at }
        : null;

      const current = {
        price: Number(row.current_price),
        volume: row.current_volume,
        timestamp: row.snapshot_fetched_at,
        isStale: row.is_stale,
      };

      return { row, noData: false, baseline, lastSeenRaw, current };
    });

    // Lazy-seed last_seen: fixes a real gap found under live testing — the
    // add-time seed only fires if a snapshot ALREADY exists at add time,
    // which is false for any genuinely brand-new symbol (its first
    // snapshot lands on the poller's next cycle, after the add request has
    // already returned). Without this, last_seen would never be seeded at
    // all, and the diff would permanently report "no_prior_view." Seeding
    // it here, the first time a snapshot is actually observed, correctly
    // produces "no visible change yet" on first sight and a real baseline
    // for every future comparison.
    const seedWrites = preComputed
      .filter((p) => !p.noData && p.lastSeenRaw === null)
      .map((p) =>
        repo.seedLastSeenOnAdd(req.userId, p.row.symbol, {
          price: p.current.price,
          volume: p.current.volume,
          seenAt: p.current.timestamp,
        })
      );
    if (seedWrites.length > 0) await Promise.all(seedWrites);

    const items = preComputed.map(({ row, noData, baseline, lastSeenRaw, current }) => {
      if (noData) {
        return {
          symbol: row.symbol,
          status: 'no_data_yet',
          currentPrice: null,
          diff: null,
        };
      }

      // If we just lazy-seeded above, use current-as-lastSeen so this
      // render correctly shows a true zero-diff instead of a missing value.
      const lastSeen = lastSeenRaw ?? { price: current.price, volume: current.volume, timestamp: current.timestamp };
      const diff = computeDiff(lastSeen, current, baseline);

      return {
        symbol: row.symbol,
        status: row.is_stale ? 'stale' : row.market_closed ? 'market_closed' : 'live',
        currentPrice: current.price,
        snapshotToken: row.snapshot_fetched_at, // server-issued, echoed back on ack — no client clock trust
        diff,
      };
    });

    // Most-meaningful-first: highest abs(finalScore) leads, matching "what
    // deserves attention now" from the brief. Items with no diff sort last.
    items.sort((a, b) => {
      const scoreA = a.diff ? Math.abs(a.diff.finalScore) : -1;
      const scoreB = b.diff ? Math.abs(b.diff.finalScore) : -1;
      return scoreB - scoreA;
    });

    res.json({ items });
  } catch (err) {
    next(err);
  }
});

// POST /watchlist  { symbol }
router.post('/watchlist', async (req, res, next) => {
  try {
    const symbol = String(req.body.symbol || '').trim().toUpperCase();
    if (!symbol) {
      return errorResponse(res, 400, 'missing_symbol', 'symbol is required');
    }

    const count = await repo.getWatchlistCount(req.userId);
    if (count >= repo.MAX_WATCHLIST_SIZE) {
      return errorResponse(res, 400, 'watchlist_full', `max ${repo.MAX_WATCHLIST_SIZE} symbols per watchlist`);
    }

    // Symbol-exists validation: only needed the first time this symbol is
    // ever seen (baseline table doubles as a "known valid" cache — if a
    // row already exists, some earlier add already validated it). Runs
    // BEFORE creating any DB row, so an invalid symbol never touches the
    // database at all.
    const existingBaseline = await repo.getBaseline(symbol);
    let freshQuote = null;
    if (!existingBaseline) {
      try {
        freshQuote = await marketDataClient.fetchQuote(symbol);
      } catch (err) {
        return errorResponse(res, 422, 'unknown_symbol', `could not resolve symbol "${symbol}"`);
      }
    }

    const { created } = await repo.ensureBaselineExists(symbol);
    await repo.addToWatchlist(req.userId, symbol);

    if (created) {
      // This request won the race lock — it's genuinely the first time
      // anyone has added this symbol. If we have a fresh quote from
      // validation, use it to seed an immediate snapshot rather than
      // making the user wait for the poller's next cycle.
      if (freshQuote) {
        await repo.upsertSnapshot(symbol, {
          price: freshQuote.price,
          volume: freshQuote.volume,
          isStale: false,
          marketClosed: false,
        });
      }
      // Compute its baseline now. Awaited deliberately: this only fires
      // once per symbol ever (the DB unique-constraint lock ensures
      // that), so a slightly slower first add for a brand-new symbol is
      // an acceptable, honest tradeoff versus the complexity of a
      // background job queue for a hackathon scope.
      await computeBaselineForSymbol(symbol, marketDataClient);
    }

    // Seed last_seen only if there's already a snapshot (won't exist for a
    // genuinely brand-new symbol until the poller's next cycle) — otherwise
    // the first GET correctly shows "no_data_yet" until that lands.
    const snap = await repo.getSnapshot(symbol);
    if (snap) {
      await repo.seedLastSeenOnAdd(req.userId, symbol, {
        price: snap.price,
        volume: snap.volume,
        seenAt: snap.fetched_at,
      });
    }

    res.status(201).json({ symbol, baselineTriggered: created });
  } catch (err) {
    next(err);
  }
});

// DELETE /watchlist/:symbol
router.delete('/watchlist/:symbol', async (req, res, next) => {
  try {
    const symbol = String(req.params.symbol).toUpperCase();
    await repo.removeFromWatchlist(req.userId, symbol);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST /watchlist/:symbol/ack  { snapshotToken }
// Client echoes back the server-issued token from the last GET — server
// never trusts a client-generated timestamp.
router.post('/watchlist/:symbol/ack', async (req, res, next) => {
  try {
    const symbol = String(req.params.symbol).toUpperCase();
    const snap = await repo.getSnapshot(symbol);
    if (!snap) {
      return errorResponse(res, 404, 'no_snapshot', 'no data exists for this symbol yet');
    }

    const result = await repo.ackWatchlistItem(req.userId, symbol, {
      price: snap.price,
      volume: snap.volume,
      seenAt: snap.fetched_at, // server's own value — the client-supplied token is only used for optimistic UI, not trusted here
    });

    if (!result) {
      return errorResponse(res, 409, 'stale_ack', 'a newer view has already been acknowledged');
    }

    res.json({ symbol, ackedAt: result.seen_at });
  } catch (err) {
    next(err);
  }
});

  return router;
}

module.exports = createWatchlistRouter;
