// src/marketData/indexSymbols.js
//
// Single source of truth for the two headline indices shown in the top
// ticker strip. They are NOT stocks: Yahoo address them by their own
// symbols (^NSEI, ^BSESN) — no .NS suffix — and they never enter the
// baseline/snapshot tables (which are FK-bound to watchable symbols).
// The poller polls this list each cycle (through the same circuit-breaker
// client) and caches the results in the index_quote table.

const INDEX_SYMBOLS = [
  { symbol: 'NIFTY', yahooSymbol: '^NSEI', label: 'NIFTY 50' },
  { symbol: 'SENSEX', yahooSymbol: '^BSESN', label: 'SENSEX' },
];

const INDEX_BY_SYMBOL = Object.fromEntries(
  INDEX_SYMBOLS.map((index) => [index.symbol, index])
);

module.exports = { INDEX_SYMBOLS, INDEX_BY_SYMBOL };