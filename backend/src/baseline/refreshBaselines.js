// src/baseline/refreshBaselines.js
//
// Daily baseline-refresh job (Section 10 #4 of the handoff). Baselines hold
// each symbol's "typical daily volatility" — the number the diff engine
// normalizes against. Computing it ONCE on first add and never again is the
// original design's known gap: as a stock's behavior drifts over time (a
// calm stock starts gapping, a hot one calms down), an ever-wooden baseline
// makes "meaningful" slowly lie. This job recomputes every stable baseline
// on a fixed off-market IST schedule.
//
// Deliberately scheduler-dependency-free: a self-rescheduling setTimeout is
// enough for "run once a day at a fixed IST time" and keeps the dependency
// surface small. `refreshAllBaselines` is exported separately so it can be
// triggered manually and tested in isolation.

const repo = require('../db/repository');
const { computeBaselineForSymbol } = require('./computeBaseline');

const DEFAULT_HOUR_IST = 18;
const DEFAULT_MINUTE_IST = 30;

// Milliseconds until the next occurrence of HH:MM IST, computed
// deterministically for testing. IST is UTC+5:30 with no DST.
function msUntilNextIstTime(now = new Date(), hour = DEFAULT_HOUR_IST, minute = DEFAULT_MINUTE_IST) {
  const istNowMs = now.getTime() + 5.5 * 60 * 60 * 1000;
  const targetToday = Date.UTC(
    new Date(istNowMs).getUTCFullYear(),
    new Date(istNowMs).getUTCMonth(),
    new Date(istNowMs).getUTCDate(),
    hour,
    minute,
    0,
    0
  );
  let target = targetToday - 5.5 * 60 * 60 * 1000; // back to real UTC
  if (target <= now.getTime()) {
    target += 24 * 60 * 60 * 1000; // already past today's slot -> tomorrow
  }
  return target - now.getTime();
}

// Recompute every refreshable baseline. Per-symbol isolation (same rule as
// the poller): one symbol's upstream failure must never abort the rest.
async function refreshAllBaselines({ marketDataClient, logger = console }) {
  const symbols = await repo.getRefreshableBaselineSymbols();
  let succeeded = 0;
  let failed = 0;

  for (const { symbol } of symbols) {
    try {
      await computeBaselineForSymbol(symbol, marketDataClient, logger);
      succeeded++;
    } catch (err) {
      // computeBaselineForSymbol already swallows and records its own
      // failures internally (marks baseline 'failed'), so reaching here
      // means something truly unexpected — log and keep going, never let
      // one symbol kill the whole daily pass.
      failed++;
      logger.error(JSON.stringify({ event: 'baseline_refresh_unexpected_error', symbol, message: err.message }));
    }
  }

  logger.log(JSON.stringify({ event: 'baseline_refresh_complete', count: symbols.length, succeeded, failed }));
  return { count: symbols.length, succeeded, failed };
}

// Create a daily self-rescheduling refresher.
//  - timeIST: 'HH:MM' 24h IST clock at which the daily pass fires
//  - You can force-market-open semantics nowhere here: baselines are built
//    from historical (closed) candles, so they never depend on the market
//    being open right now.
function createBaselineRefresher({ marketDataClient, logger = console, timeIST = `${DEFAULT_HOUR_IST}:${DEFAULT_MINUTE_IST}` }) {
  const [hour = DEFAULT_HOUR_IST, minute = DEFAULT_MINUTE_IST] = timeIST.split(':').map((n) => Number(n));
  let timer = null;
  let running = false;

  function scheduleNext() {
    const delay = msUntilNextIstTime(new Date(), hour, minute);
    timer = setTimeout(async () => {
      if (!running) {
        running = true;
        try {
          await refreshAllBaselines({ marketDataClient, logger });
        } catch (err) {
          // e.g. the DB layer itself is down — never crash the process on
          // a background job; the next day's pass retries.
          logger.error(JSON.stringify({ event: 'baseline_refresh_pass_crashed', message: err.message }));
        } finally {
          running = false;
        }
      }
      scheduleNext(); // always reschedule, even after a failed pass
    }, delay);
  }

  return {
    start() {
      if (timer) return;
      scheduleNext();
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
    // exposed for observability/tests
    getIsPassRunning: () => running,
  };
}

module.exports = { refreshAllBaselines, createBaselineRefresher, msUntilNextIstTime };