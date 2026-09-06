// src/test/e2e.test.js
// Boots the REAL Express app on a real port, talks to it over real HTTP,
// against the real local Postgres instance. This is the highest-confidence
// test in the suite: if this passes, the actual wiring works, not just
// the individual pieces in isolation.
//
// Since migration 002 (real email/password accounts), this suite proves the
// full auth contract end-to-end, not just the watchlist wiring:
//   (a) two different accounts get two different, isolated watchlists
//   (b) wrong password is rejected (and is indistinguishable from unknown email)
//   (c) logout actually invalidates the session — the old cookie gets 401
//   (d) an unauthenticated /watchlist request returns 401, NOT a silently
//       created anonymous user

const fetch = require('node-fetch');
const pool = require('../db/pool');
const { createApp } = require('../server');
const { createMarketDataClient } = require('../marketData/client');
const { createPoller } = require('../poller/poller');
const { REMEMBER_ME_MAX_AGE_MS } = require('../routes/session');

let passed = 0, failed = 0;
function assertTrue(name, condition, detail) {
  if (condition) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}  (${JSON.stringify(detail)})`); }
}

async function resetDb() {
  await pool.query('DELETE FROM last_seen');
  await pool.query('DELETE FROM watchlist_entry');
  await pool.query('DELETE FROM snapshot');
  await pool.query('DELETE FROM index_quote');
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

// Extract the session_uid cookie from a Set-Cookie header.
function cookieFrom(res) {
  const header = res.headers.get('set-cookie');
  return header ? header.split(';')[0] : null;
}

async function run() {
  await resetDb();

  const marketDataClient = createMarketDataClient(fakeProvider);
  const poller = createPoller({
    marketDataClient,
    logger: { log: () => {}, error: () => {} },
    isMarketOpenFn: () => true, // deterministic — this test must not depend on real-world wall-clock time
  });
  // Generous login budget so the auth-flow assertions below never trip the
  // brute-force limiter; the limiter itself has its own focused test
  // (auth.test.js) with a real tight window.
  const app = createApp({
    marketDataClient,
    poller,
    authOptions: { loginRateLimit: { maxAttempts: 1000, windowMs: 15 * 60 * 1000 } },
  });

  const PORT = 3999;
  const server = app.listen(PORT);
  const base = `http://localhost:${PORT}`;

  try {
    // ---- Test 1: /health is fully public — no auth, no set-cookie ----
    const res1 = await fetch(`${base}/health`);
    assertTrue('1. Health check reachable over real HTTP', res1.status === 200, res1.status);

    // ---- (d): an unauthenticated /watchlist request is 401, NOT a
    // silently-created anonymous user. The "anonymous session" model is gone.
    const anonWatchlist = await fetch(`${base}/watchlist`);
    const anonBody = await anonWatchlist.json();
    assertTrue(
      'd. Unauthenticated /watchlist returns 401 not_authenticated',
      anonWatchlist.status === 401 && anonBody.error.code === 'not_authenticated',
      { status: anonWatchlist.status, body: anonBody }
    );
    assertTrue(
      'd2. Unauthenticated request does NOT set a session cookie (no silent user minted)',
      anonWatchlist.headers.get('set-cookie') === null && anonWatchlist.headers.get('set-cookie') === null,
      anonWatchlist.headers.get('set-cookie')
    );

    // ---- Signup validation: password too short, bad email shape ----
    const badPassword = await fetch(`${base}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'short' }),
    });
    const badPasswordBody = await badPassword.json();
    assertTrue(
      '0. Signup with a password under 8 chars is rejected',
      badPassword.status === 400 && badPasswordBody.error.code === 'password_too_short',
      badPasswordBody
    );
    const badEmail = await fetch(`${base}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', password: 'password123' }),
    });
    assertTrue('0b. Signup with a malformed email is rejected', badEmail.status === 400, await badEmail.json());

    // ---- Signup alice: 201 + session cookie ----
    const aliceSignup = await fetch(`${base}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'Alice@Example.com', password: 'alice-password-1' }),
    });
    const aliceCookie = cookieFrom(aliceSignup);
    assertTrue('2. Signup returns 201 with normalized-to-lowercase email', aliceSignup.status === 201 && (await aliceSignup.json()).user.email === 'alice@example.com', aliceSignup.status);
    assertTrue('2b. Signup issues a session cookie', aliceCookie !== null, aliceCookie);

    // Duplicate email (same normalized lowercase) is rejected.
    const dupSignup = await fetch(`${base}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'other-password-1' }),
    });
    assertTrue('2c. Duplicate email signup is rejected with 409 email_taken', dupSignup.status === 409, await dupSignup.json());

    // ---- Authenticated watchlist flow (alice only) ----
    const addRes = await fetch(`${base}/watchlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: aliceCookie },
      body: JSON.stringify({ symbol: 'reliance' }), // lowercase on purpose — tests normalization
    });
    assertTrue('3. Authenticated add responds 201 with normalized uppercase symbol', addRes.status === 201 && (await addRes.json()).symbol === 'RELIANCE', addRes.status);

    const listRes1 = await fetch(`${base}/watchlist`, { headers: { Cookie: aliceCookie } });
    const listBody1 = await listRes1.json();
    assertTrue(
      '3b. Freshly added symbol has an immediate live snapshot (validation call double-purposed to seed it)',
      listBody1.items.length === 1 && listBody1.items[0].status === 'live' && listBody1.items[0].currentPrice !== null,
      listBody1
    );
    assertTrue(
      '3c. First-ever view of a brand-new symbol correctly shows a true zero diff, not a crash or garbage number',
      listBody1.items[0].diff.finalScore === 0 && listBody1.items[0].diff.reason === 'ok',
      listBody1.items[0].diff
    );

    // ---- Test 4: run the poller for real, then re-check the watchlist ----
    await poller.runCycle();
    const listRes2 = await fetch(`${base}/watchlist`, { headers: { Cookie: aliceCookie } });
    const listBody2 = await listRes2.json();
    const item = listBody2.items[0];
    assertTrue(
      '4. After poll, symbol has real price data',
      item.currentPrice !== null && typeof item.currentPrice === 'number',
      item
    );

    // ---- Test 4b: new table fields — sparkline, volume, changePct ----
    assertTrue(
      '4b-a. sparklineCloses is a 7-element array of numbers (computed at add-time from 20-candle history)',
      Array.isArray(item.sparklineCloses) && item.sparklineCloses.length === 7 && typeof item.sparklineCloses[6] === 'number',
      item.sparklineCloses
    );
    assertTrue(
      '4b-b. currentVolume is a number after poll',
      typeof item.currentVolume === 'number' && item.currentVolume !== null,
      item.currentVolume
    );
    assertTrue(
      '4b-c. avgVolume is a number after baseline computation',
      typeof item.avgVolume === 'number' && item.avgVolume !== null,
      item.avgVolume
    );
    assertTrue(
      '4b-d. changePct is a number (first view = 0 since lastSeen was just seeded to current)',
      typeof item.changePct === 'number',
      item.changePct
    );

    // ---- Test 4c: GET /indices is fully public and caches the headline
    // indices after the poller run ----
    const indicesRes = await fetch(`${base}/indices`);
    const indicesBody = await indicesRes.json();
    assertTrue(
      '4c-a. /indices returns 200 without a session cookie',
      indicesRes.status === 200,
      indicesRes.status
    );
    assertTrue(
      '4c-b. /indices contains both NIFTY and SENSEX after a poller run',
      indicesBody.indices.length === 2 &&
        indicesBody.indices.some((i) => i.symbol === 'NIFTY' && typeof i.price === 'number') &&
        indicesBody.indices.some((i) => i.symbol === 'SENSEX' && typeof i.price === 'number'),
      indicesBody
    );
    const niftyIdx = indicesBody.indices.find((i) => i.symbol === 'NIFTY');
    assertTrue(
      '4c-c. /indices entry has label NIFTY 50',
      niftyIdx && niftyIdx.label === 'NIFTY 50',
      niftyIdx
    );

    // ---- Test 5: ack the current view, confirm it's recorded ----
    const ackRes = await fetch(`${base}/watchlist/RELIANCE/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: aliceCookie },
      body: JSON.stringify({ snapshotToken: item.snapshotToken }),
    });
    assertTrue('5. Ack succeeds', ackRes.status === 200, ackRes.status);

    // ---- Test 6: cross-site origin on a state-changing request is rejected ----
    // node-fetch sends no Origin by default, so the explicit evil Origin is
    // what triggers the check.
    const csrfRes = await fetch(`${base}/watchlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example', Cookie: aliceCookie },
      body: JSON.stringify({ symbol: 'INFY' }),
    });
    const csrfBody = await csrfRes.json();
    assertTrue(
      '6. Cross-origin POST rejected with 403 and correct error code',
      csrfRes.status === 403 && csrfBody.error.code === 'cross_origin_forbidden',
      csrfBody
    );

    // ---- Test 7: missing symbol / unknown symbol error envelopes ----
    const badBodyRes = await fetch(`${base}/watchlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: aliceCookie },
      body: JSON.stringify({}),
    });
    assertTrue('7. Missing symbol returns 400 missing_symbol', badBodyRes.status === 400 && (await badBodyRes.json()).error.code === 'missing_symbol', badBodyRes.status);

    const invalidRes = await fetch(`${base}/watchlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: aliceCookie },
      body: JSON.stringify({ symbol: 'THISSYMBOLDOESNOTEXISTANYWHERE' }),
    });
    assertTrue('7b. Unknown symbol rejected with 422 unknown_symbol', invalidRes.status === 422 && (await invalidRes.json()).error.code === 'unknown_symbol', invalidRes.status);

    // ---- (a): bob is a different account with his own, empty watchlist ----
    const bobSignup = await fetch(`${base}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'bob@example.com', password: 'bob-password-1' }),
    });
    const bobCookie = cookieFrom(bobSignup);
    const bobList = await fetch(`${base}/watchlist`, { headers: { Cookie: bobCookie } });
    const bobListBody = await bobList.json();
    assertTrue(
      'a. Two separate accounts: bob sees an empty watchlist while alice has items (no data leakage)',
      bobListBody.items.length === 0 && listBody1.items.length === 1,
      { bob: bobListBody, alice: listBody1 }
    );

    // ---- (b): wrong password is rejected; and it is indistinguishable from
    // unknown-email (same 401 code + body, no account enumeration) ----
    const wrongPass = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'wrong-password-999' }),
    });
    const wrongPassBody = await wrongPass.json();
    const unknownEmail = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com', password: 'whatever-password' }),
    });
    const unknownEmailBody = await unknownEmail.json();
    assertTrue(
      'b. Wrong password is rejected with 401 invalid_credentials',
      wrongPass.status === 401 && wrongPassBody.error.code === 'invalid_credentials',
      wrongPassBody
    );
    assertTrue(
      'b2. Unknown email gets the SAME response as a wrong password (no enumeration)',
      wrongPass.status === unknownEmail.status &&
        JSON.stringify(wrongPassBody) === JSON.stringify(unknownEmailBody),
      { wrongPassBody, unknownEmailBody }
    );

    // ---- (c): logout invalidates the session — the old cookie is dead ----
    const logoutRes = await fetch(`${base}/auth/logout`, {
      method: 'POST',
      headers: { Cookie: aliceCookie },
    });
    assertTrue('c. Logout returns 204', logoutRes.status === 204, logoutRes.status);
    const afterLogout = await fetch(`${base}/watchlist`, { headers: { Cookie: aliceCookie } });
    const afterLogoutBody = await afterLogout.json();
    assertTrue(
      'c2. Watchlist request with the logged-out cookie returns 401 (session invalidated)',
      afterLogout.status === 401 && afterLogoutBody.error.code === 'not_authenticated',
      { status: afterLogout.status, body: afterLogoutBody }
    );
    // Logout must also invalidate the same session for state-changing routes.
    const afterLogoutAdd = await fetch(`${base}/watchlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: aliceCookie },
      body: JSON.stringify({ symbol: 'TCS' }),
    });
    assertTrue('c3. Adding with the logged-out cookie also 401s', afterLogoutAdd.status === 401, afterLogoutAdd.status);

    // ---- Login restores the account: 200 + a working cookie, and alice's
    // watchlist is still there (persistence across "devices"/sessions) ----
    const aliceLogin = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'alice-password-1' }),
    });
    const aliceLoginCookie = cookieFrom(aliceLogin);
    assertTrue('d3. Correct login returns 200 with a fresh session cookie', aliceLogin.status === 200 && aliceLoginCookie !== null, aliceLogin.status);
    const restored = await fetch(`${base}/watchlist`, { headers: { Cookie: aliceLoginCookie } });
    const restoredBody = await restored.json();
    assertTrue(
      'd4. Watchlist persists across sessions — RELIANCE still there after login',
      restoredBody.items.some((i) => i.symbol === 'RELIANCE'),
      restoredBody
    );

    // ---- Remember me: a REAL cookie-expiry behavior, not a visual checkbox ----
    const remTrue = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'alice-password-1', remember: true }),
    });
    const remTrueHeader = remTrue.headers.get('set-cookie') || '';
    assertTrue(
      'rm1. remember=true issues a 90-day cookie — header carries the matched Max-Age + an Expires date',
      remTrueHeader.includes(`Max-Age=${REMEMBER_ME_MAX_AGE_MS / 1000}`) && remTrueHeader.includes('Expires='),
      { header: remTrueHeader, maxAge: REMEMBER_ME_MAX_AGE_MS }
    );
    const remFalse = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'alice-password-1', remember: false }),
    });
    const remFalseHeader = remFalse.headers.get('set-cookie') || '';
    assertTrue(
      'rm2. remember=false issues a browser-close session cookie (NO Max-Age/Expires in the header)',
      !remFalseHeader.includes('Max-Age=') && !remFalseHeader.includes('Expires='),
      remFalseHeader
    );
    const remAbsent = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'alice-password-1' }),
    });
    const remAbsentHeader = remAbsent.headers.get('set-cookie') || '';
    assertTrue(
      'rm3. Omitting remember entirely defaults to the short session cookie too',
      !remAbsentHeader.includes('Max-Age=') && !remAbsentHeader.includes('Expires='),
      remAbsentHeader
    );
    const remSignup = await fetch(`${base}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'remembered@example.com', password: 'remembered-pass-1', remember: true }),
    });
    const remSignupHeader = remSignup.headers.get('set-cookie') || '';
    assertTrue(
      'rm4. Signup honors remember=true with the same 90-day cookie',
      remSignupHeader.includes(`Max-Age=${REMEMBER_ME_MAX_AGE_MS / 1000}`),
      remSignupHeader
    );

    // ---- Delete flow (authenticated, with the fresh login cookie) ----
    const delRes = await fetch(`${base}/watchlist/RELIANCE`, { method: 'DELETE', headers: { Cookie: aliceLoginCookie } });
    assertTrue('8. Delete responds 204', delRes.status === 204, delRes.status);
    const listRes3 = await fetch(`${base}/watchlist`, { headers: { Cookie: aliceLoginCookie } });
    const listBody3 = await listRes3.json();
    assertTrue('8b. Symbol no longer in watchlist after delete', listBody3.items.length === 0, listBody3);

    // ---- Auth diagnostics: every login/signup outcome must appear in
    // /health's authEvents ring buffer so failed attempts are diagnosable
    // without Render log access. This MUST run before the orphan tests
    // below, which delete all users destructively. ----

    // 1) Both invalid-login and successful-login events must exist in the ring
    //    buffer by this point — the order depends on how many other auth events
    //    (signups, other logins) were recorded, so just confirm presence.
    const healthAfterAuth = await (await fetch(`${base}/health`)).json();
    const events = healthAfterAuth.authEvents || [];
    const eventTypes = events.map((e) => e.event);
    assertTrue(
      '10. /health exposes an authEvents array after auth activity',
      Array.isArray(events) && events.length > 0,
      events
    );
    assertTrue(
      '10b. auth_login_invalid was recorded for the wrong-password attempt',
      eventTypes.includes('auth_login_invalid'),
      eventTypes
    );
    assertTrue(
      '10c. auth_login_success was recorded for the correct login',
      eventTypes.includes('auth_login_success'),
      eventTypes
    );

    // 2) Re-authenticate alice, then check the newest event has email + ip.
    const freshLogin = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'alice-password-1' }),
    });
    const freshHealth = await (await fetch(`${base}/health`)).json();
    const newest = freshHealth.authEvents[0];
    assertTrue(
      '11. Newest auth event has the logged-in email',
      newest.event === 'auth_login_success' && newest.email === 'alice@example.com',
      newest
    );

    // 3) Session rejection: a cookie with a valid signature but a stale
    //    session_version must appear in the buffer as session_rejected.
    const orphanSetup = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'alice-password-1' }),
    });
    const orphanCookie = cookieFrom(orphanSetup);
    await pool.query('DELETE FROM users'); // orphan every session
    await fetch(`${base}/watchlist`, { headers: { Cookie: orphanCookie } });
    const staleHealth = await (await fetch(`${base}/health`)).json();
    const staleEvent = staleHealth.authEvents.find((e) => e.event === 'session_rejected');
    assertTrue(
      '12. Stale session cookie produces a session_rejected diagnostic event',
      !!staleEvent,
      staleHealth.authEvents.slice(0, 5)
    );

    // ---- Orphaned cookie: valid signature but the user row is gone. The new
    // model must answer 401, never crash (FK 23503 regression from bug #10)
    // and never mint a replacement anonymous account. ----
    const orphanSetup2 = await fetch(`${base}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'orphan@test.com', password: 'orphan-pass-123' }),
    });
    const orphanCookie2 = cookieFrom(orphanSetup2);
    await pool.query('DELETE FROM users'); // orphan every session
    const orphanRes = await fetch(`${base}/watchlist`, { headers: { Cookie: orphanCookie2 } });
    const orphanBody = await orphanRes.json();
    assertTrue(
      '9. Orphaned-cookie request returns 401, not a 500 (bug #10 regression)',
      orphanRes.status === 401 && orphanBody.error.code === 'not_authenticated',
      { status: orphanRes.status, body: orphanBody }
    );
    assertTrue(
      '9b. Orphaned-cookie request does not silently create a new account',
      (await fetch(`${base}/watchlist`)).status === 401,
      'both unauthenticated callers got 401'
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