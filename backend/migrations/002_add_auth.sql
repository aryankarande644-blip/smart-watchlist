-- migrations/002_add_auth.sql
-- Real user accounts replace anonymous sessions (clean cutover).
--
-- Decision recorded in HANDOFF.md §6: the "anonymous signed cookie" identity
-- model is superseded. Anonymous rows carry no real data — wipe them and add
-- the auth columns. watchlist_entry/last_seen cascade off users, so wipe
-- those too (this migration is a clean slate by design).
--
-- OAuth / email-verification are explicitly deferred future scope, not
-- forgotten (see HANDOFF §6).
--
-- Email uniqueness is enforced at the DB layer (UNIQUE) so a race between
-- two simultaneous signups can never create duplicate accounts; the route
-- layer also normalizes to lowercase. UNIQUE on TEXT is byte-order-correct
-- for lowercase-normalized writes.
--
-- Migration runs against an EMPTY users table (DELETE above), so the
-- NOT NULL / UNIQUE columns can be added directly without a default.

DELETE FROM last_seen;
DELETE FROM watchlist_entry;
DELETE FROM users;

ALTER TABLE users
  ADD COLUMN email TEXT UNIQUE NOT NULL,
  ADD COLUMN password_hash TEXT NOT NULL,
  ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0;