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
  addSymbol: (symbol) =>
    request('/watchlist', { method: 'POST', body: JSON.stringify({ symbol }) }),
  removeSymbol: (symbol) =>
    request(`/watchlist/${encodeURIComponent(symbol)}`, { method: 'DELETE' }),
  ackSymbol: (symbol, snapshotToken) =>
    request(`/watchlist/${encodeURIComponent(symbol)}/ack`, {
      method: 'POST',
      body: JSON.stringify({ snapshotToken }),
    }),
  signup: (email, password) =>
    request('/auth/signup', { method: 'POST', body: JSON.stringify({ email, password }) }),
  login: (email, password) =>
    request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => request('/auth/logout', { method: 'POST' }),
};
