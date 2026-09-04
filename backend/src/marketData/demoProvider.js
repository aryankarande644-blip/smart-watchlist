// src/marketData/demoProvider.js
//
// A deliberate, first-class fallback — NOT a hack bolted on for testing.
// Selected explicitly via MARKET_DATA_PROVIDER=demo so the app is honestly
// demoable (e.g. presenting to judges outside real market hours, or before
// a real provider API key is wired) without silently pretending fake data
// is live. The frontend disclaimer already covers this; this provider just
// makes sure there's always *something* real to look at.

const SEED_PRICES = {
  RELIANCE: 2980, TCS: 3850, INFY: 1650, HDFCBANK: 1680,
  WIPRO: 445, AXISBANK: 1150, ICICIBANK: 1220, SBIN: 810,
};

// Each symbol drifts from its own running price with small random noise,
// so repeated polls look like a real, continuously-moving feed rather than
// independent random numbers each time.
const runningPrices = new Map();

function fetchQuote(symbol) {
  const seed = SEED_PRICES[symbol] ?? 500 + (symbol.charCodeAt(0) % 50) * 10;
  const current = runningPrices.get(symbol) ?? seed;
  const drift = current * (Math.random() - 0.5) * 0.01; // up to ~0.5% per tick
  const next = Math.max(1, current + drift);
  runningPrices.set(symbol, next);

  return Promise.resolve({
    price: Math.round(next * 100) / 100,
    volume: Math.round(20000 + Math.random() * 180000),
  });
}

function fetchHistorical(symbol, days = 20) {
  const seed = SEED_PRICES[symbol] ?? 500;
  const candles = Array.from({ length: days }, () => ({
    close: seed * (1 + (Math.random() - 0.5) * 0.03),
    volume: Math.round(20000 + Math.random() * 180000),
  }));
  return Promise.resolve(candles);
}

module.exports = { fetchQuote, fetchHistorical };
