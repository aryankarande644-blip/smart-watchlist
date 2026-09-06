// src/Logo.jsx
//
// TRADEYE brand lockup, hand-drawn in SVG (no raster/photo asset).
//
// The mark (looks like a small circular icon in the sidebar; a large 150px
// almond in the login hero) is a stylized EYE drawn as market-chart elements:
//
//   - An almond/eye silhouette with pointed corners, filled with a subtle
//     two-tone gradient (darker top-left -> brighter bottom-right) so it has
//     dimension without a photorealistic render.
//   - A darker iris/lens inside, behind a RISING CANDLESTICK CHART: six bars
//     of varying height, an alternating mix of solid (filled teal) and hollow
//     (outline) candles, each climbing higher as the eye scans left to right,
//     with a thin trend line riding their wick-tops.
//   - A thin orbit ring/ellipse arcing around the eye at a slight tilt,
//     extending just past the almond's corners, with a small solid dot at one
//     end of the arc.
//
// The lockup keeps the color-split wordmark: "TRADE" + teal "EYE", and the
// optional tagline underneath. tone='dark' is for dark backgrounds (login
// hero), tone='light' for light ones (sidebar). Colors come from CSS custom
// properties so the SVG carries no hardcoded hexes.
//
// Hero composition: <Logo tone="dark" tagline stack /> renders the mark on
// top with the wordmark + tagline centered beneath it, exactly as the login
// hero uses it. The sidebar uses <Logo tone="light" compact /> (mark left,
// wordmark right).

function EyeMark({ size = 48 }) {
  return (
    <svg
      className="eye-mark"
      viewBox="0 0 260 170"
      width={size}
      height={(size * 170) / 260}
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="tradEyeAlmond" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" style={{ stopColor: 'var(--logo-almond-dark)' }} />
          <stop offset="100%" style={{ stopColor: 'var(--logo-almond-bright)' }} />
        </linearGradient>
      </defs>

      {/* orbit ring, tilted, breathing just past the almond's corners */}
      <ellipse
        className="eye-mark__orbit"
        cx="130"
        cy="86"
        rx="122"
        ry="72"
        transform="rotate(-12 130 86)"
      />
      <circle className="eye-mark__orbit-dot" cx="249" cy="61" r="4" />

      {/* the eye silhouette, two-tone gradient fill */}
      <path
        className="eye-mark__almond"
        d="M28 85 C 55 40 95 28 130 30 C 165 28 205 40 232 85 C 205 130 165 142 130 140 C 95 142 55 130 28 85 Z"
      />

      {/* the iris bed the candles sit on */}
      <ellipse className="eye-mark__iris" cx="130" cy="85" rx="78" ry="46" />

      {/* rising candlestick chart: hollow (outline) and solid candles climb L->R */}
      <g className="eye-mark__candles">
        <line className="eye-mark__wick" x1="68" y1="60" x2="68" y2="112" />
        <rect className="eye-mark__body eye-mark__body--hollow" x="63" y="98" width="10" height="14" rx="1.5" />

        <line className="eye-mark__wick" x1="92" y1="52" x2="92" y2="112" />
        <rect className="eye-mark__body" x="87" y="84" width="10" height="24" rx="1.5" />

        <line className="eye-mark__wick" x1="116" y1="44" x2="116" y2="106" />
        <rect className="eye-mark__body eye-mark__body--hollow" x="111" y="72" width="10" height="24" rx="1.5" />

        <line className="eye-mark__wick" x1="140" y1="38" x2="140" y2="100" />
        <rect className="eye-mark__body" x="135" y="58" width="10" height="24" rx="1.5" />

        <line className="eye-mark__wick" x1="164" y1="32" x2="164" y2="92" />
        <rect className="eye-mark__body eye-mark__body--hollow" x="159" y="48" width="10" height="20" rx="1.5" />

        <line className="eye-mark__wick" x1="188" y1="24" x2="188" y2="84" />
        <rect className="eye-mark__body" x="183" y="40" width="10" height="20" rx="1.5" />

        <polyline className="eye-mark__trend" points="70,58 94,50 118,42 142,36 166,30 188,22" />
      </g>
    </svg>
  );
}

export function Logo({ tone = 'dark', tagline = false, compact = false, stack = false, markSize }) {
  const size = markSize || (compact ? 40 : stack ? 150 : 48);
  return (
    <div className={`logo logo--${tone}${compact ? ' logo--compact' : ''}${stack ? ' logo--stack' : ''}`}>
      <EyeMark size={size} />
      <div className="logo__text">
        <div className="logo__word">
          TRADE<span className="logo__eye">EYE</span>
        </div>
        {tagline && <p className="logo__tag">An extra eye on the market.</p>}
      </div>
    </div>
  );
}

export const LogoMark = EyeMark;