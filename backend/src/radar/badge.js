// src/radar/badge.js
//
// Pure, testable mapping from a diff's existing fields to a Market Radar
// badge label + a one-line "why". No new computation is done here — it only
// reads the fields computeDiff already produces (isMeaningful, direction,
// confidenceMultiplier, finalScore) and selects a badge + explanation.
//
// The four cases, per the spec:
//   - isMeaningful && confidenceMultiplier > 1.3  -> "Volume Spike"
//   - isMeaningful && direction === 'up'          -> "Strong Move"
//   - isMeaningful && direction === 'down'        -> "High Volatility"
//   - 1.0 <= abs(finalScore) < 1.5 (near threshold)-> "Near Breakout"
//   - otherwise                                   -> null (no badge; not a mover)

const HIGH_CONFIDENCE_VOLUME_RATIO = 1.3;

// Spec: "score between 1.0-1.5x (below threshold but close)" to the
// meaningful threshold. MEANINGFUL_THRESHOLD is 1.5; the floor here is the
// point below which a move is just noise, so we use 1.0.
const NEAR_BREAKOUT_MIN_SCORE = 1.0;

function radarBadge(diff) {
  if (!diff || diff.reason !== 'ok' || !diff.isMeaningful && !isNearBreakout(diff)) {
    return null;
  }

  if (diff.isMeaningful) {
    if (diff.confidenceMultiplier > HIGH_CONFIDENCE_VOLUME_RATIO) {
      return { label: 'Volume Spike', why: 'Above average volume' };
    }
    if (diff.direction === 'up') {
      return { label: 'Strong Move', why: 'Sharp move up vs its normal range' };
    }
    if (diff.direction === 'down') {
      return { label: 'High Volatility', why: 'Sharp move down vs its normal range' };
    }
    // isMeaningful true but flat direction (unusual) — treat as activity.
    return { label: 'High Activity', why: 'Elevated activity vs its normal range' };
  }

  if (isNearBreakout(diff)) {
    return { label: 'Near Breakout', why: 'Close to a meaningful move' };
  }

  return null;
}

function isNearBreakout(diff) {
  const score = Math.abs(diff.finalScore || 0);
  return score >= NEAR_BREAKOUT_MIN_SCORE && score < 1.5;
}

module.exports = { radarBadge, HIGH_CONFIDENCE_VOLUME_RATIO, NEAR_BREAKOUT_MIN_SCORE };