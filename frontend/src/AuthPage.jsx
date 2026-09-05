// src/AuthPage.jsx
import { useState } from 'react';
import { api } from './api';

// Single page, two modes (toggle). Rendered whenever a /watchlist request
// comes back 401 — the server stopped trusting whatever cookie we had.
const MODE = {
  login: 'login',
  signup: 'signup',
};

// Map server error codes to human-readable copy for the one-line error line.
const MESSAGES = {
  invalid_credentials: 'Invalid email or password.',
  invalid_email: "That email address doesn't look right.",
  password_too_short: 'Password must be at least 8 characters.',
  email_taken: 'An account with that email already exists.',
  rate_limited: 'Too many login attempts. Try again in a few minutes.',
};

export function AuthPage({ onAuthenticated }) {
  const [mode, setMode] = useState(MODE.login);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);

  const isLogin = mode === MODE.login;

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      if (isLogin) {
        await api.login(email, password);
      } else {
        await api.signup(email, password);
      }
      onAuthenticated();
    } catch (err) {
      setError(MESSAGES[err.code] || err.message || 'Something went wrong.');
    } finally {
      setPending(false);
    }
  }

  function toggle() {
    setMode(isLogin ? MODE.signup : MODE.login);
    setError(null);
  }

  return (
    <div className="auth">
      <div className="auth__card">
        <h1 className="auth__title">{isLogin ? 'Sign in' : 'Create your account'}</h1>

        <div className="auth__tabs">
          <button
            type="button"
            className={`auth__tab${isLogin ? ' auth__tab--active' : ''}`}
            onClick={() => { setMode(MODE.login); setError(null); }}
          >
            Sign in
          </button>
          <button
            type="button"
            className={`auth__tab${!isLogin ? ' auth__tab--active' : ''}`}
            onClick={() => { setMode(MODE.signup); setError(null); }}
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
            <input
              type="password"
              required
              autoComplete={isLogin ? 'current-password' : 'new-password'}
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={isLogin ? 'Your password' : 'At least 8 characters'}
            />
          </label>

          {error && <p className="auth__error">{error}</p>}

          <button type="submit" className="auth__submit" disabled={pending}>
            {pending ? 'Please wait…' : isLogin ? 'Sign in' : 'Sign up'}
          </button>
        </form>

        <p className="auth__switch">
          {isLogin ? "Don't have an account? " : 'Already have an account? '}
          <button type="button" className="auth__link" onClick={toggle}>
            {isLogin ? 'Sign up' : 'Sign in'}
          </button>
        </p>
      </div>
    </div>
  );
}