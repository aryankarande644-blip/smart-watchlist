// src/test/oauth.e2e.test.js
// Full Google OAuth redirect flow against the REAL Express app over real HTTP
// and real Postgres. The Google side is faked by a local HTTP server standing
// in for the token + userinfo endpoints, and the OAuth client is pointed at it
// via the injectable tokenUrl/userinfoUrl — so the code under test is the
// actual route + session + repository wiring, with only Google's endpoints
// stubbed out.
//
// Covers the owner decisions recorded in HANDOFF §10#9:
//   (a) an OAuth sign-in CREATES the user (auth_provider='google', no password)
//   (b) the SAME account is reused on repeat sign-ins (never a duplicate)
//   (c) an existing email/password account is AUTO-LINKED silently — the same
//       row signs in, password still works, no duplicate row
//   (d) an unverified Google email is REJECTED before any user lookup
//   (e) the state nonce is consume-once (replay is rejected)
//   (f) a Google-only account can't be brute-forced through password login
//       (same 401 as an unknown email — no provider enumeration)
//   (g) an unconfigured provider degrades to auth_error=provider_not_configured
//       (both entry and callback) instead of a 500 or a silent blank
//   (h) a Google consent cancel (?error=access_denied) -> auth_error=google_denied

const fetch = require('node-fetch');
const http = require('http');
const pool = require('../db/pool');
const { createApp } = require('../server');
const { createGoogleOAuth } = require('../auth/googleOAuth');
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
  await pool.query('DELETE FROM index_quote');
  await pool.query('DELETE FROM baseline');
  await pool.query('DELETE FROM users');
}

const silentLogger = { log: () => {}, error: () => {} };

function cookieFrom(res) {
  const header = res.headers.get('set-cookie');
  return header ? header.split(';')[0] : null;
}

function stateFrom(res) {
  const location = res.headers.get('location');
  if (!location) return null;
  const match = location.match(/[?&]state=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function run() {
  await resetDb();

  // ---- Fake Google: a local server that stands in for the token + userinfo
  // endpoints. `fakeUserinfo` is swapped per-scenario below. ----
  let fakeUserinfo = { email: 'gauth@example.com', email_verified: true, name: 'G Atest', sub: 'sub-1' };
  const googleServer = http.createServer((req, res) => {
    const respond = (body) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url.startsWith('/token')) {
      respond({ access_token: 'access-token-1', token_type: 'Bearer', expires_in: 3600 });
    } else if (req.url.startsWith('/userinfo')) {
      respond(fakeUserinfo);
    } else {
      res.writeHead(404); res.end();
    }
  });
  await new Promise((resolve) => googleServer.listen(0, resolve));
  const googlePort = googleServer.address().port;

  const google = createGoogleOAuth({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    redirectUri: `http://localhost:${googlePort}/cb`,
    tokenUrl: `http://localhost:${googlePort}/token`,
    userinfoUrl: `http://localhost:${googlePort}/userinfo`,
  });

  const fakeProvider = {
    async fetchQuote() { return { price: 1000, volume: 50000 }; },
    async fetchHistorical() { return Array.from({ length: 20 }, () => ({ close: 1000, volume: 50000 })); },
  };
  const marketDataClient = createMarketDataClient(fakeProvider);
  const poller = createPoller({ marketDataClient, logger: silentLogger, isMarketOpenFn: () => true });

  const PORT = 4003;
  const appOrigin = 'http://localhost:5173';
  const app = createApp({
    marketDataClient,
    poller,
    authOptions: {
      google,
      loginRateLimit: { maxAttempts: 1000, windowMs: 15 * 60 * 1000 },
      appOrigin,
    },
  });
  const server = app.listen(PORT);
  const base = `http://localhost:${PORT}`;

  try {
    // ---- Entry point redirects to Google with a fresh CSRF state ----
    const start = await fetch(`${base}/auth/google`, { redirect: "manual" });
    const demoLocation = start.headers.get('location');
    assertTrue('1. GET /auth/google redirects (302) to Google', start.status === 302 && demoLocation && demoLocation.startsWith('https://accounts.google.com/o/oauth2/v2/auth'), start.status);
    assertTrue('1b. Redirect carries client_id + state nonce', demoLocation.includes('client_id=test-client-id') && demoLocation.includes('state='), demoLocation);

    // ---- (a) Brand-new Google user is CREATED with no password ----
    const s1 = stateFrom(start);
    const cb1 = await fetch(`${base}/auth/google/callback?code=auth-code-1&state=${encodeURIComponent(s1)}`, { redirect: "manual" });
    const cb1Cookie = cookieFrom(cb1);
    assertTrue('2. Callback redirects (302) into the frontend origin (no auth_error)', cb1.status === 302 && (cb1.headers.get('location') || '').startsWith(appOrigin) && !cb1.headers.get('location').includes('auth_error='), { status: cb1.status, location: cb1.headers.get('location') });
    assertTrue('2b. Callback issues a session cookie', cb1Cookie !== null, cb1Cookie);
    assertTrue('2c. Callback cookie is a SHORT session (no Max-Age/Expires — browser-close)', !(cb1.headers.get('set-cookie') || '').includes('Max-Age=') && !(cb1.headers.get('set-cookie') || '').includes('Expires='), cb1.headers.get('set-cookie'));

    const wl1 = await fetch(`${base}/watchlist`, { headers: { Cookie: cb1Cookie } });
    assertTrue('2d. The issued cookie authenticates against /watchlist', wl1.status === 200 && (await wl1.json()).user.email === 'gauth@example.com', wl1.status);

    const newUser = await pool.query('SELECT email, password_hash, auth_provider FROM users WHERE email = $1', ['gauth@example.com']);
    assertTrue('2e. OAuth user row: auth_provider=google, password_hash NULL', newUser.rows.length === 1 && newUser.rows[0].auth_provider === 'google' && newUser.rows[0].password_hash === null, newUser.rows);

    // ---- (b) Repeat sign-in reuses the SAME account, never a duplicate ----
    const s2 = stateFrom(await fetch(`${base}/auth/google`, { redirect: "manual" }));
    await fetch(`${base}/auth/google/callback?code=auth-code-2&state=${encodeURIComponent(s2)}`, { redirect: "manual" });
    const repeatCount = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE email = $1', ['gauth@example.com']);
    assertTrue('3. Repeat Google sign-in does NOT create a duplicate row', repeatCount.rows[0].n === 1, repeatCount.rows);

    // ---- (e) State nonce is consume-once: replaying the same state is rejected ----
    const replay = await fetch(`${base}/auth/google/callback?code=auth-code-bogus&state=${encodeURIComponent(s1)}`, { redirect: "manual" });
    const replayLocation = replay.headers.get('location') || '';
    assertTrue('4. Replaying a consumed state is rejected (state_mismatch)', replay.status === 302 && replayLocation.includes('auth_error=google_state_mismatch'), replayLocation);

    // ---- (d) Unverified Google email never reaches the user store ----
    fakeUserinfo = { email: 'unverified@example.com', email_verified: false, sub: 'sub-2' };
    const s3 = stateFrom(await fetch(`${base}/auth/google`, { redirect: "manual" }));
    const unverified = await fetch(`${base}/auth/google/callback?code=auth-code-3&state=${encodeURIComponent(s3)}`, { redirect: "manual" });
    const unverifiedLocation = unverified.headers.get('location') || '';
    assertTrue('5. Unverified email is redirected with google_email_unverified', unverified.status === 302 && unverifiedLocation.includes('auth_error=google_email_unverified'), unverifiedLocation);
    const unverifiedRow = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE email = $1', ['unverified@example.com']);
    assertTrue('5b. No user row was created for the unverified email', unverifiedRow.rows[0].n === 0, unverifiedRow.rows);

    // ---- (c) Verified Google email matching an EXISTING email/password
    // account auto-links silently: same row, password intact ----
    const signup = await fetch(`${base}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'linkme@example.com', password: 'linkme-password-1' }),
    });
    const signupCookie = cookieFrom(signup);
    const signupUser = await pool.query('SELECT id, password_hash, auth_provider FROM users WHERE email = $1', ['linkme@example.com']);
    const linkedId = signupUser.rows[0].id;
    const originalHash = signupUser.rows[0].password_hash;

    fakeUserinfo = { email: 'linkme@example.com', email_verified: true, sub: 'sub-3' };
    const s4 = stateFrom(await fetch(`${base}/auth/google`, { redirect: "manual" }));
    const linkedCb = await fetch(`${base}/auth/google/callback?code=auth-code-4&state=${encodeURIComponent(s4)}`, { redirect: "manual" });
    const linkedCookie = cookieFrom(linkedCb);
    assertTrue('6. Auto-link callback still 302s into the frontend', linkedCb.status === 302 && (linkedCb.headers.get('location') || '').startsWith(appOrigin), linkedCb.status);

    const linkedWl = await fetch(`${base}/watchlist`, { headers: { Cookie: linkedCookie } });
    const linkedWlBody = await linkedWl.json();
    assertTrue('6b. The Google-issued cookie is a session for the EXISTING account', linkedWl.status === 200 && linkedWlBody.user.email === 'linkme@example.com', { status: linkedWl.status, body: linkedWlBody.user });
    const afterLink = await pool.query('SELECT id, password_hash, auth_provider FROM users WHERE email = $1', ['linkme@example.com']);
    assertTrue(
      '6c. No duplicate row: same id, auth_provider still email, password_hash untouched',
      afterLink.rows.length === 1 && afterLink.rows[0].id === linkedId && afterLink.rows[0].auth_provider === 'email' && afterLink.rows[0].password_hash === originalHash,
      afterLink.rows
    );
    const pwLogin = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'linkme@example.com', password: 'linkme-password-1' }),
    });
    assertTrue('6d. Original email/password still logs in after being auto-linked', pwLogin.status === 200 && cookieFrom(pwLogin) !== null, pwLogin.status);

    // Also confirm the ORIGINAL password account still works with its own cookie.
    assertTrue('6e. The pre-link signup cookie still authenticates', (await fetch(`${base}/watchlist`, { headers: { Cookie: signupCookie } })).status === 200, 'expected 200');

    // ---- (f) A Google-only account cannot be brute-forced via password login,
    // and the failure is INDISTINGUISHABLE from an unknown email ----
    const gLogin = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'gauth@example.com', password: 'guess-password-123' }),
    });
    const gLoginBody = await gLogin.json();
    const unknownLogin = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com', password: 'guess-password-123' }),
    });
    const unknownLoginBody = await unknownLogin.json();
    assertTrue('7. Password login with a Google-only account email is 401 invalid_credentials', gLogin.status === 401 && gLoginBody.error.code === 'invalid_credentials', gLoginBody);
    assertTrue('7b. The response is byte-identical to an unknown email (no provider enumeration)', JSON.stringify(gLoginBody) === JSON.stringify(unknownLoginBody), { gLoginBody, unknownLoginBody });

    // ---- Signup collision: Google owns the email, email signup is refused ----
    const dupSignup = await fetch(`${base}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'gauth@example.com', password: 'some-password-1' }),
    });
    assertTrue('8. Email signup with a Google-owned email is 409 email_taken', dupSignup.status === 409, await dupSignup.json());

    // ---- (g) Provider not configured: both routes degrade to a CLEAR error
    // redirect, never a 500 and never a silent blank response. The frontend
    // maps auth_error=provider_not_configured to text on the login card. ----
    const noConfigApp = createApp({
      marketDataClient,
      poller,
      authOptions: { google: null, appOrigin },
    });
    const noConfigServer = noConfigApp.listen(0);
    const noConfigBase = `http://localhost:${noConfigServer.address().port}`;
    const ncStart = await fetch(`${noConfigBase}/auth/google`, { redirect: "manual" });
    const ncLocation = ncStart.headers.get('location') || '';
    assertTrue('9. Unconfigured provider: /auth/google redirects with auth_error=provider_not_configured', ncStart.status === 302 && ncLocation.startsWith(appOrigin) && ncLocation.includes('auth_error=provider_not_configured'), { status: ncStart.status, location: ncLocation });
    const ncCb = await fetch(`${noConfigBase}/auth/google/callback?code=whatever&state=whatever`, { redirect: "manual" });
    const ncCbLocation = ncCb.headers.get('location') || '';
    assertTrue('9b. Unconfigured provider: /auth/google/callback also redirects with provider_not_configured', ncCb.status === 302 && ncCbLocation.startsWith(appOrigin) && ncCbLocation.includes('auth_error=provider_not_configured'), { status: ncCb.status, location: ncCbLocation });
    noConfigServer.close();

    // ---- (h) User cancels at Google's consent screen: Google bounces back
    // with ?error=access_denied, the route turns it into google_denied (the
    // error check runs BEFORE state consumption, so no state/token is wasted).
    const denied = await fetch(`${base}/auth/google/callback?error=access_denied&state=any-nonce`, { redirect: "manual" });
    const deniedLocation = denied.headers.get('location') || '';
    assertTrue('10. Google cancel (?error=access_denied) redirects with auth_error=google_denied', denied.status === 302 && deniedLocation.startsWith(appOrigin) && deniedLocation.includes('auth_error=google_denied'), { status: denied.status, location: deniedLocation });

  } finally {
    poller.stop();
    server.close();
    googleServer.close();
    await pool.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(async (err) => {
  console.error('OAuth e2e crashed:', err);
  try { await pool.end(); } catch (_) {}
  try { process.exit(1); } catch (_) {}
});