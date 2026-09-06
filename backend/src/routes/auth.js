// src/routes/auth.js
const express = require('express');
const repo = require('../db/repository');
const { hashPassword, verifyPassword } = require('../auth/passwords');
const { createLimiter } = require('../auth/rateLimit');
const { createStateStore } = require('../auth/oauthState');
const { setSessionCookie, clearSessionCookie, readSession } = require('./session');
const { recordAuthEvent } = require('../diagnostics');

// Loose but real shape check: something@something.tld, max 254 chars (RFC
// 5321 address length). Full RFC validation is out of scope — this exists to
// reject obvious garbage, not to be a complete email parser.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const MIN_PASSWORD_LENGTH = 8;

// A real bcrypt hash of an impossible password. When login gets an email that
// isn't a user — OR a Google-authenticated account that has no password — we
// still run a bcrypt compare against this so the response timing doesn't leak
// whether the account exists or what its provider is. The #1 account
// enumeration side channel on login endpoints.
const DUMMY_HASH = '$2b$10$C6UzMDM.H6dfI/f/IKcEeOHNhMuNZ4uHlM6tSRzMshNsaE5CmPqVa';

function errorResponse(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// Extract the real client IP from behind Render's proxy.
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.ip || 'unknown';
}

// Google OAuth account resolution (owner decision 2026-09-06):
//   - OPEN ID's userinfo MUST report email_verified === true for us to trust
//     the email match at all. An unverified email is rejected with a clear
//     error — we never create or auto-link on an untrusted email address.
//   - Verified email, no existing account          -> create (auth_provider
//     'google', password_hash NULL).
//   - Verified email, existing 'google' account    -> sign in to it.
//   - Verified email, existing email/password      -> auto-link SILENTLY: the
//     same account signs in, nothing is rewritten, the password stays valid.
//     No duplicate row is ever created (the email UNIQUE constraint is the
//     final backstop).
function resolveGoogleUser(email) {
  return repo.findUserByEmail(email).then((user) => {
    if (user) return user;
    return repo.createUser(email, null, 'google').catch((err) => {
      // A concurrent callback won the create race on the same brand-new email
      // (unique_violation) — adopt the row the winner created.
      if (err && err.code === '23505') return repo.findUserByEmail(email);
      throw err;
    });
  });
}

function createAuthRouter({ loginRateLimit = {}, google = null, stateStore = null, appOrigin = null } = {}) {
  const router = express.Router();
  const limiter = createLimiter(loginRateLimit);
  const store = stateStore || createStateStore();
  const origin = appOrigin || process.env.FRONTEND_ORIGIN || 'http://localhost:5173';

  // Bounce back to the frontend with a machine-readable error code in the URL
  // (?auth_error=...). The auth page maps codes to copy. Used for every
  // failure path in the OAuth flow — the user is mid-UI-hopping, so a JSON
  // error page would strand them; this keeps them in the app.
  const failOAuth = (res, code) => res.redirect(`${origin}?auth_error=${encodeURIComponent(code)}`);

  router.post('/signup', async (req, res, next) => {
    try {
      const email = normalizeEmail(req.body?.email);
      const password = String(req.body?.password || '');
      const rememberMe = req.body?.remember === true;

      if (!email || !EMAIL_RE.test(email) || email.length > MAX_EMAIL_LENGTH) {
        return errorResponse(res, 400, 'invalid_email', 'a valid email is required');
      }
      if (!password || password.length < MIN_PASSWORD_LENGTH) {
        return errorResponse(res, 400, 'password_too_short', `password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      }

      const passwordHash = await hashPassword(password);
      let user;
      try {
        user = await repo.createUser(email, passwordHash, 'email');
      } catch (err) {
        // unique_violation on users.email — a second account already claimed it
        // (whether via email/password signup OR a Google-authenticated account).
        if (err && err.code === '23505') {
          recordAuthEvent({ event: 'auth_signup_email_taken', email, ip: clientIp(req), code: 'email_taken', route: 'POST /auth/signup' });
          return errorResponse(res, 409, 'email_taken', 'an account with this email already exists');
        }
        throw err;
      }

      recordAuthEvent({ event: 'auth_signup_success', email, ip: clientIp(req), route: 'POST /auth/signup' });
      setSessionCookie(res, user.id, user.session_version, { rememberMe });
      res.status(201).json({ user: { email: user.email } });
    } catch (err) {
      next(err);
    }
  });

  router.post('/login', async (req, res, next) => {
    try {
      const email = normalizeEmail(req.body?.email);
      const ip = clientIp(req);

      if (!limiter.check(req)) {
        recordAuthEvent({ event: 'auth_login_rate_limited', email, ip, route: 'POST /auth/login' });
        return errorResponse(res, 429, 'rate_limited', 'too many login attempts, try again later');
      }

      const password = String(req.body?.password || '');
      const rememberMe = req.body?.remember === true;
      const user = await repo.findUserByEmail(email);

      // Compare against the dummy hash when the email is unknown OR belongs to
      // a Google-only account (password_hash NULL) — both branches take the
      // same bcrypt time and return the same 401, so neither account existence
      // nor the auth provider leaks through timing or the response body.
      const passwordOk = await verifyPassword(
        password,
        user && user.password_hash ? user.password_hash : DUMMY_HASH
      );

      if (!user || !passwordOk) {
        recordAuthEvent({ event: 'auth_login_invalid', email, ip, code: 'invalid_credentials', route: 'POST /auth/login' });
        return errorResponse(res, 401, 'invalid_credentials', 'invalid email or password');
      }

      recordAuthEvent({ event: 'auth_login_success', email, ip, route: 'POST /auth/login' });
      setSessionCookie(res, user.id, user.session_version, { rememberMe });
      res.json({ user: { email: user.email } });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', async (req, res, next) => {
    try {
      // Real revocation, not just client-side clearing: bump the user's
      // session version so every cookie already in the wild stops verifying.
      // readSession inspects the cookie even if it's already stale — revoking
      // twice (a replayed old cookie) must still invalidate, never resurrect.
      const session = readSession(req);
      if (session) {
        await repo.bumpSessionVersion(session.userId);
      }
      clearSessionCookie(res);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // ---- Google OAuth 2.0 ----
  // Owner decision 2026-09-06: options (1) auto-link silently + email_verified
  // gate + short browser-close session for the redirect flow. See HANDOFF §10#9.

  router.get('/google', (req, res, next) => {
    try {
      if (!google) {
        return failOAuth(res, 'provider_not_configured');
      }
      const state = store.issue();
      res.redirect(google.getAuthorizationUrl(state));
    } catch (err) {
      next(err);
    }
  });

  router.get('/google/callback', async (req, res, next) => {
    try {
      if (!google) {
        return failOAuth(res, 'provider_not_configured');
      }
      // Google bounces back with ?error=access_denied (etc.) when the user
      // cancels consent. Never an error condition — just a cancelled flow.
      if (req.query.error) {
        return failOAuth(res, 'google_denied');
      }
      // CSRF guard: the state must be one WE issued, unused, and unexpired.
      if (!store.consume(req.query.state)) {
        return failOAuth(res, 'google_state_mismatch');
      }
      if (!req.query.code) {
        return failOAuth(res, 'google_callback_error');
      }

      const token = await google.exchangeCode(req.query.code);
      const info = await google.getUserInfo(token.access_token);

      // The email_verified gate is a product decision, not just hygiene: a
      // Google account's unverified email is not a trustworthy identity, so we
      // refuse to create or auto-link on it (HANDOFF §7/§10).
      const email = normalizeEmail(info.email);
      if (!email || info.email_verified !== true) {
        return failOAuth(res, 'google_email_unverified');
      }

      const user = await resolveGoogleUser(email);

      // Short browser-close session by design: the redirect flow has no
      // "remember me" checkbox, so it gets the conservative default.
      setSessionCookie(res, user.id, user.session_version);
      res.redirect(origin);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createAuthRouter };