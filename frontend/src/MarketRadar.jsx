// src/MarketRadar.jsx
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { Sparkline } from './Sparkline';

// Market Radar: a public-at-the-market level "what's moving right now"
// section. The backend computes the top 5 movers from a curated universe,
// excluding anything the requesting user already watches, ranked by absolute
// move score vs each symbol's own recent baseline. Each card carries the
// badge + one-line "why" the backend derived, plus the same cached
// last-7-days sparkline used by the watchlist table.
//
// Fetch is stateless and cheap (reads the poller-cached snapshot/baseline
// tables); it rides the same poll interval as the watchlist, pausing when
// the tab is backgrounded.
const RADAR_POLL_MS = Number(import.meta.env.VITE_POLL_INTERVAL_MS) || 20000;

function formatPrice(price) {
  if (price === null || price === undefined) return '—';
  return `₹${price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function formatPct(changePct) {
  if (changePct === null || changePct === undefined) return '—';
  return `${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%`;
}

function formatVolume(volume) {
  if (volume === null || volume === undefined) return '—';
  if (volume >= 1e7) return `${(volume / 1e7).toFixed(1)} Cr`;
  if (volume >= 1e5) return `${(volume / 1e5).toFixed(1)} L`;
  return volume.toLocaleString('en-IN');
}

function badgeClass(label) {
  switch (label) {
    case 'Volume Spike': return 'radar__badge radar__badge--spike';
    case 'Strong Move': return 'radar__badge radar__badge--up';
    case 'High Volatility': return 'radar__badge radar__badge--down';
    case 'Near Breakout': return 'radar__badge radar__badge--breakout';
    default: return 'radar__badge';
  }
}

export function MarketRadar({ onAdd }) {
  const [items, setItems] = useState(null); // null = loading
  const [busySymbol, setBusySymbol] = useState(null);
  const [expanded, setExpanded] = useState(true); // sidebar panel starts open
  const timer = useRef(null);

  const refresh = async () => {
    try {
      const data = await api.getRadar();
      setItems(data.items || []);
    } catch (_) {
      // Keep last-known cards rather than wiping on transient errors. A 401
      // is handled upstream by the app-level auth flip.
    }
  };

  useEffect(() => {
    refresh();

    function schedule() {
      timer.current = setInterval(refresh, RADAR_POLL_MS);
    }
    function clear() {
      if (timer.current) clearInterval(timer.current);
    }
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
  }, []);

  async function handleAdd(symbol) {
    setBusySymbol(symbol);
    try {
      await onAdd(symbol);
      // The symbol is now on the watchlist — drop it from the radar
      // immediately rather than waiting for the next poll.
      await refresh();
    } finally {
      setBusySymbol(null);
    }
  }

  // Always render the section with a heading so the "Market Radar" UI is
  // discoverable. When no movers are currently flagged (market quiet, no
  // data, or after hours), show a clear empty-state message instead of
  // disappearing entirely — mirroring the watchlist's empty behavior.
  const empty = items !== null && items.length === 0;
  const loading = items === null;

  return (
    <section className="radar" aria-label="Market Radar">
      <button
        type="button"
        className="radar__head"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
      >
        <span className={`radar__chevron${expanded ? ' radar__chevron--open' : ''}`} aria-hidden="true" />
        <span className="radar__title">Market Radar</span>
        <span className="radar__live"><span className="radar__dot" /> Live</span>
      </button>
      {expanded && (
        <>
          {empty && (
            <div className="state state--empty">
              <p>No unusual movement right now.</p>
              <p className="state__hint">
                Check back after market hours or Monday's open for the latest movers.
              </p>
            </div>
          )}
          {loading && <div className="state state--loading">Gathering radar…</div>}
          <div className="radar__grid">
        {(items === null ? [] : items).map((item, i) => {
          const direction = item.changePct > 0 ? 'up' : item.changePct < 0 ? 'down' : '';
          const why = item.badge?.why;
          return (
            <article key={item.symbol} className="radar__card">
              <div className="radar__card-head">
                <span className="radar__rank">{i + 1}</span>
                <div className="radar__stock">
                  <span className="radar__symbol">{item.symbol}</span>
                  <span className="radar__exchange">NSE</span>
                </div>
                {item.badge && <span className={badgeClass(item.badge.label)}>{item.badge.label}</span>}
              </div>
              <div className="radar__price-row">
                <span className={`radar__price ${direction}`}>{formatPrice(item.currentPrice)}</span>
                <span className={`radar__change ${direction}`}>{formatPct(item.changePct)}</span>
              </div>
              <div className="radar__meta">
                {item.currentVolume !== null
                  ? `Vol ${formatVolume(item.currentVolume)} vs avg ${item.avgVolume !== null ? formatVolume(item.avgVolume) : '—'}`
                  : 'Vol —'}
              </div>
              {why && <div className="radar__why">{why}</div>}
              <div className="radar__spark">
                <Sparkline closes={item.sparklineCloses} />
              </div>
              <button
                type="button"
                className="radar__add"
                onClick={() => handleAdd(item.symbol)}
                disabled={busySymbol === item.symbol}
              >
                {busySymbol === item.symbol ? 'Adding…' : '+ Add to watchlist'}
              </button>
            </article>
          );
        })}
          </div>
        </>
      )}
    </section>
  );
}