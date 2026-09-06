// src/AuthPage.jsx
//
// TRADEYE brand login/signup (2026-09-06). Rendered whenever a /watchlist
// request comes back 401 — the server stopped trusting whatever cookie we had.
//
// The composition comes from login-page-design.zip (v0.app export) tuned to
// the app's FLOATING-CARD layout (like the pre-v0 photo hero, not the v0
// two-column split the zip shipped):
//
//   - The DARK hero stage spans the FULL page width: the eye mark + TRADEYE
//     wordmark + tagline float mid-left, and the emerald "market mountain"
//     artwork rises from the bottom edge, clipped at the stage's bounds.
//   - The light LOGIN CARD floats ON TOP, positioned center-right, so dark
//     hero is visible around the card's top, bottom, and right edges. The
//     card sits on a soft multi-layer shadow.
//   - The card color-INVERTS on hover (light -> near-black green, text dark
//     -> light green) via CSS custom properties with a 250ms ease fade. It is
//     purely visual — no layout, size, or behavior changes.
//
// The card keeps every working auth feature: Sign in / Sign up mode toggle,
// email, password with show/hide, "Remember me" (real: 90-day cookie vs.
// browser-close), "Forgot password?" (placeholder pending email provider —
// NOT wired), primary arrow button, "OR CONTINUE WITH" divider + the Google
// sign-in button (full redirect flow through /auth/google), and the client
// side structured logging on failures.
import { useEffect, useState } from 'react';
import { api } from './api';

const MODE = { login: 'login', signup: 'signup' };

// Map server error codes (and OAuth redirect error codes from ?auth_error=...)
// to human-readable copy.
const MESSAGES = {
  invalid_credentials: 'Invalid email or password.',
  invalid_email: "That email address doesn't look right.",
  password_too_short: 'Password must be at least 8 characters.',
  email_taken: 'An account with that email already exists.',
  rate_limited: 'Too many login attempts. Try again in a few minutes.',
  google_email_unverified: "Google hasn't verified that email — sign in with your email and password, or a different Google account.",
  google_denied: 'Google sign-in was cancelled. Try again, or sign in below.',
  google_state_mismatch: 'Google sign-in expired. Please try again.',
  google_callback_error: 'Google sign-in failed. Please try again.',
  provider_not_configured: 'Google sign-in isn\u2019t set up yet \u2014 sign in with your email and password instead.',
};

// The TRADEYE "eye" mark — straight from login-page-design.zip app/page.tsx.
function EyeMark() {
  return (
    <svg className="eye-mark" viewBox="0 0 220 112" role="img" aria-label="TradeEye mark">
      <defs>
        <linearGradient id="eye-dark" x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#010d12" />
          <stop offset=".38" stopColor="#062a2d" />
          <stop offset=".7" stopColor="#007765" />
          <stop offset="1" stopColor="#10d3a0" />
        </linearGradient>
        <linearGradient id="eye-light" x1="0" y1="1" x2="1" y2="0">
          <stop stopColor="#003e3e" />
          <stop offset=".35" stopColor="#08a888" />
          <stop offset=".7" stopColor="#efffff" />
          <stop offset="1" stopColor="#ffffff" />
        </linearGradient>
        <radialGradient id="eye-pupil" cx="35%" cy="30%">
          <stop stopColor="#13d9aa" />
          <stop offset=".5" stopColor="#00695d" />
          <stop offset="1" stopColor="#001c24" />
        </radialGradient>
        <filter id="eye-shadow"><feDropShadow dx="0" dy="7" stdDeviation="4" floodColor="#00191d" floodOpacity=".42" /></filter>
      </defs>
      <g filter="url(#eye-shadow)">
        <path d="M18 57c37-44 74-58 111-42 18 8 31 21 55 29-31 1-49-7-69-16-25-11-52-7-97 29Z" fill="url(#eye-dark)" />
        <path d="M18 57c31 6 49 20 71 29 27 11 54 3 95-32-37 13-55 5-76-5-26-13-49-8-90 8Z" fill="url(#eye-light)" />
        <circle cx="105" cy="57" r="29" fill="url(#eye-pupil)" stroke="#d8fffa" strokeWidth="3" />
      </g>
      <g stroke="#2ef2c3" strokeWidth="3">
        <path d="M90 69V51M98 75V42M106 67V31M114 70V44M122 61V36" />
      </g>
      <g stroke="#d7fff8" strokeWidth="2"><path d="M90 55v20M98 47v28M106 36v33M114 48v24M122 40v23" /></g>
      <path d="M7 81C45 101 78 100 111 83c25-13 42-36 69-48" fill="none" stroke="#008b74" strokeWidth="1.5" />
      <path d="M66 13c42-9 80-10 103 1 11 5 12 12 3 20" fill="none" stroke="#00a983" strokeWidth="1.5" />
      <circle cx="170" cy="13" r="3.7" fill="#008f72" />
    </svg>
  );
}

// Glossy emerald mountain landscape — straight from the zip's app/page.tsx.
function MarketArtwork() {
  return (
    <div className="artwork" aria-hidden="true">
      <svg className="market-scene" viewBox="0 0 1000 520" preserveAspectRatio="none" role="img" aria-label="Glossy emerald mountain landscape">
        <defs>
          <linearGradient id="mountain-back" x1="0" y1="0" x2="0.9" y2="1"><stop stopColor="#000b10" /><stop offset=".56" stopColor="#001f25" /><stop offset="1" stopColor="#00564e" /></linearGradient>
          <linearGradient id="mountain-front" x1="0" y1="0" x2="1" y2=".8"><stop stopColor="#000910" /><stop offset=".5" stopColor="#00282d" /><stop offset=".78" stopColor="#00695f" /><stop offset="1" stopColor="#eff8f6" /></linearGradient>
          <linearGradient id="water" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#cde4e4" stopOpacity=".7" /><stop offset="1" stopColor="#eaf6f5" stopOpacity=".12" /></linearGradient>
          <linearGradient id="rim" x1="0" y1="0" x2="1" y2="0"><stop stopColor="#52ffe0" /><stop offset=".62" stopColor="#00cfa9" /><stop offset="1" stopColor="#eafffa" /></linearGradient>
          <filter id="mountain-depth"><feDropShadow dx="0" dy="12" stdDeviation="10" floodColor="#00171c" floodOpacity=".45" /></filter>
          <filter id="shine"><feGaussianBlur stdDeviation="5" /></filter>
          <linearGradient id="ridge" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#001419" /><stop offset=".55" stopColor="#003f3e" /><stop offset="1" stopColor="#d9e5e5" /></linearGradient>
          <linearGradient id="ridge2" x1="0" y1="0" x2="1" y2="0"><stop stopColor="#001116" /><stop offset=".8" stopColor="#007f73" /><stop offset="1" stopColor="#e9eeee" /></linearGradient>
          <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#eaf4f4" stopOpacity=".85" /><stop offset="1" stopColor="#cbd9da" stopOpacity=".15" /></linearGradient>
          <linearGradient id="edge-light" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#bffff4" stopOpacity=".9" /><stop offset="1" stopColor="#00a98a" stopOpacity=".05" /></linearGradient>
          <filter id="soft"><feGaussianBlur stdDeviation="7" /></filter>
          <filter id="ridge-shadow" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="14" stdDeviation="12" floodColor="#00181b" floodOpacity=".35" /></filter>
        </defs>
        <path d="M0 316c88-33 150-50 220-15 47 23 77 37 132 14 56-23 72-73 118-79 25-3 25 21 20 49-6 33 27 56 78 77H0Z" fill="url(#ridge)" filter="url(#ridge-shadow)" />
        <path d="M0 299c85 29 161 67 235 59 56-6 97-43 144-73 43-27 79-47 111-61-6 27-11 53-4 69 13 29 54 53 95 69H0Z" fill="url(#ridge2)" opacity=".96" />
        <path d="M0 307c110 34 170 61 253 48 60-9 106-52 159-86" fill="none" stroke="url(#edge-light)" strokeWidth="7" opacity=".32" />
        <path d="M0 307c110 34 170 61 253 48 60-9 106-52 159-86" fill="none" stroke="#58f8d4" strokeWidth="5" opacity=".35" filter="url(#soft)" />
        <path d="M0 307c110 34 170 61 253 48 60-9 106-52 159-86" fill="none" stroke="#c7fff6" strokeWidth="1.2" opacity=".95" />
        <path d="M0 301c107 32 171 59 253 47 61-9 108-51 161-84" fill="none" stroke="#ffffff" strokeWidth="8" opacity=".18" filter="url(#soft)" />
        <path d="M22 286c83 19 151 51 221 48 64-3 105-37 150-68" fill="none" stroke="#ecfffb" strokeWidth="2" opacity=".7" />
        <path d="M28 283c82 19 148 48 215 46 61-2 101-31 141-58" fill="none" stroke="#53f7d5" strokeWidth="7" opacity=".2" filter="url(#soft)" />
        <path d="M0 371h660v49H0Z" fill="url(#floor)" />
        <path d="M0 371c144 2 263 8 390 1 97-5 168-3 270 0" fill="none" stroke="#ffffff" strokeWidth="2" />
        <g transform="translate(0 742) scale(1 -1)" opacity=".18" filter="url(#soft)"><path d="M0 316c88-33 150-50 220-15 47 23 77 37 132 14 56-23 72-73 118-79 25-3 25 21 20 49-6 33 27 56 78 77H0Z" fill="#006b64" /></g>
        <g fill="none" strokeLinecap="round"><path d="M70 389c85-5 160 8 238 0 68-7 127-4 202 1" stroke="#52d6c2" strokeWidth="2" opacity=".28" /><path d="M118 399c72-4 128 5 194 0 59-5 112-2 166 2" stroke="#0aa992" strokeWidth="1.5" opacity=".32" /><path d="M22 410c105-4 172 4 250 0 90-5 185 0 298 2" stroke="#ffffff" strokeWidth="1" opacity=".6" /><path d="M178 417c58-3 112 2 174 0 47-2 91 0 141 1" stroke="#61cfc0" strokeWidth="1" opacity=".25" /></g>
        <g opacity=".2" filter="url(#soft)"><path d="M0 378c150 9 290 4 410 0" stroke="#00bfa1" strokeWidth="18" /></g>
      </svg>
    </div>
  );
}

export function AuthPage({ onAuthenticated }) {
  const [mode, setMode] = useState(MODE.login);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);

  // An OAuth failure bounces back to the frontend with ?auth_error=<code>.
  // Read it once on mount so the card can explain what happened, then drop the
  // param so a refresh doesn't re-show a stale error.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('auth_error');
    if (code) {
      setError(MESSAGES[code] || 'Google sign-in failed. Please try again.');
      history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  const isLogin = mode === MODE.login;

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      if (isLogin) {
        await api.login(email, password, remember);
      } else {
        await api.signup(email, password, remember);
      }
      onAuthenticated(email);
    } catch (err) {
      // Structured client-side log so auth failures are visible in the browser
      // console even when the UI message is generic.
      console.error(JSON.stringify({ event: 'auth_action_failed', action: isLogin ? 'login' : 'signup', code: err.code, status: err.status, message: err.message }));
      setError(MESSAGES[err.code] || err.message || 'Something went wrong.');
    } finally {
      setPending(false);
    }
  }

  function toggle() {
    setMode(isLogin ? MODE.signup : MODE.login);
    setError(null);
    setShowPassword(false);
  }

  function handleGoogle() {
    // Full-page redirect through the backend: /auth/google -> Google consent ->
    // /auth/google/callback sets the session cookie -> redirects back here.
    // On success the App's initial /watchlist fetch picks the session up; on
    // failure the redirect carries ?auth_error=... which the effect above shows.
    window.location.href = api.googleAuthUrl;
  }

  return (
    <main className="login-shell">
      {/* Full-bleed dark hero stage: eye mark + wordmark + tagline + artwork.
          Everything here is layered and clipped at the stage's bounds. */}
      <div className="hero-stage">
        <div className="visual-wash" aria-hidden="true" />
        <div className="brand-lockup">
          <EyeMark />
          <div className="brand-copy">
            <strong>TRADE<span>EYE</span></strong>
            <small>An <span>extra eye</span> on the market</small>
          </div>
        </div>
        <MarketArtwork />
      </div>

      {/* Floating login card, center-right, over the hero. */}
      <section className="auth-panel" aria-label="Sign in or create an account">
        <div className="auth-card">
          <p className="form-kicker">{isLogin ? 'SECURE ACCESS' : 'JOIN TRADEYE'}</p>
          <h1>{isLogin ? 'Welcome back' : 'Create your account'}</h1>
          <p className="form-intro">
            {isLogin
              ? 'Sign in to see the market with a clearer view.'
              : 'An extra eye on the market — watchlist signals, radar coverage, no noise.'}
          </p>

          <form className="login-form" onSubmit={handleSubmit}>
            <label htmlFor="auth-email">Email</label>
            <input
              id="auth-email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />

            <div className="password-row">
              <label htmlFor="auth-password">Password</label>
              <span className="auth__forgot" title="Coming soon">Forgot password?</span>
            </div>
            <div className="auth__password">
              <input
                id="auth-password"
                type={showPassword ? 'text' : 'password'}
                required
                autoComplete={isLogin ? 'current-password' : 'new-password'}
                minLength={isLogin ? undefined : 8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={isLogin ? 'Your password' : 'At least 8 characters'}
              />
              <button
                type="button"
                className="auth__toggle"
                onClick={() => setShowPassword((v) => !v)}
                aria-pressed={showPassword}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>

            {isLogin && (
              <div className="auth__row">
                <label className="auth__check">
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={(e) => setRemember(e.target.checked)}
                  />
                  <span>Remember me</span>
                </label>
              </div>
            )}

            {error && <p className="auth__error">{error}</p>}

            <button type="submit" className="auth__submit" disabled={pending}>
              <span>{pending ? 'Please wait…' : isLogin ? 'Sign in' : 'Create account'}</span>
              {!pending && <span className="auth__arrow" aria-hidden="true">{'\u2192'}</span>}
            </button>
          </form>

          <div className="auth__divider">
            <span>OR CONTINUE WITH</span>
          </div>

          <button type="button" className="auth__google" onClick={handleGoogle}>
            <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
              <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
              <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
              <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
              <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
            </svg>
            <span>Continue with Google</span>
          </button>

          <p className="signup">
            {isLogin ? "Don't have an account? " : 'Already have an account? '}
            <button type="button" className="auth__link" onClick={toggle}>
              {isLogin ? 'Sign up' : 'Sign in'}
            </button>
          </p>

          <p className="legal">
            Market data for demo purposes only and may be delayed — not for financial decisions.
          </p>
        </div>
      </section>
    </main>
  );
}