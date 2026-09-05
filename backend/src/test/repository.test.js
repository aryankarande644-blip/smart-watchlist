// src/test/repository.test.js
// Runs against the real local Postgres instance (not mocked) — this is
// specifically to prove the concurrency-lock and idempotency behaviors
// we designed on paper, since those are exactly the kind of bug that
// only shows up under real execution.

const pool = require('../db/pool');
const repo = require('../db/repository');

let passed = 0;
let failed = 0;

function assertTrue(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}  (${JSON.stringify(detail)})`);
  }
}

async function resetDb() {
  // Clean slate between test runs — order matters due to FK constraints.
  await pool.query('DELETE FROM last_seen');
  await pool.query('DELETE FROM watchlist_entry');
  await pool.query('DELETE FROM snapshot');
  await pool.query('DELETE FROM baseline');
  await pool.query('DELETE FROM users');
}

// Accounts require email + password_hash now (migration 002); these tests
// only exercise watchlist plumbing, so any dummy values work.
const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
let userSeq = 0;
async function makeUser() {
  userSeq++;
  return repo.createUser(`test-${userSeq}-${Date.now()}@test.local`, DUMMY_HASH);
}

async function run() {
  await resetDb();

  // ---- Test 1: baseline race lock — two concurrent "first add" of the
  // same brand-new symbol must result in exactly ONE winner. ----
  {
    const results = await Promise.all([
      repo.ensureBaselineExists('RELIANCE'),
      repo.ensureBaselineExists('RELIANCE'),
      repo.ensureBaselineExists('RELIANCE'),
    ]);
    const winners = results.filter((r) => r.created === true);
    assertTrue(
      '1. Concurrent baseline creation: exactly one winner out of 3 racers',
      winners.length === 1,
      results
    );
  }

  // ---- Test 2: idempotent watchlist add — duplicate add is a safe no-op ----
  {
    const user = await makeUser();
    await repo.addToWatchlist(user.id, 'RELIANCE');
    await repo.addToWatchlist(user.id, 'RELIANCE'); // duplicate, should not error or double-insert
    const count = await repo.getWatchlistCount(user.id);
    assertTrue('2. Duplicate add does not create a second row', count === 1, count);
  }

  // ---- Test 3: watchlist size cap is enforceable at the query layer ----
  {
    const user = await makeUser();
    for (let i = 0; i < 5; i++) {
      const symbol = `TESTSTOCK${i}`;
      await repo.ensureBaselineExists(symbol);
      await repo.addToWatchlist(user.id, symbol);
    }
    const count = await repo.getWatchlistCount(user.id);
    assertTrue('3. Watchlist count query is accurate after multiple adds', count === 5, count);
  }

  // ---- Test 4: snapshot upsert is atomic and does not partial-write ----
  {
    await repo.ensureBaselineExists('TCS');
    await repo.upsertSnapshot('TCS', { price: 3500.5, volume: 100000, isStale: false, marketClosed: false });
    let snap = await repo.getSnapshot('TCS');
    assertTrue('4a. First snapshot write lands correctly', Number(snap.price) === 3500.5 && snap.volume === '100000', snap);

    // Simulate the poller updating again — full replace, not partial.
    await repo.upsertSnapshot('TCS', { price: 3550.75, volume: 120000, isStale: false, marketClosed: false });
    snap = await repo.getSnapshot('TCS');
    assertTrue('4b. Second snapshot write fully replaces old values', Number(snap.price) === 3550.75 && snap.volume === '120000', snap);
  }

  // ---- Test 5: markSnapshotStale preserves last-known-good price ----
  {
    await repo.markSnapshotStale('TCS');
    const snap = await repo.getSnapshot('TCS');
    assertTrue(
      '5. Marking stale preserves the last-known-good price (not wiped)',
      snap.is_stale === true && Number(snap.price) === 3550.75,
      snap
    );
  }

  // ---- Test 6: ack cannot move seen_at backwards (replay protection) ----
  {
    const user = await makeUser();
    await repo.ensureBaselineExists('INFY');
    await repo.addToWatchlist(user.id, 'INFY');

    const t1 = new Date('2026-09-04T10:00:00Z');
    const t0Earlier = new Date('2026-09-04T09:00:00Z');

    const firstAck = await repo.ackWatchlistItem(user.id, 'INFY', { price: 1500, volume: 5000, seenAt: t1 });
    assertTrue('6a. First ack succeeds and returns a row', firstAck !== null, firstAck);

    const replayAck = await repo.ackWatchlistItem(user.id, 'INFY', { price: 1400, volume: 4000, seenAt: t0Earlier });
    assertTrue('6b. Ack with an earlier timestamp is rejected (no replay)', replayAck === null, replayAck);

    const lastSeen = await repo.getLastSeen(user.id, 'INFY');
    assertTrue(
      '6c. Rejected replay did not overwrite the real last_seen value',
      Number(lastSeen.price) === 1500,
      lastSeen
    );
  }

  // ---- Test 7: getDistinctWatchedSymbols reflects only currently-watched symbols ----
  {
    await resetDb();
    const userA = await makeUser();
    const userB = await makeUser();
    await repo.ensureBaselineExists('WIPRO');
    await repo.ensureBaselineExists('HDFC');
    await repo.addToWatchlist(userA.id, 'WIPRO');
    await repo.addToWatchlist(userB.id, 'WIPRO'); // both watch WIPRO
    await repo.addToWatchlist(userB.id, 'HDFC');

    let symbols = await repo.getDistinctWatchedSymbols();
    assertTrue(
      '7a. Distinct symbols across users, no duplicates',
      symbols.sort().join(',') === 'HDFC,WIPRO',
      symbols
    );

    await repo.removeFromWatchlist(userB.id, 'HDFC');
    symbols = await repo.getDistinctWatchedSymbols();
    assertTrue(
      '7b. Symbol drops out of poll universe once nobody watches it',
      symbols.sort().join(',') === 'WIPRO',
      symbols
    );
  }

  // ---- Test 8: getWatchlistWithData returns a single joined row per symbol ----
  {
    await resetDb();
    const user = await makeUser();
    await repo.ensureBaselineExists('AXISBANK');
    await repo.markBaselineReady('AXISBANK', { typicalDailyVolatility: 0.018, avgVolume: 80000, historyDaysUsed: 20 });
    await repo.upsertSnapshot('AXISBANK', { price: 1100, volume: 90000, isStale: false, marketClosed: false });
    await repo.addToWatchlist(user.id, 'AXISBANK');
    await repo.seedLastSeenOnAdd(user.id, 'AXISBANK', { price: 1100, volume: 90000, seenAt: new Date() });

    const rows = await repo.getWatchlistWithData(user.id);
    assertTrue('8. Joined watchlist query returns exactly one row for the symbol', rows.length === 1, rows);
    assertTrue(
      '8b. Joined row carries baseline + snapshot + last_seen together',
      rows[0].baseline_status === 'ready' && Number(rows[0].current_price) === 1100,
      rows[0]
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(async (err) => {
  console.error('Test run crashed:', err);
  await pool.end();
  process.exit(1);
});
