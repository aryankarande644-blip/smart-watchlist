// src/routes/auth.js
const express = require('express');
const repo = require('../db/repository');
const { hashPassword, verifyPassword } = require('../auth/passwords');
const { createLimiter } = require('../auth/rateLimit');
const { setSessionCookie, clearSessionCookie, readSession } = require('./session');

// Loose but real shape check: something@something.tld, max 254 chars (RFC
// 5321 address length). Full RFC validation is out of scope — this exists to
// reject obvious garbage, not to be a complete email parser.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const MIN_PASSWORD_LENGTH = 8;

// A real bcrypt hash of an impossible password. When login gets an email that
// isn't a user, we still run a bcrypt compare against this so the response
// timing doesn't leak whether the account exists — the #1 account enumeration
// side channel on login endpoints.
const DUMMY_HASH = '$2b$10$C6UzMDM.H6dfI/f/IKcEeOHNhMuNZ4uHlM6tSRzMshNsaE5CmPqVa';

function errorResponse(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function createAuthRouter({ loginRateLimit = {} } = {}) {
  const router = express.Router();
  const limiter = createLimiter(loginRateLimit);

  router.post('/signup', async (req, res, next) => {
    try {
      const email = normalizeEmail(req.body?.email);
      const password = String(req.body?.password || '');

      if (!email || !EMAIL_RE.test(email) || email.length > MAX_EMAIL_LENGTH) {
        return errorResponse(res, 400, 'invalid_email', 'a valid email is required');
      }
      if (!password || password.length < MIN_PASSWORD_LENGTH) {
        return errorResponse(res, 400, 'password_too_short', `password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      }

      const passwordHash = await hashPassword(password);
      let user;
      try {
        user = await repo.createUser(email, passwordHash);
      } catch (err) {
        // unique_violation on users.email — a second account already claimed it
        if (err && err.code === '23505') {
          return errorResponse(res, 409, 'email_taken', 'an account with this email already exists');
        }
        throw err;
      }

      setSessionCookie(res, user.id, user.session_version);
      res.status(201).json({ user: { email: user.email } });
    } catch (err) {
      next(err);
    }
  });

  router.post('/login', async (req, res, next) => {
    try {
      if (!limiter.check(req)) {
        return errorResponse(res, 429, 'rate_limited', 'too many login attempts, try again later');
      }

      const email = normalizeEmail(req.body?.email);
      const password = String(req.body?.password || '');
      const user = await repo.findUserByEmail(email);

      // Compare against the dummy hash when the email is unknown, so both
      // failure branches take the same bcrypt time. Same 401 body either way.
      const passwordOk = await verifyPassword(password, user ? user.password_hash : DUMMY_HASH);

      if (!user || !passwordOk) {
        return errorResponse(res, 401, 'invalid_credentials', 'invalid email or password');
      }

      setSessionCookie(res, user.id, user.session_version);
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

  return router;
}

module.exports = { createAuthRouter };