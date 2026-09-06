// src/db/repository.js
const pool = require('./pool');

// ---- Users ----

// Accounts replaced anonymous sessions (migration 002). Email is normalized
// to lowercase by the route layer; the UNIQUE constraint is the final backstop
// against duplicate-account races.
//
// auth_provider ('email' | 'google', migration 004) records how the account was
// established. Google-authenticated accounts have password_hash = NULL; the
// auth routes are the only layer that should know that distinction — this
// repository layer just stores and returns it faithfully.
async function createUser(email, passwordHash, authProvider = 'email') {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, auth_provider) VALUES ($1, $2, $3)
     RETURNING id, email, created_at, session_version, auth_provider`,
    [email, passwordHash || null, authProvider]
  );
  return rows[0];
}

async function findUserByEmail(email) {
  const { rows } = await pool.query(
    'SELECT id, email, password_hash, created_at, session_version, auth_provider FROM users WHERE email = $1',
    [email]
  );
  return rows[0] || null;
}

async function getUserById(userId) {
  const { rows } = await pool.query(
    'SELECT id, email, created_at, session_version, auth_provider FROM users WHERE id = $1',
    [userId]
  );
  return rows[0] || null;
}

// Logout / session revocation: bumping the version invalidates every cookie
// already issued to a user. The signed cookie carries the version it was
// issued at; any older version now fails verification (and therefore 401s).
async function bumpSessionVersion(userId) {
  await pool.query(
    'UPDATE users SET session_version = session_version + 1 WHERE id = $1',
    [userId]
  );
}

async function userExists(userId) {
  const { rows } = await pool.query('SELECT 1 FROM users WHERE id = $1', [userId]);
  return rows.length > 0;
}

// ---- Symbol validation / baseline (race-safe insert) ----

// Returns { created: boolean, baseline: row }
// The unique PK on baseline.symbol IS the concurrency lock we designed:
// if two requests race to add the same brand-new symbol, only one INSERT
// wins; the other sees `created: false` and does nothing further.
async function ensureBaselineExists(symbol) {
  const { rows } = await pool.query(
    `INSERT INTO baseline (symbol, status)
     VALUES ($1, 'pending')
     ON CONFLICT (symbol) DO NOTHING
     RETURNING symbol, status`,
    [symbol]
  );
  if (rows.length > 0) {
    return { created: true, baseline: rows[0] };
  }
  const existing = await pool.query(
    'SELECT symbol, status FROM baseline WHERE symbol = $1',
    [symbol]
  );
  return { created: false, baseline: existing.rows[0] || null };
}

async function getBaseline(symbol) {
  const { rows } = await pool.query('SELECT * FROM baseline WHERE symbol = $1', [symbol]);
  return rows[0] || null;
}

// Symbols whose baseline is stable or retriable — used by the daily refresh
// job. 'pending' is excluded on purpose: that row's first computation is
// either in-flight (the add route awaits it) or already being handled, so a
// refresh must not race against it.
const REFRESHABLE_BASELINE_STATUSES = ['ready', 'low_confidence', 'failed'];
async function getRefreshableBaselineSymbols() {
  const { rows } = await pool.query(
    'SELECT symbol, status FROM baseline WHERE status = ANY($1) ORDER BY symbol',
    [REFRESHABLE_BASELINE_STATUSES]
  );
  return rows;
}

// sparklineCloses: the last <=7 closing prices captured at compute time —
// a bounded, always-overwritten summary so the frontend's "Last 7 Days"
// sparkline never requires re-fetching history from the provider.
async function markBaselineReady(symbol, { typicalDailyVolatility, avgVolume, historyDaysUsed, lowConfidence = false, sparklineCloses }) {
  await pool.query(
    `UPDATE baseline
     SET status = $5, typical_daily_volatility = $2, avg_volume = $3,
         history_days_used = $4, last_computed_at = now(), sparkline_closes = $6
     WHERE symbol = $1`,
    [symbol, typicalDailyVolatility, avgVolume, historyDaysUsed, lowConfidence ? 'low_confidence' : 'ready', sparklineCloses != null ? JSON.stringify(sparklineCloses) : null]
  );
}

async function markBaselineFailed(symbol) {
  await pool.query(`UPDATE baseline SET status = 'failed' WHERE symbol = $1`, [symbol]);
}

// ---- Watchlist ----

const MAX_WATCHLIST_SIZE = 30;

async function getWatchlistCount(userId) {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS count FROM watchlist_entry WHERE user_id = $1',
    [userId]
  );
  return rows[0].count;
}

// Idempotent add: ON CONFLICT DO NOTHING means a duplicate/double-click add
// is a safe no-op, not an error.
async function addToWatchlist(userId, symbol) {
  await pool.query(
    `INSERT INTO watchlist_entry (user_id, symbol) VALUES ($1, $2)
     ON CONFLICT (user_id, symbol) DO NOTHING`,
    [userId, symbol]
  );
}

async function removeFromWatchlist(userId, symbol) {
  await pool.query(
    'DELETE FROM watchlist_entry WHERE user_id = $1 AND symbol = $2',
    [userId, symbol]
  );
}

// Full joined view: symbol + latest snapshot + last_seen + baseline in one
// query, avoiding N+1 chattiness (decided during the API contract design).
async function getWatchlistWithData(userId) {
  const { rows } = await pool.query(
    `SELECT
       w.symbol,
       s.price AS current_price,
       s.volume AS current_volume,
       s.fetched_at AS snapshot_fetched_at,
       s.is_stale,
       s.market_closed,
       b.status AS baseline_status,
       b.typical_daily_volatility,
       b.avg_volume,
       b.sparkline_closes,
       ls.price AS last_seen_price,
       ls.volume AS last_seen_volume,
       ls.seen_at AS last_seen_at
     FROM watchlist_entry w
     LEFT JOIN snapshot s ON s.symbol = w.symbol
     LEFT JOIN baseline b ON b.symbol = w.symbol
     LEFT JOIN last_seen ls ON ls.user_id = w.user_id AND ls.symbol = w.symbol
     WHERE w.user_id = $1
     ORDER BY w.added_at DESC`,
    [userId]
  );
  return rows;
}

// ---- Snapshot (shared across all users, written only by the poller) ----

// Atomic replace, never partial-field update — closes the poller-write vs
// user-read race we identified during planning.
async function upsertSnapshot(symbol, { price, volume, isStale, marketClosed }) {
  await pool.query(
    `INSERT INTO snapshot (symbol, price, volume, fetched_at, is_stale, market_closed)
     VALUES ($1, $2, $3, now(), $4, $5)
     ON CONFLICT (symbol) DO UPDATE SET
       price = EXCLUDED.price,
       volume = EXCLUDED.volume,
       fetched_at = EXCLUDED.fetched_at,
       is_stale = EXCLUDED.is_stale,
       market_closed = EXCLUDED.market_closed`,
    [symbol, price, volume, isStale, marketClosed]
  );
}

async function markSnapshotStale(symbol) {
  // Keep last-known-good price/volume intact; only flip the flag.
  // If no snapshot row exists yet (this symbol has NEVER successfully
  // fetched a single time), there's nothing to mark — this UPDATE is
  // correctly a no-op. That's a distinct state from "was fine, now stale":
  // callers must check for a null snapshot separately (see
  // getWatchlistWithData: current_price IS NULL means "no data yet",
  // is_stale=true on a non-null row means "had data, now degraded").
  await pool.query('UPDATE snapshot SET is_stale = true WHERE symbol = $1', [symbol]);
}

async function getSnapshot(symbol) {
  const { rows } = await pool.query('SELECT * FROM snapshot WHERE symbol = $1', [symbol]);
  return rows[0] || null;
}

async function getDistinctWatchedSymbols() {
  const { rows } = await pool.query('SELECT DISTINCT symbol FROM watchlist_entry');
  return rows.map((r) => r.symbol);
}

// Radar data: latest snapshot + baseline (volatility/avgVolume/sparkline) for
// a given set of symbols, WITHOUT any per-user notion. The radar compares a
// symbol's current move against its own recent baseline (market-wide "what's
// moving now"), not against a user's last_seen. Only symbols with a live
// (non-null) snapshot AND a computable baseline are worth scoring.
async function getRadarData(symbols) {
  if (!symbols || symbols.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT
       s.symbol,
       s.price AS current_price,
       s.volume AS current_volume,
       s.fetched_at AS snapshot_fetched_at,
       s.is_stale,
       s.market_closed,
       b.status AS baseline_status,
       b.typical_daily_volatility,
       b.avg_volume,
       b.sparkline_closes
     FROM snapshot s
     JOIN baseline b ON b.symbol = s.symbol
     WHERE s.symbol = ANY($1)`,
    [symbols]
  );
  return rows;
}

// ---- Index quotes (the top ticker strip's cache, written only by the poller) ----

// Indices never enter snapshot/baseline (those are FK-bound to watchable
// symbols), so they get their own tiny table — same write model as snapshot:
// atomic replace, never partial-field update.
async function upsertIndexQuote(symbol, { price, isStale, marketClosed }) {
  await pool.query(
    `INSERT INTO index_quote (symbol, price, fetched_at, is_stale, market_closed)
     VALUES ($1, $2, now(), $3, $4)
     ON CONFLICT (symbol) DO UPDATE SET
       price = EXCLUDED.price,
       fetched_at = EXCLUDED.fetched_at,
       is_stale = EXCLUDED.is_stale,
       market_closed = EXCLUDED.market_closed`,
    [symbol, price, isStale, marketClosed]
  );
}

async function markIndexQuoteStale(symbol) {
  // Same semantics as snapshot staleness: keep last-known-good price, only
  // flip the flag. No-op if no row exists yet (never successfully fetched).
  await pool.query('UPDATE index_quote SET is_stale = true WHERE symbol = $1', [symbol]);
}

async function getIndexQuote(symbol) {
  const { rows } = await pool.query('SELECT * FROM index_quote WHERE symbol = $1', [symbol]);
  return rows[0] || null;
}

async function getIndexQuotes() {
  const { rows } = await pool.query('SELECT * FROM index_quote ORDER BY symbol');
  return rows;
}

// ---- Last seen (the ack / "what changed since you last checked" reset) ----

async function seedLastSeenOnAdd(userId, symbol, { price, volume, seenAt }) {
  // Seeds last_seen = current snapshot at the moment of adding, so the
  // first-ever render is a true zero-diff instead of a missing-data case.
  await pool.query(
    `INSERT INTO last_seen (user_id, symbol, price, volume, seen_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, symbol) DO NOTHING`,
    [userId, symbol, price, volume, seenAt]
  );
}

// Ack is clamped: cannot move seen_at backwards (no replay), and the caller
// (route layer) is responsible for passing the server-issued snapshot
// timestamp, not a client-generated one — removes client clock trust.
async function ackWatchlistItem(userId, symbol, { price, volume, seenAt }) {
  const { rows } = await pool.query(
    `INSERT INTO last_seen (user_id, symbol, price, volume, seen_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, symbol) DO UPDATE SET
       price = EXCLUDED.price, volume = EXCLUDED.volume, seen_at = EXCLUDED.seen_at
       WHERE EXCLUDED.seen_at >= last_seen.seen_at
     RETURNING *`,
    [userId, symbol, price, volume, seenAt]
  );
  return rows[0] || null; // null means the ack was rejected as backwards-in-time
}

async function getLastSeen(userId, symbol) {
  const { rows } = await pool.query(
    'SELECT * FROM last_seen WHERE user_id = $1 AND symbol = $2',
    [userId, symbol]
  );
  return rows[0] || null;
}

module.exports = {
  createUser,
  findUserByEmail,
  getUserById,
  bumpSessionVersion,
  userExists,
  ensureBaselineExists,
  getBaseline,
  getRefreshableBaselineSymbols,
  markBaselineReady,
  markBaselineFailed,
  MAX_WATCHLIST_SIZE,
  getWatchlistCount,
  addToWatchlist,
  removeFromWatchlist,
  getWatchlistWithData,
  upsertSnapshot,
  markSnapshotStale,
  getSnapshot,
  getDistinctWatchedSymbols,
  getRadarData,
  upsertIndexQuote,
  markIndexQuoteStale,
  getIndexQuote,
  getIndexQuotes,
  seedLastSeenOnAdd,
  ackWatchlistItem,
  getLastSeen,
};
