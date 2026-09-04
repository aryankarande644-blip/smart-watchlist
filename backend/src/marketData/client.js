// src/marketData/client.js
//
// Provider-agnostic interface. `provider` must implement:
//   fetchQuote(symbol) -> { price, volume }        (throws on failure)
//   fetchHistorical(symbol, days) -> [{ close, volume }, ...]  (throws on failure)
//
// In production this wraps a real NSE/BSE API. In tests/dev without network
// access to that host, a fake provider implementing the same interface is
// injected instead — the retry/backoff/circuit-breaker logic below is
// identical either way, so testing against the fake genuinely proves this
// module's behavior, not just the fake's behavior.

class CircuitOpenError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'CircuitOpenError';
  }
}

// Distinguishes "Yahoo/the upstream answered and rejected the symbol" (-> 422
// unknown_symbol) from "we never got a usable answer at all" (-> 502
// upstream_error). Without this, a network/rate-limit failure is misreported
// as an invalid symbol, which is a very different problem to debug.
const UPSTREAM_FAILURE_PATTERNS = [
  /fetch failed/i,
  /ECONN/i,
  /ETIMEDOUT/i,
  /EAI_AGAIN/i,
  /EADDR/i,
  /ENOTFOUND/i,
  /timeout/i,
  /HTTPERROR/i,
  /http error/i,
  /\b429\b/,
  /\b401\b/,
  /\b409\b/,
  /\b5\d\d\b/,
];

// Signatures that mean Yahoo DID answer (delisted/never-existed/bad symbol)
// rather than being unreachable — these stay valid 422 "unknown symbol" cases,
// even though the current watchlist flow reports them as validation failures.
const KNOWN_SYMBOL_MISS_PATTERNS = [
  /no data found/i,
  /no usable quote data/i,
  /no usable \(completed\) historical/i,
  /no historical data/i,
];

function isUpstreamError(err) {
  if (!err) return false;
  if (err.name === 'CircuitOpenError') return true;
  const msg = String(err.message || '');
  if (KNOWN_SYMBOL_MISS_PATTERNS.some((p) => p.test(msg))) return false;
  return UPSTREAM_FAILURE_PATTERNS.some((p) => p.test(msg));
}

function createMarketDataClient(provider, opts = {}) {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 100;
  const failureThreshold = opts.failureThreshold ?? 5; // consecutive failures across ALL symbols
  const cooldownMs = opts.cooldownMs ?? 60000;

  let consecutiveFailures = 0;
  let circuitOpenedAt = null;

  function isCircuitOpen() {
    if (circuitOpenedAt === null) return false;
    if (Date.now() - circuitOpenedAt >= cooldownMs) {
      // Cooldown elapsed — allow a trial request through (half-open).
      circuitOpenedAt = null;
      consecutiveFailures = 0;
      return false;
    }
    return true;
  }

  function recordSuccess() {
    consecutiveFailures = 0;
    circuitOpenedAt = null;
  }

  function recordFailure() {
    consecutiveFailures++;
    if (consecutiveFailures >= failureThreshold && circuitOpenedAt === null) {
      circuitOpenedAt = Date.now();
    }
  }

  async function withRetry(fn, symbol) {
    if (isCircuitOpen()) {
      throw new CircuitOpenError(`circuit open — upstream API assumed down`);
    }
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await fn();
        recordSuccess();
        return result;
      } catch (err) {
        lastErr = err;
        if (attempt < maxRetries) {
          const delay = baseDelayMs * 2 ** attempt; // exponential backoff
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    recordFailure();
    throw lastErr;
  }

  return {
    async fetchQuote(symbol) {
      return withRetry(() => provider.fetchQuote(symbol), symbol);
    },
    async fetchHistorical(symbol, days) {
      return withRetry(() => provider.fetchHistorical(symbol, days), symbol);
    },
    // exposed for observability / health checks
    getCircuitState() {
      return isCircuitOpen() ? 'open' : 'closed';
    },
  };
}

module.exports = { createMarketDataClient, CircuitOpenError, isUpstreamError };
