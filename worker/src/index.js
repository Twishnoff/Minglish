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
        const history = await getHistory(db, email);

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
              orderIndex: w.orderIndex,
              tries: w.tries,
              finalStatus: w.finalStatus,
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

      return json(env, { error: 'Not found.' }, 404);
    } catch (err) {
      console.error(err);
      return json(env, { error: err.message || 'Internal error.' }, 500);
    }
  },
};
