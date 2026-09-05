// src/routes/session.js
const crypto = require('crypto');
const repo = require('../db/repository');

const COOKIE_NAME = 'session_uid';
const SECRET = process.env.SESSION_SECRET || 'dev-only-secret-change-in-prod';

// Cross-site topology (frontend on Vercel, API on Render) requires
// SameSite=None, because the browser treats .vercel.app -> .onrender.com as
// two different sites and drops a SameSite=strict cookie entirely, which
// would silently create a fresh anonymous user on every request.
// Default stays 'strict' (safest for local + same-site deploys). The CSRF
// origin-check middleware in server.js is what makes SameSite=None safe here:
// browsers require a SameSite=None cookie to be Secure, and the origin check
// independently rejects cross-site state-changing requests.
const SAME_SITE = ['strict', 'lax', 'none'].includes(process.env.SESSION_COOKIE_SAMESITE)
  ? process.env.SESSION_COOKIE_SAMESITE
  : 'strict';
// Secure is mandatory for SameSite=None (browsers reject it otherwise);
// otherwise follow NODE_ENV.
const IS_SECURE = SAME_SITE === 'none' || process.env.NODE_ENV === 'production';
const COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 365; // 1 year

// Cookie payload is `${userId}.${sessionVersion}` — the version is the
// server-side session state that makes logout real. A cookie issued before a
// logout carries an older version than the user row, so verification fails and
// the request 401s even if the cookie string itself is replayed.
function sign(userId, sessionVersion) {
  const value = `${userId}.${sessionVersion}`;
  const hmac = crypto.createHmac('sha256', SECRET).update(value).digest('hex');
  return `${value}.${hmac}`;
}

// Returns { userId, version } on success, null on any signature problem.
function verify(signed) {
  if (!signed) return null;
  const lastDot = signed.lastIndexOf('.');
  if (lastDot <= 0) return null;
  const [value, sig] = [signed.slice(0, lastDot), signed.slice(lastDot + 1)];
  const expected = crypto.createHmac('sha256', SECRET).update(value).digest('hex');
  // Constant-time comparison to avoid timing attacks on the signature check.
  const sigBuf = Buffer.from(sig || '', 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  const [userId, versionStr] = value.split('.');
  const version = Number(versionStr);
  if (!userId || !Number.isInteger(version)) return null;
  return { userId, version };
}

// Read-only cookie inspection (for logout, which must revoke even a replay of
// an already-invalidated cookie).
function readSession(req) {
  const cookieVal = req.cookies?.[COOKIE_NAME];
  return cookieVal ? verify(cookieVal) : null;
}

// Shared cookie issuance: used by the /auth routes after signup/login so the
// exact same cookie attributes (and signature scheme) drive every session.
function setSessionCookie(res, userId, version) {
  res.cookie(COOKIE_NAME, sign(userId, version), {
    httpOnly: true,
    sameSite: SAME_SITE,
    secure: IS_SECURE,
    maxAge: COOKIE_MAX_AGE_MS,
  });
}

// Clearing must mirror the set options, or the browser won't delete it.
function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: SAME_SITE,
    secure: IS_SECURE,
  });
}

// Middleware: purely resolves an EXISTING valid session cookie into
// req.userId. It never creates accounts — the anonymous-session model was
// superseded by real email/password accounts (migration 002 + /auth routes).
// A request with no cookie, an invalid signature, a cookie from a deleted
// user, or a cookie whose session version is stale (logged out) has no
// req.userId; protected routes then answer 401 (not_authenticated) instead of
// silently minting a user. This also makes the old FK-23503 orphaned-cookie
// crash (HANDOFF §8, bug #10) structurally impossible: nothing writes a
// watchlist row for a nonexistent user because nothing auto-creates one.
// /health is registered before this middleware and stays fully public.
async function sessionMiddleware(req, res, next) {
  try {
    const session = readSession(req);

    if (session) {
      const user = await repo.getUserById(session.userId);
      if (user && user.session_version === session.version) {
        req.userId = user.id;
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { sessionMiddleware, setSessionCookie, clearSessionCookie, readSession, COOKIE_NAME };
