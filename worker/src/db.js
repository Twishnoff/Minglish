import { CONFIG } from './config.js';
import { pacificDateString, subtractDays, addDays } from './dates.js';
import { generateWordBatch } from './claude.js';

export function isAllowedEmail(env, email) {
  const allowed = (env.ALLOWED_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes((email || '').trim().toLowerCase());
}

// Records today's visit (idempotent) and returns the current streak --
// the count of consecutive Pacific-time calendar days ending today with
// no gaps.
export async function recordLoginAndGetStreak(db, email, today) {
  await db
    .prepare('INSERT OR IGNORE INTO login_days (user_email, date) VALUES (?, ?)')
    .bind(email, today)
    .run();

  const { results } = await db
    .prepare('SELECT date FROM login_days WHERE user_email = ? ORDER BY date DESC LIMIT 400')
    .bind(email)
    .all();

  const loginDates = new Set(results.map((r) => r.date));
  let streak = 0;
  let cursor = today;
  while (loginDates.has(cursor)) {
    streak += 1;
    cursor = subtractDays(cursor, 1);
  }
  return streak;
}

// Tops up a user's word_pool with freshly generated words/phrases if the
// number of *eligible* words (untested, failed, or cooldown-expired) has
// run low. Best-effort: swallows Claude errors so a flaky generation call
// doesn't break the whole /api/state request -- the user can still work
// through whatever is already eligible.
export async function ensurePoolTopped(env, db, email, today) {
  const cooldownCutoff = subtractDays(today, CONFIG.PASS_COOLDOWN_DAYS);

  const { results: eligibleRows } = await db
    .prepare(
      `SELECT COUNT(*) as n FROM word_pool
       WHERE user_email = ? AND (
         status = 'untested'
         OR status = 'failed'
         OR (status = 'passed' AND (last_result_date IS NULL OR last_result_date <= ?))
       )`
    )
    .bind(email, cooldownCutoff)
    .all();

  const eligibleCount = eligibleRows[0]?.n ?? 0;
  if (eligibleCount >= CONFIG.POOL_TOPUP_THRESHOLD) return;

  const { results: totalRows } = await db
    .prepare('SELECT COUNT(*) as n FROM word_pool WHERE user_email = ?')
    .bind(email)
    .all();
  const totalCount = totalRows[0]?.n ?? 0;

  const needed = Math.max(CONFIG.POOL_TARGET_SIZE - totalCount, CONFIG.POOL_TOPUP_THRESHOLD);
  if (needed <= 0) return;

  const { results: existingTermRows } = await db
    .prepare('SELECT text FROM word_pool WHERE user_email = ?')
    .bind(email)
    .all();
  const existingTerms = existingTermRows.map((r) => r.text);

  let batch;
  try {
    batch = await generateWordBatch(env, needed, existingTerms);
  } catch (err) {
    console.error('Word-pool top-up failed, continuing with existing pool:', err);
    return;
  }

  const stmt = db.prepare(
    'INSERT OR IGNORE INTO word_pool (user_email, text, mandarin, ipa, example, status, created_date) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const inserts = batch.map((item) =>
    stmt.bind(email, item.text, item.mandarin, item.ipa || null, item.example || null, 'untested', today)
  );
  if (inserts.length) await db.batch(inserts);
}

// Returns today's practice set (creating it if this is the first call of
// the day), each entry shaped as:
// { logId, wordId, text, mandarin, orderIndex, tries, finalStatus }
export async function getOrCreateTodayWords(db, email, today) {
  const { results: existing } = await db
    .prepare(
      `SELECT dl.id as logId, dl.word_id as wordId, dl.order_index as orderIndex,
              dl.tries as tries, dl.final_status as finalStatus,
              dl.late_success as lateSuccess,
              wp.text as text, wp.mandarin as mandarin, wp.ipa as ipa, wp.example as example
       FROM daily_log dl JOIN word_pool wp ON wp.id = dl.word_id
       WHERE dl.user_email = ? AND dl.date = ?
       ORDER BY dl.order_index ASC`
    )
    .bind(email, today)
    .all();

  if (existing.length > 0) return existing;

  // First visit today -- select up to DAILY_WORD_COUNT words, prioritizing
  // failed words first, then untested/cooldown-expired words at random.
  const cooldownCutoff = subtractDays(today, CONFIG.PASS_COOLDOWN_DAYS);

  const { results: failedWords } = await db
    .prepare(
      `SELECT id, text, mandarin FROM word_pool
       WHERE user_email = ? AND status = 'failed'
       ORDER BY last_result_date ASC
       LIMIT ?`
    )
    .bind(email, CONFIG.DAILY_WORD_COUNT)
    .all();

  const remaining = CONFIG.DAILY_WORD_COUNT - failedWords.length;
  let fillerWords = [];
  if (remaining > 0) {
    const { results } = await db
      .prepare(
        `SELECT id, text, mandarin FROM word_pool
         WHERE user_email = ? AND (
           status = 'untested'
           OR (status = 'passed' AND (last_result_date IS NULL OR last_result_date <= ?))
         )
         ORDER BY RANDOM()
         LIMIT ?`
      )
      .bind(email, cooldownCutoff, remaining)
      .all();
    fillerWords = results;
  }

  const chosen = [...failedWords, ...fillerWords];

  if (chosen.length === 0) return [];

  const insertStmt = db.prepare(
    'INSERT INTO daily_log (user_email, date, word_id, order_index, tries, final_status) VALUES (?, ?, ?, ?, 0, NULL)'
  );
  await db.batch(chosen.map((w, i) => insertStmt.bind(email, today, w.id, i)));

  // Re-query rather than trying to thread D1's per-statement insert ids
  // back through the batch -- simpler and just as cheap at this size.
  const { results: created } = await db
    .prepare(
      `SELECT dl.id as logId, dl.word_id as wordId, dl.order_index as orderIndex,
              dl.tries as tries, dl.final_status as finalStatus,
              dl.late_success as lateSuccess,
              wp.text as text, wp.mandarin as mandarin, wp.ipa as ipa, wp.example as example
       FROM daily_log dl JOIN word_pool wp ON wp.id = dl.word_id
       WHERE dl.user_email = ? AND dl.date = ?
       ORDER BY dl.order_index ASC`
    )
    .bind(email, today)
    .all();
  return created;
}

export async function getTodayPerformance(db, email, today) {
  const { results } = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN final_status = 'correct' THEN 1 ELSE 0 END) as correct,
         SUM(CASE WHEN final_status IS NOT NULL THEN 1 ELSE 0 END) as total
       FROM daily_log WHERE user_email = ? AND date = ?`
    )
    .bind(email, today)
    .all();
  const row = results[0] || { correct: 0, total: 0 };
  return { correct: row.correct || 0, total: row.total || 0 };
}

// Returns one entry per calendar day from the user's first day of activity
// through today, inclusive, as { date, score } -- score is a 0-100 percent.
// Days with no daily_log rows at all (the user never opened the app, or a
// day that's entirely in-progress with nothing decided yet) come back as 0,
// per the spec ("for days where no score was earned, count it as a 0").
// Today's entry updates live as the user answers -- it's just today's
// daily_log rows aggregated same as any other day -- and once a day is
// over, its daily_log rows are never touched again (a new day's words get
// their own date), so a past day's score is naturally frozen at whatever it
// was at 11:59 PM PT without needing a separate snapshot/cron job.
export async function getHistory(db, email, today) {
  const { results } = await db
    .prepare(
      `SELECT date,
         SUM(CASE WHEN final_status = 'correct' THEN 1 ELSE 0 END) as correct,
         SUM(CASE WHEN final_status IS NOT NULL THEN 1 ELSE 0 END) as total
       FROM daily_log
       WHERE user_email = ?
       GROUP BY date
       ORDER BY date ASC`
    )
    .bind(email)
    .all();

  const scoreByDate = new Map(
    results.map((r) => [r.date, r.total > 0 ? Math.round((r.correct / r.total) * 100) : 0])
  );

  const { results: loginRows } = await db
    .prepare('SELECT MIN(date) as minDate FROM login_days WHERE user_email = ?')
    .bind(email)
    .all();
  const earliestLogin = loginRows[0]?.minDate || null;
  const earliestActivity = results.length > 0 ? results[0].date : null;
  const candidates = [earliestLogin, earliestActivity].filter(Boolean);
  if (candidates.length === 0) return [];
  const start = candidates.sort()[0];

  const out = [];
  let cursor = start;
  while (cursor <= today) {
    out.push({ date: cursor, score: scoreByDate.has(cursor) ? scoreByDate.get(cursor) : 0 });
    cursor = addDays(cursor, 1);
  }
  return out;
}

export async function getDailyLogRow(db, email, today, wordId) {
  const { results } = await db
    .prepare('SELECT * FROM daily_log WHERE user_email = ? AND date = ? AND word_id = ?')
    .bind(email, today, wordId)
    .all();
  return results[0] || null;
}

export async function incrementTries(db, logId, newTries) {
  await db.prepare('UPDATE daily_log SET tries = ? WHERE id = ?').bind(newTries, logId).run();
}

export async function lockFinalStatus(db, logId, status) {
  await db.prepare('UPDATE daily_log SET final_status = ? WHERE id = ?').bind(status, logId).run();
}

// Sticky flag: once a word locked in 'incorrect' for the day is later
// passed on a free retry, mark it so the UI can show "eventually got it"
// (yellow) instead of "still wrong" (red). Never cleared back to 0.
// (This was already wired up in the frontend/README's documented design --
// wiring it here closes the loop so it actually takes effect.)
export async function markLateSuccess(db, logId) {
  await db.prepare('UPDATE daily_log SET late_success = 1 WHERE id = ?').bind(logId).run();
}

export async function updateWordPoolStatus(db, wordId, status, date) {
  await db
    .prepare('UPDATE word_pool SET status = ?, last_result_date = ? WHERE id = ?')
    .bind(status, date, wordId)
    .run();
}
