-- scripts/reset-dev-db.sql
-- Real gap found during manual verification: local dev/testing had no
-- clean-slate command, so test runs and manual curl sessions silently
-- polluted each other's data in the shared local Postgres instance.
TRUNCATE last_seen, watchlist_entry, snapshot, baseline, users CASCADE;
