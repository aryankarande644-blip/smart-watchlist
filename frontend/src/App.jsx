// src/App.jsx
import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from './api';
import { WatchlistRow } from './WatchlistRow';
import { AddSymbolForm } from './AddSymbolForm';
import { AuthPage } from './AuthPage';
import { TickerStrip } from './TickerStrip';
import { MarketRadar } from './MarketRadar';
import { Logo } from './Logo';

// Configurable via VITE_POLL_INTERVAL_MS (ms); default 20s. Env-driven so
// the interval can be tuned without a code change.
const POLL_INTERVAL_MS = Number(import.meta.env.VITE_POLL_INTERVAL_MS) || 20000;

// Avatar initial: first letter of the local part, uppercased
// ("a@example.com" -> "A"). Falls back to "?" if we somehow lack an email.
function initialsFor(email) {
  if (!email) return '?';
  const local = String(email).split('@')[0].trim();
  return (local[0] || '?').toUpperCase();
}

function IconWatchlist() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <circle cx="3.5" cy="6" r="1" fill="currentColor" stroke="none" />
      <circle cx="3.5" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="3.5" cy="18" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconRadar() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 12 L17.5 6.5" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function App() {
  // authed: null = checking (first load), true = signed in, false = the
  // server rejected our session (or we logged out) -> show the auth page.
  const [authed, setAuthed] = useState(null);
  const [items, setItems] = useState(null); // null = not loaded yet
  const [connectionError, setConnectionError] = useState(false);
  const [busySymbol, setBusySymbol] = useState(null);
  const [activeView, setActiveView] = useState('watchlist'); // 'watchlist' | 'radar'
  const [userEmail, setUserEmail] = useState(null);
  const pollTimer = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.getWatchlist();
      setItems(data.items);
      if (data.user?.email) setUserEmail(data.user.email);
      setConnectionError(false);
      setAuthed(true);
    } catch (err) {
      // A rejected session (401) flips us to the auth page; anything else
      // is a connectivity problem, distinct from a stale DATA badge.
      if (err.status === 401) {
        setItems(null);
        setUserEmail(null);
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

  async function handleAuthenticated(email) {
    if (email) setUserEmail(email);
    setActiveView('watchlist'); // fresh login always starts on the Watchlist view
    await refresh();
  }

  async function handleLogout() {
    try {
      await api.logout(); // clears the cookie server-side too (session revoked)
    } finally {
      setItems(null);
      setUserEmail(null);
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
      <div className="app app--auth">
        <TickerStrip variant="dark" />
        <AuthPage onAuthenticated={handleAuthenticated} />
      </div>
    );
  }

  const initials = initialsFor(userEmail);

  return (
    <div className="app">
      <TickerStrip />
      <div className="shell">
        <nav className="side-nav" aria-label="Primary">
          <div className="side-nav__brand">
            <Logo tone="light" compact />
          </div>
          <ul className="side-nav__list">
            <li>
              <button
                type="button"
                className={`side-nav__item${activeView === 'watchlist' ? ' side-nav__item--active' : ''}`}
                aria-current={activeView === 'watchlist' ? 'page' : undefined}
                onClick={() => setActiveView('watchlist')}
              >
                <IconWatchlist />
                <span>Watchlist</span>
              </button>
            </li>
            <li>
              <button
                type="button"
                className={`side-nav__item${activeView === 'radar' ? ' side-nav__item--active' : ''}`}
                aria-current={activeView === 'radar' ? 'page' : undefined}
                onClick={() => setActiveView('radar')}
              >
                <IconRadar />
                <span>Market Radar</span>
              </button>
            </li>
          </ul>
          <p className="side-nav__tag">An extra eye on the market.</p>
        </nav>

        <div className="content">
          <header className="masthead">
            <div className="masthead__row">
              <h1>{activeView === 'watchlist' ? 'Watchlist' : 'Market Radar'}</h1>
              <div className="masthead__actions">
                <span className="avatar" title={userEmail || undefined}>{initials}</span>
                <button type="button" className="masthead__logout" onClick={handleLogout}>
                  Log out
                </button>
              </div>
            </div>
            <p className="masthead__disclaimer">
              Data for demo purposes, may be delayed — not for financial decisions.
            </p>
          </header>

          {connectionError && (
            <div className="banner banner--error">Can't reach the server. Retrying…</div>
          )}

          {activeView === 'watchlist' ? (
            <main className="view">
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
                <div className="wl-scroll">
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
                </div>
              )}
            </main>
          ) : (
            <main className="view">
              <MarketRadar onAdd={handleAdd} />
            </main>
          )}

          {activeView === 'watchlist' && <AddSymbolForm onAdd={handleAdd} />}
        </div>
      </div>
    </div>
  );
}