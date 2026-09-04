// src/marketData/realProvider.js
//
// Real implementation of the { fetchQuote, fetchHistorical } interface,
// backed by yahoo-finance2 (unofficial Yahoo Finance client, no API key
// required, MIT licensed, actively maintained — verified on npm before
// using: `npm view yahoo-finance2 version`).
//
// NOTE ON TESTING: this sandbox has no network path to finance.yahoo.com
// (not in the allowed-domains list), so the actual HTTP calls could not be
// live-tested here. What COULD be verified without network access — and
// WAS verified, see realProvider.test.js — is the mapping/adapter logic:
// correctly appending the .NS suffix, correctly reading Yahoo's actual
// field names (regularMarketPrice, regularMarketVolume, etc., confirmed
// against the installed package's real type definitions, not guessed),
// and correctly slicing/shaping historical data to our interface. That is
// the part most likely to silently break; the HTTP plumbing itself is
// yahoo-finance2's problem, not ours.
//
// Uses the v3 class API per the package's own bundled usage guidance
// (node_modules/yahoo-finance2/skills/yahoo-finance2/SKILL.md) — the old
// v1/v2 singleton pattern is explicitly deprecated.

const YahooFinance = require('yahoo-finance2').default;

// Factory, not a bare singleton — allows a fake/mock client to be injected
// for testing the mapping logic without a real network call.
function createRealProvider(yahooFinanceClient = new YahooFinance()) {
  // Indian NSE tickers need a .NS suffix on Yahoo Finance (e.g. RELIANCE.NS).
  // BSE would use .BO — NSE is the more liquid/primary exchange for most
  // large-caps, so it's the default here; a real product might let a user
  // pick, but that's explicitly out of scope per the interface contract.
  function toYahooSymbol(symbol) {
    return `${symbol}.NS`;
  }

  async function fetchQuote(symbol) {
    const q = await yahooFinanceClient.quote(toYahooSymbol(symbol));
    if (!q || typeof q.regularMarketPrice !== 'number') {
      // Delisted, invalid, or Yahoo returned an unexpected shape — treat as
      // a failure so the existing retry/circuit-breaker layer in client.js
      // handles it exactly like any other upstream failure.
      throw new Error(`No usable quote data for ${symbol}`);
    }
    return {
      price: q.regularMarketPrice,
      volume: typeof q.regularMarketVolume === 'number' ? q.regularMarketVolume : null,
    };
  }

  async function fetchHistorical(symbol, days = 20) {
    const period2 = new Date();
    // Fetch a wider window than requested — weekends/holidays mean
    // calendar days != trading days, so asking for exactly `days` calendar
    // days back would under-deliver trading days. 2.2x is a safe buffer.
    const period1 = new Date(period2.getTime() - days * 2.2 * 24 * 60 * 60 * 1000);

    // NOTE: deliberately uses the chart endpoint, not `historical`. Found
    // live: Yahoo returns the CURRENT, still-in-progress session as a daily
    // candle with a null close/volume, and yahoo-finance2's `historical`
    // wrapper throws on ANY row with a null close — so it always failed
    // whenever the market was open (which is exactly when the app runs).
    // The chart endpoint returns those same rows without throwing, which
    // lets US filter them out — the correct behavior anyway, since an
    // incomplete candle must never go into a volatility baseline.
    const { quotes } = await yahooFinanceClient.chart(toYahooSymbol(symbol), {
      period1,
      period2,
      interval: '1d',
    });

    if (!Array.isArray(quotes) || quotes.length === 0) {
      throw new Error(`No historical data for ${symbol}`);
    }

    // Only COMPLETED trading days count toward a baseline: filter out any
    // candle whose close is missing/null (in-progress session, trading halt,
    // etc.). If every row in the window is incomplete, that is genuinely no
    // usable data — throw so the retry/circuit-breaker layer handles it.
    const completedCandles = quotes.filter((r) => typeof r.close === 'number' && r.close !== null);
    if (completedCandles.length === 0) {
      throw new Error(`No usable (completed) historical data for ${symbol}`);
    }

    // Take the most recent `days` completed trading days, oldest-first
    // (matches the order computeBaseline.js expects for its return-sequence
    // calculation).
    return completedCandles.slice(-days).map((r) => ({
      close: r.close,
      volume: typeof r.volume === 'number' ? r.volume : 0,
    }));
  }

  return { fetchQuote, fetchHistorical };
}

module.exports = { createRealProvider };
