// src/test/radar.e2e.test.js
// Boots the REAL Express app over real HTTP + real Postgres, testing the
// Market Radar endpoint:
//   (a) excludes symbols already on the requesting user's watchlist
//   (b) returns at most 5 results, sorted by absolute score descending
//   (c) badge mapping surfaces the expected kinds across the universe
//
// The radaring strategy uses the poller-cached snapshot + baseline tables,
// so this seeds a realistic universe where each symbol's current price moves
// a known amount relative to its own baseline — making the badge outcomes
// deterministic rather than random.

const fetch = require('node-fetch');
const pool = require('../db/pool');
const repo = require('../db/repository');
const { createApp } = require('../server');
const { createMarketDataClient } = require('../marketData/client');
const { createPoller } = require('../poller/poller');
const { RADAR_UNIVERSE } = require('../marketData/radarUniverse');

let passed = 0, failed = 0;
function assertTrue(name, condition, detail) {
  if (condition) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}  (${JSON.stringify(detail)})`); }
}

const silentLogger = { log: () => {}, error: () => {} };
const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

async function resetDb() {
  await pool.query('DELETE FROM last_seen');
  await pool.query('DELETE FROM watchlist_entry');
  await pool.query('DELETE FROM index_quote');
  await pool.query('DELETE FROM snapshot');
  await pool.query('DELETE FROM baseline');
  await pool.query('DELETE FROM users');
}

// Seed a radar candidate symbol with a baseline and a snapshot. The current
// price is set relative to its baseline volatility / the sparkline last close
// so the diff is a known magnitude.
// Reference price = sparklineCloses last value; current price = reference * priceFactor.
// volatility is used as typical_daily_volatility.
async function seedRadarSymbol(symbol, { sparklineLast, priceFactor, avgVolume, volatility, currentVolume }) {
  await repo.ensureBaselineExists(symbol);
  const sparkline = Array.from({ length: 7 }, (_, i) => Math.round((sparklineLast - (6 - i)) * 100) / 100);
  await repo.markBaselineReady(symbol, {
    typicalDailyVolatility: volatility,
    avgVolume,
    historyDaysUsed: 20,
    sparklineCloses: sparkline,
  });
  const price = Math.round(sparklineLast * priceFactor * 100) / 100;
  await repo.upsertSnapshot(symbol, { price, volume: currentVolume, isStale: false, marketClosed: false });
  return { symbol, reference: sparklineLast, price, sparkline };
}

function cookieFrom(res) {
  const header = res.headers.get('set-cookie');
  return header ? header.split(';')[0] : null;
}

async function run() {
  await resetDb();

  // Deterministic provider (radar route itself does NOT call it; this exists
  // only so the app boots with a valid client/poller).
  const fakeProvider = {
    async fetchQuote() { return { price: 1000, volume: 50000 }; },
    async fetchHistorical() {
      return Array.from({ length: 20 }, () => ({ close: 1000, volume: 50000 }));
    },
  };

  const marketDataClient = createMarketDataClient(fakeProvider);
  const poller = createPoller({ marketDataClient, logger: silentLogger, isMarketOpenFn: () => true });
  const app = createApp({
    marketDataClient,
    poller,
    authOptions: { loginRateLimit: { maxAttempts: 1000, windowMs: 15 * 60 * 1000 } },
  });

  const PORT = 4001;
  const server = app.listen(PORT);
  const base = `http://localhost:${PORT}`;

  try {
    // Seed a handful of radar-universe symbols with distinct move magnitudes.
    const M = 1.0 / 100; // baseline volatility 1%
    // A: huge volume-confirmed up move (Volume Spike) — 3x vol, +4% price
    await seedRadarSymbol('TITAN', { sparklineLast: 3000, priceFactor: 1.04, avgVolume: 100000, volatility: M, currentVolume: 300000 });
    // B: strong up move, normal-ish volume (Strong Move) — +3%, 1.1x vol
    await seedRadarSymbol('WIPRO', { sparklineLast: 400, priceFactor: 1.03, avgVolume: 100000, volatility: M, currentVolume: 110000 });
    // C: sharp down move (High Volatility) — -3%
    await seedRadarSymbol('ITC', { sparklineLast: 300, priceFactor: 0.97, avgVolume: 100000, volatility: M, currentVolume: 100000 });
    // D: near-breakout, moderate up move — +1.2% (< 1.5x vol threshold)
    await seedRadarSymbol('SBIN', { sparklineLast: 700, priceFactor: 1.012, avgVolume: 100000, volatility: M, currentVolume: 100000 });
    // E: non-mover — tiny move (no badge)
    await seedRadarSymbol('TCS', { sparklineLast: 3500, priceFactor: 1.001, avgVolume: 100000, volatility: M, currentVolume: 100000 });

    // Sign up a user and add TITAN + TCS to their watchlist — both must be
    // excluded from their radar.
    const signup = await fetch(`${base}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'radar@example.com', password: 'radar-pass-1' }),
    });
    const cookie = cookieFrom(signup);
    await fetch(`${base}/watchlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ symbol: 'TITAN' }),
    });
    await fetch(`${base}/watchlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ symbol: 'TCS' }),
    });

    const res = await fetch(`${base}/radar`, { headers: { Cookie: cookie } });
    const body = await res.json();
    const items = body.items || [];

    assertTrue('1. /radar responds 200 for an authenticated user', res.status === 200, res.status);

    // (a) exclusion
    assertTrue(
      '2a. Symbols on the user watchlist (TITAN, TCS) are excluded from the radar',
      !items.some((i) => i.symbol === 'TITAN' || i.symbol === 'TCS'),
      items.map((i) => i.symbol)
    );

    // (b) at most 5, sorted by abs finalScore descending
    assertTrue('2b. Radar returns at most 5 items', items.length <= 5, items.length);
    const sorted = items.every((it, i) => i === 0 || Math.abs(items[i - 1].diff.finalScore) >= Math.abs(it.diff.finalScore));
    assertTrue('2c. Items sorted by absolute score descending', sorted, items.map((i) => i.diff.finalScore));

    // (c) badge mapping: the seeded movers should carry the expected labels
    const bySym = Object.fromEntries(items.map((i) => [i.symbol, i]));

    // TITAN excluded (watchlist), so WIPRO (+3%, normal vol) and ITC (-3%) and
    // SBIN (+1.2%) and others should appear. Confirm we captured at least one
    // of each badge class among the remaining seeded universe.
    const labels = new Set(items.map((i) => i.badge && i.badge.label));
    assertTrue(
      '3. Radar surfaces Strong Move / High Volatility / Near Breakout badges from seeded movers',
      labels.has('Strong Move') && labels.has('High Volatility') && labels.has('Near Breakout'),
      [...labels]
    );

    // ITC is a High Volatility (down move) and is NOT on the watchlist.
    if (bySym.ITC) {
      assertTrue('4. Down mover ITC labelled High Volatility', bySym.ITC.badge.label === 'High Volatility', bySym.ITC.badge);
    }

    // Each card carries the fields the frontend needs.
    assertTrue(
      '5. Every card has symbol/currentPrice/sparklineCloses/volume fields',
      items.every((i) => i.symbol && typeof i.currentPrice === 'number' && Array.isArray(i.sparklineCloses) && i.avgVolume !== undefined),
      items[0]
    );

    // Unauthenticated /radar is 401 (it's user-specific).
    const unauth = await fetch(`${base}/radar`);
    assertTrue('6. Unauthenticated /radar returns 401', unauth.status === 401, unauth.status);

  } finally {
    poller.stop();
    server.close();
    await pool.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(async (err) => {
  console.error('Radar e2e crashed:', err);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});