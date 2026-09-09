import { CONFIG } from './config.js';

// Asks Claude for `count` new customs/trade-compliance English words or
// short phrases, each with a natural Simplified Chinese translation, that
// aren't already in `existingTerms`. Returns an array of
// { text, mandarin } objects. Throws on failure -- caller decides how to
// handle a topup failure (we don't want a flaky Claude call to block the
// whole /api/state request).
export async function generateWordBatch(env, count, existingTerms) {
  const avoidList = existingTerms.length
    ? `Do not repeat any of these terms, which are already in use:\n${existingTerms.join(', ')}\n\n`
    : '';

  const prompt = `You are helping build a vocabulary list for a Customs / Trade Compliance ` +
    `manager who is a native Mandarin speaker learning to sound more professional and be ` +
    `clearly understood in spoken English.\n\n` +
    `Generate exactly ${count} English words or short phrases (a phrase is fine, e.g. ` +
    `"Bill of Lading" or "Customs Compliance") that a trade/customs compliance professional ` +
    `would commonly need to say out loud at work. Favor terms that are useful but easy to ` +
    `mispronounce or unfamiliar to a non-native speaker. ${avoidList}` +
    `Respond with ONLY a JSON array (no markdown fences, no commentary), where each element ` +
    `is an object: {"text": "<English word or phrase>", "mandarin": "<natural Simplified ` +
    `Chinese translation>"}.`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CONFIG.CLAUDE_MODEL,
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Claude API error ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const raw = (data.content || []).map((block) => block.text || '').join('');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Model occasionally wraps in fences or adds stray text despite
    // instructions -- try to salvage the JSON array substring.
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) throw new Error(`Could not parse Claude word-list response: ${raw.slice(0, 200)}`);
    parsed = JSON.parse(match[0]);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Claude word-list response was not a JSON array');
  }

  return parsed
    .filter((item) => item && typeof item.text === 'string' && typeof item.mandarin === 'string')
    .map((item) => ({ text: item.text.trim(), mandarin: item.mandarin.trim() }))
    .filter((item) => item.text.length > 0 && item.mandarin.length > 0);
}
