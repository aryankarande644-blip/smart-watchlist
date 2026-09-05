// src/App.jsx
import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from './api';
import { WatchlistRow } from './WatchlistRow';
import { AddSymbolForm } from './AddSymbolForm';
import { AuthPage } from './AuthPage';
import { TickerStrip } from './TickerStrip';
import { MarketRadar } from './MarketRadar';

// Configurable via VITE_POLL_INTERVAL_MS (ms); default 20s. Env-driven so
// the interval can be tuned without a code change.
const POLL_INTERVAL_MS = Number(import.meta.env.VITE_POLL_INTERVAL_MS) || 20000;

export function App() {
  // authed: null = checking (first load), true = signed in, false = the
  // server rejected our session (or we logged out) -> show the auth page.
  const [authed, setAuthed] = useState(null);
  const [items, setItems] = useState(null); // null = not loaded yet
  const [connectionError, setConnectionError] = useState(false);
  const [busySymbol, setBusySymbol] = useState(null);
  const pollTimer = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.getWatchlist();
      setItems(data.items);
      setConnectionError(false);
      setAuthed(true);
    } catch (err) {
      // A rejected session (401) flips us to the auth page; anything else
      // is a connectivity problem, distinct from a stale DATA badge.
      if (err.status === 401) {
        setItems(null);
        setAuthed(false);
        return;
      }
      setConnectionError(true);
    }
  }, []);

  useEffect(() => {
    refresh();

    function schedule() {
      pollTimer.current = setInterval(refresh, POLL_INTERVAL_MS);
    }
    function clear() {
      if (pollTimer.current) clearInterval(pollTimer.current);
    }

    // Only poll while signed in — there's nothing to fetch on the auth page.
    if (authed !== true) {
      clear();
      return () => clear();
    }
    // Pause polling when the tab is backgrounded — don't burn API quota
    // or battery for a tab nobody is looking at.
    function handleVisibility() {
      if (document.hidden) {
        clear();
      } else {
        refresh();
        schedule();
      }
    }

    schedule();
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      clear();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [refresh, authed]);

  async function handleAuthenticated() {
    await refresh();
  }

  async function handleLogout() {
    try {
      await api.logout(); // clears the cookie server-side too (session revoked)
    } finally {
      setItems(null);
      setConnectionError(false);
      setAuthed(false);
    }
  }

  async function handleAdd(symbol) {
    await api.addSymbol(symbol);
    await refresh();
  }

  async function handleRemove(symbol) {
    setBusySymbol(symbol);
    try {
      await api.removeSymbol(symbol);
      await refresh();
    } finally {
      setBusySymbol(null);
    }
  }

  async function handleAck(symbol) {
    const item = items.find((i) => i.symbol === symbol);
    if (!item) return;
    setBusySymbol(symbol);
    try {
      await api.ackSymbol(symbol, item.snapshotToken);
      await refresh();
    } finally {
      setBusySymbol(null);
    }
  }

  if (authed === false) {
    return (
      <div className="app">
        <TickerStrip />
        <AuthPage onAuthenticated={handleAuthenticated} />
      </div>
    );
  }

  return (
    <div className="app">
      <TickerStrip />
      <div className="page">
        <header className="masthead">
          <div className="masthead__row">
            <h1>Watchlist</h1>
            <button type="button" className="masthead__logout" onClick={handleLogout}>
              Log out
            </button>
          </div>
          <p className="masthead__disclaimer">
            Data for demo purposes, may be delayed — not for financial decisions.
          </p>
        </header>

        {connectionError && (
          <div className="banner banner--error">Can't reach the server. Retrying…</div>
        )}

        <div className="layout">
          <aside className="sidebar">
            <MarketRadar onAdd={handleAdd} />
          </aside>

          <main>
            {authed === null && items === null && !connectionError && (
              <div className="state state--loading">Loading your watchlist…</div>
            )}

            {items !== null && items.length === 0 && (
              <div className="state state--empty">
                <p>Nothing here yet.</p>
                <p className="state__hint">Add a stock below to start tracking what changes.</p>
              </div>
            )}

            {items !== null && items.length > 0 && (
              <table className="wl-table">
                <thead>
                  <tr>
                    <th>Stock</th>
                    <th>Price</th>
                    <th>Change</th>
                    <th>Volume vs Avg</th>
                    <th>Signal</th>
                    <th>Last 7 Days</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, i) => (
                    <WatchlistRow
                      key={item.symbol}
                      item={item}
                      featured={i === 0 && item.diff?.isMeaningful}
                      onAck={handleAck}
                      onRemove={handleRemove}
                      busy={busySymbol === item.symbol}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </main>
        </div>

        <AddSymbolForm onAdd={handleAdd} />
      </div>
    </div>
  );
}