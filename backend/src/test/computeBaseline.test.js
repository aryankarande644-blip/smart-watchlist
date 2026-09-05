// src/test/computeBaseline.test.js
const pool = require('../db/pool');
const repo = require('../db/repository');
const { computeBaselineForSymbol, computeVolatilityAndVolume } = require('../baseline/computeBaseline');

let passed = 0, failed = 0;
function assertTrue(name, condition, detail) {
  if (condition) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}  (${JSON.stringify(detail)})`); }
}

async function resetDb() {
  await pool.query('DELETE FROM last_seen');
  await pool.query('DELETE FROM watchlist_entry');
  await pool.query('DELETE FROM snapshot');
  await pool.query('DELETE FROM index_quote');
  await pool.query('DELETE FROM baseline');
  await pool.query('DELETE FROM users');
}

const silentLogger = { log: () => {}, error: () => {} };

async function run() {
  await resetDb();

  // ---- Test 1: normal computation reaches 'ready' with real numbers written to DB ----
  {
    await repo.ensureBaselineExists('TESTSYM1');
    const closes = Array.from({ length: 20 }, (_, i) => 100 + Math.sin(i) * 2);
    const provider = {
      async fetchHistorical() {
        // Fractional volumes on purpose — this is the exact shape that
        // broke avg_volume's BIGINT column before the fix.
        return closes.map((close, i) => ({
          close,
          volume: 50000.7 + i * 123.456,
        }));
      },
    };
    await computeBaselineForSymbol('TESTSYM1', provider, silentLogger);
    const baseline = await repo.getBaseline('TESTSYM1');
    assertTrue('1a. Baseline reaches status=ready', baseline.status === 'ready', baseline);
    assertTrue('1b. typical_daily_volatility is a positive real number', Number(baseline.typical_daily_volatility) > 0, baseline.typical_daily_volatility);
    assertTrue('1c. avg_volume is written as a whole number (BIGINT-safe)', Number.isInteger(Number(baseline.avg_volume)), baseline.avg_volume);
  }

  // ---- Test 1d/e: sparkline_closes is captured at compute time — exactly
  // the last 7 closes, bounded, rounded, matching the source candles ----
  {
    await repo.ensureBaselineExists('TESTSYM5');
    const closes = Array.from({ length: 20 }, (_, i) => 100 + Math.sin(i) * 2);
    const provider = {
      async fetchHistorical() {
        return closes.map((close, i) => ({ close, volume: 40000 + i }));
      },
    };
    await computeBaselineForSymbol('TESTSYM5', provider, silentLogger);
    const baseline = await repo.getBaseline('TESTSYM5');
    const expected = closes.slice(-7).map((c) => Math.round(c * 100) / 100);
    assertTrue('1d. sparkline_closes holds exactly the last 7 closes', Array.isArray(baseline.sparkline_closes) && baseline.sparkline_closes.length === 7 && baseline.sparkline_closes.length === expected.length, baseline.sparkline_closes);
    assertTrue('1e. sparkline values match the source candles (rounded)', JSON.stringify(baseline.sparkline_closes) === JSON.stringify(expected), { got: baseline.sparkline_closes, expected });
  }

  // ---- Test 1f: a short (low_confidence) history still gets a bounded
  // sparkline — never more than 7 points, still overwritten ----
  {
    await repo.ensureBaselineExists('TESTSYM6');
    const closes6 = Array.from({ length: 8 }, (_, i) => 200 + i);
    const provider = {
      async fetchHistorical() {
        return closes6.map((close) => ({ close, volume: 30000 }));
      },
    };
    await computeBaselineForSymbol('TESTSYM6', provider, silentLogger);
    const baseline = await repo.getBaseline('TESTSYM6');
    assertTrue('1f. Short history gets min(7, days) sparkline points (bounded)', Array.isArray(baseline.sparkline_closes) && baseline.sparkline_closes.length === 7 && baseline.sparkline_closes.length <= 7 && baseline.sparkline_closes[6] === 207, baseline.sparkline_closes);
  }

  // ---- Test 2: insufficient history marks baseline as failed, not crashing ----
  {
    await repo.ensureBaselineExists('TESTSYM2');
    const provider = {
      async fetchHistorical() {
        return [{ close: 100, volume: 1000 }, { close: 101, volume: 1100 }]; // only 2 days, below MIN_USABLE_DAYS
      },
    };
    await computeBaselineForSymbol('TESTSYM2', provider, silentLogger);
    const baseline = await repo.getBaseline('TESTSYM2');
    assertTrue('2. Insufficient history results in status=failed, not a crash', baseline.status === 'failed', baseline);
  }

  // ---- Test 3: low confidence path (5-19 days) still reaches a usable state ----
  {
    await repo.ensureBaselineExists('TESTSYM3');
    const provider = {
      async fetchHistorical() {
        return Array.from({ length: 8 }, (_, i) => ({ close: 200 + i, volume: 30000 }));
      },
    };
    await computeBaselineForSymbol('TESTSYM3', provider, silentLogger);
    const baseline = await repo.getBaseline('TESTSYM3');
    assertTrue('3. Short-but-usable history results in status=low_confidence', baseline.status === 'low_confidence', baseline);
  }

  // ---- Test 4: upstream failure marks baseline failed, does not throw out ----
  {
    await repo.ensureBaselineExists('TESTSYM4');
    const provider = { async fetchHistorical() { throw new Error('upstream down'); } };
    let threw = false;
    try {
      await computeBaselineForSymbol('TESTSYM4', provider, silentLogger);
    } catch (err) {
      threw = true;
    }
    const baseline = await repo.getBaseline('TESTSYM4');
    assertTrue('4a. Upstream failure does not throw out of computeBaselineForSymbol', threw === false, threw);
    assertTrue('4b. Upstream failure results in status=failed', baseline.status === 'failed', baseline);
  }

  // ---- Test 5: pure function sanity check on known input ----
  {
    const candles = [
      { close: 100, volume: 1000 },
      { close: 102, volume: 2000 }, // +2%
      { close: 101, volume: 3000 }, // ~-0.98%
      { close: 103, volume: 4000 }, // ~+1.98%
    ];
    const { typicalDailyVolatility, avgVolume } = computeVolatilityAndVolume(candles);
    assertTrue('5a. Volatility is a small positive fraction (not a raw percent, not 0)', typicalDailyVolatility > 0 && typicalDailyVolatility < 1, typicalDailyVolatility);
    assertTrue('5b. Average volume matches expected mean', avgVolume === 2500, avgVolume);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(async (err) => {
  console.error('Test crashed:', err);
  await pool.end();
  process.exit(1);
});
