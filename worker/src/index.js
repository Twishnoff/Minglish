import { pacificDateString } from './dates.js';
import {
  isAllowedEmail,
  recordLoginAndGetStreak,
  ensurePoolTopped,
  getOrCreateTodayWords,
  getTodayPerformance,
  getHistory,
} from './db.js';
import { handleAttempt } from './scoring.js';
import { synthesizeSpeech } from './azure.js';
import { generateDetailsForExisting } from './claude.js';

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-User-Email, X-Word-Id',
  };
}

function json(env, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
  });
}

function getEmail(request, url) {
  return (
    request.headers.get('X-User-Email') ||
    url.searchParams.get('email') ||
    ''
  ).trim();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(env) });
    }

    try {
      // --- POST /api/login { email } -- validates only, no session state.
      if (url.pathname === '/api/login' && request.method === 'POST') {
        const { email } = await request.json();
        if (!isAllowedEmail(env, email)) {
          return json(env, { error: 'Email not recognized.' }, 401);
        }
        return json(env, { ok: true, email: email.trim().toLowerCase() });
      }

      // Every other route requires a recognized email, sent either as
      // ?email= or an X-User-Email header. There's no password and no
      // session token by design (see README) -- this is a private,
      // two-person tool, and the allowlist check happens on every request.
      const email = getEmail(request, url).toLowerCase();
      if (!isAllowedEmail(env, email)) {
        return json(env, { error: 'Email not recognized.' }, 401);
      }

      const db = env.DB;
      const today = pacificDateString();

      // --- GET /api/state -- streak, today's words, performance, history.
      // Also acts as the "login" that (a) records today's visit for streak
      // purposes and (b) generates today's word set on first call of the day.
      if (url.pathname === '/api/state' && request.method === 'GET') {
        const streak = await recordLoginAndGetStreak(db, email, today);
        await ensurePoolTopped(env, db, email, today);
        const words = await getOrCreateTodayWords(db, email, today);
        const { correct, total } = await getTodayPerformance(db, email, today);
        const history = await getHistory(db, email, today);

        return json(env, {
          streak,
          today: {
            date: today,
            correct,
            total,
            percent: total > 0 ? Math.round((correct / total) * 100) : null,
            words: words.map((w) => ({
              logId: w.logId,
              wordId: w.wordId,
              text: w.text,
              mandarin: w.mandarin,
              ipa: w.ipa || '',
              example: w.example || '',
              orderIndex: w.orderIndex,
              tries: w.tries,
              finalStatus: w.finalStatus,
              lateSuccess: !!w.lateSuccess,
            })),
          },
          history,
        });
      }

      // --- POST /api/attempt -- multipart-free binary upload.
      // Query params: wordId, contentType (the browser's MediaRecorder mime type).
      // Body: raw audio bytes.
      if (url.pathname === '/api/attempt' && request.method === 'POST') {
        const wordId = Number(url.searchParams.get('wordId'));
        const referenceText = url.searchParams.get('text') || '';
        const contentType = request.headers.get('Content-Type') || 'audio/webm; codecs=opus';

        if (!wordId || !referenceText) {
          return json(env, { error: 'wordId and text are required.' }, 400);
        }

        const audioBuffer = await request.arrayBuffer();
        if (audioBuffer.byteLength === 0) {
          return json(env, { error: 'No audio received.' }, 400);
        }

        const result = await handleAttempt(env, db, {
          email,
          today,
          wordId,
          audioBuffer,
          contentType,
          referenceText,
        });
        return json(env, result);
      }

      // --- GET /api/tts?text=... -- Azure Neural TTS playback, proxied so
      // the Azure key never reaches the browser. Returns raw MP3 bytes;
      // frontend falls back to the browser's own speech synthesis if this
      // errors. Gated behind the same allowlist check as everything else.
      if (url.pathname === '/api/tts' && request.method === 'GET') {
        const text = (url.searchParams.get('text') || '').trim();
        if (!text) return json(env, { error: 'text is required.' }, 400);
        try {
          const audio = await synthesizeSpeech(env, text);
          return new Response(audio, {
            headers: {
              'Content-Type': 'audio/mpeg',
              'Cache-Control': 'public, max-age=86400',
              ...corsHeaders(env),
            },
          });
        } catch (err) {
          console.error('TTS failed:', err);
          return json(env, { error: 'TTS unavailable.' }, 502);
        }
      }

      // --- POST /api/admin/backfill-details -- one-time (or run-until-done)
      // maintenance route: fills in ipa/example for word_pool rows created
      // before those columns existed. Same allowlist gate as every other
      // route (there's no separate admin role in this two-person tool -- see
      // README). Processes one batch per call so it stays well within a
      // Worker's CPU/time limits; call repeatedly until `remaining` is 0.
      if (url.pathname === '/api/admin/backfill-details' && request.method === 'POST') {
        const BATCH_SIZE = 20;
        const { results: rows } = await db
          .prepare(
            `SELECT id, text FROM word_pool
             WHERE user_email = ? AND (ipa IS NULL OR ipa = '' OR example IS NULL OR example = '')
             LIMIT ?`
          )
          .bind(email, BATCH_SIZE)
          .all();

        if (rows.length === 0) {
          return json(env, { updated: 0, remaining: 0 });
        }

        const details = await generateDetailsForExisting(env, rows.map((r) => r.text));
        const stmt = db.prepare('UPDATE word_pool SET ipa = ?, example = ? WHERE id = ?');
        const updates = rows
          .map((row, i) => (details[i] ? stmt.bind(details[i].ipa, details[i].example, row.id) : null))
          .filter(Boolean);
        if (updates.length) await db.batch(updates);

        const { results: remainingRows } = await db
          .prepare(
            `SELECT COUNT(*) as n FROM word_pool
             WHERE user_email = ? AND (ipa IS NULL OR ipa = '' OR example IS NULL OR example = '')`
          )
          .bind(email)
          .all();

        return json(env, { updated: updates.length, remaining: remainingRows[0]?.n ?? 0 });
      }

      return json(env, { error: 'Not found.' }, 404);
    } catch (err) {
      console.error(err);
      return json(env, { error: err.message || 'Internal error.' }, 500);
    }
  },
};
