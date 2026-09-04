// src/App.jsx
import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from './api';
import { WatchlistRow } from './WatchlistRow';
import { AddSymbolForm } from './AddSymbolForm';

// Configurable via VITE_POLL_INTERVAL_MS (ms); default 20s. Env-driven so
// the interval can be tuned without a code change.
const POLL_INTERVAL_MS = Number(import.meta.env.VITE_POLL_INTERVAL_MS) || 20000;

export function App() {
  const [items, setItems] = useState(null); // null = not loaded yet
  const [connectionError, setConnectionError] = useState(false);
  const [busySymbol, setBusySymbol] = useState(null);
  const pollTimer = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.getWatchlist();
      setItems(data.items);
      setConnectionError(false);
    } catch (err) {
      // Distinct from a stale DATA badge — this means we can't reach the
      // backend at all, a different failure layer entirely.
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
  }, [refresh]);

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

  return (
    <div className="page">
      <header className="masthead">
        <h1>Watchlist</h1>
        <p className="masthead__disclaimer">
          Data for demo purposes, may be delayed — not for financial decisions.
        </p>
      </header>

      {connectionError && (
        <div className="banner banner--error">Can't reach the server. Retrying…</div>
      )}

      <main>
        {items === null && !connectionError && (
          <div className="state state--loading">Loading your watchlist…</div>
        )}

        {items !== null && items.length === 0 && (
          <div className="state state--empty">
            <p>Nothing here yet.</p>
            <p className="state__hint">Add a stock below to start tracking what changes.</p>
          </div>
        )}

        {items !== null && items.length > 0 && (
          <div className="ledger">
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
          </div>
        )}
      </main>

      <AddSymbolForm onAdd={handleAdd} />
    </div>
  );
}
