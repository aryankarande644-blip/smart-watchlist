// src/baseline/computeBaseline.js
const repo = require('../db/repository');

// Standard deviation of daily returns, as the "typical daily volatility"
// measure — this is the number the diff engine divides by, so it must
// never be allowed to come out as exactly 0 or negative (the repository/
// diffEngine floor is a second line of defense, this is the first).
function computeVolatilityAndVolume(candles) {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);

  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }

  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - meanReturn) ** 2, 0) / returns.length;
  const typicalDailyVolatility = Math.sqrt(variance);

  const avgVolume = volumes.reduce((a, v) => a + v, 0) / volumes.length;

  return { typicalDailyVolatility, avgVolume: Math.round(avgVolume) }; // avg_volume is BIGINT in Postgres — must be an integer
}

// Triggered once when a symbol is FIRST added by anyone (see ensureBaselineExists's
// `created` flag in the watchlist route) — computes real stats from historical
// data and moves the baseline from 'pending' to 'ready' (or 'low_confidence'
// if too little history exists, or 'failed' after exhausting retries).
async function computeBaselineForSymbol(symbol, marketDataClient, logger = console) {
  const LOOKBACK_DAYS = 20;
  const MIN_USABLE_DAYS = 5; // below this, don't even attempt — too noisy to be meaningful

  try {
    const candles = await marketDataClient.fetchHistorical(symbol, LOOKBACK_DAYS);

    if (!candles || candles.length < MIN_USABLE_DAYS) {
      await repo.markBaselineFailed(symbol);
      logger.error(JSON.stringify({ event: 'baseline_insufficient_history', symbol, daysAvailable: candles?.length ?? 0 }));
      return;
    }

    const { typicalDailyVolatility, avgVolume } = computeVolatilityAndVolume(candles);
    const lowConfidence = candles.length < LOOKBACK_DAYS;

    // Sparkline data: the last <=7 completed closing prices, captured here
    // (before the candles are discarded) and stored on the baseline row.
    // Bounded and always overwritten — never grows over time, and the
    // frontend never needs to re-fetch history just to draw 7 dots.
    const sparklineCloses = candles
      .slice(-7)
      .map((c) => Math.round(c.close * 100) / 100);

    await repo.markBaselineReady(symbol, {
      typicalDailyVolatility,
      avgVolume,
      historyDaysUsed: candles.length,
      lowConfidence,
      sparklineCloses,
    });

    logger.log(JSON.stringify({ event: 'baseline_computed', symbol, typicalDailyVolatility, avgVolume, daysUsed: candles.length, lowConfidence, sparklineCloses }));
  } catch (err) {
    await repo.markBaselineFailed(symbol);
    logger.error(JSON.stringify({ event: 'baseline_computation_failed', symbol, message: err.message }));
  }
}

module.exports = { computeBaselineForSymbol, computeVolatilityAndVolume };
