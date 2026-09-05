// src/WatchlistRow.jsx
import { Sparkline } from './Sparkline';

function formatPrice(price) {
  if (price === null || price === undefined) return '—';
  return `₹${price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

function SignalBadge({ isMeaningful, direction }) {
  // Signal derived purely from the existing diff.isMeaningful + direction,
  // no new computation client-side.
  if (isMeaningful) {
    const kind = direction === 'up' ? 'signal--up' : direction === 'down' ? 'signal--down' : 'signal--watching';
    const text = direction === 'up' ? 'Strong up' : direction === 'down' ? 'Strong down' : 'Moving';
    return <span className={`signal ${kind}`}>{text}</span>;
  }
  return <span className="signal signal--muted">Normal</span>;
}

export function WatchlistRow({ item, featured, onAck, onRemove, busy }) {
  const { symbol, status, currentPrice, changePct, currentVolume, avgVolume, sparklineCloses, diff } = item;

  if (status === 'no_data_yet') {
    return (
      <tr className="wl-row">
        <td>
          <div className="wl-row__stock">
            <span className="wl-row__symbol">{symbol}</span>
            <span className="wl-row__pending-note">Establishing baseline — first data lands shortly</span>
          </div>
        </td>
        <td>—</td>
        <td>—</td>
        <td>—</td>
        <td><span className="signal signal--watching">Starting</span></td>
        <td>—</td>
        <td>
          <div className="wl-row__actions">
            <button className="wl-row__btn" onClick={() => onRemove(symbol)} disabled={busy} aria-label={`Remove ${symbol}`}>
              Remove
            </button>
          </div>
        </td>
      </tr>
    );
  }

  const isMeaningful = diff?.isMeaningful;
  const direction = diff?.direction;
  const priceClass = direction === 'up' ? 'up' : direction === 'down' ? 'down' : '';

  return (
    <tr className={`wl-row${featured ? ' wl-row--featured' : ''}`}>
      <td>
        <div className="wl-row__stock">
          <span className="wl-row__symbol">{symbol}</span>
          <div className="wl-row__badges">
            {status === 'stale' && <span className="badge badge--stale">Delayed</span>}
            {status === 'market_closed' && <span className="badge badge--closed">Closed</span>}
          </div>
        </div>
      </td>
      <td className={`wl-row__price ${priceClass}`}>{formatPrice(currentPrice)}</td>
      <td>
        <span className={`wl-row__change ${priceClass}`}>{formatPct(changePct)}</span>
      </td>
      <td>
        {currentVolume !== null ? (
          <div className="wl-row__volume">
            <strong>{formatVolume(currentVolume)}</strong>
            <div>vs avg {avgVolume !== null ? formatVolume(avgVolume) : '—'}</div>
          </div>
        ) : (
          <span className="wl-row__volume">—</span>
        )}
      </td>
      <td><SignalBadge isMeaningful={isMeaningful} direction={direction} /></td>
      <td>
        <Sparkline closes={sparklineCloses} />
      </td>
      <td>
        <div className="wl-row__actions">
          {isMeaningful && (
            <button className="wl-row__btn wl-row__btn--ack" onClick={() => onAck(symbol)} disabled={busy}>
              Mark seen
            </button>
          )}
          <button className="wl-row__btn" onClick={() => onRemove(symbol)} disabled={busy} aria-label={`Remove ${symbol}`}>
            Remove
          </button>
        </div>
      </td>
    </tr>
  );
}