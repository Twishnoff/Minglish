import { CONFIG } from './config.js';

// Asks Claude for `count` new customs/trade-compliance English words or
// short phrases, each with a natural Simplified Chinese translation, an IPA
// phonetic transcription, and an example sentence, that aren't already in
// `existingTerms`. Returns an array of { text, mandarin, ipa, example}
// objects. Throws on failure -- caller decides how to handle a topup
// failure (we don't want a flaky Claude call to block the whole /api/state
// request).
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
    `For each term also provide:\n` +
    `- an IPA phonetic transcription in General American English (e.g. "/ˈbɪl ʌv ˈleɪdɪŋ/")\n` +
    `- a natural example sentence using the term the way a trade compliance manager might say ` +
    `it out loud -- pull from a realistic real-world usage if one comes to mind, otherwise ` +
    `invent one that sounds natural for that role.\n\n` +
    `Respond with ONLY a JSON array (no markdown fences, no commentary), where each element ` +
    `is an object: {"text": "<English word or phrase>", "mandarin": "<natural Simplified ` +
    `Chinese translation>", "ipa": "<IPA transcription>", "example": "<example sentence>"}.`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CONFIG.CLAUDE_MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Claude API error ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const raw = (data.content || []).map((block) => block.text || '').join('');
  const parsed = parseJsonArray(raw, 'word-list');

  return parsed
    .filter((item) => item && typeof item.text === 'string' && typeof item.mandarin === 'string')
    .map((item) => ({
      text: item.text.trim(),
      mandarin: item.mandarin.trim(),
      ipa: typeof item.ipa === 'string' ? item.ipa.trim() : '',
      example: typeof item.example === 'string' ? item.example.trim() : '',
    }))
    .filter((item) => item.text.length > 0 && item.mandarin.length > 0);
}

// Backfills ipa + example for words/phrases already sitting in a user's
// word_pool from before this feature existed (see the /api/admin/
// backfill-details route). `terms` is a plain array of English text;
// returns an array of {ipa, example} in the SAME ORDER so the caller can
// zip it back onto its own row list by index.
export async function generateDetailsForExisting(env, terms) {
  const prompt = `For each of the following English words/phrases used by a Customs / Trade ` +
    `Compliance professional learning to speak English clearly, provide:\n` +
    `- an IPA phonetic transcription in General American English\n` +
    `- a natural example sentence using it the way a trade compliance manager might say it ` +
    `out loud -- pull from a realistic real-world usage if one comes to mind, otherwise invent ` +
    `one that sounds natural for that role.\n\n` +
    `Terms, in order:\n${terms.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\n` +
    `Respond with ONLY a JSON array (no markdown fences, no commentary) with exactly ` +
    `${terms.length} elements in the SAME ORDER as the terms above, each an object: ` +
    `{"ipa": "<IPA transcription>", "example": "<example sentence>"}.`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CONFIG.CLAUDE_MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Claude API error ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const raw = (data.content || []).map((block) => block.text || '').join('');
  const parsed = parseJsonArray(raw, 'backfill-details');

  return parsed.map((item) => ({
    ipa: typeof item?.ipa === 'string' ? item.ipa.trim() : '',
    example: typeof item?.example === 'string' ? item.example.trim() : '',
  }));
}

// Shared JSON-array parsing with the same fences/stray-text salvage logic
// both Claude calls above need.
function parseJsonArray(raw, label) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) throw new Error(`Could not parse Claude ${label} response: ${raw.slice(0, 200)}`);
    parsed = JSON.parse(match[0]);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Claude ${label} response was not a JSON array`);
  }
  return parsed;
}
