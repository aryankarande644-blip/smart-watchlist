// src/diagnostics.js
//
// Tiny shared diagnostics bag, exposed via /health so upstream failures can be
// diagnosed over HTTP without digging through platform logs (helpful when the
// platform's log viewer isn't available to the engineer doing diagnosis).

let state = {
  lastQuoteError: null, // { name, message, at }
};

function recordQuoteError(err) {
  state.lastQuoteError = {
    name: err && err.name ? err.name : 'Error',
    message: err && err.message ? String(err.message) : String(err),
    at: new Date().toISOString(),
  };
  return state.lastQuoteError;
}

function clearQuoteError() {
  state.lastQuoteError = null;
}

function getDiagnostics() {
  return state;
}

module.exports = { recordQuoteError, clearQuoteError, getDiagnostics };