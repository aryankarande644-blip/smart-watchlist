// src/diagnostics.js
//
// Tiny shared diagnostics bag, exposed via /health so upstream failures can be
// diagnosed over HTTP without digging through platform logs (helpful when the
// platform's log viewer isn't available to the engineer doing diagnosis).

let state = {
  lastQuoteError: null, // { name, message, at }
  lastRouteError: null, // { name, message, code, stack, route, at }
};

// Ring buffer of recent auth events (newest first). Exposed via /health so
// the developer can see exactly what happened on a failed login/signup even
// without Render log access. Logged to console on every event so Render's
// log stream also captures it in real time.
const MAX_AUTH_EVENTS = 20;
let authEvents = [];

function recordAuthEvent({ event, email, code, ip, route }) {
  const entry = {
    event,
    code: code || undefined,
    email: email || undefined,
    ip: ip || undefined,
    route: route || undefined,
    at: new Date().toISOString(),
  };
  authEvents = [entry, ...authEvents].slice(0, MAX_AUTH_EVENTS);
  // Structured log so Render's log stream always has a searchable record.
  console.log(JSON.stringify(entry));
  return entry;
}

function getDiagnostics() {
  return { ...state, authEvents };
}

function recordQuoteError(err) {
  state.lastQuoteError = {
    name: err && err.name ? err.name : 'Error',
    message: err && err.message ? String(err.message) : String(err),
    at: new Date().toISOString(),
  };
  return state.lastQuoteError;
}

function recordRouteError(err, req = null) {
  state.lastRouteError = {
    name: err && err.name ? err.name : 'Error',
    message: err && err.message ? String(err.message) : String(err),
    code: err && err.code != null ? String(err.code) : undefined,
    stack: err && err.stack ? String(err.stack) : undefined,
    route: req ? `${req.method} ${req.originalUrl || req.url}` : undefined,
    at: new Date().toISOString(),
  };
  return state.lastRouteError;
}

function clearQuoteError() {
  state.lastQuoteError = null;
}

module.exports = { recordQuoteError, clearQuoteError, recordRouteError, recordAuthEvent, getDiagnostics };