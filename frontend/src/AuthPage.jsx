// src/AuthPage.jsx
//
// Dark-teal brand login/signup (2026-09-06). Rendered whenever a /watchlist
// request comes back 401 — the server stopped trusting whatever cookie we had.
//
//   Layout: the dark backdrop spans the FULL page width — big two-tone eye
//   mark + TRADEEYE wordmark + tagline at top-left, Track/Analyze/Radar value
//   props, and the closing line "Markets move. You see more." at the bottom.
//   The light form card FLOATS center-right on top of that background (dark
//   stage peeks around its top/bottom/right edges, no vertical seam); on
//   narrow screens the stage stacks and the card centers beneath the brand.
//   The dark ticker pins across the very top.
//
//   Card (light): "Welcome back" header + eyebrow, Sign in / Sign up tabs,
//   email, password with show/hide, "Remember me" (real: 90-day cookie vs.
//   browser-close), "Forgot password?" (placeholder pending email provider —
//   NOT wired), primary dark arrow button, "OR CONTINUE WITH" divider, and
//   the Google sign-in button (full redirect flow through /auth/google).
import { useEffect, useState } from 'react';
import { api } from './api';
import { Logo } from './Logo';

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

const VALUE_PROPS = [
  {
    title: 'Track',
    body: 'Live NSE prices, volume vs. average, and 7-day sparklines on your watchlist.',
  },
  {
    title: 'Analyze',
    body: 'Meaningful-move signals tuned to each stock\u2019s own volatility, not a blanket threshold.',
  },
  {
    title: 'Radar',
    body: 'Top movers across the market surface outside your watchlist.',
  },
];

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

  function selectMode(next) {
    setMode(next);
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
    <div className="auth-stage">
      <section className="auth-hero" aria-label="About TRADEYE">
        <Logo tone="dark" tagline stack />

        <ul className="auth-hero__props">
          {VALUE_PROPS.map((p) => (
            <li key={p.title}>
              <strong>{p.title}</strong>
              <span>{p.body}</span>
            </li>
          ))}
        </ul>

        <p className="auth-hero__closing">Markets move. You see more.</p>
      </section>

      <section className="auth-panel" aria-label="Sign in or create an account">
        <div className="auth-card">
          <p className="auth-card__eyebrow">Same market / a clearer view</p>
          <h1 className="auth-card__title">{isLogin ? 'Welcome back' : 'Create your account'}</h1>

          <div className="auth__tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={isLogin}
              className={`auth__tab${isLogin ? ' auth__tab--active' : ''}`}
              onClick={() => selectMode(MODE.login)}
            >
              Sign in
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={!isLogin}
              className={`auth__tab${!isLogin ? ' auth__tab--active' : ''}`}
              onClick={() => selectMode(MODE.signup)}
            >
              Sign up
            </button>
          </div>

          <form className="auth__form" onSubmit={handleSubmit}>
            <label className="auth__field">
              <span className="auth__label">Email</span>
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </label>

            <label className="auth__field">
              <span className="auth__label">Password</span>
              <div className="auth__password">
                <input
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
            </label>

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
                <span className="auth__forgot" title="Coming soon">Forgot password?</span>
              </div>
            )}

            {error && <p className="auth__error">{error}</p>}

            <button type="submit" className="auth__submit" disabled={pending}>
              <span>{pending ? 'Please wait…' : isLogin ? 'Sign in' : 'Sign up'}</span>
              <svg className="auth__arrow" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path d="M1 8h13M9 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
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

          <p className="auth__switch">
            {isLogin ? "Don't have an account? " : 'Already have an account? '}
            <button type="button" className="auth__link" onClick={toggle}>
              {isLogin ? 'Sign up' : 'Sign in'}
            </button>
          </p>
        </div>
      </section>
    </div>
  );
}