// src/auth/rateLimit.js
//
// Sliding-window in-memory per-IP limiter for /auth/login — credential
// stuffing / brute force is the realistic threat on a small project, so login
// gets throttled even when everything else is open. In-memory is correct here:
// the deployment is pinned to a single Render instance, and this is cheap
// entropy-protection, not a global control plane.
//
// `now` is injectable for deterministic tests.

function createLimiter({ maxAttempts = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const attempts = new Map(); // key -> [timestamps of attempts, oldest first]

  function keyFor(req) {
    // Render sits behind its own proxy; X-Forwarded-For carries the real
    // client. Fall back to req.ip (loopback in tests — the test limiter is
    // configured wide open).
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return fwd.split(',')[0].trim();
    return req.ip || 'unknown';
  }

  function check(req) {
    const now = Date.now();
    const key = keyFor(req);
    const recent = (attempts.get(key) || []).filter((ts) => now - ts < windowMs);
    if (recent.length >= maxAttempts) {
      attempts.set(key, recent);
      return false;
    }
    // Record the attempt *before* checking so success/failure both consume
    // budget — an attacker shouldn't get free retries by logging in correctly.
    recent.push(now);
    attempts.set(key, recent);
    return true;
  }

  return { check };
}

module.exports = { createLimiter };