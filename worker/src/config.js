// Tunable constants for the pronunciation tool's scoring/pool logic.
// Pulled out here so they're easy to find and adjust without hunting
// through the request-handling code.

export const CONFIG = {
  // Calendar used for "today", streaks, and cooldowns, per the spec.
  TIMEZONE: 'America/Los_Angeles',

  // How many words/phrases make up a day's practice set.
  DAILY_WORD_COUNT: 10,

  // A word that's answered correctly isn't shown again until this many
  // days have passed.
  PASS_COOLDOWN_DAYS: 7,

  // How many scored attempts a word gets before it locks in as
  // "incorrect" for the day. Matches the spec's "right on try 1 or 2 ->
  // correct; wrong after that -> counted wrong, retried tomorrow."
  // Assumption (flagged in README): exactly 2 scored tries, not "3+".
  MAX_SCORED_TRIES: 2,

  // Soft target for how many entries (across all statuses) should exist
  // in a user's word_pool. Topped up with fresh Claude-generated
  // words/phrases when the pool of *eligible* (untested/failed/
  // cooldown-expired) words runs low.
  POOL_TARGET_SIZE: 100,
  POOL_TOPUP_THRESHOLD: 20, // top up once eligible words drop below this

  // Pronunciation Assessment pass bar. Two independent checks, both must
  // pass (see scoring.js):
  //   1) Azure's speech recognizer must have actually recognized the
  //      audio as a match for the reference text (not garbage/silence).
  //   2) The phoneme-level AccuracyScore must clear this bar.
  MIN_ACCURACY_SCORE: 80,

  // Diagnostic bar (separate from MIN_ACCURACY_SCORE above) used only to
  // decide which specific phonemes get underlined as "needs work" in the
  // UI -- see buildMispronunciationRanges in azure.js. Lower than the pass
  // bar on purpose: this is meant to surface the roughest spots within an
  // attempt, including ones that still passed overall.
  MISPRONUNCIATION_HIGHLIGHT_THRESHOLD: 60,

  // Azure Neural TTS voice used for the speaker button (falls back to the
  // browser's built-in speech synthesis if this fails/is unavailable). Any
  // Neural voice from Azure's voice gallery works here; this one was
  // chosen for clear, natural General American pronunciation.
  TTS_VOICE: 'en-US-AvaNeural',

  // Claude model used to generate the word/phrase list + Mandarin
  // translations. Update this to whatever the current cheap/fast model
  // is at deploy time -- this is a placeholder, verify it's still valid.
  CLAUDE_MODEL: 'claude-haiku-4-5',
};
