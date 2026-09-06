# TRADEYE — Smart Market Watchlist, Complete Build Handoff

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
-- anonymous-session model superseded by migration 002 (see Section 6).
-- auth_provider / nullable password_hash added by migration 004 (see §6).
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,               -- NULLABLE as of migration 004: Google-
                                    -- authenticated accounts have no password
  auth_provider TEXT NOT NULL DEFAULT 'email'
    CHECK (auth_provider IN ('email', 'google')),  -- how the account was made
  session_version INTEGER NOT NULL DEFAULT 0,
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
POST /auth/signup   body: { email, password, remember? }   -- PUBLIC
  -> 201 { user: { email } }  + session cookie (short by default; `remember:true`
         => 90-day cookie, maximized off the same policy as login)
  -> 400 invalid_email | password_too_short
  -> 409 email_taken
POST /auth/login    body: { email, password, remember? }   -- PUBLIC, rate-limited
  -> 200 { user: { email } } + session cookie (`remember:true` => 90-day)
  -> 401 invalid_credentials  -- identical for wrong password, unknown email,
         AND Google-only accounts (NULL password_hash): byte-identical body via
         a DUMMY_HASH bcrypt compare, no provider/timing enumeration
POST /auth/logout   -- revokes session_version + clears the cookie, 204
GET /auth/google    -- PUBLIC, no session required. 302 to Google's authorize
         endpoint with a consume-once `state` nonce (10-min TTL). 302 with
         ?auth_error=provider_not_configured when env not set.
GET /auth/google/callback -- PUBLIC. 302 back to FRONTEND_ORIGIN with a short
         browser-close session cookie; owner-decided auto-link for existing
         email/password accounts (same row, no duplicate). Failures redirect
         with ?auth_error=<one of google_denied | google_state_mismatch |
         google_callback_error | google_email_unverified>.

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
  -- also returns user: { email } (the authenticated account's email; added
  -- 2026-09-05 in the final nav pass so the frontend avatar can render its
  -- initial even after a cold reload with a valid session cookie)

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
  -> 200 { status: 'ok', db: 'ok', poller: {...}, marketDataCircuit: 'closed',
           lastQuoteError, lastRouteError, authEvents: [...] }
  -> 503 { status: 'degraded', ... }   -- if DB unreachable OR circuit breaker open
  -- authEvents: ring buffer (newest first, max 20) of every login/signup
     outcome + session rejection, visible without Render log access:
     auth_login_success, auth_login_invalid, auth_login_rate_limited,
     auth_signup_success, auth_signup_email_taken, session_rejected.
     Each entry has { event, email?, code?, ip?, route?, at }.

GET /indices   -- public (mounted before session middleware, like /health);
                -- powers the top ticker strip. Reads the poller's cache.
  -> 200 { indices: [
      { symbol: 'NIFTY'|'SENSEX', label: string, price: number|null,
        fetchedAt: ISOString, isStale: boolean, marketClosed: boolean }
    ] }

GET /radar   -- requires a session (user-specific: it excludes the requesting
              user's own watchlist symbols). Auth same as /watchlist.
              Reads the poller-cached snapshot+baseline tables; pure
              per-request computation, WRITES nothing.
  -> 200 { items: [   -- at most 5, sorted by abs(diff.finalScore) descending
      { symbol: string,
        currentPrice: number | null,
        changePct: number | null,        -- % vs the symbol's own last close
                                           (last sparkline_closes point) — the
                                           radar's "moving right now" reference
        previousClose: number | null,    -- that reference price
        currentVolume: number | null,
        avgVolume: number | null,
        sparklineCloses: number[] | null, -- bounded <=7 closes, reused for card
        diff: { finalScore, isMeaningful, direction, confidenceMultiplier, ... },
        badge: { label, why } | null      -- label: one of 'Volume Spike' |
                                           'Strong Move' | 'High Volatility' |
                                           'High Activity' | 'Near Breakout'
      }
    ] }
  -> 401 { error: { code: 'not_authenticated' } }

POST /watchlist   -- the radar's per-card "Add to watchlist" button reuses
              this exact endpoint; no radar-specific write path exists.
```

Files: `backend/src/routes/watchlist.js`, `backend/src/routes/health.js`, `backend/src/routes/radar.js`

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
  (10 per 15 min sliding window). Every login/signup success, failure,
  rate-limit, and stale-session rejection is logged to console (structured
  JSON, visible in Render logs) and recorded in the `authEvents` ring buffer
  exposed by `/health` — the original bug where a real user couldn't log in
  but no server-side trail existed is now structurally impossible to miss.
- **Why:** persistent watchlists across devices was a hard product gap of
  the cookie-only model. **Still explicitly deferred, not forgotten:** email
  verification and GitHub/other OAuth. Google OAuth itself is now DONE
  (migration 004 + §10 #9); email verification still needs email
  infrastructure that doesn't exist at hackathon scope. The session layer is
  account-based, not cookie-based, so all of these stay clean future adds.

### Google OAuth: real OAuth 2.0 ("Continue with Google"), not a fake button
Owner decision 2026-09-06. Full redirect flow through the backend, no API
key leaked to the browser (the `client_secret` only ever leaves the server
in the token exchange):

- **`GET /auth/google`** (no session required) → `302` to Google's
  authorize endpoint with `client_id`, the registered `redirect_uri`,
  `scope=openid email`, and a random **`state` nonce** stored server-side
  (consume-once, 10-min TTL — defeats OAuth login CSRF / replay).
- **`GET /auth/google/callback`** → consumes the `state` → exchanges
  `code` for an ID token/google userinfo → **requires `email_verified ===
  true`** (owner correctness refinement: an unverified Google email is
  bounced with `?auth_error=google_email_unverified` and creates nothing) →
  resolves the account → issues a **short, browser-close session cookie**
  (Google sessions deliberately do NOT honor remember-me) → `302` back to
  `FRONTEND_ORIGIN`. Failures redirect with `?auth_error=<code>`
  (`provider_not_configured`, `google_denied`, `google_state_mismatch`,
  `google_callback_error`, `google_email_unverified`).
- **Account resolution (`resolveGoogleUser`)** — owner decision: an email
  that already exists auto-links **silently**:
  - email unknown → create row with `auth_provider='google'`,
    `password_hash=NULL`;
  - email exists with `auth_provider='email'` → reuse the SAME row
    (auto-link); `auth_provider` stays `'email'`, the password stays valid,
    no duplicate — the user just got a faster way in;
  - a Google-owned email signing up/into `/auth/*` password endpoints can
    never be claimed — login with a NULL-hash email returns the byte-identical
    `401 invalid_credentials` as an unknown email (no provider enumeration),
    and email signup collides with `409 email_taken`.
- Login with a Google-only account is deliberately **indistinguishable**
  from a wrong password: the route runs a `DUMMY_HASH` bcrypt compare so
  timing and response body reveal nothing (this extends the anti-enumeration
  contract from the email/password path).
- **Config:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `GOOGLE_REDIRECT_URI` env vars; unset → `/auth/google` answers
  `provider_not_configured` instead of crashing. Registered URIs:
  - prod `https://watchlist-backend-mt3i.onrender.com/auth/google/callback`
  - dev `http://localhost:3001/auth/google/callback`

### Remember me = the session cookie's real expiry, not a fake checkbox
Owner decision 2026-09-06, unifying the UI and the wire:
- `remember: true` (login *or* signup) → cookie issued with
  `Max-Age=7776000` (90 days) + `Expires`.
- `remember: false` or omitted → **browser-close session cookie** (no
  `Max-Age`/`Expires`), and Google sessions always get this short form.
- Backed by `REMEMBER_ME_MAX_AGE_MS = 1000*60*60*24*90` in
  `routes/session.js` and exercised in `e2e.test.js` (rm1–rm4) against the
  real Set-Cookie header. Security posture unchanged: `HttpOnly; SameSite=Strict`
  (SameSite=None only on cross-origin Render—Neon/Vercel deployment), and
  logout still bumps `session_version` so remember-me can't survive logout.
- **`Forgot password?` is a label only** (title="Coming soon"), deliberately
  not a clickable link — there's no email provider yet. Do NOT wire a fake
  reset; it is the marked wiring point for when email infra lands.

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

### Market Radar reuses the ONE poller / circuit-breaker — never a second one
The Market Radar (`GET /radar`, 2026-09-05) is deliberately **not** a second
parallel poller with its own failure modes. Its curated universe
(`marketData/radarUniverse.js`, a fixed ~20-22 liquid NSE large-caps) is
merged into the *existing* 30-second poll cycle via
`[...new Set([...watchedSymbols, ...RADAR_UNIVERSE])]` — so a symbol present in
BOTH the universe and someone's watchlist is fetched **exactly once** per
cycle, and every radar symbol gets a fresh snapshot through the same
per-symbol isolation, market-hours awareness, overlap guard and circuit
breaker the watchlist already trusts. No second resilience surface was added.
The radar endpoint itself is pure per-request computation from those cached
snapshot+baseline tables (it WRITES nothing); only the "Add to watchlist"
button on each card hits `POST /watchlist` (which then seeds its own baseline).
**Radar scoring is stateless per-user by design** — there's no last_seen for
"right now, market-wide" moves. Each symbol is scored against its own recent
baseline using the existing `computeDiff`, with the previous reference taken
from the symbol's own last completed close (the final `sparkline_closes`
point) so the card shows a real day-over-close change % and
`abs(finalScore)` reuses the meaningful-threshold semantics. Badge mapping is
a thin, pure read of existing diff fields (`radar/badge.js`), not new
computation. Tradeoffs of reusing the single poller: the universe adds ~20
upstream quotes per cycle and the radar can only surface movers that have a
ready baseline (roughly the 20-day lookback window after first fetch) — both
accepted. It is user-specific (must exclude the requesting user's watchlist),
so it sits behind the same auth middleware as `/watchlist`.

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

Design tokens (light "TRADEYE" theme — the app was renamed to **TRADEYE**
(quote: **"An extra eye on the market."**) in the final navigation pass
2026-09-05; the earlier dark ledger theme
was replaced by a white background, near-black text, hairline borders, colored
badges, and a persistent top ticker strip):
- Background `#FFFFFF`, primary text `#1A1A1A`, secondary text `#6B7280`
- Up `#16A34A` (green), down `#DC2626` (red)
- Accent `#D97706` (amber) — used for the avatar initials, the active nav item's
  soft tint (12% opacity), and reserved for the single most meaningful row's
  highlight (featured row background + its Signal badge)
- Hairline borders `#E5E7EB`, subtle surface `#F9FAFB` for inputs/active tab
- Fraunces (serif) for the masthead/headline, Inter for everything else,
  `tabular-nums` on all price figures
- Persistent top ticker strip (NIFTY 50, SENSEX) reads the public `/indices`
  endpoint, sticky at top, above the masthead on every page (incl. login)
- **Final navigation structure:** a persistent full-height left sidebar with
  the "TRADEYE" wordmark and exactly two nav items (Watchlist, Market Radar),
  each an icon + label with a soft amber-tint highlight for the active view;a tagline at the bottom ("An extra eye on the market."). Page switching is plain
  React state (`activeView: 'watchlist' | 'radar'`), no routing library. A
  circular avatar with the first letter of the user's email sits top-right next
  to Log out. Watchlist is the table view; Market Radar is a full-width page
  (see section 9 / radar section below).
- Watchlist is a table: Stock | Price | Change | Volume vs Avg | Signal |
  Last 7 Days. Signal badge derives from the existing diff.isMeaningful +
  direction. "Last 7 Days" is an inline SVG sparkline over `sparkline_closes`.
- Polling pauses when tab backgrounded (Page Visibility API)
- React ErrorBoundary wraps the whole app — one bad render can't blank the page
- **Deliberately excluded, by design (not forgotten): no search bar** (there is
  no real symbol-search backend endpoint; a static input would look broken) and
  **no theme toggle** (the product is a single light theme).

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
| 12 | `CEAT` fails symbol validation (`422 unknown_symbol`) while SBIN/WIPRO add fine | **Yahoo data gap, NOT a code bug.** `CEAT.NS` is mislabeled by Yahoo as `instrumentType: MUTUALFUND` on the `YHD` exchange with `regularMarketPrice: undefined`, `currency: null`, and `history: null` (no completed candles) — it is not the live NSE equity Ceat Ltd. The raw v8 chart endpoint confirms this for both the quote and history paths. Our validator correctly rejects it: `fetchQuote` requires a numeric `regularMarketPrice`, `fetchHistorical` requires non-empty completed closes; neither is present | None needed — this is correct validation rejection of bad upstream data, not a bug. Deliberately left as-is (per owner decision). Not to be "fixed" with a ticker workaround unless explicitly requested |

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
  migrations/004_google_oauth.sql -- auth_provider + nullable password_hash (Google OAuth)
  scripts/reset-dev-db.sql     -- local dev clean-slate
src/
      diffEngine.js               -- Section 3, PURE function, 17 tests
      server.js                   -- Express app wiring, graceful shutdown, provider selection,
                                --    configurable poll interval, CSRF origin check, baseline refresher,
                                --    Google OAuth client built from env (null => provider_not_configured)
      diagnostics.js             -- shared diagnostics bag: lastQuoteError, lastRouteError,
                                --    authEvents ring buffer (20-entry, newest first) — exposed via /health
                                --    for live diagnosis without Render log access
      auth/
        passwords.js              -- bcrypt hash/verify (cost 10, DUMMY_HASH for anti-enumeration)
        rateLimit.js              -- per-IP sliding-window login limiter
        googleOAuth.js            -- OAuth 2.0 client: authorize-URL build, code->token exchange,
                                --    userinfo fetch (injectable fetch for tests; client_secret never
                                --    leaves the server)
        oauthState.js             -- consume-once `state` nonce store (10-min TTL), defeats login CSRF
      db/
        pool.js                   -- pg Pool, env-configured DATABASE_URL
        repository.js             -- every query, race locks, idempotency, refresh-symbols helper,
                                --    index_quote cache, sparkline column, auth_provider-aware create/find
    baseline/
      computeBaseline.js        -- historical candles -> volatility/avgVolume -> status + sparkline_closes
      refreshBaselines.js       -- daily off-market recompute job (Section 10 #4), 11 tests
    marketData/
      indexSymbols.js           -- NIFTY 50 -> ^NSEI, SENSEX -> ^BSESN (index vs .NS mapping)
      radarUniverse.js          -- Market Radar's fixed curated universe (~20 liquid NSE large-caps)
      client.js                 -- retry/backoff + circuit breaker, provider-agnostic
      demoProvider.js            -- explicit simulated-data fallback (incl. indices)
      realProvider.js             -- yahoo-finance2 backed, LIVE-verified (incl. ^NSEI/^BSESN)
    poller/
      poller.js                 -- per-symbol isolated, overlap-guarded, market-hours + real 2026 NSE holidays,
                                --    also polls headline indices AND the radar universe each cycle (deduped once)
    radar/
      badge.js                  -- pure diff-field -> badge label + one-line "why" (Volume Spike / Strong
                                --    Move / High Volatility / High Activity / Near Breakout)
    routes/
      session.js                 -- session cookie resolve-only middleware (+ sign/verify/issue/clear; versioned
                                --    payload; REMEMBER_ME_MAX_AGE_MS = 90 days for `remember` cookies)
      auth.js                    -- signup / login / logout (rate-limited, remember-me) + GET /auth/google +
                                --    callback (state consume, email_verified gate, silent auto-link, short cookie)
      watchlist.js                -- GET/POST/DELETE/ack, live symbol validation, 401-guarded
      indices.js                  -- public GET /indices for the top ticker strip
      radar.js                    -- GET /radar (401-guarded): top 5 movers, excludes user's watchlist
      health.js                   -- DB + poller + circuit status
    test/
      diffEngine.test.js          -- 17 tests
      computeBaseline.test.js      -- 12 tests (incl. sparkline_closes bounds)
      realProvider.test.js          -- 35 tests (incl. ^NSEI/^BSESN mapping, direct-fallback)
      repository.test.js             -- 13 tests (real Postgres)
      marketDataClient.test.js        -- 19 tests
      poller.test.js                   -- 23 tests (incl. index polling + radar-universe merge/dedupe)
      refreshBaselines.test.js           -- 11 tests (real Postgres, deterministic schedule math)
      auth.test.js                        -- 13 tests
      googleOAuth.test.js                  -- 23 tests (authorize-URL/token/userinfo exactness + state store)
      oauth.e2e.test.js                     -- 22 tests (full redirect flow vs fake Google: create, no-dup,
                                          --    state-replay rejection, unverified-gate, auto-link, Google-only
                                          --    login indistinguishability, 409 on Google-owned email,
                                          --    provider-not-configured degradation, google_denied cancel)
      radarBadge.test.js                    -- 13 tests (pure badge-mapping cases + boundaries)
      radar.e2e.test.js                     -- 8 tests (exclusion, top-5 sort, badge mapping, 401)
      e2e.test.js                       -- 44 tests (real HTTP server + Postgres, incl. /indices + table fields
                                         --    + remember-me cookie contract rm1-rm4 + auth diagnostics 10-12)
      run.js                             -- runs all suites in sequence

frontend/
  package.json                  -- react, vite
  vite.config.js                 -- dev-only proxy to backend (incl. /indices)
  index.html                      -- Fraunces + Inter font loading
  Throwaway? no. — src/
    main.jsx                      -- entry, wraps App in ErrorBoundary
    App.jsx                        -- nav state (activeView), sidebar nav + compact logo, avatar, watchlist table,
                                --    dark `app--auth` shell (dark ticker + AuthPage) when unauthenticated
    api.js                          -- thin fetch client matching Section 5 exactly (incl. remember + googleAuthUrl)
    Logo.jsx                        -- hand-drawn SVG TRADEYE lockup: two-tone almond eye (candlestick bars
                                --    + orbit ring/dot), color-split wordmark; dark/light tones; stacked
                                --    hero variant + compact sidebar variant
    TickerStrip.jsx                 -- top sticky NIFTY/SENSEX strip (public /indices; light + dark variant)
    WatchlistRow.jsx                 -- table row: Stock/Price/Change/Volume/Signal/Sparkline
    MarketRadar.jsx                  -- full-width Market Radar page: subtitle, last-updated (+ one-click add)
    Sparkline.jsx                    -- inline SVG "Last 7 Days" sparkline (shared by table + radar)
    AddSymbolForm.jsx                 -- debounced add, inline errors
    AuthPage.jsx                       -- premium login/signup: light card floating center-right on the full-width
                                    --    photographed hero (no left-panel text/logo). Card: tabs, show/hide password,
                                    --    remember-me, 90-day vs browser-close, forgot-password placeholder, Google
                                    --    button, ?auth_error= handling cleared from the URL
    ErrorBoundary.jsx                  -- React error boundary
    assets/                            -- photographed hero backgrounds, exported at 2x: tradeye-hero-desktop-{1x,2x}.png,
                                    --    tradeye-hero-mobile-{1x,2x}.png (1x = LANCZOS downscale of the 2x)
    index.css, App.css                  -- light design tokens + dark-teal auth/logo/ticker styles, Section 7/9#
```

**Run everything locally:**
```bash
# Postgres must be running, DB created, migration applied:
psql -f backend/migrations/001_init.sql

cd backend
npm install
npm test                          # 253 tests across 13 suites, needs Postgres reachable
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
A full visual redesign to the light "TRADEYE" look plus the table restructure,
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

### 8. Market Radar — DONE (2026-09-05)
The "Market Radar" section: top movers from a fixed curated universe of
liquid NSE large-caps, shown above the watchlist table. This was built as a
deliberate resilience exercise — reuse, don't fork:
- **`marketData/radarUniverse.js`:** ~20 fixed liquid NSE symbols (RELIANCE,
  TCS, HDFCBANK, INFY, ICICIBANK, SBIN, HINDUNILVR, ITC, BHARTIARTL,
  KOTAKBANK, LT, AXISBANK, ASIANPAINT, MARUTI, WIPRO, SUNPHARMA, TITAN,
  ULTRACEMCO, BAJFINANCE, NESTLEIND). CEAT deliberately absent (see §8 bug #12
  for the Yahoo data quirk).
- **Poller:** the universe is merged into the SAME 30-second cycle as watched
  symbols via `[...new Set([...distinctWatched, ...RADAR_UNIVERSE])]`, so an
  overlap symbol (both watched and in the universe) is fetched exactly once
  per cycle. All existing resilience (per-symbol isolation, overlap guard,
  circuit breaker) applies with zero new surface. See the §6 architecture
  decision above.
- **`GET /radar`** (401-guarded like `/watchlist`, since it's user-specific):
  scores each universe symbol against its OWN baseline via the existing
  `computeDiff`, referencing the symbol's last completed close (final
  sparkline point) as the prior — no per-user last_seen. Returns the top 5 by
  `abs(finalScore)` descending, each with symbol, current price, day-over-
  close change %, volume vs avg, the shared 7-day sparkline, and a
  `badge { label, why }`.
- **`radar/badge.js`:** pure read of existing diff fields — no new
  computation:
  - `isMeaningful` + `confidenceMultiplier > 1.3` → **Volume Spike**
    ("Above average volume")
  - `isMeaningful` + `direction === 'up'` → **Strong Move**
  - `isMeaningful` + `direction === 'down'` → **High Volatility**
  - `1.0 <= abs(finalScore) < 1.5` → **Near Breakout**
  - otherwise no badge (not a mover)
- **Frontend `MarketRadar.jsx`:** now a full-width page (in the final nav
  pass the collapsible sidebar panel was removed — it renders only when
  `activeView === 'radar'`). Keeps the "Live" indicator (pulse dot) and the
  5-across card grid (stacks to 3 → 2 → 1 column responsively) with rank,
  symbol, NSE label, badge, price, change %, volume-vs-avg line, one-line
  "why", sparkline, and a "+ Add to watchlist" button that hits the existing
  `POST /watchlist` (the added symbol drops out of the radar immediately).
  **Three radar-only elements added in the final pass:**
  1. A subtitle under the "Market Radar" heading — verbatim:
     "Top stocks from Nifty 50 (not in your watchlist) showing unusual
     activity right now."
  2. A "Last updated" line in the radar meta row, sourced from the poller's
     `lastSuccessfulPollAt` (fetched alongside the radar via `GET /health`);
     shows "—" while no successful cycle has completed (e.g. market closed).
  3. A bottom closing line — verbatim: "Market Radar shows opportunities
     outside your watchlist, using the same analysis you trust."
  The frontend fetches `GET /radar` + `GET /health` together on the shared
  poll interval and pauses when the tab is backgrounded, mirroring the
  watchlist behavior.
- **Tests:** `radarBadge.test.js` (13) covers all four badge cases + the
  1.3-and-1.0/1.5 boundaries + stale/no-badge guards; `radar.e2e.test.js`
  (8) covers watchlist exclusion, at-most-5 + sort-by-abs-score, badge
  mapping from a seeded deterministic universe, field shape, and 401;
`poller.test.js` gained the merge/dedupe test (both-lists symbol fetched
   exactly once, indices counted separately). Full suite: **199 tests, 0
   failures.** Frontend production build clean.

### 9. Google OAuth login + dark-teal two-panel auth redesign — DONE (2026-09-06)
Real OAuth 2.0, not a fake button — full server-side redirect flow (§6):
- **Migration `004_google_oauth.sql`:** `users.auth_provider` (TEXT CHECK
  `'email'|'google'`, default `'email'`) + `password_hash` now NULLABLE
  (Google-only accounts have no password). Applied locally; **must be applied
  to the Neon production DB** alongside the code deploy.
- **Backend:** `auth/googleOAuth.js` (injectable-fetch client: authorize
  URL, code→token exchange, userinfo), `auth/oauthState.js` (consume-once
  state nonce, 10-min TTL), `routes/auth.js` gained `GET /auth/google` +
  `GET /auth/google/callback`. Owner decisions implemented and tested:
  **silent auto-link** for existing email/password rows, **`email_verified`
  gate** (unverified Google emails are rejected, nothing created), **short
  browser-close session for Google**, NULL-hash logins byte-identical to
  unknown-email 401s, duplicate-email signup → 409, error bounces to
  `FRONTEND_ORIGIN` as `?auth_error=<code>`.
- **Remember me is now real:** `remember:true` (login/signup) → 90-day
  `Max-Age` + `Expires`; false/omitted → browser-close session cookie.
  Cookie `HttpOnly; SameSite=Strict` posture unchanged; logout still bumps
  `session_version`. Tested against the real Set-Cookie header (e2e rm1–rm4).
- **Frontend:** dark-teal brand pass. `Logo.jsx` (hand-drawn SVG eye +
  rising candles wordmark, dark/light tones), `AuthPage.jsx` (light card on
  the photographed hero with
  tabs, show-hide password, remember-me, `Forgot password?` placeholder not
  wired, Google button → `api.googleAuthUrl`), `TickerStrip` dark variant,
  `app--auth` dark shell, `?auth_error` handled and scrubbed from the URL.
- **Floating-card layout (2026-09-06, after first deploy):** the auth page
  is no longer a hard 50/50 two-panel split. A complex SVG eye mark
  (`Logo.jsx`, still used in the app sidebar — two-tone almond eye, six
  solid/hollow rising candlesticks, dashed trend line, tilted orbit ring +
  dot, `viewBox 0 0 260 170`) was designed for the left panel, then all
  left-panel content (eye/wordmark/tagline, Track/Analyze/Radar, closing
  line) was removed entirely — see the "Hero background photo" bullet for
  the current state. The light form card (tabs, show/hide password,
  remember-me, "Forgot password?" placeholder, Google button) floats
  center-right with real elevation (layered shadow + radius) so the image
  shows around its top, bottom and right edges. The dark ticker stays pinned
  above everything; the card keeps its full behavior and the `?auth_error`
  handling. Verified via `npm run build` (no browser in this env — a manual
  browser pass over login/signup tabs and a narrow viewport is the last
  visual check).
- **Hero background photo (2026-09-06):** the full-width backdrop is a
  photographed hero image (`src/assets/`, exported by the owner at 2x). It
  scales gracefully at ANY desktop resolution — `background-size: cover`
  + `background-position: center` fills the stage proportionally on 4K,
  1366×768 laptops, and non-maximized windows with zero stretching/gaps. On
  high-DPI screens a `@media (min-resolution: 2dppx)` query swaps in the 2x
  export (1758×895 / mobile 941×1672) for sharpness; normal-DPI screens get
  a LANCZOS-halved 1x twin (879×447 / 470×836) to save bandwidth. The ≤960px
  rule swaps to the portrait mobile export (`center top`). **All left-panel
  text is gone** — no eye mark/wordmark/tagline, no Track/Analyze/Radar value
  props, no "Markets move. You see more." closing; the image IS the hero, and
  the white card floats center-right (`.auth-stage` `justify-content:
  flex-end`, vertically centered) on the raw, un-scrimmed photo. The dark
  ticker stays pinned at the very top.
- **Forgot password = label only (title="Coming soon")**, NOT clickable —
  no email provider yet. This is the marked wiring point (+ email
  verification) when email infra lands; do NOT wire a fake reset.
- **Deploy:** set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `GOOGLE_REDIRECT_URI=https://watchlist-backend-mt3i.onrender.com/auth/google/callback`
  on Render, create the matching Google Cloud OAuth client, apply migration
  004 to Neon, redeploy. Until the env is set the route degrades to a clear
  `provider_not_configured` redirect, never a crash.
- **Tests:** `googleOAuth.test.js` (23) + `oauth.e2e.test.js` (22, full
  redirect flow against a fake Google — incl. tests 9/9b pinning the
  unconfigured-provider degradation and test 10 pinning the consent-cancel
  path) + remember-me tests rm1–rm4. Full suite: **253 tests, 0 failures.**
  Frontend production build clean.

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
8. The auth anti-enumeration contract stays airtight: NULL-hash (Google-only)
   logins AND unknown emails must stay byte-identical 401s (DUMMY_HASH
   compare, no timing or body leak), and login rate-limiting stays on.
9. OAuth `state` coercion stays consume-once and TTL'd (replay → state_mismatch),
   the `email_verified` gate stays (unverified Google emails create nothing),
   auto-link stays silent (reuse the same row; never a duplicate account),
   and Google sessions stay browser-close-short (no remember-me for OAuth).
10. `Forgot password?` stays a placeholder until a real email provider exists —
    same rule as demo-mode honesty: never fake a reset flow that doesn't work.
