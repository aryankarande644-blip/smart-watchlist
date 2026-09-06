// src/Logo.jsx
//
// TRADEYE brand lockup, hand-drawn in SVG (no raster/photo asset):
//
//   - An almond "eye" outline with a soft iris wash behind it.
//   - Inside the eye, a small RISING candlestick-chart silhouette (three teal
//     candles + a faint trend line over their wick tops) — the "extra eye on
//     the market" idea rendered as a mark.
//   - The TRADEYE wordmark beside/under it, with "EYE" tinted in the brand
//     teal (the color-split effect).
//
// tone='dark'  -> for dark backgrounds (login hero): near-white outline, bright
//                 teal candles, bright-teal "EYE". The splash where brand is.
// tone='light' -> for light backgrounds (sidebar, cards): near-black outline,
//                 deep-teal candles, deep-teal "EYE".
//
// Colors come from CSS custom properties set on the wrapper (see App.css), so
// the SVG itself carries no hardcoded hexes.

function EyeMark({ size = 46 }) {
  return (
    <svg
      className="eye-mark"
      viewBox="0 0 48 48"
      width={size}
      height={size}
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="24" cy="24" r="12" className="eye-mark__iris" />
      <path
        className="eye-mark__almond"
        d="M24 6 C 33 6 43 13 45 24 C 43 35 33 42 24 42 C 15 42 5 35 3 24 C 5 13 15 6 24 6 Z"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <g className="eye-mark__candles">
        <line className="eye-mark__wick" x1="16" y1="22" x2="16" y2="33" strokeWidth="1.6" strokeLinecap="round" />
        <rect className="eye-mark__body" x="14" y="25" width="4" height="7" rx="0.8" />
        <line className="eye-mark__wick" x1="24" y1="14" x2="24" y2="30" strokeWidth="1.6" strokeLinecap="round" />
        <rect className="eye-mark__body" x="22" y="17" width="4" height="9" rx="0.8" />
        <line className="eye-mark__wick" x1="32" y1="11" x2="32" y2="25" strokeWidth="1.6" strokeLinecap="round" />
        <rect className="eye-mark__body" x="30" y="13" width="4" height="8" rx="0.8" />
        <polyline className="eye-mark__trend" points="16,22 24,14 32,11" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  );
}

export function Logo({ tone = 'dark', tagline = false, compact = false }) {
  return (
    <div className={`logo logo--${tone}${compact ? ' logo--compact' : ''}`}>
      <EyeMark size={compact ? 34 : 48} />
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