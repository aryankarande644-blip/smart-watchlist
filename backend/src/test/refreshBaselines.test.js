// src/test/refreshBaselines.test.js
const pool = require('../db/pool');
const repo = require('../db/repository');
const { refreshAllBaselines, msUntilNextIstTime } = require('../baseline/refreshBaselines');

let passed = 0, failed = 0;
function assertTrue(name, condition, detail) {
  if (condition) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}  (${JSON.stringify(detail)})`); }
}

async function resetDb() {
  await pool.query('DELETE FROM last_seen');
  await pool.query('DELETE FROM watchlist_entry');
  await pool.query('DELETE FROM snapshot');
  await pool.query('DELETE FROM baseline');
  await pool.query('DELETE FROM users');
}

const silentLogger = { log: () => {}, error: () => {} };

// Provider that returns plausible 20-day history, or throws for BLACKLISTED symbols.
function makeHistoryProvider(failSymbols = []) {
  return {
    async fetchHistorical(symbol) {
      if (failSymbols.includes(symbol)) throw new Error(`simulated upstream outage for ${symbol}`);
      return Array.from({ length: 20 }, (_, i) => ({
        close: 100 + Math.sin(i) * 3,
        volume: 30000 + i * 100,
      }));
    },
  };
}

async function seedBaseline(symbol, status = 'ready') {
  await repo.ensureBaselineExists(symbol);
  await repo.markBaselineReady(symbol, { typicalDailyVolatility: 0.02, avgVolume: 31000, historyDaysUsed: 20 });
  if (status === 'failed') await repo.markBaselineFailed(symbol);
  return symbol;
}

async function run() {
  await resetDb();

  // ---- Test 1: deterministic schedule math for the next IST deadline ----
  {
    // 2026-09-04T10:00:00Z == 15:30 IST — before the 18:30 IST slot the
    // same day, so the next fire is today 13:00:00Z (3 hours away).
    const beforeSlot = new Date('2026-09-04T10:00:00Z');
    assertTrue('1a. Before the daily slot, delay goes to TODAY at 18:30 IST', msUntilNextIstTime(beforeSlot, 18, 30) === 3 * 60 * 60 * 1000, msUntilNextIstTime(beforeSlot, 18, 30));

    // 2026-09-04T14:00:00Z == 19:30 IST — after today's slot, so it rolls
    // to tomorrow 13:00:00Z (23 hours away).
    const afterSlot = new Date('2026-09-04T14:00:00Z');
    assertTrue('1b. After the daily slot, delay rolls forward to TOMORROW 18:30 IST', msUntilNextIstTime(afterSlot, 18, 30) === 23 * 60 * 60 * 1000, msUntilNextIstTime(afterSlot, 18, 30));

    // Exactly at the slot (2026-09-04T13:00:00Z == 18:30 IST) -> tomorrow.
    const exactlyAt = new Date('2026-09-04T13:00:00Z');
    assertTrue('1c. Exactly at the slot, delay rolls forward 24h', msUntilNextIstTime(exactlyAt, 18, 30) === 24 * 60 * 60 * 1000, msUntilNextIstTime(exactlyAt, 18, 30));
  }

  // ---- Test 2: a full pass recomputes every ready baseline ----
  {
    await seedBaseline('REFSYM1');
    await seedBaseline('REFSYM2');
    const result = await refreshAllBaselines({ marketDataClient: makeHistoryProvider(), logger: silentLogger });
    assertTrue('2a. Both ready baselines refreshed', result.succeeded === 2 && result.failed === 0, result);
    const b1 = await repo.getBaseline('REFSYM1');
    const b2 = await repo.getBaseline('REFSYM2');
    assertTrue('2b. Refresh left both baselines healthy/ready', b1.status === 'ready' && b2.status === 'ready', { b1: b1.status, b2: b2.status });
  }

  // ---- Test 3: per-symbol isolation — one dead symbol can't abort the pass ----
  {
    const result = await refreshAllBaselines({ marketDataClient: makeHistoryProvider(['REFSYM2']), logger: silentLogger });
    const b2 = await repo.getBaseline('REFSYM2');
    assertTrue('3a. A failing symbol is marked failed but does not abort/crash the pass', result.count === 2, result);
    assertTrue('3b. The failing upstream flipped its baseline to failed (honest state)', b2.status === 'failed', b2.status);
    const b1 = await repo.getBaseline('REFSYM1');
    assertTrue('3c. The healthy symbol still refreshed fine in the same pass', b1.status === 'ready' && Number(b1.typical_daily_volatility) > 0, b1.status);
  }

  // ---- Test 4: 'failed' baselines are retried by the refresh pass ----
  {
    await repo.ensureBaselineExists('REFSYM3');
    await repo.markBaselineFailed('REFSYM3'); // genuinely failed baseline
    await repo.ensureBaselineExists('REFSYM4'); // left 'pending' on purpose — should NOT be refreshed
    await repo.ensureBaselineExists('REFSYM5');
    await repo.markBaselineFailed('REFSYM5');

    const result = await refreshAllBaselines({ marketDataClient: makeHistoryProvider(), logger: silentLogger });
    const b3 = await repo.getBaseline('REFSYM3');
    const b5 = await repo.getBaseline('REFSYM5');
    assertTrue('4a. A previously-failed baseline is recovered to ready by refresh', b3.status === 'ready', b3.status);
    assertTrue('4b. A second failed baseline is also recovered', b5.status === 'ready', b5.status);
    const b4 = await repo.getBaseline('REFSYM4');
    assertTrue('4c. Pending rows are left untouched by the refresh pass', b4.status === 'pending', b4.status);
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