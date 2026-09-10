-- Adds the ipa/example/late_success columns to an already-deployed database
-- (the base schema.sql already has these for a fresh install -- this file
-- is only needed against a database created before this change).
--
-- Apply with:
--   wrangler d1 execute pronunciation-tool-db --remote --file=./migrations/0001_add_ipa_example_and_late_success.sql
--
-- SQLite/D1 don't support "ADD COLUMN IF NOT EXISTS", so if you've already
-- run this once, re-running it will fail with "duplicate column name" --
-- that's expected and means you're already up to date.

ALTER TABLE word_pool ADD COLUMN ipa TEXT;
ALTER TABLE word_pool ADD COLUMN example TEXT;

-- Also closes a pre-existing gap: the frontend and README already describe
-- a "late success" (yellow) status for a word that locks in wrong for the
-- day but is later passed on a free retry, but the deployed daily_log table
-- never had the column for it, so that status could never actually fire.
-- Backend code now sets it (see db.js markLateSuccess / scoring.js).
ALTER TABLE daily_log ADD COLUMN late_success INTEGER NOT NULL DEFAULT 0;

-- Existing rows will have NULL ipa/example until either (a) they naturally
-- cycle out after their 7-day pass cooldown and get regenerated, or (b) you
-- run the one-time backfill described in the README (POST
-- /api/admin/backfill-details), which is the faster path since it covers
-- the whole existing pool right away instead of waiting on cooldowns.
