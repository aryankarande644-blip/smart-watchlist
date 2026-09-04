// src/test/realProvider.test.js
const { createRealProvider } = require('../marketData/realProvider');

let passed = 0, failed = 0;
function assertTrue(name, condition, detail) {
  if (condition) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}  (${JSON.stringify(detail)})`); }
}

// Fake client shaped exactly like yahoo-finance2's real response, per its
// actual (installed, inspected) type definitions — not guessed. Historical is
// mocked as the `chart` method ({ meta, quotes }), which is what
// fetchHistorical uses internally (the `historical` wrapper throws on the
// in-progress day's null close — see realProvider.js).
function makeFakeYahooClient({ quoteResponse, chartResponse, throwOnQuote, throwOnChart } = {}) {
  return {
    calls: [],
    async quote(symbol) {
      this.calls.push(['quote', symbol]);
      if (throwOnQuote) throw new Error('simulated Yahoo failure');
      return quoteResponse;
    },
    async chart(symbol, opts) {
      this.calls.push(['chart', symbol, opts]);
      if (throwOnChart) throw new Error('simulated Yahoo failure');
      return chartResponse;
    },
  };
}

async function run() {
  // ---- Test 1: fetchQuote correctly appends .NS and maps real Yahoo field names ----
  {
    const fake = makeFakeYahooClient({
      quoteResponse: { regularMarketPrice: 2980.5, regularMarketVolume: 4500000, currency: 'INR' },
    });
    const provider = createRealProvider(fake);
    const result = await provider.fetchQuote('RELIANCE');
    assertTrue('1a. Symbol correctly suffixed with .NS for NSE', fake.calls[0][1] === 'RELIANCE.NS', fake.calls[0]);
    assertTrue('1b. price mapped from regularMarketPrice', result.price === 2980.5, result);
    assertTrue('1c. volume mapped from regularMarketVolume', result.volume === 4500000, result);
  }

  // ---- Test 2: missing/malformed quote data throws (so retry/circuit breaker can handle it) ----
  {
    const fake = makeFakeYahooClient({ quoteResponse: { regularMarketPrice: null } }); // delisted-style response
    const provider = createRealProvider(fake);
    let threw = false;
    try { await provider.fetchQuote('DELISTED'); } catch (err) { threw = true; }
    assertTrue('2. Malformed/missing price data throws (not silently returns garbage)', threw, threw);
  }

  // ---- Test 3: quote with missing volume degrades to null, not a crash ----
  {
    const fake = makeFakeYahooClient({ quoteResponse: { regularMarketPrice: 500 } }); // no volume field at all
    const provider = createRealProvider(fake);
    const result = await provider.fetchQuote('THINSTOCK');
    assertTrue('3. Missing volume field maps to null, not undefined/crash', result.volume === null, result);
  }

  // ---- Test 4: upstream throw propagates (not swallowed) ----
  {
    const fake = makeFakeYahooClient({ throwOnQuote: true });
    const provider = createRealProvider(fake);
    let threw = false;
    try { await provider.fetchQuote('WHATEVER'); } catch (err) { threw = true; }
    assertTrue('4. Upstream failure propagates as a real throw', threw, threw);
  }

  // ---- Test 5: fetchHistorical correctly shapes data and slices to requested days ----
  {
    const fullHistory = Array.from({ length: 45 }, (_, i) => ({
      date: new Date(2026, 0, i + 1),
      close: 100 + i,
      volume: 1000 * i,
    }));
    const fake = makeFakeYahooClient({ chartResponse: { meta: {}, quotes: fullHistory } });
    const provider = createRealProvider(fake);
    const result = await provider.fetchHistorical('TCS', 20);

    assertTrue('5a. Symbol correctly suffixed with .NS', fake.calls[0][1] === 'TCS.NS', fake.calls[0]);
    assertTrue('5b. Result sliced to exactly the requested 20 days', result.length === 20, result.length);
    assertTrue('5c. close/volume correctly mapped, oldest-of-the-slice first', result[0].close === fullHistory[25].close, { got: result[0], expected: fullHistory[25] });
    assertTrue('5d. Most recent day is last in the slice', result[19].close === fullHistory[44].close, result[19]);
  }

  // ---- Test 5e: in-progress/null-close candles are filtered out of history ----
  // Regression test for the live bug: during market hours Yahoo returns the
  // current session as a candle with close:null, and the old `historical`
  // implementation threw on it. The result must only contain COMPLETED days.
  {
    const withNullCloses = [
      { date: new Date(2026, 0, 1), close: 100, volume: 1000 },
      { date: new Date(2026, 0, 2), close: 101, volume: 1100 },
      { date: new Date(2026, 0, 3), close: null, volume: 900 },  // in-progress session
    ];
    const fake = makeFakeYahooClient({ chartResponse: { meta: {}, quotes: withNullCloses } });
    const provider = createRealProvider(fake);
    const result = await provider.fetchHistorical('TODAY', 20);
    assertTrue('5e. Null-close (in-progress) candles are filtered out, not thrown on', result.length === 2, result);
    assertTrue('5e. Filtered history has no null closes and keeps real values', result.every((r) => typeof r.close === 'number' && r.close !== null) && result[1].close === 101, result);
  }

  // ---- Test 5f: ALL candles incomplete => genuine no-data, throws ----
  {
    const fake = makeFakeYahooClient({
      chartResponse: { meta: {}, quotes: [{ date: new Date(), close: null, volume: null }] },
    });
    const provider = createRealProvider(fake);
    let threw = false;
    try { await provider.fetchHistorical('HALTED', 20); } catch (err) { threw = true; }
    assertTrue('5f. All-incomplete history throws (retry/circuit layer can handle it)', threw, threw);
  }

  // ---- Test 6: empty historical data throws (not a silent empty baseline) ----
  {
    const fake = makeFakeYahooClient({ chartResponse: { meta: {}, quotes: [] } });
    const provider = createRealProvider(fake);
    let threw = false;
    try { await provider.fetchHistorical('BRANDNEW', 20); } catch (err) { threw = true; }
    assertTrue('6. Empty historical result throws, does not silently compute a fake baseline', threw, threw);
  }

  // ---- Test 7: date-range buffer requests MORE than `days` to cover weekends/holidays ----
  {
    const fake = makeFakeYahooClient({ chartResponse: { meta: {}, quotes: Array.from({ length: 20 }, () => ({ close: 1, volume: 1 })) } });
    const provider = createRealProvider(fake);
    await provider.fetchHistorical('WIPRO', 20);
    const optsUsed = fake.calls[0][2];
    const spanDays = (optsUsed.period2 - optsUsed.period1) / (24 * 60 * 60 * 1000);
    assertTrue('7. Requested date range is wider than 20 calendar days (weekend/holiday buffer)', spanDays > 20, spanDays);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
