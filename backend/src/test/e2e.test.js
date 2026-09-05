// src/test/e2e.test.js
// Boots the REAL Express app on a real port, talks to it over real HTTP,
// against the real local Postgres instance. This is the highest-confidence
// test in the suite: if this passes, the actual wiring works, not just
// the individual pieces in isolation.

const fetch = require('node-fetch');
const pool = require('../db/pool');
const { createApp } = require('../server');
const { createMarketDataClient } = require('../marketData/client');
const { createPoller } = require('../poller/poller');

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

const fakeProvider = {
  async fetchQuote(symbol) {
    if (symbol === 'THISSYMBOLDOESNOTEXISTANYWHERE') {
      throw new Error('simulated unknown symbol');
    }
    return { price: 1000 + Math.random() * 10, volume: 50000 };
  },
  async fetchHistorical(symbol, days = 20) {
    return Array.from({ length: days }, () => ({
      close: 1000 + Math.random() * 10,
      volume: 50000 + Math.random() * 10000,
    }));
  },
};

async function run() {
  await resetDb();

  const marketDataClient = createMarketDataClient(fakeProvider);
  const poller = createPoller({
    marketDataClient,
    logger: { log: () => {}, error: () => {} },
    isMarketOpenFn: () => true, // deterministic — this test must not depend on real-world wall-clock time
  });
  const app = createApp({ marketDataClient, poller });

  const PORT = 3999;
  const server = app.listen(PORT);
  const base = `http://localhost:${PORT}`;

  try {
    // ---- Test 1: first request creates a session cookie ----
    const res1 = await fetch(`${base}/health`);
    assertTrue('1. Health check reachable over real HTTP', res1.status === 200 || res1.status === 503, res1.status);

    const addRes = await fetch(`${base}/watchlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'reliance' }), // lowercase on purpose — tests normalization
    });
    const setCookieHeader = addRes.headers.get('set-cookie');
    assertTrue('2. Adding a symbol sets a session cookie', !!setCookieHeader, setCookieHeader);
    assertTrue('2b. Add responds 201 with normalized uppercase symbol', addRes.status === 201, addRes.status);
    const addBody = await addRes.json();
    assertTrue('2c. Symbol normalized to uppercase', addBody.symbol === 'RELIANCE', addBody);

    // Extract cookie to reuse across requests, simulating the same browser session.
    const cookie = setCookieHeader.split(';')[0];

    // ---- Test 3: with validation wired to a real provider call, adding a
    // symbol now seeds an immediate snapshot (no need to wait for the
    // poller's next cycle) — this replaced the old no_data_yet-on-add
    // behavior with a strictly better one. Confirm that improvement here.
    const listRes1 = await fetch(`${base}/watchlist`, { headers: { Cookie: cookie } });
    const listBody1 = await listRes1.json();
    assertTrue(
      '3. Freshly added symbol has an immediate live snapshot (validation call double-purposed to seed it)',
      listBody1.items.length === 1 && listBody1.items[0].status === 'live' && listBody1.items[0].currentPrice !== null,
      listBody1
    );
    assertTrue(
      '3b. First-ever view of a brand-new symbol correctly shows a true zero diff, not a crash or garbage number',
      listBody1.items[0].diff.finalScore === 0 && listBody1.items[0].diff.reason === 'ok',
      listBody1.items[0].diff
    );

    // ---- Test 4: run the poller for real, then re-check the watchlist ----
    await poller.runCycle();
    const listRes2 = await fetch(`${base}/watchlist`, { headers: { Cookie: cookie } });
    const listBody2 = await listRes2.json();
    const item = listBody2.items[0];
    assertTrue(
      '4. After poll, symbol has real price data',
      item.currentPrice !== null && typeof item.currentPrice === 'number',
      item
    );

    // ---- Test 5: ack the current view, confirm it's recorded ----
    const ackRes = await fetch(`${base}/watchlist/RELIANCE/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ snapshotToken: item.snapshotToken }),
    });
    assertTrue('5. Ack succeeds', ackRes.status === 200, ackRes.status);

    // ---- Test 6: a second browser (no cookie) gets its OWN independent session ----
    const res2ndUser = await fetch(`${base}/watchlist`);
    const cookie2ndUser = res2ndUser.headers.get('set-cookie');
    assertTrue('6. A request with no cookie gets a fresh, different session', !!cookie2ndUser && cookie2ndUser !== setCookieHeader, { cookie2ndUser, setCookieHeader });
    const body2ndUser = await res2ndUser.json();
    assertTrue('6b. New session has an empty watchlist (no data leakage between users)', body2ndUser.items.length === 0, body2ndUser);

    // ---- Test 7: remove the symbol, confirm it's gone ----
    const delRes = await fetch(`${base}/watchlist/RELIANCE`, { method: 'DELETE', headers: { Cookie: cookie } });
    assertTrue('7. Delete responds 204', delRes.status === 204, delRes.status);
    const listRes3 = await fetch(`${base}/watchlist`, { headers: { Cookie: cookie } });
    const listBody3 = await listRes3.json();
    assertTrue('7b. Symbol no longer in watchlist after delete', listBody3.items.length === 0, listBody3);

    // ---- Test 8: missing symbol on POST returns a clean error envelope ----
    const badRes = await fetch(`${base}/watchlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    });
    const badBody = await badRes.json();
    assertTrue(
      '8. Missing symbol returns uniform error envelope',
      badRes.status === 400 && badBody.error && badBody.error.code === 'missing_symbol',
      badBody
    );

    // ---- Test 9: unknown/invalid symbol is rejected with 422, never touches the DB ----
    const invalidRes = await fetch(`${base}/watchlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ symbol: 'THISSYMBOLDOESNOTEXISTANYWHERE' }),
    });
    const invalidBody = await invalidRes.json();
    assertTrue(
      '9. Unknown symbol rejected with 422 and correct error code',
      invalidRes.status === 422 && invalidBody.error && invalidBody.error.code === 'unknown_symbol',
      invalidBody
    );
    const listAfterInvalid = await fetch(`${base}/watchlist`, { headers: { Cookie: cookie } });
    const listAfterInvalidBody = await listAfterInvalid.json();
    assertTrue(
      '9b. Rejected symbol did not get added to the watchlist',
      listAfterInvalidBody.items.every((i) => i.symbol !== 'THISSYMBOLDOESNOTEXISTANYWHERE'),
      listAfterInvalidBody
    );

  // ---- Test 10: cross-site origin on a state-changing request is rejected ----
    // CSRF defense-in-depth beyond sameSite:strict. node-fetch sends no
    // Origin by default, so the explicit evil Origin here is what triggers it.
    const csrfRes = await fetch(`${base}/watchlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example', Cookie: cookie },
      body: JSON.stringify({ symbol: 'INFY' }),
    });
    const csrfBody = await csrfRes.json();
    assertTrue(
      '10. Cross-origin POST rejected with 403 and correct error code',
      csrfRes.status === 403 && csrfBody.error && csrfBody.error.code === 'cross_origin_forbidden',
      csrfBody
    );

    // Test 10b: the SAME request sent without an Origin header (normal
    // same-origin browser fetch via the Vite proxy, or curl) is unaffected.
    const noOriginRes = await fetch(`${base}/watchlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ symbol: 'INFY' }),
    });
    assertTrue('10b. Same request without Origin is accepted normally', noOriginRes.status === 201, noOriginRes.status);

    // ---- Test 11: a signed-but-orphaned session cookie (its user row was
    // deleted, e.g. by a DB reset) must NOT 500 — the middleware substitutes a
    // fresh anonymous session and the request succeeds. Regression for the
    // FK-23503 crash found live: TRUNCATE users CASCADE orphaned pre-reset
    // cookies, and addToWatchlist then blew up on the missing parent row. ----
    const orphanCookieSetup = await fetch(`${base}/watchlist`); // mints a fresh session
    const orphanCookieHeader = orphanCookieSetup.headers.get('set-cookie');
    const orphanCookie = orphanCookieHeader ? orphanCookieHeader.split(';')[0] : null;
    assertTrue('11. Orphan-cookie setup produced a cookie', !!orphanCookie, orphanCookieHeader);
    await pool.query('DELETE FROM users'); // orphan every session, simulating a DB reset
    const orphanRes = await fetch(`${base}/watchlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: orphanCookie },
      body: JSON.stringify({ symbol: 'TCS' }),
    });
    const orphanBody = await orphanRes.json();
    const orphanSetCookie = orphanRes.headers.get('set-cookie');
    assertTrue(
      '11. Orphaned cookie gets a fresh anonymous session, not a 500',
      orphanRes.status === 201 && !!orphanSetCookie && !!orphanCookie && orphanSetCookie.split(';')[0] !== orphanCookie,
      { status: orphanRes.status, orphanSetCookie, body: orphanBody }
    );
    const orphanList = await fetch(`${base}/watchlist`, { headers: { Cookie: orphanSetCookie.split(';')[0] } });
    const orphanListBody = await orphanList.json();
    assertTrue(
      '11b. Orphaned-session add actually persisted (fresh user owns it now)',
      orphanListBody.items.some((i) => i.symbol === 'TCS'),
      orphanListBody
    );

  } finally {
    poller.stop();
    server.close();
    await pool.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(async (err) => {
  console.error('E2E test crashed:', err);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
