// src/AddSymbolForm.jsx
import { useState } from 'react';

export function AddSymbolForm({ onAdd }) {
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!value.trim() || submitting) return; // prevent double-submit on fast double-click
    setSubmitting(true);
    setError(null);
    try {
      await onAdd(value.trim());
      setValue('');
    } catch (err) {
      setError(err.code === 'watchlist_full' ? 'Your watchlist is full (30 max).' : 'Could not add that symbol.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="add-form" onSubmit={handleSubmit}>
      <input
        type="text"
        placeholder="Add a symbol, e.g. TCS"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={submitting}
        aria-label="Symbol to add"
      />
      <button type="submit" disabled={submitting || !value.trim()}>
        {submitting ? 'Adding…' : 'Add'}
      </button>
      {error && <span className="add-form__error">{error}</span>}
    </form>
  );
}
