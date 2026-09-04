// src/marketData/realProvider.js
//
// Real implementation of the { fetchQuote, fetchHistorical } interface,
// backed by yahoo-finance2 (unofficial Yahoo Finance client, no API key
// required, MIT licensed, actively maintained — verified on npm before
// using: `npm view yahoo-finance2 version`).
//
// MAPPING/ADAPTER LOGIC is covered by realProvider.test.js; the full HTTP
// path was additionally LIVE-VERIFIED against real Yahoo data (quotes + 20
// completed candles) during the build.
//
// DEPLOYMENT NOTE (found live, Phase 2): the stock yahoo-finance2 default
// User-Agent — `Mozilla/5.0 (compatible; yahoo-finance2/x.y.z)` — is a
// "compatible" UA that Yahoo frequently rejects from cloud/datacenter IPs
// (Render, AWS, etc.) with 429/401, while the same code worked fine from a
// residential IP. Sending a real browser UA fixes it. `YF_QUERY_HOST`
// (env, default query2) optionally switches the query endpoint, e.g. to
// `query1.finance.yahoo.com`, if one host is more permissive than the other.
//
// Uses the v3 class API per the package's bundled usage guidance
// (node_modules/yahoo-finance2/skills/yahoo-finance2/SKILL.md) — the old
// v1/v2 singleton pattern is explicitly deprecated.

const YahooFinance = require('yahoo-finance2').default;

// A real, current desktop Chrome UA. yahoo-finance2's built-in default is a
// "compatible" UA that Yahoo tends to block — see note above.
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function defaultYahooFinanceClient() {
  return new YahooFinance({
    YF_QUERY_HOST: process.env.YF_QUERY_HOST || 'query2.finance.yahoo.com',
    fetchOptions: {
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    },
  });
}

// Factory, not a bare singleton — allows a fake/mock client to be injected
// for testing the mapping logic without a real network call.
function createRealProvider(yahooFinanceClient = defaultYahooFinanceClient()) {
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
