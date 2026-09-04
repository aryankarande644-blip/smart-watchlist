# Watchlist Backend

Backend for the Smart Market Watchlist. Express + Postgres + a real market
data provider (yahoo-finance2, `.NS` NSE tickers). 104/104 tests pass —
run `npm test`.

## What's real and tested

- Diff engine (the core "meaningfulness" algorithm) — pure function, 17 tests
- Postgres schema + repository layer, including the concurrency race lock — 13 tests
- Retry/backoff + circuit breaker for the market data client — 9 tests
- **Real market data provider** (`yahoo-finance2`) — 15 tests, and
  **live-verified** against real `query1.finance.yahoo.com` data (quotes,
  history, invalid-symbol rejection). In-progress-day candle handling
  included (see `src/marketData/realProvider.js`).
- Poller: per-symbol isolation, overlap guard, real 2026 NSE holiday
  calendar, market-hours awareness — 13 tests
- Daily baseline-refresh job (default 18:30 IST, off-market) — 11 tests
- Full Express API over real HTTP, real cookies/sessions, symbol
  validation (422 on unknown), CSRF origin-check hardening — 17 tests

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgresql://app:app_local_dev@localhost:5432/watchlist_dev` | Postgres connection |
| `PORT` | `3001` | HTTP port |
| `MARKET_DATA_PROVIDER` | `real` | `real` (yahoo-finance2) or `demo` (simulated, explicitly labeled) |
| `FRONTEND_ORIGIN` | `http://localhost:5173` | CORS allow-origin + CSRF Origin check |
| `SESSION_SECRET` | `dev-only-secret-change-in-prod` | HMAC key for the session cookie |
| `POLL_INTERVAL_MS` | `30000` | Upstream polls per symbol cycle |
| `BASELINE_REFRESH_TIME_IST` | `18:30` | Daily off-market baseline recompute time (24h IST) |

## Local setup

```
npm install
psql < migrations/001_init.sql   # against your Postgres
DATABASE_URL=postgresql://... npm start
```

Run in demo mode (works anytime, no network to Yahoo needed):

```
MARKET_DATA_PROVIDER=demo npm start
```

## Run the full proven test suite

```
npm test
```

Needs Postgres reachable (`src/db/pool.js` for the default DSN).