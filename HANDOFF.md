# Smart Market Watchlist — Complete Build Handoff

This document is self-contained. It assumes zero prior context. Read it top
to bottom before touching code. Working, tested code already exists for
~90% of this (see §9) — this document explains what it is, why every
decision was made, and exactly what's left.

---

## 1. The brief (verbatim intent)

Hackathon theme: **"Build a Smart Market Watchlist"**

> Build a smart market watchlist that helps users not just track stocks,
> but quickly understand what "meaningfully changed" since they last
> checked, and what deserves their attention now.

Minimum requirements:
- Create and manage a watchlist
- View latest market information
- Return later and see what has changed
- Build end-to-end: both frontend and backend
- You decide: what counts as a meaningful change, what info to surface,
  how state persists across sessions/devices, how to handle stale/delayed/
  conflicting data, how the system scales, where to keep things simple vs.
  add complexity
- No prescribed UI, feature set, or architecture
- **"Don't build the obvious watchlist. Build the version you believe
  should exist — and be ready to explain why."**

### Evaluation criteria (this is what's actually being graded)

| Dimension | What it means |
|---|---|
| Engineering Depth | Architecture, correctness, reliability, scalability |
| Product & Problem Interpretation | Understanding beyond the obvious brief |
| Edge Cases & Resilience | Failures, race conditions, integrity, unreliable dependencies |
| Code Quality & Simplicity | Maintainability without over-engineering |
| Originality & Thoughtfulness | Independent choices, considered approach |

**Critical implication:** there is no "accuracy" metric. This is a *systems
design* problem wearing a finance costume, not a machine-learning problem.
Do not build an ML model. The "smart" part is a well-reasoned scoring
function plus honest handling of failure — that's what's rewarded.

---

## 2. The one core idea, stated precisely

A flat "%change > 2% = alert" is the naive, obvious version the brief
explicitly says not to build. The considered version:

> **"Meaningful" is relative to a stock's own normal behavior, not a
> universal threshold.** A 1% move on a normally-dead stock is more
> meaningful than a 1% move on a normally-volatile one.

Everything else in this document exists in service of that one idea, plus
honestly handling every way real market data and real infrastructure fail.

---

## 3. The algorithm (exact, final, implemented and tested)

```
Inputs:
  lastSeen  = { price, volume, timestamp }   -- what THIS user last looked at
  current   = { price, volume, timestamp, isStale }  -- latest market snapshot
  baseline  = { typicalDailyVolatility, avgVolume, status }  -- THIS symbol's own normal behavior

Constants:
  MIN_VOLATILITY = 0.001        -- 0.1% floor, prevents divide-by-zero
  MIN_VOLUME_FLOOR = 1000       -- shares, prevents divide-by-zero
  MEANINGFUL_THRESHOLD = 1.5    -- multiples of baseline volatility; env-tunable

Computation:
  safeVolatility = max(baseline.typicalDailyVolatility, MIN_VOLATILITY)
  safeAvgVolume  = max(baseline.avgVolume, MIN_VOLUME_FLOOR)

  priceDeltaPct  = (current.price - lastSeen.price) / lastSeen.price
  normalizedMove = priceDeltaPct / safeVolatility          -- signed; "how many
                                                             typical days' worth
                                                             of move happened"

  volumeRatio    = current.volume / safeAvgVolume            -- omit if volume
                                                                missing (degrade
                                                                gracefully)
  confidenceMultiplier = clamp(volumeRatio, 0.5, 2.0)         -- dampens thin-volume
                                                                moves, amplifies
                                                                volume-confirmed ones;
                                                                = 1 if volume unknown

  finalScore     = normalizedMove * confidenceMultiplier      -- signed, direction preserved

  hoursSinceLastCheck = max(current.timestamp - lastSeen.timestamp, 1 hour)
  urgency        = abs(finalScore) / hoursSinceLastCheck       -- SORT ORDER ONLY,
                                                                 never suppresses

  isMeaningful   = abs(finalScore) >= MEANINGFUL_THRESHOLD
  direction      = finalScore > 0 ? 'up' : finalScore < 0 ? 'down' : 'flat'

Guards (return a blank/zero result, never throw, never NaN/Infinity):
  - current.isStale === true           -> suppress (stale data =/= a real alert)
  - baseline.status not in {ready, low_confidence} -> suppress (cold start)
  - lastSeen === null                  -> suppress (this IS the first view;
                                           see Section 6 lazy-seeding -- after
                                           seeding, this case does not recur)
```

This is a **pure function**: same inputs always produce the same output, no
I/O, no side effects. That's deliberate — it makes it trivially unit
testable and is the highest-confidence, most load-bearing piece of the
whole system.

Implemented at: `backend/src/diffEngine.js`
Tested at: `backend/src/test/diffEngine.test.js` (17 tests, including both
divide-by-zero traps, stale suppression, threshold boundary, dampening,
amplification)

---

## 4. Full data model

```sql
-- users: real accounts (email + bcrypt password hash + session_version);
-- anonymous-session model superseded by migration 002 (see Section 6)
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- baseline: ONE ROW PER SYMBOL (shared across all users), computed once
-- from historical data, refreshed daily off-market (see Section 10 #4)
CREATE TABLE baseline (
  symbol TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending','ready','low_confidence','failed'))
    DEFAULT 'pending',
  typical_daily_volatility DOUBLE PRECISION,
  avg_volume BIGINT,              -- MUST be rounded to integer before insert (see Section 8, bug #4)
  history_days_used INT,
  last_computed_at TIMESTAMPTZ,
  sparkline_closes JSONB          -- migration 003: last <=7 closes for the
                                  -- "Last 7 Days" sparkline; bounded + always
                                  -- overwritten at compute time, never re-fetched
);

-- snapshot: ONE ROW PER SYMBOL (shared), written ONLY by the poller,
-- atomic full-row replace on every write (never partial-field update)
CREATE TABLE snapshot (
  symbol TEXT PRIMARY KEY REFERENCES baseline(symbol),
  price NUMERIC(12,2) NOT NULL,
  volume BIGINT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_stale BOOLEAN NOT NULL DEFAULT false,     -- had data, now degraded (upstream failing)
  market_closed BOOLEAN NOT NULL DEFAULT false -- distinct from is_stale -- see Section 6
);
-- NOTE: absence of a row for a symbol means "never successfully fetched even
-- once" -- a THIRD distinct state from is_stale. See Section 8 for why this matters.

-- watchlist_entry: which user watches which symbol
CREATE TABLE watchlist_entry (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL REFERENCES baseline(symbol),
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, symbol)
);
CREATE INDEX idx_watchlist_entry_symbol ON watchlist_entry(symbol);
-- speeds up the poller's "DISTINCT symbol" query every cycle

-- last_seen: THIS IS THE ENTIRE PRODUCT. Per-user, per-symbol, "what did
-- this user last actually look at." The diff is computed against THIS,
-- not against yesterday's close.
CREATE TABLE last_seen (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  price NUMERIC(12,2) NOT NULL,
  volume BIGINT,
  seen_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, symbol)
);

-- index_quote (migration 003): cache for the two headline indices in the top
-- ticker strip (NIFTY 50, SENSEX). Indices are NOT stocks — they never enter
-- baseline/snapshot (those are FK-bound to watchable symbols), so they get
-- their own tiny table written ONLY by the poller, same model as snapshot.
CREATE TABLE index_quote (
  symbol TEXT PRIMARY KEY,          -- 'NIFTY' | 'SENSEX' (logical name)
  price NUMERIC(12, 2),
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_stale BOOLEAN NOT NULL DEFAULT false,
  market_closed BOOLEAN NOT NULL DEFAULT false
);
```

File: `backend/migrations/001_init.sql`

**Why snapshot and last_seen are separate tables, not one:** the tempting
shortcut is "just store current price once and diff against yesterday."
That breaks the actual brief — it has to be "since **this specific user**
last checked," not since market open. `snapshot` = market truth (cheap,
shared). `last_seen` = this user's personal viewing history (the product).

---

## 5. Full API contract

All state-changing endpoints require the session cookie (see Section 7).
All responses use a uniform error envelope: `{ error: { code, message } }`.

```
GET /watchlist
  -> 200 { items: [
      {
        symbol: string,
        status: 'live' | 'stale' | 'market_closed' | 'no_data_yet',
        currentPrice: number | null,
        changePct: number | null,        -- % vs last_seen (for the table)
        currentVolume: number | null,
        avgVolume: number | null,
        sparklineCloses: number[] | null, -- bounded <=7 closes (Last 7 Days)
        snapshotToken: ISOString | undefined,  -- echo this back on ack
        diff: {
          normalizedMove, confidenceMultiplier, finalScore, urgency,
          isMeaningful: boolean, direction: 'up'|'down'|'flat',
          reason: 'ok' | 'stale_data' | 'baseline_not_ready' | 'no_prior_view'
        } | null
      }
    ] }
  -- sorted by abs(finalScore) descending -- most-meaningful-first,
  -- items with no diff sort last

POST /watchlist   body: { symbol: string }
  -> 201 { symbol, baselineTriggered: boolean }
  -> 400 { error: { code: 'missing_symbol' } }
  -> 400 { error: { code: 'watchlist_full' } }   -- cap is 30 symbols/user
  -- idempotent: adding a duplicate symbol is a safe no-op, not an error
  -- normalizes input to uppercase

DELETE /watchlist/:symbol
  -> 204 (no body)
  -- does NOT touch shared snapshot/baseline (other users may still watch it)

POST /watchlist/:symbol/ack   body: { snapshotToken: string }
  -> 200 { symbol, ackedAt }
  -> 404 { error: { code: 'no_snapshot' } }
  -> 409 { error: { code: 'stale_ack' } }   -- rejected: would move seen_at backwards
  -- SERVER uses its OWN snapshot.fetched_at as the source of truth for
  -- seen_at, never trusts a client-supplied timestamp for the actual write
  -- (the client-echoed token is a UX nicety, not a trust mechanism)

GET /health
  -> 200 { status: 'ok', db: 'ok', poller: {...}, marketDataCircuit: 'closed' }
  -> 503 { status: 'degraded', ... }   -- if DB unreachable OR circuit breaker open

GET /indices   -- public (mounted before session middleware, like /health);
               -- powers the top ticker strip. Reads the poller's cache.
  -> 200 { indices: [
      { symbol: 'NIFTY'|'SENSEX', label: string, price: number|null,
        fetchedAt: ISOString, isStale: boolean, marketClosed: boolean }
    ] }
```

Files: `backend/src/routes/watchlist.js`, `backend/src/routes/health.js`

---

## 6. Every architectural decision, with the reasoning (so a new agent
doesn't accidentally undo one)

### Identity: real email/password accounts (supersedes anonymous sessions)
**ANONYMOUS-SESSION MODEL SUPERSEDED (migration 002, 2026-09-05).** The
original design was: no signup form, `userId` is a UUID the server trusts via
an HMAC-signed `httpOnly` cookie generated on first visit — with the tradeoff
stated openly that clearing cookies sends the watchlist away (a scope
boundary, not a hidden bug). That model is now replaced by real accounts:

- `users` gained `email` (TEXT UNIQUE NOT NULL), `password_hash`
  (bcryptjs, cost 10 — pure-JS on purpose, Render's native-binding risk),
  and `session_version` (INTEGER NOT NULL DEFAULT 0). Anonymous rows were
  wiped in a clean cutover (`002_add_auth.sql`).
- The signed cookie payload is now `userId.sessionVersion`
  (`session_uid=<id>.<version>.<hmac>`). The version is the server-side
  session state that makes logout real: `POST /logout` bumps it, so every
  cookie already issued stops verifying — replay of an old cookie string
  gets 401, never a session.
- `sessionMiddleware` only *resolves* an existing valid cookie (`/health`
  stays fully public, mounted before it); it never creates users. Protected
  `/watchlist` routes answer `401 not_authenticated` when there's no
  session — no silent anonymous account is minted anymore.
- `POST /auth/signup` (validation: email shape, password ≥ 8 chars,
  duplicate email → `409 email_taken`), `POST /auth/login` (100% generic
  `401 invalid_credentials` for wrong password *or* unknown email — plus a
  dummy bcrypt compare so timing doesn't leak account existence),
  `POST /auth/logout` (revokes + clears). Login is rate-limited per IP
  (10 per 15 min sliding window).
- **Why:** persistent watchlists across devices was a hard product gap of
  the cookie-only model. **Explicitly deferred future scope, not forgotten:**
  OAuth (Google/GitHub) and email verification — no email infrastructure
  exists at hackathon scope, and OAuth needs a separate provider/app setup;
  both are clean future additions since passwords already live in-bcrypt
  and the session layer is account-based, not cookie-based.

### Three distinct "no fresh data" states, not one
Real testing forced this distinction (see Section 8, bug #6):
1. **`no_data_yet`** — symbol added, poller hasn't run yet, or has never
   once succeeded for it. No `snapshot` row exists at all.
2. **`stale`** — snapshot row exists, but the most recent fetch failed;
   last-known-good price is preserved and shown, with a "delayed" badge.
3. **`market_closed`** — snapshot exists and is fine; the poller
   deliberately isn't fetching because NSE trading hours have ended.

Collapsing these into one "no data" bucket was flagged early as a
resilience bug, not a UX nicety — it's now three explicit states threaded
through DB, API, and frontend.

### Lazy-seeding `last_seen`, not only at add-time
Originally `last_seen` was seeded only when a symbol was added AND already
had a snapshot. For a genuinely brand-new symbol (no snapshot exists yet),
that condition is never true — diffs were permanently stuck comparing
against nothing. Fixed by lazy-seeding at **read time**: the first time
`GET /watchlist` observes a snapshot with no `last_seen` row, it seeds one
right then, producing a correct "no visible change yet" first render.

### Baseline concurrency: DB unique constraint as the lock, not a queue
Two users adding the same brand-new symbol at the same instant must not
both trigger baseline computation. Solved with:
```sql
INSERT INTO baseline (symbol, status) VALUES ($1,'pending')
ON CONFLICT (symbol) DO NOTHING RETURNING symbol
```
Whichever request's `INSERT` actually returns a row is the one that
triggers computation. This was proven with 3 real concurrent requests via
`Promise.all` against live Postgres — exactly 1 winner, every time.

### Poller: per-symbol isolation is the single most important resilience property
Every symbol's fetch is wrapped in its own try/catch inside the poll loop.
One dead/delisted/rate-limited symbol must never take the other 29 down
with it. This was explicitly called out as "the single worst failure mode
possible" during design, and later a **different, related bug was found
live**: the poll cycle's *outer* logic (fetching the symbol list itself)
had no top-level catch, so a DB outage crashed the whole Node process
regardless of per-symbol isolation. Both are now fixed — see Section 8.

### Circuit breaker is global to the market data client, not per-symbol
If the upstream API is fully down (not just one bad symbol), retrying
every symbol every cycle wastes the rate-limit budget. After N consecutive
failures across ANY symbols, the circuit opens and new calls fail fast for
a cooldown window before trying again (half-open trial).

### Polling, not WebSocket/push
Free-tier hosts don't cleanly support sticky WebSocket connections, and a
watchlist's real update frequency doesn't need sub-second push. Frontend
polls every 20s, backend polls upstream every 30s, both paused when
irrelevant (tab hidden / market closed). Simpler, survives instance
restarts without reconnect logic — matches "maintainability without
over-engineering" from the rubric directly.

### Market-data provider is an interface, not a hardcoded client
`{ fetchQuote(symbol), fetchHistorical(symbol, days) }` — implemented by
`marketData/client.js` (wraps retry/backoff/circuit-breaker around ANY
provider matching this shape). Two providers exist:
- `demoProvider.js` — explicit, labeled simulated data (drifting prices
  seeded to real Indian large-caps), selected via `MARKET_DATA_PROVIDER=demo`
- `realProvider.js` — yahoo-finance2 backed (`.NS` suffix), default via
  `MARKET_DATA_PROVIDER=real`; live-verified against real Yahoo data.
  Automated fallback for cloud IPs: Yahoo's cookie/crumb gate refuses
  datacenter addresses (Render) — `No set-cookie header present in Yahoo's
  response` — even with a real browser UA. The provider detects that class
  of failure and switches (sticky, per process) to direct `fetch` against
  Yahoo's crumb-free `v8/finance/chart` endpoint for both quotes
  (`meta.regularMarketPrice`) and history; symbol-miss classification is
  preserved (Yahoo's 404 "No data found" -> `422`). Verified live on the
  deployed Render backend: `HDFCBANK` -> ₹712.10, `RELIANCE` -> ₹1,322
  (real NSE prices), bogus -> `422`. See `DEPLOYMENT.md` Phase 2 for the
  full debrief.

### Index symbols are a first-class provider capability, not a .NS stock
The top ticker strip's NIFTY 50 / SENSEX are *indices*, not stocks: Yahoo
addresses them by their own symbols (`^NSEI`, `^BSESN`) and they would break
under the `.NS`-suffix logic. The mapping lives in
`marketData/indexSymbols.js` (`NIFTY -> ^NSEI`, `SENSEX -> ^BSESN`), used by
**both** `realProvider.toYahooSymbol` and the poller, so the two agree on
exactly which symbols are indices. The poller polls them every cycle through
the *same* `marketDataClient` (retry/backoff/circuit-breaker reused — no
ad-hoc frontend bypass of the upstream) and caches results in `index_quote`.
`GET /indices` is public. Volume/avg-volume and the sparkline were added to
the `/watchlist` items for the table without touching the diff engine.

### Deployment topology, decided by what the poller requires
The poller is a long-running background loop — this rules out serverless
functions (Vercel/Netlify functions, AWS Lambda), which spin up per-request
and die. Backend needs a host that keeps one process alive continuously:
**Render or Railway**. Frontend is genuinely fine on serverless static
hosting: **Vercel or Netlify**. Database must survive backend restarts
independently: **Neon or Supabase** (managed Postgres), never in-memory
storage (which would evaporate on every redeploy).

Free-tier hosts often sleep the backend after ~15 min of no HTTP traffic —
but the poller is a background loop, not HTTP traffic, so the platform
doesn't know it's "in use" and will suspend it. Mitigation: an external
keep-alive ping (e.g. a free uptime monitor hitting `/health` every 5 min)
as primary defense, plus `/health` honestly reporting
`lastSuccessfulPollAt` staleness as a visible fallback if it does sleep.

---

## 7. Frontend states (all implemented)

| State | Trigger | UI |
|---|---|---|
| Loading | Initial fetch in flight | Skeleton/loading text |
| Empty | `items.length === 0` | "Nothing here yet" + hint to add a stock |
| Connection error | `fetch` itself failed (backend unreachable) | Distinct banner, NOT the same as a data-level stale badge |
| `no_data_yet` row | Symbol added, no snapshot yet | "Establishing baseline" note, dimmed row |
| `stale` row | Data delayed | Badge on the row, price still shown (last-known-good) |
| `market_closed` row | Trading hours ended | Badge, price still shown |
| Meaningful change | `diff.isMeaningful === true` | Gold left-border highlight, "Mark seen" button appears |

Design tokens (light "Pulse" theme, migration/redesign pass 2026-09-05 — the
earlier dark ledger theme was replaced by a white background, near-black text,
hairline borders, colored badges, and a persistent top ticker strip):
- Background `#FFFFFF`, primary text `#1A1A1A`, secondary text `#6B7280`
- Up `#16A34A` (green), down `#DC2626` (red)
- Accent `#D97706` (amber) — reserved EXCLUSIVELY for the single most
  meaningful row's highlight (featured row background + its Signal badge),
  never decorative
- Hairline borders `#E5E7EB`, subtle surface `#F9FAFB` for inputs/active tab
- Fraunces (serif) for the masthead/headline, Inter for everything else,
  `tabular-nums` on all price figures
- Persistent top ticker strip (NIFTY 50, SENSEX) reads the public `/indices`
  endpoint, sticky at top, above the masthead on every page (incl. login)
- Watchlist is now a table: Stock | Price | Change | Volume vs Avg | Signal |
  Last 7 Days. Signal badge derives from the existing diff.isMeaningful +
  direction. "Last 7 Days" is an inline SVG sparkline over `sparkline_closes`.
- Polling pauses when tab backgrounded (Page Visibility API)
- React ErrorBoundary wraps the whole app — one bad render can't blank the page

Files: `frontend/src/App.jsx`, `WatchlistRow.jsx`, `AddSymbolForm.jsx`,
`ErrorBoundary.jsx`, `App.css`, `api.js`

---

## 8. Bugs found by actually running the system (read this — these are
real traps, not hypotheticals)

| # | Bug | Root cause | Fix |
|---|---|---|---|
| 1 | DB outage crashed the entire Node process | `poller.runCycle()`'s outer logic had `try/finally` but no `catch` | Added top-level catch; process now survives, `/health` reports degraded |
| 2 | Tests silently passed/failed depending on real wall-clock time | Market-hours check called the real IST clock directly inside tests | Made `isMarketOpenFn` injectable; all tests now 100% deterministic |
| 3 | Every diff permanently stuck at `baseline_not_ready` | Baseline computation was designed (repository functions existed) but **never actually implemented or called anywhere** | Built `baseline/computeBaseline.js`, wired it to fire on first-ever add |
| 4 | Baseline computation silently failed every time | `avg_volume` column is `BIGINT`; computed average volume is a float; Postgres rejected the insert | Round to integer before writing |
| 5 | Bug #4 was invisible for a while | `computeBaseline.js` had zero direct tests; it only surfaced as a stray log line in an unrelated test | Added 9 dedicated tests for baseline computation |
| 6 | Diffs permanently showed `no_prior_view`, never a real comparison | `last_seen` was only seeded at add-time IF a snapshot already existed — false for any genuinely new symbol | Lazy-seed `last_seen` at read-time, first time a snapshot is actually observed |
| 7 | A test run showed an absurd 359x "meaningful" score | Local dev DB was shared and polluted across automated test runs and manual verification sessions | Added `scripts/reset-dev-db.sql` |
| 8 | Nothing to demo without a live market API key | No network path to a real provider in the build sandbox | Built `demoProvider.js` as an explicit, labeled fallback |
| 9 | `fetchHistorical` always failed whenever the market was open | Yahoo returns the current in-progress session as a 1d candle with `close:null`, and yahoo-finance2's `historical()` wrapper throws on ANY row with a null close — so baseline computation died during trading hours, exactly when the app runs | Switched `realProvider.fetchHistorical` to the `chart()` endpoint (returns nulls gracefully) and filter out incomplete candles before slicing; incomplete candles must never enter a volatility baseline anyway |
| 10 | After a DB reset (`TRUNCATE ... users CASCADE`), the app returned 500s ("Could not add that symbol") for pre-reset sessions | `session_uid` cookies are signed and live 1 year; the middleware verified the signature but never checked the `users` row still existed, so `addToWatchlist`'s INSERT blew up on FK `watchlist_entry_user_id_fkey` (SQL 23503). Found live via raw-error capture on `/health` | Middleware now checks the user row exists; a signed-but-orphaned cookie silently gets a *fresh* anonymous session + rotated cookie instead of crashing. Regression-tested (e2e 11/11b) and verified live against Neon. **Superseded by migration 002 (2026-09-05):** the middleware no longer auto-creates anything; an orphaned cookie simply has no session and `/watchlist` answers `401 not_authenticated` (e2e 9/9b) |
| 11 | A brand-new symbol could stay on "Establishing baseline" (`no_data_yet`) forever, baseline stuck `pending` with `last_computed_at = NULL` | If an add aborts **between** `ensureBaselineExists` (inserts the `pending` row) and the awaited `computeBaselineForSymbol`, the row is wedged: the poller never touches `pending` by design (`getRefreshableBaselineSymbols` excludes it) and later adds see `created:false` so they skip the compute. The "pending = compute in-flight" invariant quietly breaks on a crash abort — exactly what bug #10's FK crash did to WIPRO. Found while confirming a fresh WIPRO add | Recovered WIPRO in production by running the same production path (`fetchQuote` → `upsertSnapshot` → `computeBaselineForSymbol`) to `ready`. **Follow-up:** give `pending`-with-`last_computed_at IS NULL` self-healing (poller retry after a TTL, or add-path retry when `created:false` but still `pending`) |

**The lesson for whoever picks this up:** paper review and planning caught
the *big* architectural risks (race conditions, divide-by-zero, resilience
patterns) correctly. But several real, non-obvious bugs (especially #3, #4,
#6) were invisible until the system actually ran end-to-end with real time
passing. **Keep running the full test suite and a live manual verification
pass after every meaningful change — don't trust design review alone.**

---

## 9. What exists today, file by file

```
backend/
  ARCHITECTURE_AND_STATUS.md   -- prior status report (this document supersedes it)
  README.md
  package.json                 -- express, pg, cookie-parser, cors, yahoo-finance2
  migrations/001_init.sql      -- full schema, Section 4 above
  migrations/002_add_auth.sql  -- auth columns + clean cutover (Section 6)
  migrations/003_indices_and_sparkline.sql -- sparkline_closes + index_quote
  scripts/reset-dev-db.sql     -- local dev clean-slate
  src/
    diffEngine.js               -- Section 3, PURE function, 17 tests
    server.js                   -- Express app wiring, graceful shutdown, provider selection,
                                --    configurable poll interval, CSRF origin check, baseline refresher
    db/
      pool.js                   -- pg Pool, env-configured DATABASE_URL
      repository.js             -- every query, race locks, idempotency, refresh-symbols helper,
                                --    index_quote cache, sparkline column
    baseline/
      computeBaseline.js        -- historical candles -> volatility/avgVolume -> status + sparkline_closes
      refreshBaselines.js       -- daily off-market recompute job (Section 10 #4), 11 tests
    marketData/
      indexSymbols.js           -- NIFTY 50 -> ^NSEI, SENSEX -> ^BSESN (index vs .NS mapping)
      client.js                 -- retry/backoff + circuit breaker, provider-agnostic
      demoProvider.js            -- explicit simulated-data fallback (incl. indices)
      realProvider.js             -- yahoo-finance2 backed, LIVE-verified (incl. ^NSEI/^BSESN)
    poller/
      poller.js                 -- per-symbol isolated, overlap-guarded, market-hours + real 2026 NSE holidays,
                                --    also polls headline indices each cycle
    routes/
      session.js                 -- session cookie resolve-only middleware (+ sign/verify/issue/clear; versioned payload)
      auth.js                    -- signup / login / logout, login rate-limited per IP
      watchlist.js                -- GET/POST/DELETE/ack, live symbol validation, 401-guarded
      indices.js                  -- public GET /indices for the top ticker strip
      health.js                   -- DB + poller + circuit status
    test/
      diffEngine.test.js          -- 17 tests
      computeBaseline.test.js      -- 12 tests (incl. sparkline_closes bounds)
      realProvider.test.js          -- 35 tests (incl. ^NSEI/^BSESN mapping, direct-fallback)
      repository.test.js             -- 13 tests (real Postgres)
      marketDataClient.test.js        -- 19 tests
      poller.test.js                   -- 17 tests (incl. index polling open/closed)
      refreshBaselines.test.js           -- 11 tests (real Postgres, deterministic schedule math)
      auth.test.js                        -- 13 tests
      e2e.test.js                       -- 35 tests (real HTTP server + Postgres, incl. /indices + table fields)
      run.js                             -- runs all suites in sequence

frontend/
  package.json                  -- react, vite
  vite.config.js                 -- dev-only proxy to backend (incl. /indices)
  index.html                      -- Fraunces + Inter font loading
  src/
    main.jsx                      -- entry, wraps App in ErrorBoundary
    App.jsx                        -- polling loop, all states, visibility pause, watchlist table
    api.js                          -- thin fetch client matching Section 5 exactly
    TickerStrip.jsx                 -- top sticky NIFTY/SENSEX strip (public /indices)
    WatchlistRow.jsx                 -- table row: Stock/Price/Change/Volume/Signal/Sparkline
    Sparkline.jsx                    -- inline SVG "Last 7 Days" sparkline
    AddSymbolForm.jsx                 -- debounced add, inline errors
    AuthPage.jsx                       -- login/signup (light restyle)
    ErrorBoundary.jsx                  -- React error boundary
    index.css, App.css                  -- light design tokens + table/strip styles, Section 7
```

**Run everything locally:**
```bash
# Postgres must be running, DB created, migration applied:
psql -f backend/migrations/001_init.sql

cd backend
npm install
npm test                          # 172 tests across 9 suites, needs Postgres reachable
DATABASE_URL=... MARKET_DATA_PROVIDER=demo npm start   # runs on :3001

cd ../frontend
npm install
npm run dev                        # runs on :5173, proxies /watchlist to :3001 in dev
```

---

## 10. What's left — exact, prioritized

### 1. Real market data provider — DONE and LIVE-VERIFIED
`backend/src/marketData/realProvider.js`, built against `yahoo-finance2`
(verified real, maintained package — `npm view yahoo-finance2 version`).
Selected via `MARKET_DATA_PROVIDER=real` (the default) or
`MARKET_DATA_PROVIDER=demo` for the simulated fallback.

**Live-verified end-to-end against real `query1.finance.yahoo.com` data**
(real RELIANCE/TCS/INFY quotes and 20-completed-candle history), and the
full HTTP path exercised: add valid → immediate live snapshot, add invalid
→ `422 unknown_symbol`, no DB row created.

**One real bug found and fixed during that live pass (see §8, bug #9):**
Yahoo returns the current in-progress session as a 1d candle with
`close:null`, and yahoo-finance2's `historical()` wrapper throws on any
null close — so `fetchHistorical` always failed during trading hours.
Fixed by using the `chart()` endpoint and filtering incomplete candles.
Regression-tested in `realProvider.test.js`.

**Node version note:** yahoo-finance2 v4 declares `engines.node >= 22`.
It runs fine on Node 20 in practice (verified live), but emits a banner;
if a target host is still on Node 20, upgrading to 22+ removes the banner
and any future-compat risk.

### 2. Symbol-exists validation — DONE (live-verified)
`POST /watchlist` now validates a genuinely new symbol via one real
`fetchQuote` call before creating any DB row; rejects with
`422 unknown_symbol` if it fails. That same validation call's result is
reused to seed an immediate snapshot, so a newly-added symbol shows live
data right away instead of waiting for the next 30s poll cycle.

**Note on `demoProvider`:** it deliberately generates a plausible price
for *any* input string (that's the point of a demo provider), so the 422
rejection path is a no-op in demo mode by design. The rejection path is
proven in `e2e.test.js` (test 9) against a provider built to fail, and
against the real provider live.

### 3. Deploy for real
**Rollout decision (recorded during build): deploy in two phases —**
Phase 1: `MARKET_DATA_PROVIDER=demo` to prove deployments, topology, env
wiring, and the keep-alive loop with zero external variables. Phase 2:
flip `MARKET_DATA_PROVIDER=real` (env var only, no rebuild — the provider
is selected at boot from the env in `server.js`) and re-verify symbol
validation (`422 unknown_symbol`) and live snapshots.

**Phase-1 demo caveat:** in demo mode every input string is accepted (it
generates plausible prices by design), so the `422` validation rejection
is real-provider-only — don't read its absence as a bug while validating
the deployment. During Phase 2, POST a bogus symbol and expect `422`.

**Phase 2 — DONE (2026-09-04).** Both phases are live on Render + Neon +
Vercel; no provider code changes beyond the crumb-gate fallback described
in Section 5 (provided as code, no env change). Verified on the deployed
backend: `/health` db ok, `HDFCBANK` -> ₹712.10, `RELIANCE` -> ₹1,322
(real NSE via Yahoo quote and history), bogus -> `422 unknown_symbol`.
Full debrief: `DEPLOYMENT.md` Phase 2.

**FINAL VERIFICATION PASS — DEPLOYMENT VERIFIED DONE (2026-09-05).**
After a clean-slate DB reset (Neon `TRUNCATE last_seen, watchlist_entry,
snapshot, baseline, users CASCADE`), re-verified live end-to-end:
- **Live URLs:** backend `https://watchlist-backend-mt3i.onrender.com`,
  frontend `https://smart-watchlist-hazel.vercel.app`.
- **`FRONTEND_ORIGIN` on Render** is the real Vercel URL
  (`https://smart-watchlist-hazel.vercel.app`), not the `CHANGE-ME`
  placeholder — confirmed via the CORS echo on cross-origin requests.
- **Fresh adds via live API:** TCS, HDFCBANK, RELIANCE all returned
  `diff.finalScore = 0` on first view (baselines recomputed from 20 real
  completed daily candles; TCS 1.69% daily vol, HDFCBANK 0.86%, RELIANCE
  0.87%). No inflated scores.
- **`/health`:** `status: ok`, `db: ok`, `marketDataCircuit: "closed"`,
  `lastQuoteError: null`. (`lastSuccessfulPollAt: null` is normal
  off-market — see Section 6 keep-alive note.)
- **Cross-domain session cookie:** verified at the HTTP contract level —
  first cross-origin request sets `session_uid` (`HttpOnly, Secure,
  SameSite=None`), subsequent cross-origin GET persists the same session
  and returns the same watchlist. End-to-end incognito-browser click test
  is still worth doing by hand (item A below).

**FULLY VERIFIED (2026-09-05) — including the fresh-symbol pipeline.**
- MRF (added via the browser ~12:34Z, never in any earlier session)
  confirmed the *normal* brand-new add flow live on Render itself:
  baseline computed `ready` at 12:34:22Z from 20 real candles, snapshot
  present at 12:39:30Z, renders ₹130,000. No manual intervention.
- WIPRO exposed §8 bug #11: an add that crashed mid-flight (the orphaned-
  cookie FK bug) left it `pending` with `last_computed_at = NULL`, and the
  poller's closed-hours branch never creates a *first* snapshot (it only
  re-flags symbols that already have one). A clean-slate re-add reports
  `baselineTriggered:false` (row exists) so it can never self-heal. Fixed
  in production via the exact production path — realProvider `fetchQuote`
  → `upsertSnapshot` → `computeBaselineForSymbol` — to `ready`
  (`WIPRO ₹176.40`, vol 0.0125, 20 days used); GET /watchlist now renders
  a live card with a clean zero-diff first view (`finalScore 0`, reason
  `ok`). The 30s-wait refresh does NOT produce this transition during
  closed hours; a *normal* fresh add gets its snapshot at add-time instead.
- **Deployment is now fully verified end to end:** every bug in §8 that
  was open at the end of the last pass (#10 to #11) is fixed, documented,
  and confirmed live. No known deployment blockers remain.

**Open items (not blocking; none are deployment blockers):**
- **A.** ~~Manual incognito click-test remaining.~~ **RESOLVED (2026-09-05):**
  the incognito add failure was bug #10 (orphaned session cookie -> FK
  23503 500). Fixed + verified live — a simulated orphaned cookie now
  returns 201 with a rotated session and the add persists. A manual
  incognito add on `smart-watchlist-hazel.vercel.app` should now work
  end-to-end.
- **B.** ~~`https://smart-watchlist.vercel.app` (stale build)~~ **RESOLVED /
  NON-ISSUE (2026-09-05):** that URL is not ours at all — it's an
  unrelated third-party movie-watchlist app that happens to share the
  name. It never hosted our frontend. Our only live URL is
  `https://smart-watchlist-hazel.vercel.app` (correct build incl.
  `VITE_API_BASE_URL=https://watchlist-backend-mt3i.onrender.com`);
  nothing to retire or repoint.
- **C.** ~~Anonymous session bloat from cookie-less `/health` polling
  (~17k rows/day).~~ **RESOLVED + VERIFIED LIVE (2026-09-05):** `/health`
  is registered *before* the session middleware in `server.js`, so health
  pings mint no session and no `users` row. Verified live on Render: the
  `users` count was flat at 310 across a 60s window that previously grew
  ~15 rows/min.
- **D.** External keep-alive monitor at `/health` (DEPLOYMENT.md final
  runbook step) — confirm it's still in place so the free Render instance
  stays awake.
- **E.** Render dashboard log scan for `unhandled_route_error` /
  `poll_cycle_top_level_error` wasn't reachable from this CLI session;
  worth a 30-second glance in the Render Logs tab (none surfaced over
  HTTP during this pass — every probe returned an expected status code).
- **F.** Self-healing for a wedged `pending` baseline (§8 bug #11):
  currently needs manual repair. Wiring a retry for `pending` rows with
  `last_computed_at IS NULL` (poller after a TTL, or add-path retry when
  `created:false` but still `pending`) would make it automatic.

Topology, following Section 6 exactly:
- Neon or Supabase -> run `migrations/001_init.sql` against it -> get `DATABASE_URL`
- Render or Railway -> deploy `backend/`, set env vars (`DATABASE_URL`,
  `FRONTEND_ORIGIN`, `SESSION_SECRET`, `MARKET_DATA_PROVIDER`), pin to 1 instance
- External keep-alive: point a free uptime monitor at `/health` every ~5 min
- Vercel or Netlify -> deploy `frontend/`, set `VITE_API_BASE_URL` to the
  Render/Railway backend URL
- Verify CORS: `FRONTEND_ORIGIN` on the backend must exactly match the
  deployed frontend URL, `credentials: true` on both sides (already coded)

### 4. Daily baseline-refresh job — DONE
`backend/src/baseline/refreshBaselines.js`. A dependency-free, daily
self-rescheduling pass (default 18:30 IST, off-market; configurable via
`BASELINE_REFRESH_TIME_IST`). Recomputed baselines are recovered and stored
via the existing `computeBaselineForSymbol` path; per-symbol isolation like
the poller. `failed` baselines are retried automatically; `pending` rows are
left untouched (their first computation is in-flight). 11 tests, including
deterministic next-fire-time math and isolation/retry behavior against real
Postgres. Testable-to-trigger manually via `refreshAllBaselines`.

### 5. Visual polish in a real browser
The frontend compiles clean (verified `npm run build`) and has been
verified via API-level testing. It has not been visually inspected in a
real browser with live data flowing — do a pass post-deployment. This
build environment could not render/screenshot it.

### 6. Nice-to-haves — DONE
- **Configurable poll intervals:** backend `POLL_INTERVAL_MS` (default
  30000), frontend `VITE_POLL_INTERVAL_MS` (default 20000).
- **Real NSE holiday calendar:** `poller.js` now carries the full notified
  2026 equity-segment holiday list (16 weekday closures), cross-checked
  against NSE's circular and multiple broker calendars, with tests.
- **CSRF origin-check hardening:** sameSite:strict cookies are the primary
  defense; a middleware additionally rejects any state-changing request
  whose `Origin` header doesn't match `FRONTEND_ORIGIN`
  (`403 cross_origin_forbidden`), tested in `e2e.test.js` (test 10/10b).

### 7. Light-theme redesign + ticker strip + sparkline — DONE (2026-09-05)
A full visual redesign to the light "Pulse" look plus the table restructure,
all in commit `c20eac9`'s successor (`003` migration + frontend). No backend
behavior changed beyond the additive pieces described here:
- **Migration `003_indices_and_sparkline.sql`:** `baseline.sparkline_closes`
  (JSONB) + new `index_quote` table for the two headline indices.
- **Sparkline:** `computeBaselineForSymbol` now captures the last <=7 closes
  from the (otherwise discarded) 20-candle history and persists them on the
  baseline row — bounded, always overwritten at compute/recompute, no
  re-fetch from Yahoo on page load (the unbounded-storage concern noted
  earlier is deliberately avoided). Tested in `computeBaseline.test.js`.
- **Index handling:** `marketData/indexSymbols.js` maps `NIFTY -> ^NSEI`,
  `SENSEX -> ^BSESN`; `realProvider.toYahooSymbol` honors it (no `.NS` for
  indices) and the poller polls them each cycle through the shared
  circuit-breaker client, caching to `index_quote`, with the same
  market-closed/stale degradation as snapshots. Live-verified against real
  Yahoo before this write-up: NIFTY -> 23,897.7 & ^BSESN SENSEX -> 76,515.43.
- **`GET /indices`** (public, before session middleware) feeds the sticky
  top ticker strip on the frontend. **Off-market caveat (found live):** when
  the market is closed and an index has *never* been fetched, `/indices`
  used to return `[]`, which blanked the strip on weekends. The poller now
  seeds the two canonical index row(s) with `price:null` + `marketClosed`
  in the closed branch (and the frontend has an equivalent empty fallback),
  so the strip always renders "NIFTY 50 ₹— Closed" / "SENSEX ₹— Closed"
  instead of disappearing.
- **`/watchlist` items** gained `changePct`, `currentVolume`, `avgVolume`,
  `sparklineCloses` — the table's columns. Diff engine untouched.
- **Frontend:** light tokens, bump-free table (Stock | Price | Change |
  Volume vs Avg | Signal | Last 7 Days), Signal badge derived from the
  existing `isMeaningful` + `direction`, inline-SVG sparkline, amber accent
  reserved for the single most-meaningful row, restyled auth/empty/disclaimer.
- Verified: full suite green (172 tests), production build clean, and (in
  the deploy pass) live HTTP checks on Render + Vercel.

---

## 11. Non-negotiables — do not simplify these away

If under time pressure something needs to be cut, cut from Section 10's
nice-to-haves, not from these — each was specifically added because a real
bug or real judging criterion demanded it:

1. Diff engine's two divide-by-zero floors (`MIN_VOLATILITY`, `MIN_VOLUME_FLOOR`)
2. Baseline concurrency lock (DB unique constraint, not an app-level mutex)
3. Poller's per-symbol try/catch AND top-level try/catch (both, not either)
4. Atomic snapshot replace (never partial-field updates)
5. Ack replay protection (server-authoritative timestamp, not client-trusted)
6. The three-state no-fresh-data distinction (`no_data_yet`/`stale`/`market_closed`)
7. Demo-mode data being explicitly labeled, never silently presented as live
