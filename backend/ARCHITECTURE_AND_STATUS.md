# Smart Market Watchlist — Status Report & Architecture

## 1. Where this stands, honestly

The backend is real, running, and proven — not scaffolded. **70/70 tests pass**,
every one against real infrastructure (a real local Postgres instance, a real
running Express server, real HTTP requests with real cookies) — not mocks of
each other. The frontend is built, compiles clean, and is wired to the exact
proven API contract.

This document exists because paper-planning has a blind spot: it cannot find
bugs that only exist in running code. Every bug listed in §3 was found by
actually executing the system, not by reasoning about it — several of them
(the poller-crashing DB outage, the never-implemented baseline computation,
the BIGINT/float mismatch, the permanently-stuck `no_prior_view` state) were
invisible on paper and would have been discovered live, in front of judges,
if this pass hadn't happened first.

## 2. Test coverage (61 → 70, after this session's fixes)

| Suite | Tests | Proves |
|---|---|---|
| `diffEngine.test.js` | 17 | Core "meaningfulness" algorithm — both divide-by-zero traps, stale suppression, cold-start, threshold, dampening/amplification |
| `computeBaseline.test.js` | 9 | Baseline computation reaches `ready`/`low_confidence`/`failed` correctly; BIGINT-safe volume rounding |
| `repository.test.js` | 13 | Real concurrency race lock (3 simultaneous `Promise.all` racers, real Postgres, exactly 1 winner), idempotent writes, atomic snapshot replace, ack replay rejection |
| `marketDataClient.test.js` | 9 | Retry/backoff recovery, circuit breaker open→cooldown→recover cycle |
| `poller.test.js` | 10 | Per-symbol failure isolation, overlap guard, market-hours logic, DB-outage crash regression |
| `e2e.test.js` | 12 | Full real HTTP round-trip: cookies, session isolation, add/list/ack/delete, error envelopes |

Run everything: `cd backend && npm test`

## 3. Bugs found by running the system (not found on paper)

| # | Bug | How it was found | Fix |
|---|---|---|---|
| 1 | `runCycle` had no top-level `catch` — a DB outage crashed the entire Node process | Postgres restarted under a live-running backend | Wrapped full cycle body in try/catch; process now survives, `/health` reports `degraded` instead |
| 2 | Tests silently depended on real wall-clock IST market hours, causing them to skip assertions once real time crossed 15:30 | Same test suite passed at 12:40 IST, silently degraded at 17:04 IST | Made `isMarketOpenFn` injectable everywhere; all tests are now 100% deterministic |
| 3 | Baseline computation was **designed extensively but never implemented** — every diff was permanently stuck at `baseline_not_ready` | Live curl session showed `baseline_not_ready` on every symbol | Built `computeBaseline.js`, wired it to fire on first-ever add via the existing DB-lock (`created` flag) |
| 4 | `avg_volume` is `BIGINT` in Postgres; computed average volume is a float → every baseline computation silently failed | Log line in an unrelated e2e test run: `invalid input syntax for type bigint` | Round to integer before writing |
| 5 | `computeBaseline.js` had zero direct test coverage — bug #4 only surfaced as a stray log line, easy to miss | Noticed the log line while re-verifying something else | Added 9 dedicated tests |
| 6 | `last_seen` seeding only fired if a snapshot already existed at add-time — for a genuinely new symbol (the common case) it never seeded, so diffs stayed `no_prior_view` forever | Live curl session, clean DB, real poll cycle | Added lazy-seed at the read layer: first time a snapshot is actually observed, seed `last_seen` to it |
| 7 | Local dev/testing had no clean-slate mechanism — automated test runs and manual curl sessions silently polluted each other's data in the shared local DB, producing a nonsensical 359x "meaningful" score | Manual verification run showed an absurd score after prior test data leaked in | Added `scripts/reset-dev-db.sql` |
| 8 | No demo-mode data path — without a live NSE/BSE key, the app had nothing to show | Realized while trying to verify live behavior in this sandbox (no network path to a real market API host) | Built `demoProvider.js` as a first-class, explicitly-labeled fallback (`MARKET_DATA_PROVIDER=demo`), not a silent hack |

## 4. Full architecture (as built)

```
┌─────────────────────────────────────────────────────────────────┐
│  FRONTEND (React + Vite)                                        │
│  Deployed: Vercel/Netlify (static, serverless-fine)              │
│                                                                    │
│  App.jsx — polls GET /watchlist every 20s, paused when tab hidden│
│  WatchlistRow.jsx — renders 4 states: live / stale /             │
│                      market_closed / no_data_yet                 │
│  AddSymbolForm.jsx — debounced, disabled while in-flight          │
│  ErrorBoundary.jsx — one bad render doesn't blank the page        │
│  api.js — thin client, credentials:'include' for session cookie   │
└─────────────────────────────┬─────────────────────────────────────┘
                               │ HTTPS, CORS(credentials:true)
┌─────────────────────────────▼─────────────────────────────────────┐
│  BACKEND (Node/Express)                                          │
│  Deployed: Render/Railway (long-running process — poller needs it)│
│                                                                    │
│  session.js — anonymous HMAC-signed cookie identity                │
│  routes/watchlist.js — GET/POST/DELETE/ack, uniform error envelope│
│  routes/health.js — DB + poller + circuit-breaker status           │
│  diffEngine.js — PURE function: (lastSeen, current, baseline)      │
│                   → { finalScore, isMeaningful, direction, ... }   │
│  baseline/computeBaseline.js — historical candles → volatility/    │
│                                  avgVolume → status                │
│  poller/poller.js — per-symbol isolated, overlap-guarded,          │
│                      market-hours-aware, top-level-caught          │
│  marketData/client.js — retry+backoff+circuit breaker,             │
│                          provider-agnostic interface                │
│  marketData/demoProvider.js — explicit simulated-data fallback      │
│  db/repository.js — every query, race locks via DB unique          │
│                      constraints, idempotent writes                 │
└─────────────────────────────┬─────────────────────────────────────┘
                               │ pg (parameterized queries only)
┌─────────────────────────────▼─────────────────────────────────────┐
│  POSTGRES                                                          │
│  Deployed: Neon/Supabase (managed, survives backend restarts)      │
│                                                                    │
│  users · baseline · snapshot · watchlist_entry · last_seen         │
│  (see migrations/001_init.sql for exact schema)                    │
└─────────────────────────────────────────────────────────────────┘
```

### Data flow for the core "what changed" loop

1. User adds a symbol → `ensureBaselineExists` (DB-unique-constraint race lock)
   → if this request won the lock, `computeBaselineForSymbol` runs synchronously
2. Poller (30s interval, market-hours-aware) fetches each **uniquely watched**
   symbol once, writes an atomic snapshot replace
3. `GET /watchlist` joins watchlist + snapshot + baseline + last_seen in one
   query, lazy-seeds `last_seen` on first sight, computes the diff via the
   pure `computeDiff` function, sorts most-meaningful-first
4. User acks → server-issued `snapshotToken` is echoed back (never a
   client-generated timestamp) → `last_seen` updates, replay-protected

## 5. What's still an explicit, marked wiring point

**Real NSE/BSE market data provider.** This sandbox has no network path to
any live market API host, so this could never be genuinely tested here.
Everything is built against a provider-agnostic interface
(`{ fetchQuote, fetchHistorical }`) specifically so this is a one-file swap:
implement that interface against a real API, point `MARKET_DATA_PROVIDER`
at it (or default away from `demo`), and every other proven layer — retry,
circuit breaker, poller isolation, baseline computation, routes — works
unchanged underneath it.

**Symbol-exists validation** on add currently trusts the input beyond
uppercasing it — the real check (call `fetchQuote` once before accepting)
needs the real provider wired in to be meaningful; the wiring point is
explicitly marked in `routes/watchlist.js`.

## 6. What's next, in priority order

1. **Wire a real market data provider.** Free NSE/BSE-backed wrappers exist;
   implement the two-method interface, test locally, deploy.
2. **Deploy for real**, following the deployment decisions already locked
   (Render/Railway + Neon/Supabase + Vercel, env-var secrets, `npm ci`,
   pinned Node version, external keep-alive ping).
3. **Symbol-exists validation** on add, now that a real provider exists to
   validate against.
4. **Visual polish pass** on the frontend with real data flowing — the
   ledger design is built and compiles, but hasn't been eyeballed against
   real-looking numbers in a real browser yet.
5. Optional, if time allows: swap the fixed 30s/20s polling intervals for
   env-configurable values, add the daily baseline-refresh cron job (only
   the on-add trigger exists today).
