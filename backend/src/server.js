// src/server.js
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');

const { sessionMiddleware } = require('./routes/session');
const { createAuthRouter } = require('./routes/auth');
const { createGoogleOAuth } = require('./auth/googleOAuth');
const createWatchlistRouter = require('./routes/watchlist');
const { createRadarRouter } = require('./routes/radar');
const { createHealthRouter } = require('./routes/health');
const { createIndicesRouter } = require('./routes/indices');
const { createMarketDataClient } = require('./marketData/client');
const { createPoller } = require('./poller/poller');
const { createBaselineRefresher } = require('./baseline/refreshBaselines');
const { recordRouteError } = require('./diagnostics');
const pool = require('./db/pool');

const PORT = process.env.PORT || 3001;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 30000;
const BASELINE_REFRESH_TIME_IST = process.env.BASELINE_REFRESH_TIME_IST || '18:30';

// Google OAuth client built from env — null (=> the /auth/google routes answer
// with a clear "not configured" redirect) until GOOGLE_CLIENT_ID and
// GOOGLE_CLIENT_SECRET are set on the host. GOOGLE_REDIRECT_URI must be the
// EXACT URI registered in Google Cloud Console for the deployed environment:
//   https://watchlist-backend-mt3i.onrender.com/auth/google/callback  (prod)
//   http://localhost:3001/auth/google/callback                        (dev)
function createGoogleOAuthFromEnv() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/auth/google/callback';
  return createGoogleOAuth({ clientId, clientSecret, redirectUri });
}

// CSRF defense-in-depth: sameSite:strict already stops the session cookie
// from riding along on cross-site requests, but a mismatched Origin on a
// state-changing request is cheap extra hardening (defense against any
// future cookie relaxation, proxy misconfig, or browser quirk). Requests
// with NO Origin header (same-origin fetches, curl, health pings) pass —
// a cross-site browser request always carries Origin.
function originCheck(allowed) {
  return (req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && origin !== allowed) {
        return res.status(403).json({ error: { code: 'cross_origin_forbidden', message: 'origin not allowed' } });
      }
    }
    next();
  };
}

function createApp({ marketDataClient, poller, authOptions = {} }) {
  const app = express();

  app.use(cors({ origin: FRONTEND_ORIGIN, credentials: true })); // credentials:true required for the cookie session to attach
  app.use(originCheck(FRONTEND_ORIGIN));
  app.use(express.json());
  app.use(cookieParser());

  app.use(createHealthRouter({ poller, marketDataClient }));
  app.use(createIndicesRouter()); // public, like /health — ticker strip
  app.use(sessionMiddleware);

  app.use('/auth', createAuthRouter({
    loginRateLimit: authOptions.loginRateLimit,
    // Injectable for tests; production builds the client from env vars below.
    google: authOptions.google || createGoogleOAuthFromEnv(),
    stateStore: authOptions.stateStore,
    appOrigin: authOptions.appOrigin || FRONTEND_ORIGIN,
  }));
  app.use(createWatchlistRouter({ marketDataClient }));
  app.use(createRadarRouter());

  // Central error handler — every route's `next(err)` lands here.
  app.use((err, req, res, next) => {
    const route = `${req.method} ${req.originalUrl || req.url}`;
    const full = { event: 'unhandled_route_error', route, name: err && err.name, message: err && err.message ? String(err.message) : String(err), code: err && err.code, stack: err && err.stack };
    console.error(JSON.stringify(full));
    recordRouteError(err, req);
    res.status(500).json({ error: { code: 'internal_error', message: 'something went wrong' } });
  });

  return app;
}

function start(realMarketDataProvider, opts = {}) {
  const marketDataClient = createMarketDataClient(realMarketDataProvider);
  const poller = createPoller({
    marketDataClient,
    intervalMs: opts.pollIntervalMs ?? POLL_INTERVAL_MS,
    isMarketOpenFn: opts.forceMarketOpen ? () => true : undefined,
  });
  // Daily baseline recomputation fires off-market (18:30 IST default).
  const baselineRefresher = createBaselineRefresher({
    marketDataClient,
    timeIST: opts.baselineRefreshTimeIST ?? BASELINE_REFRESH_TIME_IST,
  });
  const app = createApp({ marketDataClient, poller });

  const server = app.listen(PORT, () => {
    console.log(JSON.stringify({ event: 'server_started', port: PORT }));
    poller.start();
    baselineRefresher.start();
  });

  // Graceful shutdown: stop accepting new poll cycles, let in-flight work
  // finish, close the DB pool, then exit. Prevents a redeploy from landing
  // mid-write.
  async function shutdown(signal) {
    console.log(JSON.stringify({ event: 'shutdown_initiated', signal }));
    poller.stop();
    baselineRefresher.stop();
    server.close(async () => {
      await pool.end();
      console.log(JSON.stringify({ event: 'shutdown_complete' }));
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return { app, server, poller, marketDataClient, baselineRefresher };
}

module.exports = { createApp, start };

// Only actually start listening when run directly (not when required by tests).
if (require.main === module) {
  // Provider selection: MARKET_DATA_PROVIDER=demo|real (default: real, which
  // fails loudly until wired — a silent fallback to fake data in production
  // would be dishonest; demo mode must be an explicit, visible choice).
  const providerMode = process.env.MARKET_DATA_PROVIDER || 'real';

  let provider;
  if (providerMode === 'demo') {
    provider = require('./marketData/demoProvider');
    console.log(JSON.stringify({ event: 'market_data_provider', mode: 'demo', note: 'simulated prices, not live market data' }));
  } else {
    const { createRealProvider } = require('./marketData/realProvider');
    provider = createRealProvider();
    console.log(JSON.stringify({ event: 'market_data_provider', mode: 'real', note: 'yahoo-finance2, .NS suffix (NSE)' }));
  }
  start(provider, { forceMarketOpen: providerMode === 'demo' });
}
