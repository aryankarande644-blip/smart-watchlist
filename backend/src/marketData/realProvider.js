// src/marketData/realProvider.js
//
// Real implementation of the { fetchQuote, fetchHistorical } interface,
// backed by Yahoo Finance.
//
// PRIMARY PATH: yahoo-finance2 (quote/chart) — the maintained package, used
// when Yahoo's credential/crumb machinery works (residential IPs, some hosts).
//
// DIRECT-FETCH FALLBACK: Yahoo aggressively gates its crumb/cookie step from
// datacenter/cloud IPs (Render, AWS, etc.) — found live in Phase 2: even with
// a real browser User-Agent, Yahoo's `getcrumb` endpoint returns NO Set-Cookie
// from such IPs, and yahoo-finance2's wrapper refuses to proceed (`No
// set-cookie header present in Yahoo's response`). The v8 CHART endpoint,
// however, has long worked WITHOUT any cookie/crumb, so on the first
// crumb/cookie-class failure the provider switches to direct `fetch` against
// v8/finance/chart for both quotes (via `meta.regularMarketPrice`) and
// history. The switch is sticky per process — every call going through a dead
// crumb path is wasted round-trips.
//
// MAPPING/ADAPTER LOGIC is covered by realProvider.test.js; the HTTP paths
// were LIVE-VERIFIED against real Yahoo data during the build.

const YahooFinance = require('yahoo-finance2').default;

// A real, current desktop Chrome UA. Yahoo's crumb/consent flow has
// historically rejected the package's own "compatible" UA, especially from
// cloud IPs. (Issue: gadicc/yahoo-finance2#977 and #741.)
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Signatures that mean Yahoo's cookie/crumb/consent gate did not admit us —
// the trigger for switching to the direct-fetch fallback path.
function isCrumbGateFailure(err) {
  const msg = String((err && err.message) || '');
  return /set-cookie|cookie|crumb|consent|session(request|id)?/i.test(msg);
}

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

  // Once Yahoo refuses the crumb gate, bypass the package's wrapper entirely
  // and talk to the v8 chart endpoint directly (no cookie/crumb needed).
  let useDirectFetch = false;

  async function directFetchJson(url) {
    const res = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    let body = null;
    try { body = await res.json(); } catch (_) { /* non-JSON body */ }
    if (!res.ok) {
      // Yahoo answers invalid/delisted symbols with an HTTP error whose body
      // carries its own explanation ("No data found, symbol may be
      // delisted"). Surface THAT message so the route can classify it as a
      // genuine symbol-miss (422) rather than an upstream failure (502).
      const desc = body && body.chart && body.chart.error && body.chart.error.description;
      if (desc) throw new Error(String(desc));
      throw new Error(`HTTPERROR ${res.status}`);
    }
    return body;
  }

  function directChartUrl(symbol, params) {
    const host = process.env.YF_DIRECT_HOST || process.env.YF_QUERY_HOST || 'query1.finance.yahoo.com';
    const qs = new URLSearchParams(params).toString();
    return `https://${host}/v8/finance/chart/${toYahooSymbol(symbol)}?${qs}`;
  }

  async function directFetchQuote(symbol) {
    // range=1d keeps the payload tiny; meta.regularMarketPrice is the live
    // price (updated even while the 1d candle row's close is still null).
    const json = await directFetchJson(directChartUrl(symbol, { interval: '1d', range: '1d', includePrePost: 'false' }));
    const meta = json && json.chart && json.chart.result && json.chart.result[0] && json.chart.result[0].meta;
    if (!meta || typeof meta.regularMarketPrice !== 'number') {
      // Delisted, invalid, or Yahoo returned an unexpected shape — treat as
      // a failure so the existing retry/circuit-breaker layer in client.js
      // handles it exactly like any other upstream failure.
      throw new Error(`No usable quote data for ${symbol}`);
    }
    const volumes = json.chart.result[0].indicators && json.chart.result[0].indicators.quote
      && json.chart.result[0].indicators.quote[0] && json.chart.result[0].indicators.quote[0].volume;
    // Best-effort: take the LAST NON-NULL volume row (the in-progress day's
    // row can end with null while earlier rows are populated).
    let lastVolume = null;
    if (Array.isArray(volumes)) {
      for (let i = volumes.length - 1; i >= 0; i -= 1) {
        if (typeof volumes[i] === 'number') { lastVolume = volumes[i]; break; }
      }
    }
    return {
      price: meta.regularMarketPrice,
      volume: lastVolume,
    };
  }

  async function directFetchHistorical(symbol, days) {
    // Wider window than requested (weekends/holidays): calendar days !=
    // trading days, so requesting exactly `days` under-delivers. 2.2x buffer.
    const period2 = Math.floor(Date.now() / 1000);
    const period1 = Math.floor(Date.now() / 1000 - days * 2.2 * 24 * 60 * 60);
    const json = await directFetchJson(directChartUrl(symbol, { interval: '1d', period1, period2 }));
    const result = json && json.chart && json.chart.result && json.chart.result[0];
    const timestamps = result && result.timestamp;
    const quote = result && result.indicators && result.indicators.quote && result.indicators.quote[0];
    if (!Array.isArray(timestamps) || !quote) {
      throw new Error(`No historical data for ${symbol}`);
    }

    // Only COMPLETED trading days count toward a baseline: filter out any
    // candle whose close is missing/null (in-progress session, trading halt,
    // etc.). If every row in the window is incomplete, that is genuinely no
    // usable data — throw so the retry/circuit-breaker layer handles it.
    const completedCandles = timestamps
      .map((_, i) => ({ close: quote.close && quote.close[i], volume: quote.volume && quote.volume[i] }))
      .filter((c) => typeof c.close === 'number' && c.close !== null);
    if (completedCandles.length === 0) {
      throw new Error(`No usable (completed) historical data for ${symbol}`);
    }

    // Take the most recent `days` completed trading days, oldest-first
    // (matches the order computeBaseline.js expects for its return-sequence
    // calculation).
    return completedCandles.slice(-days).map((c) => ({
      close: c.close,
      volume: typeof c.volume === 'number' ? c.volume : 0,
    }));
  }

  async function fetchQuote(symbol) {
    if (useDirectFetch) return directFetchQuote(symbol);

    try {
      const q = await yahooFinanceClient.quote(toYahooSymbol(symbol));
      if (!q || typeof q.regularMarketPrice !== 'number') {
        throw new Error(`No usable quote data for ${symbol}`);
      }
      return {
        price: q.regularMarketPrice,
        volume: typeof q.regularMarketVolume === 'number' ? q.regularMarketVolume : null,
      };
    } catch (err) {
      if (!isCrumbGateFailure(err)) throw err;
      useDirectFetch = true;
      console.log(JSON.stringify({ event: 'real_provider_direct_fetch_enabled', reason: err.message }));
      return directFetchQuote(symbol);
    }
  }

  async function fetchHistorical(symbol, days = 20) {
    if (useDirectFetch) return directFetchHistorical(symbol, days);

    try {
      const period2 = new Date();
      // 2.2x window buffer — see directFetchHistorical for the rationale.
      const period1 = new Date(period2.getTime() - days * 2.2 * 24 * 60 * 60 * 1000);
      const { quotes } = await yahooFinanceClient.chart(toYahooSymbol(symbol), {
        period1,
        period2,
        interval: '1d',
      });

      if (!Array.isArray(quotes) || quotes.length === 0) {
        throw new Error(`No historical data for ${symbol}`);
      }

      const completedCandles = quotes.filter((r) => typeof r.close === 'number' && r.close !== null);
      if (completedCandles.length === 0) {
        throw new Error(`No usable (completed) historical data for ${symbol}`);
      }

      return completedCandles.slice(-days).map((r) => ({
        close: r.close,
        volume: typeof r.volume === 'number' ? r.volume : 0,
      }));
    } catch (err) {
      if (!isCrumbGateFailure(err)) throw err;
      useDirectFetch = true;
      console.log(JSON.stringify({ event: 'real_provider_direct_fetch_enabled', reason: err.message }));
      return directFetchHistorical(symbol, days);
    }
  }

  return { fetchQuote, fetchHistorical };
}

module.exports = { createRealProvider };