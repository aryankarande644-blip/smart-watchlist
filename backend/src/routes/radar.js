// src/routes/radar.js
const express = require('express');
const repo = require('../db/repository');
const { computeDiff } = require('../diffEngine');
const { radarBadge } = require('../radar/badge');
const { RADAR_UNIVERSE } = require('../marketData/radarUniverse');

function createRadarRouter() {
  const router = express.Router();

  // User-specific (it excludes the requesting user's own watchlist symbols),
  // so it goes through the same auth guard as /watchlist — a valid session
  // is required, matching the pattern in routes/watchlist.js.
  router.use((req, res, next) => {
    if (!req.userId) {
      return res.status(401).json({ error: { code: 'not_authenticated', message: 'sign in required' } });
    }
    next();
  });

  // GET /radar — top 5 movers from the curated universe, excluding anything
  // the requesting user already watches.
  //
  // Scoring is market-wide, not per-user: each symbol's current price is
  // compared against its OWN baseline (the recent "normal" volatility), with
  // no last_seen. This is "what's moving right now," where a move is
  // "unusual relative to the stock's own typical behavior" — exactly the
  // same normalize-and-compare idea as the watchlist, but stateless per user.
  //
  // Pure, per-request computation from the poller-cached snapshot + baseline
  // tables; nothing is written here.
  router.get('/radar', async (req, res, next) => {
    try {
      const userWatchlist = (
        await repo.getWatchlistWithData(req.userId)
      ).map((row) => row.symbol);

      // Candidates = the curated universe minus what this user already tracks.
      const candidates = RADAR_UNIVERSE.filter((s) => !userWatchlist.includes(s));

      const rows = await repo.getRadarData(candidates);

      const scored = rows
        .map((row) => {
          // Only score symbols that have both a fresh snapshot and a ready
          // baseline — otherwise the move is meaningless.
          if (row.current_price === null) return null;
          const baseline = (row.baseline_status === 'ready' || row.baseline_status === 'low_confidence')
            ? {
                status: row.baseline_status,
                typicalDailyVolatility: Number(row.typical_daily_volatility),
                avgVolume: Number(row.avg_volume),
              }
            : { status: row.baseline_status };

          const current = {
            price: Number(row.current_price),
            volume: row.current_volume === null ? null : Number(row.current_volume),
            timestamp: row.snapshot_fetched_at,
            isStale: row.is_stale,
          };

          // Radar = "moving right now", market-wide, so there's no per-user
          // last_seen to compare against (that's the watchlist's job). The
          // natural prior reference is the symbol's own most recent completed
          // close — the last point of its sparkline_closes (the same cached
          // history we show on the card). Using it reuses existing data, needs
          // no new schema, and gives a real day-over-last-close change %.
          const sparkline = Array.isArray(row.sparkline_closes) ? row.sparkline_closes : [];
          const lastClose = sparkline.length ? Number(sparkline[sparkline.length - 1]) : null;
          const hasReference = lastClose !== null && !Number.isNaN(lastClose) && lastClose > 0;

          const lastSeen = hasReference
            ? { price: lastClose, volume: row.avg_volume, timestamp: row.snapshot_fetched_at }
            : current; // no reference yet -> treat current as the prior (zero move)

          const diff = computeDiff(lastSeen, current, baseline);

          const changePct = hasReference
            ? ((current.price - lastClose) / lastClose) * 100
            : 0;
          const avgVolume = row.avg_volume === null ? null : Number(row.avg_volume);
          const badge = radarBadge(diff);

          return {
            symbol: row.symbol,
            currentPrice: current.price,
            changePct,
            previousClose: hasReference ? lastClose : null,
            currentVolume: current.volume,
            avgVolume,
            sparklineCloses: row.sparkline_closes,
            diff,
            badge,
          };
        })
        .filter((x) => x !== null)
        // Only surface actual movers — the "top movers" brief. A no-badge
        // symbol isn't moving meaningfully.
        .filter((x) => x.badge !== null)
        // Sort by absolute score descending — most-unusual-move first.
        .sort((a, b) => Math.abs(b.diff.finalScore) - Math.abs(a.diff.finalScore))
        .slice(0, 5);

      res.json({ items: scored });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createRadarRouter };