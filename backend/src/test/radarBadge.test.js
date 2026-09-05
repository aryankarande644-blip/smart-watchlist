// src/test/radarBadge.test.js
const { radarBadge } = require('../radar/badge');

let passed = 0, failed = 0;
function assertTrue(name, condition, detail) {
  if (condition) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}  (${JSON.stringify(detail)})`); }
}

// Radars compute diffs against a symbol's own last close; these fixtures give
// the four badge cases their required diff shapes directly (radarBadge only
// reads isMeaningful/direction/confidenceMultiplier/finalScore/reason).

function diff({ isMeaningful, direction, confidenceMultiplier, finalScore, reason = 'ok' }) {
  return { isMeaningful, direction, confidenceMultiplier, finalScore, reason };
}

async function run() {
  // ---- 1. Volume Spike: meaningful + high confidenceMultiplier (>1.3) ----
  {
    const b = radarBadge(diff({ isMeaningful: true, direction: 'up', confidenceMultiplier: 1.6, finalScore: 2.2 }));
    assertTrue('1a. Meaningful + high-volume-confidence -> Volume Spike', b && b.label === 'Volume Spike', b);
    assertTrue('1b. Volume Spike why mentions volume', /volume/i.test(b.why), b);
  }

  // ---- 2. Strong Move: meaningful + up, but NOT high-volume-confidence ----
  {
    const b = radarBadge(diff({ isMeaningful: true, direction: 'up', confidenceMultiplier: 1.1, finalScore: 1.8 }));
    assertTrue('2a. Meaningful up without volume spike -> Strong Move', b && b.label === 'Strong Move', b);
    assertTrue('2b. Strong Move why references a move up', /up/i.test(b.why), b);
  }

  // ---- 3. High Volatility: meaningful + down ----
  {
    const b = radarBadge(diff({ isMeaningful: true, direction: 'down', confidenceMultiplier: 1.2, finalScore: -1.9 }));
    assertTrue('3a. Meaningful down -> High Volatility', b && b.label === 'High Volatility', b);
    assertTrue('3b. High Volatility why references a move down', /down/i.test(b.why), b);
  }

  // ---- 4. Near Breakout: 1.0 <= abs(finalScore) < 1.5 (below threshold) ----
  {
    const b = radarBadge(diff({ isMeaningful: false, direction: 'up', confidenceMultiplier: 1.0, finalScore: 1.2 }));
    assertTrue('4a. Score 1.0-1.5x but not meaningful -> Near Breakout', b && b.label === 'Near Breakout', b);
  }

  // ---- 5. Non-mover: no badge (below near-breakout floor) ----
  {
    const b = radarBadge(diff({ isMeaningful: false, direction: 'flat', confidenceMultiplier: 1.0, finalScore: 0.4 }));
    assertTrue('5a. Small move -> no badge (not a mover)', b === null, b);
  }

  // ---- 6. Non-ok reason (stale/pending) -> no badge ----
  {
    const b = radarBadge({ isMeaningful: true, direction: 'up', confidenceMultiplier: 2.0, finalScore: 3.0, reason: 'stale_data' });
    assertTrue('6a. Stale data never surfaces a radar badge', b === null, b);
  }

  // ---- 7. Volume-spike check is strictly > 1.3 (boundary) ----
  {
    const atBoundary = radarBadge(diff({ isMeaningful: true, direction: 'up', confidenceMultiplier: 1.3, finalScore: 1.9 }));
    assertTrue('7a. confidenceMultiplier exactly 1.3 is NOT a Volume Spike', atBoundary && atBoundary.label === 'Strong Move', atBoundary);
    const above = radarBadge(diff({ isMeaningful: true, direction: 'up', confidenceMultiplier: 1.31, finalScore: 1.9 }));
    assertTrue('7b. confidenceMultiplier 1.31 IS a Volume Spike', above && above.label === 'Volume Spike', above);
  }

  // ---- 8. Near Breakout boundary: 1.0 inclusive, 1.5 exclusive ----
  {
    const atFloor = radarBadge(diff({ isMeaningful: false, direction: 'up', confidenceMultiplier: 1.0, finalScore: 1.0 }));
    assertTrue('8a. Exactly 1.0 is a Near Breakout', atFloor && atFloor.label === 'Near Breakout', atFloor);
    const below = radarBadge(diff({ isMeaningful: false, direction: 'up', confidenceMultiplier: 1.0, finalScore: 0.99 }));
    assertTrue('8b. Just under 1.0 is not a mover', below === null, below);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});