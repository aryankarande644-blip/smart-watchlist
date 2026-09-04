// src/test/marketDataClient.test.js
const { createMarketDataClient, CircuitOpenError, isUpstreamError } = require('../marketData/client');

let passed = 0;
let failed = 0;
function assertTrue(name, condition, detail) {
  if (condition) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}  (${JSON.stringify(detail)})`); }
}

// A fake provider that fails N times before succeeding, or always fails.
function makeFlakyProvider({ failTimes = 0, alwaysFail = false } = {}) {
  let calls = 0;
  return {
    calls: () => calls,
    async fetchQuote(symbol) {
      calls++;
      if (alwaysFail || calls <= failTimes) {
        throw new Error(`simulated upstream failure for ${symbol}`);
      }
      return { price: 100, volume: 5000 };
    },
    async fetchHistorical() {
      calls++;
      if (alwaysFail) throw new Error('simulated historical failure');
      return Array.from({ length: 20 }, () => ({ close: 100, volume: 5000 }));
    },
  };
}

async function run() {
  // ---- Test 1: transient failure recovers via retry ----
  {
    const provider = makeFlakyProvider({ failTimes: 2 }); // fails twice, succeeds 3rd try
    const client = createMarketDataClient(provider, { maxRetries: 3, baseDelayMs: 5 });
    const result = await client.fetchQuote('TCS');
    assertTrue('1. Retry recovers a transient failure', result.price === 100, result);
    assertTrue('1b. Exactly 3 underlying calls were made (2 fail + 1 success)', provider.calls() === 3, provider.calls());
  }

  // ---- Test 2: one bad symbol does not affect a separate client instance ----
  // (isolation is really at the poller's per-symbol try/catch level, proven
  // in the poller test — this just confirms the client throws cleanly
  // rather than hanging or crashing the process)
  {
    const provider = makeFlakyProvider({ alwaysFail: true });
    const client = createMarketDataClient(provider, { maxRetries: 2, baseDelayMs: 5 });
    let threw = false;
    try {
      await client.fetchQuote('BADSTOCK');
    } catch (err) {
      threw = true;
    }
    assertTrue('2. A fully-failing symbol throws cleanly after exhausting retries', threw === true, threw);
  }

  // ---- Test 3: circuit breaker opens after threshold consecutive failures ----
  {
    const provider = makeFlakyProvider({ alwaysFail: true });
    const client = createMarketDataClient(provider, {
      maxRetries: 0, // fail immediately, no retry delay, to reach threshold fast
      baseDelayMs: 1,
      failureThreshold: 3,
      cooldownMs: 200,
    });

    for (let i = 0; i < 3; i++) {
      try { await client.fetchQuote('X'); } catch (_) {}
    }
    assertTrue('3a. Circuit opens after reaching failure threshold', client.getCircuitState() === 'open', client.getCircuitState());

    let gotCircuitOpenError = false;
    try {
      await client.fetchQuote('Y'); // different symbol — circuit is global to the client, by design
    } catch (err) {
      gotCircuitOpenError = err instanceof CircuitOpenError;
    }
    assertTrue('3b. While open, a NEW request fails fast with CircuitOpenError (no wasted upstream call)', gotCircuitOpenError, gotCircuitOpenError);
  }

  // ---- Test 4: circuit half-opens and recovers after cooldown ----
  {
    // Provider fails exactly twice, then succeeds on every call after.
    const provider = makeFlakyProvider({ failTimes: 2 });
    const client = createMarketDataClient(provider, {
      maxRetries: 0,
      baseDelayMs: 1,
      failureThreshold: 2,
      cooldownMs: 50, // short cooldown for a fast test
    });

    // Both of the provider's built-in failures happen here, opening the circuit.
    for (let i = 0; i < 2; i++) {
      try { await client.fetchQuote('X'); } catch (_) {}
    }
    assertTrue('4a. Circuit opens after 2 failures', client.getCircuitState() === 'open', client.getCircuitState());

    // While still within cooldown, a new call must fail fast without touching the provider.
    let failedFast = false;
    try { await client.fetchQuote('X'); } catch (err) { failedFast = err instanceof CircuitOpenError; }
    assertTrue('4b. New call within cooldown fails fast, provider not called', failedFast && provider.calls() === 2, provider.calls());

    await new Promise((r) => setTimeout(r, 60)); // wait past cooldown

    // Cooldown elapsed: circuit allows a trial through. Provider now succeeds
    // (its 2 built-in failures are used up), so this call should recover.
    const result = await client.fetchQuote('X');
    assertTrue('4c. After cooldown, trial call reaches provider and recovers', result.price === 100, result);
    assertTrue('4d. Circuit is closed again after a successful trial', client.getCircuitState() === 'closed', client.getCircuitState());
  }

  // ---- Test 5: isUpstreamError separates "symbol invalid" from "source down" ----
  {
    // Yahoo answered, rejected the symbol -> NOT upstream
    assertTrue('5a. "No data found" (Yahoo rejected symbol) is NOT upstream',
      isUpstreamError(new Error('HTTPERROR 404: No data found, symbol may be delisted')) === false);
    assertTrue('5b. Real-provider unusable-quote marker is NOT upstream',
      isUpstreamError(new Error('No usable quote data for BOGUS')) === false);

    // We never got a usable answer -> IS upstream
    assertTrue('5c. HTTP 429 rate limit is upstream',
      isUpstreamError(new Error('HTTPERROR 429: Unable to determine request rate limits')) === true);
    assertTrue('5d. HTTP 401 is upstream',
      isUpstreamError(new Error('HTTPERROR 401: Unauthorized')) === true);
    assertTrue('5e. Connection reset is upstream',
      isUpstreamError(Object.assign(new Error('connect ECONNREFUSED 162.159.152.4:443'), { name: 'Error' })) === true);
    assertTrue('5f. Node fetch network failure is upstream',
      isUpstreamError(new TypeError('fetch failed')) === true);
    assertTrue('5g. CircuitOpenError is upstream',
      isUpstreamError(new CircuitOpenError('circuit open — upstream API assumed down')) === true);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
