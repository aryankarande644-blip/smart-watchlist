// src/auth/oauthState.js
//
// OAuth `state` nonce store — the piece that defeats login CSRF on the OAuth
// callback. When /auth/google bounces the browser to Google it stores a random
// nonce; the callback must present the same nonce, and each nonce is
// consume-once: a replayed or forged callback with a used/never-issued/expired
// state is rejected before any user lookup happens.
//
// In-memory with a TTL, matching the deployment reality: the backend is pinned
// to a single Render instance (rateLimit.js makes the same trade). A restart
// between redirect and callback just makes the user click "Continue with
// Google" again — no persisted state is lost.

const crypto = require('crypto');

function createStateStore({ ttlMs = 10 * 60 * 1000, now = Date.now } = {}) {
  const store = new Map(); // state -> expiresAt

  return {
    issue() {
      const state = crypto.randomBytes(24).toString('hex');
      store.set(state, now() + ttlMs);
      return state;
    },
    // Returns true only if the state was issued AND is still inside its TTL.
    // Consume-once: a replayed callback never passes twice.
    consume(state) {
      if (!state) return false;
      const expiresAt = store.get(state);
      if (expiresAt === undefined) return false;
      store.delete(state);
      return now() < expiresAt;
    },
  };
}

module.exports = { createStateStore };