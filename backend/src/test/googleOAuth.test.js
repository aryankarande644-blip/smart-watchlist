// src/test/googleOAuth.test.js
// Unit tests for the two new auth-from-scratch primitives:
//   - createGoogleOAuth: URL building, code exchange, and userinfo fetch are
//     exact about what they send to Google (felt the most worth locking down —
//     a wrong scope or a leaked client_secret in a URL would be a real bug).
//   - createStateStore: the OAuth CSRF nonce store's consume-once + TTL rules.
//
// Both use injected fakes (a stub fetch / an injected clock), so this suite
// needs no network and no Postgres. The FULL redirect flow (routes + real
// client pointed at a fake Google) lives in oauth.e2e.test.js.

const { createGoogleOAuth } = require('../auth/googleOAuth');
const { createStateStore } = require('../auth/oauthState');

let passed = 0, failed = 0;
function assertTrue(name, condition, detail) {
  if (condition) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}  (${JSON.stringify(detail)})`); }
}

// Minimal node-fetch-shaped stub. Callers can attach overrides per-test.
function stubFetch(calls, overrides = {}) {
  return async (url, options) => {
    calls.push({ url, options });
    if (overrides.throw_) throw overrides.throw_;
    return {
      ok: overrides.ok !== false,
      status: overrides.status || 200,
      json: async () => overrides.json || {},
      text: async () => overrides.text || '',
    };
  };
}

async function run() {
  // ---- OAuth URL building ----
  {
    const client = createGoogleOAuth({ clientId: 'cid-1', clientSecret: 'sec-1', redirectUri: 'https://app.example/auth/google/callback' });
    const url = client.getAuthorizationUrl('STATE-123');
    assertTrue('1. authorize URL points at Google', url.startsWith('https://accounts.google.com/o/oauth2/v2/auth'), url);
    assertTrue('1b. URL carries client_id', url.includes('client_id=cid-1'), url);
    assertTrue('1c. URL carries the exact registered redirect_uri', url.includes('redirect_uri=https%3A%2F%2Fapp.example%2Fauth%2Fgoogle%2Fcallback'), url);
    assertTrue('1d. URL requests the authorization-code response type', url.includes('response_type=code'), url);
    const parsed = new URLSearchParams(url.split('?')[1]);
    assertTrue('1e. URL requests openid+email scope (minimal, no profile beyond it)', parsed.get('scope') === 'openid email', parsed.get('scope'));
    assertTrue('1f. URL echoes the anti-CSRF state nonce', parsed.get('state') === 'STATE-123', url);
    assertTrue('1g. client_secret is NOT in the authorize URL (it must never leave the token exchange)', url.includes('client_secret') === false, url);
  }

  // ---- Code exchange ----
  {
    const calls = [];
    const client = createGoogleOAuth({
      clientId: 'cid-2', clientSecret: 'sec-2', redirectUri: 'https://app.example/cb',
      httpClient: stubFetch(calls, { json: { access_token: 'tok-abc', token_type: 'Bearer' } }),
    });
    const token = await client.exchangeCode('AUTHCODE');
    assertTrue('2. exchangeCode returns the token payload', token.access_token === 'tok-abc', token);
    const call = calls[0];
    assertTrue('2b. token request hits the token endpoint', call.url === 'https://oauth2.googleapis.com/token', call.url);
    assertTrue('2c. token request is a form-encoded POST', call.options.method === 'POST' && (call.options.headers['Content-Type'] || '').includes('application/x-www-form-urlencoded'), call.options.headers);
    const form = call.options.body;
    assertTrue('2d. grant_type=authorization_code on the wire', form.includes('grant_type=authorization_code'), form);
    assertTrue('2e. code, client_id, client_secret, redirect_uri all present', form.includes('code=AUTHCODE') && form.includes('client_id=cid-2') && form.includes('client_secret=sec-2') && form.includes('redirect_uri=https%3A%2F%2Fapp.example%2Fcb'), form);
  }

  // ---- Code exchange failure surface ----
  {
    const calls = [];
    const client = createGoogleOAuth({
      clientId: 'cid', clientSecret: 'sec', redirectUri: 'urn:x',
      httpClient: stubFetch(calls, { ok: false, status: 400, text: '{"error":"invalid_grant"}' }),
    });
    let thrown = null;
    try { await client.exchangeCode('BAD'); } catch (err) { thrown = err; }
    assertTrue('3. failed exchange throws with a stable error code', thrown && thrown.code === 'google_token_exchange_failed', thrown);
  }

  // ---- Userinfo fetch ----
  {
    const calls = [];
    const client = createGoogleOAuth({
      clientId: 'cid', clientSecret: 'sec', redirectUri: 'urn:x',
      httpClient: stubFetch(calls, { json: { email: 'a@b.com', email_verified: true } }),
    });
    const info = await client.getUserInfo('tok-xyz');
    assertTrue('4. getUserInfo returns the Google profile', info.email === 'a@b.com' && info.email_verified === true, info);
    assertTrue('4b. userinfo request sends the bearer token', calls[0].options.headers.Authorization === 'Bearer tok-xyz', calls[0].options.headers);
    assertTrue('4c. userinfo request hits the v3 endpoint', calls[0].url === 'https://www.googleapis.com/oauth2/v3/userinfo', calls[0].url);
  }

  // ---- State store: issue / consume-once / unknown / expired ----
  {
    let clock = 1000;
    const store = createStateStore({ ttlMs: 500, now: () => clock });
    const s1 = store.issue();
    const s2 = store.issue();
    assertTrue('5. issued states are distinct random nonces', typeof s1 === 'string' && s1.length >= 16 && s1 !== s2, { s1, s2 });
    assertTrue('5b. a freshly issued state is consumable', store.consume(s1) === true);
    assertTrue('5c. the SAME state is rejected on replay (consume-once)', store.consume(s1) === false);
    assertTrue('5d. a never-issued state is rejected', store.consume('attacker-guess') === false);
    assertTrue('5e. undefined/null state is rejected', store.consume(undefined) === false && store.consume(null) === false);
    clock += 600; // push past the TTL
    assertTrue('5f. an expired state is rejected', store.consume(s2) === false);
  }

  // ---- State store: reusable clock-controlled TTL + boundary ----
  {
    let clock = 0;
    const store = createStateStore({ ttlMs: 100, now: () => clock });
    const s = store.issue();
    clock = 99; // inside the window
    assertTrue('6. state inside the TTL is accepted', store.consume(s) === true);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(async (err) => {
  console.error('Google OAuth test crashed:', err);
  process.exit(1);
});