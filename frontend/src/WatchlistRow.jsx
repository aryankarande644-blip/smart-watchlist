// src/WatchlistRow.jsx

function formatPrice(price) {
  if (price === null || price === undefined) return '—';
  return `₹${price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatPct(finalScore, direction) {
  // finalScore is in units of "multiples of baseline volatility," not a raw
  // percent — displaying the raw normalizedMove-derived percent needs the
  // actual price delta, which we don't reconstruct client-side; instead we
  // show the score's magnitude as a plain, honest "x baseline" figure.
  if (finalScore === null || finalScore === undefined) return null;
  const arrow = direction === 'up' ? '▲' : direction === 'down' ? '▼' : '';
  return `${arrow} ${Math.abs(finalScore).toFixed(2)}× typical move`;
}

export function WatchlistRow({ item, featured, onAck, onRemove, busy }) {
  const { symbol, status, currentPrice, diff } = item;

  if (status === 'no_data_yet') {
    return (
      <div className="row row--pending">
        <div className="row__main">
          <span className="row__symbol">{symbol}</span>
          <span className="row__note">Establishing baseline — first data lands shortly</span>
        </div>
        <button className="row__remove" onClick={() => onRemove(symbol)} disabled={busy} aria-label={`Remove ${symbol}`}>
          Remove
        </button>
      </div>
    );
  }

  const isMeaningful = diff?.isMeaningful;
  const direction = diff?.direction;
  const priceClass = direction === 'up' ? 'up' : direction === 'down' ? 'down' : '';

  return (
    <div className={`row ${featured ? 'row--featured' : ''} ${isMeaningful ? 'row--meaningful' : ''}`}>
      <div className="row__main">
        <div className="row__symbol-line">
          <span className="row__symbol">{symbol}</span>
          {status === 'stale' && <span className="badge badge--stale">Data delayed</span>}
          {status === 'market_closed' && <span className="badge badge--closed">Market closed</span>}
        </div>
        {diff && diff.reason === 'ok' && (
          <span className={`row__change ${priceClass}`}>{formatPct(diff.finalScore, direction)}</span>
        )}
      </div>
      <div className="row__price-block">
        <span className={`row__price ${priceClass}`}>{formatPrice(currentPrice)}</span>
      </div>
      <div className="row__actions">
        {isMeaningful && (
          <button className="row__ack" onClick={() => onAck(symbol)} disabled={busy}>
            Mark seen
          </button>
        )}
        <button className="row__remove" onClick={() => onRemove(symbol)} disabled={busy} aria-label={`Remove ${symbol}`}>
          Remove
        </button>
      </div>
    </div>
  );
}
