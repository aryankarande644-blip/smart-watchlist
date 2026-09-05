// src/TickerStrip.jsx
import { useEffect, useRef, useState } from 'react';
import { api } from './api';

// Top ticker strip: NIFTY 50 and SENSEX live values. The poller caches
// these server-side; the frontend just reads the cached endpoint on the
// same interval as the watchlist, pausing when the tab is backgrounded.
const TICKER_POLL_MS = Number(import.meta.env.VITE_POLL_INTERVAL_MS) || 20000;

// Fallback so the strip is never blank even if /indices comes back empty
// (e.g. the poller hasn't seeded rows yet). The server normally returns
// both canonical indices with price:null + marketClosed once the market
// closes; this only guards the very first bootstrap before any cycle.
const DEFAULT_INDICES = [
  { symbol: 'NIFTY', label: 'NIFTY 50', price: null, marketClosed: true, isStale: false },
  { symbol: 'SENSEX', label: 'SENSEX', price: null, marketClosed: true, isStale: false },
];

function formatTickerPrice(price) {
  if (price === null || price === undefined) return '—';
  return `₹${price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

export function TickerStrip() {
  const [indices, setIndices] = useState(null);
  const timer = useRef(null);

  const refresh = async () => {
    try {
      const data = await api.getIndices();
      setIndices(data.indices);
    } catch (_) {
      // Keep the last-known values rather than wiping on transient errors.
    }
  };

  useEffect(() => {
    refresh();

    function schedule() {
      timer.current = setInterval(refresh, TICKER_POLL_MS);
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

  return (
    <nav className="ticker" aria-label="Market indices">
      <div className="ticker__inner">
        {!indices && <span className="ticker__empty">Loading indices…</span>}
        {(indices && indices.length > 0 ? indices : DEFAULT_INDICES).map((idx) => (
          <div key={idx.symbol} className="ticker__item">
            <span className="ticker__label">{idx.label}</span>
            <span className="ticker__price">{formatTickerPrice(idx.price)}</span>
            {idx.marketClosed && <span className="ticker__meta">Closed</span>}
            {idx.isStale && !idx.marketClosed && <span className="ticker__meta">Delayed</span>}
          </div>
        ))}
      </div>
    </nav>
  );
}