-- Fixes a race condition in getOrCreateTodayWords (src/db.js): the
-- check-then-insert there wasn't atomic, so two /api/state calls landing
-- close together (a page reload while the first request was still in
-- flight, a retried request, a second tab open) could each see "today's
-- set doesn't exist yet" and both create a full set of words for the same
-- day. UNIQUE(user_email, date, word_id) didn't catch this because the two
-- sets are usually different words -- what collides is order_index, which
-- wasn't constrained at all. Confirmed happening in production: 2026-09-09
-- has two full sets layered on top of each other (order_index 0-19 each
-- appearing twice, with different word_ids).
--
-- Apply with:
--   wrangler d1 execute pronunciation-tool-db --remote --file=./migrations/0002_dedupe_daily_log_and_add_order_index_uniqueness.sql
--
-- Step 1: clean up the existing duplicates so the unique index in step 2
-- can actually be created (SQLite refuses to build a unique index over data
-- that already violates it). For each (user_email, date, order_index)
-- group with more than one row, keep exactly one: prefer a row that
-- already has a final_status (real practice history) over one that
-- doesn't, then prefer more tries, then just keep the lowest id as a
-- deterministic tiebreaker. This is a one-time cleanup of already-corrupted
-- historical rows, not something that needs to run again once step 2's
-- index is in place.
DELETE FROM daily_log
WHERE id NOT IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY user_email, date, order_index
             ORDER BY (final_status IS NOT NULL) DESC, tries DESC, id ASC
           ) AS rn
    FROM daily_log
  )
  WHERE rn = 1
);

-- Step 2: the actual fix -- make it impossible to insert a second row at
-- the same (user_email, date, order_index) going forward. The code in
-- db.js now catches the constraint-violation error this produces when two
-- concurrent requests race, and treats it as "someone else already created
-- today's set" rather than a real failure.
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_log_user_date_order
  ON daily_log (user_email, date, order_index);
