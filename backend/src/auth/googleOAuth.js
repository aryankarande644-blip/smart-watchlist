// src/auth/googleOAuth.js
//
// Tiny OAuth 2.0 authorization-code client for Google Sign-In. It owns exactly
// three operations, mirroring how the browser authorization-code flow works:
//   1. buildAuthorizationUrl(state)   -> where the browser goes to consent
//   2. exchangeCode(code)             -> code -> { access_token, ... }
//   3. getUserInfo(accessToken)       -> access_token -> { email, sub, ... }
//
// The redirect boundaries are wired in the caller (routes/auth.js):
//   - /auth/google            builds the URL and bounces the browser to Google
//   - /auth/google/callback   exchanges the code, then resolves an account
//                             by the returned email (see "email_verified")
//
// `http_client` is injectable so tests can point the token/userinfo calls at a
// local fake "Google" server instead of the real endpoints. The default is
// node-fetch, already the backend's HTTP dependency.

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

function createGoogleOAuth({ clientId, clientSecret, redirectUri, tokenUrl = GOOGLE_TOKEN_URL, userinfoUrl = GOOGLE_USERINFO_URL, httpClient }) {
  const fetchImpl = httpClient || require('node-fetch');

  function getAuthorizationUrl(state) {
    const params = new URLSearchParams();
    params.set('client_id', clientId);
    params.set('redirect_uri', redirectUri);
    params.set('response_type', 'code');
    params.set('scope', 'openid email');
    params.set('access_type', 'online');
    params.set('prompt', 'select_account');
    params.set('state', state);
    return `${GOOGLE_AUTH_URL}?${params.toString()}`;
  }

  async function exchangeCode(code) {
    const body = new URLSearchParams();
    body.set('code', code);
    body.set('client_id', clientId);
    body.set('client_secret', clientSecret);
    body.set('redirect_uri', redirectUri);
    body.set('grant_type', 'authorization_code');
    const res = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      throw Object.assign(
        new Error(`google token exchange failed (${res.status})`),
        { code: 'google_token_exchange_failed' }
      );
    }
    return res.json();
  }

  async function getUserInfo(accessToken) {
    const res = await fetchImpl(userinfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw Object.assign(
        new Error(`google userinfo failed (${res.status})`),
        { code: 'google_userinfo_failed' }
      );
    }
    return res.json();
  }

  return { getAuthorizationUrl, exchangeCode, getUserInfo };
}

module.exports = { createGoogleOAuth, GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL, GOOGLE_USERINFO_URL };