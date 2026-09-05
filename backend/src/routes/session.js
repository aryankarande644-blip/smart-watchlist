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

function sign(value) {
  const hmac = crypto.createHmac('sha256', SECRET).update(value).digest('hex');
  return `${value}.${hmac}`;
}

function verify(signed) {
  if (!signed || !signed.includes('.')) return null;
  const [value, sig] = signed.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(value).digest('hex');
  // Constant-time comparison to avoid timing attacks on the signature check.
  const sigBuf = Buffer.from(sig || '', 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  return value;
}

// Middleware: resolves req.userId, creating a new anonymous user + cookie
// on first visit. No signup form, no password — session identity only.
async function sessionMiddleware(req, res, next) {
  try {
    const cookieVal = req.cookies?.[COOKIE_NAME];
    const userId = cookieVal ? verify(cookieVal) : null;

    if (userId) {
      const exists = await repo.userExists(userId);
      if (exists) {
        req.userId = userId;
        return next();
      }

      // Signed cookie is valid but its user row is gone (e.g. a DB reset /
      // TRUNCATE users CASCADE). Keep the request working: substitute a fresh
      // anonymous session instead of letting the FK throw a 500 later.
      const freshUser = await repo.createUser();
      res.cookie(COOKIE_NAME, sign(freshUser.id), {
        httpOnly: true,
        sameSite: SAME_SITE,
        secure: IS_SECURE,
        maxAge: 1000 * 60 * 60 * 24 * 365,
      });
      req.userId = freshUser.id;
      return next();
    }

    const user = await repo.createUser();
    res.cookie(COOKIE_NAME, sign(user.id), {
      httpOnly: true,
      sameSite: SAME_SITE,
      secure: IS_SECURE,
      maxAge: 1000 * 60 * 60 * 24 * 365, // 1 year
    });
    req.userId = user.id;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { sessionMiddleware };
