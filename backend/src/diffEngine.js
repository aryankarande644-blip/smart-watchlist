// diffEngine.js
// Pure function. No I/O, no DB, no framework. Given the same inputs it
// always returns the same output — that's what makes it independently testable.

const MIN_VOLATILITY = 0.001;   // 0.1% floor — prevents divide-by-zero on ultra-stable stocks
const MIN_VOLUME_FLOOR = 1000;  // shares — prevents divide-by-zero on illiquid stocks
const MEANINGFUL_THRESHOLD = 1.5; // multiples of baseline volatility to count as "meaningful"

/**
 * @param {object} lastSeen   { price, volume, timestamp }  - what the user last looked at
 * @param {object} current    { price, volume, timestamp, isStale } - latest snapshot
 * @param {object} baseline   { typicalDailyVolatility, avgVolume, status }
 * @returns {object} { normalizedMove, confidenceMultiplier, finalScore, urgency, isMeaningful, direction, reason }
 */
function computeDiff(lastSeen, current, baseline) {
  // Guard: stale data should never produce a fresh alert
  if (current.isStale) {
    return blankResult('stale_data');
  }

  // Guard: no real baseline yet (cold start) — don't compute a misleading score.
  // 'low_confidence' is deliberately treated as usable (per the original
  // design decision for newly-listed stocks with <20 days of history) —
  // only 'pending' and 'failed' block computation.
  if (!baseline || (baseline.status !== 'ready' && baseline.status !== 'low_confidence')) {
    return blankResult('baseline_not_ready');
  }

  // Guard: first-ever view — lastSeen was seeded to current on add, so this
  // should be a true zero-move, not a missing-data crash.
  if (!lastSeen) {
    return blankResult('no_prior_view');
  }

  const safeVolatility = Math.max(baseline.typicalDailyVolatility, MIN_VOLATILITY);
  const safeAvgVolume = Math.max(baseline.avgVolume, MIN_VOLUME_FLOOR);

  const priceDeltaPct = (current.price - lastSeen.price) / lastSeen.price;
  const normalizedMove = priceDeltaPct / safeVolatility; // signed

  // Volume confidence: only present if volume data is available at all.
  // Missing volume => confidenceMultiplier = 1 (neutral), graceful degrade to price-only.
  let confidenceMultiplier = 1;
  if (typeof current.volume === 'number' && current.volume !== null) {
    const volumeRatio = current.volume / safeAvgVolume;
    confidenceMultiplier = clamp(volumeRatio, 0.5, 2.0);
  }

  const finalScore = normalizedMove * confidenceMultiplier; // signed, direction preserved

  const hoursSinceLastCheck = Math.max(
    (new Date(current.timestamp) - new Date(lastSeen.timestamp)) / 3600000,
    1 // floor at 1 hour so a 2-second gap doesn't produce absurd urgency
  );
  const urgency = Math.abs(finalScore) / hoursSinceLastCheck;

  const isMeaningful = Math.abs(finalScore) >= MEANINGFUL_THRESHOLD;

  return {
    normalizedMove: round(normalizedMove, 4),
    confidenceMultiplier: round(confidenceMultiplier, 4),
    finalScore: round(finalScore, 4),
    urgency: round(urgency, 4),
    isMeaningful,
    direction: finalScore > 0 ? 'up' : finalScore < 0 ? 'down' : 'flat',
    reason: 'ok',
  };
}

function blankResult(reason) {
  return {
    normalizedMove: 0,
    confidenceMultiplier: 1,
    finalScore: 0,
    urgency: 0,
    isMeaningful: false,
    direction: 'flat',
    reason,
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

module.exports = { computeDiff, MIN_VOLATILITY, MIN_VOLUME_FLOOR, MEANINGFUL_THRESHOLD };
