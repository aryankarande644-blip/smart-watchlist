-- migrations/001_init.sql
-- This is the exact schema we designed: users, watchlist_entry, baseline,
-- snapshot, last_seen. Numbered migration files, run in order on deploy —
-- decided once, no hand-editing prod schema live.

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE baseline (
  symbol TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'low_confidence', 'failed'))
    DEFAULT 'pending',
  typical_daily_volatility DOUBLE PRECISION,
  avg_volume BIGINT,
  history_days_used INT,
  last_computed_at TIMESTAMPTZ
);

CREATE TABLE snapshot (
  symbol TEXT PRIMARY KEY REFERENCES baseline(symbol),
  price NUMERIC(12, 2) NOT NULL,
  volume BIGINT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_stale BOOLEAN NOT NULL DEFAULT false,
  market_closed BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE watchlist_entry (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL REFERENCES baseline(symbol),
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, symbol)
);

CREATE TABLE last_seen (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  price NUMERIC(12, 2) NOT NULL,
  volume BIGINT,
  seen_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, symbol)
);

-- Speeds up the poller's "DISTINCT symbol FROM watchlist_entry" query,
-- which runs every poll cycle.
CREATE INDEX idx_watchlist_entry_symbol ON watchlist_entry(symbol);
