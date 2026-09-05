// src/marketData/radarUniverse.js
//
// Market Radar universe: a fixed, curated set of well-known, liquid NSE
// large-caps. These are the symbols the radar candidates candidates from —
// the "what's moving right now, market-wide" surface, distinct from any one
// user's watchlist.
//
// Every symbol here is a plain .NS equity (NSE), so the existing provider
// logic applies as-is. This list must NOT include the index names (NIFTY /
// SENSEX live in indexSymbols.js and are handled by the ticker strip), and
// must not include any symbol Yahoo mislabels (see §8 bug #12 — CEAT is
// deliberately excluded because Yahoo serves it as a MUTUALFUND placeholder).
//
// The poller merges this universe into the SAME 30-second cycle as watched
// symbols (deduped), so each radar symbol gets a fresh per-cycle snapshot
// with no extra resilience surface — see HANDOFF §6 and §10 item 8.

const RADAR_UNIVERSE = [
  'RELIANCE',
  'TCS',
  'HDFCBANK',
  'INFY',
  'ICICIBANK',
  'SBIN',
  'HINDUNILVR',
  'ITC',
  'BHARTIARTL',
  'KOTAKBANK',
  'LT',
  'AXISBANK',
  'ASIANPAINT',
  'MARUTI',
  'WIPRO',
  'SUNPHARMA',
  'TITAN',
  'ULTRACEMCO',
  'BAJFINANCE',
  'NESTLEIND',
];

module.exports = { RADAR_UNIVERSE };