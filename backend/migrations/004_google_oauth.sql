-- migrations/004_google_oauth.sql
-- Google OAuth 2.0 sign-in (owner decision 2026-09-06, HANDOFF §10 #9).
--
-- Two additive schema changes:
--   1. password_hash becomes NULLABLE — Google-authenticated accounts have no
--      password, so their row carries password_hash = NULL. Existing
--      email/password rows keep their hashes untouched.
--   2. users.auth_provider TEXT CHECK ('email' | 'google') — records whether
--      the account was established via an email/password signup or via Google.
--      Default 'email' keeps all existing rows (and any accidental insert that
--      forgets the column) correct without a rewrite.
--
-- This migration is purely additive — no data wipe, no backfill needed. The
-- 002 migration's clean cutover already wiped pre-account rows; every row in
-- this table today is a real account and keeps its identity.

ALTER TABLE users
  ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE users
  ADD COLUMN auth_provider TEXT NOT NULL DEFAULT 'email'
  CHECK (auth_provider IN ('email', 'google'));