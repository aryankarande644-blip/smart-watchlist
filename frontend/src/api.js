// src/api.js
const BASE = import.meta.env.VITE_API_BASE_URL || '';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    credentials: 'include', // required for the session cookie to attach
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });

  if (!res.ok) {
    let body;
    try {
      body = await res.json();
    } catch (_) {
      body = { error: { code: 'unknown', message: res.statusText } };
    }
    const err = new Error(body.error?.message || 'Request failed');
    err.code = body.error?.code;
    err.status = res.status;
    throw err;
  }

  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  getWatchlist: () => request('/watchlist'),
  getIndices: () => request('/indices'),
  getRadar: () => request('/radar'),
  getHealth: () => request('/health'),
  addSymbol: (symbol) =>
    request('/watchlist', { method: 'POST', body: JSON.stringify({ symbol }) }),
  removeSymbol: (symbol) =>
    request(`/watchlist/${encodeURIComponent(symbol)}`, { method: 'DELETE' }),
  ackSymbol: (symbol, snapshotToken) =>
    request(`/watchlist/${encodeURIComponent(symbol)}/ack`, {
      method: 'POST',
      body: JSON.stringify({ snapshotToken }),
    }),
  signup: (email, password, remember) =>
    request('/auth/signup', { method: 'POST', body: JSON.stringify({ email, password, remember }) }),
  login: (email, password, remember) =>
    request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password, remember }) }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  // Google sign-in is a full-page redirect, not an XHR: the browser goes to
  // the backend, bounces to Google consent, and lands back on the callback,
  // which sets the session cookie and redirects into the app.
  get googleAuthUrl() {
    return `${BASE}/auth/google`;
  },
};
