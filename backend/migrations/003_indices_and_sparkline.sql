-- migrations/003_indices_and_sparkline.sql
-- Two additive changes supporting the light-theme ticker strip + the
-- watchlist table's "Last 7 Days" sparkline:
--
-- (1) baseline.sparkline_closes — a bounded, fixed-size array of the LAST 7
-- closing prices, captured when the baseline is computed (and overwritten on
-- every daily recompute). Stored ON the baseline row so the frontend shows a
-- sparkline without re-fetching history from Yahoo on every page load, and so
-- the data can't grow unbounded over time (always exactly <= 7 numbers).
--
-- (2) index_quote — a small cache for the two headline indices shown in the
-- top ticker strip (NIFTY 50 -> ^NSEI, SENSEX -> ^BSESN). These are indices,
-- not stocks: they never enter baseline/snapshot (which are FK-bound to
-- watchable symbols), so they get their own tiny table written only by the
-- poller, the same way snapshot is written only by the poller.

CREATE TABLE IF NOT EXISTS index_quote (
  symbol TEXT PRIMARY KEY,             -- 'NIFTY' | 'SENSEX' (logical name)
  price NUMERIC(12, 2),
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_stale BOOLEAN NOT NULL DEFAULT false,
  market_closed BOOLEAN NOT NULL DEFAULT false
);

ALTER TABLE baseline ADD COLUMN IF NOT EXISTS sparkline_closes JSONB;