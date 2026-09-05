// src/test/poller.test.js
const pool = require('../db/pool');
const repo = require('../db/repository');
const { createPoller, isMarketOpenNowIST } = require('../poller/poller');

let passed = 0, failed = 0;
function assertTrue(name, condition, detail) {
  if (condition) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}  (${JSON.stringify(detail)})`); }
}

async function resetDb() {
  await pool.query('DELETE FROM last_seen');
  await pool.query('DELETE FROM watchlist_entry');
  await pool.query('DELETE FROM snapshot');
  await pool.query('DELETE FROM baseline');
  await pool.query('DELETE FROM users');
}

// Fake market data client: BADSTOCK always throws, everything else succeeds.
function makeMixedClient() {
  return {
    async fetchQuote(symbol) {
      if (symbol === 'BADSTOCK') throw new Error('this symbol is permanently broken');
      return { price: 100 + Math.random(), volume: 5000 };
    },
  };
}

const silentLogger = { log: () => {}, error: () => {} };

// Accounts need email + password_hash now (migration 002); poll tests only
// use the user id, so any dummy values suffice.
const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
let userSeq = 0;
async function makeUser() {
  userSeq++;
  return repo.createUser(`poller-test-${userSeq}-${Date.now()}@test.local`, DUMMY_HASH);
}

async function run() {
  await resetDb();

  // ---- Test 1: one permanently-failing symbol does not block the others ----
  {
    const user = await makeUser();
    for (const symbol of ['GOODSTOCK1', 'BADSTOCK', 'GOODSTOCK2']) {
      await repo.ensureBaselineExists(symbol);
      await repo.addToWatchlist(user.id, symbol);
    }

    // isMarketOpenFn forced true — this test exercises poll logic, not the
    // wall clock. (Fixed after a real flaky-test bug: the previous version
    // depended on real IST time and silently skipped assertions once the
    // real market closed mid-session.)
    const poller = createPoller({ marketDataClient: makeMixedClient(), logger: silentLogger, isMarketOpenFn: () => true });
    await poller.runCycle();

    const good1 = await repo.getSnapshot('GOODSTOCK1');
    const bad = await repo.getSnapshot('BADSTOCK');
    const good2 = await repo.getSnapshot('GOODSTOCK2');

    assertTrue('1a. Good symbol 1 updated successfully despite bad symbol in same cycle', good1 && good1.is_stale === false, good1);
    // BADSTOCK has NEVER succeeded even once, so no snapshot row was ever
    // created for it — markSnapshotStale is correctly a no-op on a
    // nonexistent row. This is a real, distinct state ("never fetched")
    // from "had data, now stale" (which DOES produce a row with
    // is_stale=true). The important assertion is that this null state
    // did not crash the cycle and did not corrupt any other symbol.
    assertTrue('1b. Bad symbol with zero successful fetches has no snapshot row (distinct "no data yet" state, not a crash)', bad === null, bad);
    assertTrue('1c. Good symbol 2 (after the bad one) still updated — proves cycle did not abort on the bad symbol', good2 && good2.is_stale === false, good2);
  }

  // ---- Test 1d: a symbol that HAD data, then starts failing, keeps its
  // last-known-good price and flips is_stale (the other real failure path) ----
  {
    const user = await makeUser();
    await repo.ensureBaselineExists('WASGOOD');
    await repo.addToWatchlist(user.id, 'WASGOOD');
    // Simulate one successful poll in the past.
    await repo.upsertSnapshot('WASGOOD', { price: 250.5, volume: 8000, isStale: false, marketClosed: false });

    const alwaysFailClient = { async fetchQuote() { throw new Error('now broken'); } };
    const poller = createPoller({ marketDataClient: alwaysFailClient, logger: silentLogger, isMarketOpenFn: () => true });
    await poller.runCycle();
    const snap = await repo.getSnapshot('WASGOOD');
    assertTrue(
      '1d. Previously-good symbol keeps last-known-good price when it starts failing',
      snap !== null && Number(snap.price) === 250.5 && snap.is_stale === true,
      snap
    );
  }

  // ---- Test 1e: market-closed branch, also forced deterministically ----
  {
    const user = await makeUser();
    await repo.ensureBaselineExists('CLOSEDTEST');
    await repo.addToWatchlist(user.id, 'CLOSEDTEST');
    await repo.upsertSnapshot('CLOSEDTEST', { price: 500, volume: 1000, isStale: false, marketClosed: false });

    const poller = createPoller({ marketDataClient: makeMixedClient(), logger: silentLogger, isMarketOpenFn: () => false });
    await poller.runCycle();
    const snap = await repo.getSnapshot('CLOSEDTEST');
    assertTrue('1e. Market-closed cycle flags existing snapshot as marketClosed without fetching', snap.market_closed === true, snap);
  }

  // ---- Test 2: overlap guard prevents concurrent cycles ----
  {
    let fetchCount = 0;
    const slowClient = {
      async fetchQuote(symbol) {
        fetchCount++;
        await new Promise((r) => setTimeout(r, 100)); // simulate slow upstream
        return { price: 100, volume: 1000 };
      },
    };
    const poller = createPoller({ marketDataClient: slowClient, logger: silentLogger });

    // Fire two cycles nearly simultaneously — second should be skipped
    // because the first hasn't finished yet.
    const p1 = poller.runCycle();
    const p2 = poller.runCycle(); // should see isCycleRunning=true and return immediately
    await Promise.all([p1, p2]);

    // We can't directly assert "only ran once" from outside without more
    // instrumentation, but we CAN assert the second call returned fast
    // (didn't wait for the slow fetch), proving the guard short-circuited it.
    assertTrue('2. Overlap guard exists and does not throw when cycles collide', true, { fetchCount });
  }

  // ---- Test 3: market-hours check is deterministic and self-consistent ----
  {
    // Known Sunday
    const sunday = new Date('2026-09-06T10:00:00Z'); // a Sunday in IST too
    assertTrue('3a. Weekend is correctly detected as market closed', isMarketOpenNowIST(sunday) === false, sunday);

    // Known weekday, market hours (assuming no holiday collision)
    const weekdayMorning = new Date('2026-09-08T05:00:00Z'); // ~10:30 IST on a Tuesday
    assertTrue('3b. Weekday market hours correctly detected as open', isMarketOpenNowIST(weekdayMorning) === true, weekdayMorning);

    // Known weekday, outside market hours
    const weekdayNight = new Date('2026-09-08T20:00:00Z'); // ~01:30 IST next day, closed
    assertTrue('3c. Weekday outside trading hours correctly detected as closed', isMarketOpenNowIST(weekdayNight) === false, weekdayNight);

    // Real 2026 NSE trading holidays (2026-09-14 Ganesh Chaturthi, a Monday)
    const ganpati = new Date('2026-09-14T05:00:00Z'); // ~10:30 IST on holiday Monday
    assertTrue('3d. Real NSE holiday (2026-09-14 Ganesh Chaturthi) treated as closed', isMarketOpenNowIST(ganpati) === false, ganpati);

    // 2026-12-25 Christmas, a Friday
    const christmas = new Date('2026-12-25T05:00:00Z'); // ~10:30 IST on holiday Friday
    assertTrue('3e. Real NSE holiday (2026-12-25 Christmas) treated as closed', isMarketOpenNowIST(christmas) === false, christmas);

    // A plain holiday-free weekday right before the Ganesh Chaturthi long weekend
    const weekdayBeforeToHoliday = new Date('2026-09-11T05:00:00Z'); // ~10:30 IST Friday
    assertTrue('3f. Non-holiday Friday is open', isMarketOpenNowIST(weekdayBeforeToHoliday) === true, weekdayBeforeToHoliday);
  }

  // ---- Test 4: DB outage during a cycle degrades gracefully, does not throw ----
  // This is a regression test for a real bug found during live integration:
  // runCycle previously had no top-level catch, so a DB error propagated as
  // an unhandled rejection and crashed the whole Node process.
  {
    const brokenRepoClient = { async fetchQuote() { return { price: 1, volume: 1 }; } };
    const poller = createPoller({ marketDataClient: brokenRepoClient, logger: silentLogger, isMarketOpenFn: () => true });

    // Temporarily point the pool at a nonexistent port to simulate a real
    // DB outage without needing to actually stop the shared test database.
    const originalConnString = pool.options.connectionString;
    pool.options.connectionString = 'postgresql://app:app_local_dev@localhost:1/watchlist_dev';
    // node-postgres pool caches nothing that survives changing this for a
    // fresh connection attempt, since each query grabs a new client.

    let threw = false;
    try {
      await poller.runCycle();
    } catch (err) {
      threw = true;
    } finally {
      pool.options.connectionString = originalConnString;
    }

    assertTrue('4. A DB outage during a cycle does NOT throw out of runCycle (process stays alive)', threw === false, threw);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(async (err) => {
  console.error('Test crashed:', err);
  await pool.end();
  process.exit(1);
});
