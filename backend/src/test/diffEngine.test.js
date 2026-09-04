const { computeDiff } = require('../diffEngine');

const now = new Date('2026-09-04T10:00:00Z');
const twoHoursAgo = new Date('2026-09-04T08:00:00Z');

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log('  expected:', JSON.stringify(expected));
    console.log('  actual  :', JSON.stringify(actual));
  }
}

function assertTrue(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}  (${detail})`);
  }
}

// ---- Case 1: Normal move, baseline case ----
{
  const lastSeen = { price: 100, volume: 100000, timestamp: twoHoursAgo };
  const current  = { price: 103, volume: 100000, timestamp: now, isStale: false };
  const baseline = { status: 'ready', typicalDailyVolatility: 0.02, avgVolume: 100000 };
  const r = computeDiff(lastSeen, current, baseline);
  // 3% move / 2% typical vol = 1.5 normalizedMove, volume ratio 1 -> confidenceMultiplier 1
  assertTrue('1. Normal move computes expected normalizedMove', r.normalizedMove === 1.5, r.normalizedMove);
  assertTrue('1. Normal move is exactly at meaningful threshold (1.5 >= 1.5)', r.isMeaningful === true, r.isMeaningful);
  assertTrue('1. Direction is up', r.direction === 'up', r.direction);
}

// ---- Case 2: Zero-volatility stock (would divide by zero without floor) ----
{
  const lastSeen = { price: 100, volume: 50000, timestamp: twoHoursAgo };
  const current  = { price: 100.05, volume: 50000, timestamp: now, isStale: false };
  const baseline = { status: 'ready', typicalDailyVolatility: 0, avgVolume: 50000 }; // zero!
  const r = computeDiff(lastSeen, current, baseline);
  assertTrue('2. Zero volatility does not produce Infinity/NaN', Number.isFinite(r.finalScore), r.finalScore);
  assertTrue('2. Zero volatility uses MIN_VOLATILITY floor correctly', r.normalizedMove === 0.5, r.normalizedMove);
}

// ---- Case 3: Zero-volume stock (would divide by zero without floor) ----
{
  const lastSeen = { price: 100, volume: 0, timestamp: twoHoursAgo };
  const current  = { price: 105, volume: 200, timestamp: now, isStale: false };
  const baseline = { status: 'ready', typicalDailyVolatility: 0.02, avgVolume: 0 }; // zero!
  const r = computeDiff(lastSeen, current, baseline);
  assertTrue('3. Zero avgVolume does not produce Infinity/NaN', Number.isFinite(r.finalScore), r.finalScore);
}

// ---- Case 4: Missing volume data entirely (graceful degrade to price-only) ----
{
  const lastSeen = { price: 100, volume: null, timestamp: twoHoursAgo };
  const current  = { price: 103, volume: null, timestamp: now, isStale: false };
  const baseline = { status: 'ready', typicalDailyVolatility: 0.02, avgVolume: 100000 };
  const r = computeDiff(lastSeen, current, baseline);
  assertTrue('4. Missing volume degrades to neutral multiplier (1.0)', r.confidenceMultiplier === 1, r.confidenceMultiplier);
  assertTrue('4. Missing volume: score equals raw normalizedMove', r.finalScore === r.normalizedMove, r);
}

// ---- Case 5: First-ever view (no lastSeen yet) ----
{
  const baseline = { status: 'ready', typicalDailyVolatility: 0.02, avgVolume: 100000 };
  const current  = { price: 100, volume: 100000, timestamp: now, isStale: false };
  const r = computeDiff(null, current, baseline);
  assertTrue('5. No prior view returns blank/no-crash result', r.reason === 'no_prior_view' && r.isMeaningful === false, r);
}

// ---- Case 6: Move below meaningful threshold (listed, not badged) ----
{
  const lastSeen = { price: 100, volume: 100000, timestamp: twoHoursAgo };
  const current  = { price: 100.5, volume: 100000, timestamp: now, isStale: false }; // 0.5% move
  const baseline = { status: 'ready', typicalDailyVolatility: 0.02, avgVolume: 100000 };
  const r = computeDiff(lastSeen, current, baseline);
  assertTrue('6. Small move is NOT flagged meaningful', r.isMeaningful === false, r.finalScore);
  assertTrue('6. Small move still returns a real (non-blank) score', r.reason === 'ok', r.reason);
}

// ---- Case 7: Big move on thin volume (should be dampened) ----
{
  const lastSeen = { price: 100, volume: 100000, timestamp: twoHoursAgo };
  const current  = { price: 106, volume: 20000, timestamp: now, isStale: false }; // low volume vs avg
  const baseline = { status: 'ready', typicalDailyVolatility: 0.02, avgVolume: 100000 };
  const r = computeDiff(lastSeen, current, baseline);
  // volumeRatio = 0.2 -> clamped to 0.5 (floor of the confidence band)
  assertTrue('7. Thin volume dampens score (confidenceMultiplier clamped to 0.5)', r.confidenceMultiplier === 0.5, r.confidenceMultiplier);
  assertTrue('7. Dampened score is less than raw normalizedMove', Math.abs(r.finalScore) < Math.abs(r.normalizedMove), r);
}

// ---- Case 8: Big move on high volume (should NOT be dampened, should amplify) ----
{
  const lastSeen = { price: 100, volume: 100000, timestamp: twoHoursAgo };
  const current  = { price: 106, volume: 250000, timestamp: now, isStale: false }; // high volume vs avg
  const baseline = { status: 'ready', typicalDailyVolatility: 0.02, avgVolume: 100000 };
  const r = computeDiff(lastSeen, current, baseline);
  // volumeRatio = 2.5 -> clamped to 2.0 (ceiling of the confidence band)
  assertTrue('8. High volume amplifies score (confidenceMultiplier clamped to 2.0)', r.confidenceMultiplier === 2.0, r.confidenceMultiplier);
  assertTrue('8. Amplified score is greater than raw normalizedMove', Math.abs(r.finalScore) > Math.abs(r.normalizedMove), r);
}

// ---- Bonus: Stale data must never produce a fresh alert ----
{
  const lastSeen = { price: 100, volume: 100000, timestamp: twoHoursAgo };
  const current  = { price: 120, volume: 100000, timestamp: now, isStale: true }; // huge move, but stale!
  const baseline = { status: 'ready', typicalDailyVolatility: 0.02, avgVolume: 100000 };
  const r = computeDiff(lastSeen, current, baseline);
  assertTrue('Bonus. Stale data suppresses alert regardless of move size', r.isMeaningful === false && r.reason === 'stale_data', r);
}

// ---- Bonus: Baseline not ready (cold start) must not compute a misleading score ----
{
  const lastSeen = { price: 100, volume: 100000, timestamp: twoHoursAgo };
  const current  = { price: 150, volume: 100000, timestamp: now, isStale: false };
  const baseline = { status: 'pending', typicalDailyVolatility: null, avgVolume: null };
  const r = computeDiff(lastSeen, current, baseline);
  assertTrue('Bonus. Pending baseline suppresses score, no crash', r.reason === 'baseline_not_ready' && Number.isFinite(r.finalScore), r);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
