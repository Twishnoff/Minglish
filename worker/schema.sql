-- D1 schema for the English Pronunciation Practice tool.
-- Apply with: wrangler d1 execute pronunciation-tool-db --file=./schema.sql

-- The full pool of words/phrases a user can be tested on. Capped (soft limit,
-- see POOL_TARGET_SIZE in src/config.js) at ~100 per user, topped up by
-- calling Claude when it runs low on eligible (untested/failed/cooldown-expired)
-- entries.
CREATE TABLE IF NOT EXISTS word_pool (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email TEXT NOT NULL,
  text TEXT NOT NULL,             -- the English word or phrase, e.g. "Bill of Lading"
  mandarin TEXT NOT NULL,         -- precomputed Simplified Chinese translation
  ipa TEXT,                       -- precomputed IPA phonetic transcription, e.g. "/ˈbɪl ʌv ˈleɪdɪŋ/"
  example TEXT,                   -- precomputed example sentence using the word/phrase
  status TEXT NOT NULL DEFAULT 'untested', -- 'untested' | 'passed' | 'failed'
  last_result_date TEXT,          -- Pacific-time YYYY-MM-DD of the most recent pass/fail
  created_date TEXT NOT NULL,     -- Pacific-time YYYY-MM-DD when this entry was generated
  UNIQUE(user_email, text)
);

CREATE INDEX IF NOT EXISTS idx_word_pool_user_status
  ON word_pool (user_email, status);

-- One row per (user, calendar day, word) selected into that day's 10.
-- final_status stays NULL while the word is still within its scored
-- attempts; once decided it is frozen for the day (see scoring.js).
CREATE TABLE IF NOT EXISTS daily_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email TEXT NOT NULL,
  date TEXT NOT NULL,             -- Pacific-time YYYY-MM-DD
  word_id INTEGER NOT NULL REFERENCES word_pool(id),
  order_index INTEGER NOT NULL,   -- 0-9, preserves left/right arrow order
  tries INTEGER NOT NULL DEFAULT 0,
  final_status TEXT,              -- NULL | 'correct' | 'incorrect'
  late_success INTEGER NOT NULL DEFAULT 0, -- 1 if locked 'incorrect' but later passed a free retry
  UNIQUE(user_email, date, word_id)
);

CREATE INDEX IF NOT EXISTS idx_daily_log_user_date
  ON daily_log (user_email, date);

-- Belt-and-suspenders against the check-then-insert race in
-- getOrCreateTodayWords (src/db.js): two /api/state calls landing close
-- together (a reload while the first is still in flight, a retried
-- request, a second tab) can both see "no rows yet for today" and both try
-- to create a full day's set. UNIQUE(user_email, date, word_id) above
-- doesn't stop that -- the two sets are usually different words, so no
-- word_id collides -- but this index does, since both sets independently
-- assign order_index 0..N-1. Whichever insert loses the race gets a
-- constraint-violation error, which the code catches and treats as "someone
-- else already created it" (see db.js).
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_log_user_date_order
  ON daily_log (user_email, date, order_index);

-- One row per (user, calendar day) the user opened the app. Used to compute
-- the login streak (consecutive Pacific-time calendar days, no gaps).
CREATE TABLE IF NOT EXISTS login_days (
  user_email TEXT NOT NULL,
  date TEXT NOT NULL,             -- Pacific-time YYYY-MM-DD
  PRIMARY KEY (user_email, date)
);
