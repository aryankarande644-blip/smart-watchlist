// src/poller/poller.js
const repo = require('../db/repository');

// NSE trading window, IST. Kept simple and explicit per the decision to
// hardcode a static holiday list rather than call a live calendar API.
// Full 2026 equity-segment calendar as notified by NSE (cross-checked
// against NSE's own circular and multiple broker calendars). Only weekday
// closures appear here — weekend holidays are already handled by the
// getDay() check below, so listing them would be redundant.
// format YYYY-MM-DD, IST calendar dates.
const NSE_HOLIDAYS_2026 = new Set([
  '2026-01-15', // Municipal Corporation Elections, Maharashtra
  '2026-01-26', // Republic Day
  '2026-03-03', // Holi
  '2026-03-26', // Shri Ram Navami
  '2026-03-31', // Shri Mahavir Jayanti
  '2026-04-03', // Good Friday
  '2026-04-14', // Dr. Baba Saheb Ambedkar Jayanti
  '2026-05-01', // Maharashtra Day
  '2026-05-28', // Bakri Id / Id-ul-Zuha
  '2026-06-26', // Moharram
  '2026-09-14', // Ganesh Chaturthi
  '2026-10-02', // Mahatma Gandhi Jayanti
  '2026-10-20', // Dussehra
  '2026-11-10', // Diwali - Balipratipada
  '2026-11-24', // Prakash Gurpurb Sri Guru Nanak Dev
  '2026-12-25', // Christmas
]);

function isMarketOpenNowIST(now = new Date()) {
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay(); // 0 = Sunday, 6 = Saturday
  if (day === 0 || day === 6) return false;

  const dateStr = ist.toISOString().slice(0, 10);
  if (NSE_HOLIDAYS_2026.has(dateStr)) return false;

  const minutes = ist.getHours() * 60 + ist.getMinutes();
  const marketOpen = 9 * 60 + 15;   // 09:15
  const marketClose = 15 * 60 + 30; // 15:30
  return minutes >= marketOpen && minutes <= marketClose;
}

function createPoller({ marketDataClient, intervalMs = 30000, logger = console, isMarketOpenFn = isMarketOpenNowIST }) {
  let isCycleRunning = false;
  let lastSuccessfulPollAt = null;
  let timer = null;

  async function runCycle() {
    if (isCycleRunning) {
      logger.log(JSON.stringify({ event: 'poll_cycle_skipped_overlap' }));
      return;
    }
    isCycleRunning = true;
    const cycleStart = Date.now();

    let successCount = 0;
    let failCount = 0;

    try {
      const marketOpen = isMarketOpenFn();
      const symbols = await repo.getDistinctWatchedSymbols();

      if (!marketOpen) {
        // Market closed: don't poll, just flag existing snapshots as
        // market-closed so the frontend can show the right state, and
        // don't waste API budget.
        for (const symbol of symbols) {
          try {
            const existing = await repo.getSnapshot(symbol);
            if (existing) {
              await repo.upsertSnapshot(symbol, {
                price: existing.price,
                volume: existing.volume,
                isStale: existing.is_stale,
                marketClosed: true,
              });
            }
          } catch (err) {
            logger.error(JSON.stringify({ event: 'market_closed_flag_error', symbol, message: err.message }));
          }
        }
        logger.log(JSON.stringify({ event: 'poll_cycle_skipped_market_closed', symbolCount: symbols.length }));
        return;
      }

      // Per-symbol isolation: each symbol gets its own try/catch so one
      // bad/delisted/rate-limited symbol can never take the rest down with it.
      for (const symbol of symbols) {
        try {
          const quote = await marketDataClient.fetchQuote(symbol);
          await repo.upsertSnapshot(symbol, {
            price: quote.price,
            volume: quote.volume,
            isStale: false,
            marketClosed: false,
          });
          successCount++;
        } catch (err) {
          failCount++;
          try {
            await repo.markSnapshotStale(symbol);
          } catch (dbErr) {
            logger.error(JSON.stringify({ event: 'mark_stale_failed', symbol, message: dbErr.message }));
          }
          logger.error(JSON.stringify({ event: 'symbol_fetch_failed', symbol, message: err.message }));
        }
      }

      lastSuccessfulPollAt = new Date();
    } catch (err) {
      // Top-level catch: this is the fix for a real bug found under live
      // testing — a DB outage (or any other unexpected failure not caught
      // by the per-symbol try/catch below, e.g. getDistinctWatchedSymbols
      // itself failing) must degrade the poller, not crash the whole
      // Node process. The process staying alive is what lets /health
      // correctly report 'degraded' instead of the entire service dying.
      failCount++;
      logger.error(JSON.stringify({ event: 'poll_cycle_top_level_error', message: err.message }));
    } finally {
      isCycleRunning = false;
      logger.log(JSON.stringify({
        event: 'poll_cycle_complete',
        durationMs: Date.now() - cycleStart,
        successCount,
        failCount,
      }));
    }
  }

  function start() {
    runCycle(); // immediate poll on boot — don't wait a full interval to look alive
    timer = setInterval(runCycle, intervalMs);
  }

  function stop() {
    // Graceful shutdown: stop scheduling new cycles. Caller is responsible
    // for awaiting any in-flight cycle before exiting the process.
    if (timer) clearInterval(timer);
  }

  return {
    start,
    stop,
    runCycle, // exposed directly for testing
    getStatus: () => ({ isCycleRunning, lastSuccessfulPollAt }),
  };
}

module.exports = { createPoller, isMarketOpenNowIST };
