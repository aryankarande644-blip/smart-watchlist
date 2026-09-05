// src/Sparkline.jsx
// Tiny inline SVG sparkline for the "Last 7 Days" column. Takes the
// bounded sparklineCloses array (<=7 values) captured at baseline compute
// time — no provider refetch on the client.

function pointsFor(closes, width, height, pad) {
  if (!Array.isArray(closes) || closes.length < 2) return [];
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const n = closes.length;
  return closes.map((value, i) => {
    const x = pad + (i / (n - 1)) * (width - pad * 2);
    const y = pad + (1 - (value - min) / span) * (height - pad * 2);
    return { x, y };
  });
}

export function Sparkline({ closes, width = 76, height = 24, color }) {
  const pad = 2;
  const points = pointsFor(closes, width, height, pad);

  if (points.length < 2) {
    return <span className="sparkline__empty">—</span>;
  }

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
  const last = points[points.length - 1];
  const stroke = color || 'var(--muted)';

  return (
    <svg className="sparkline" width={width} height={height} role="img" aria-label="Last 7 days price trend">
      <path className="sparkline__line" d={line} style={{ stroke }} />
      <circle className="sparkline__dot" r="2" cx={last.x} cy={last.y} style={{ fill: stroke }} />
    </svg>
  );
}