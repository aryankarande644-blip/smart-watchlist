// src/diagnostics.js
//
// Tiny shared diagnostics bag, exposed via /health so upstream failures can be
// diagnosed over HTTP without digging through platform logs (helpful when the
// platform's log viewer isn't available to the engineer doing diagnosis).

let state = {
  lastQuoteError: null, // { name, message, at }
  lastRouteError: null, // { name, message, code, stack, route, at }
};

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

function getDiagnostics() {
  return state;
}

module.exports = { recordQuoteError, clearQuoteError, recordRouteError, getDiagnostics };