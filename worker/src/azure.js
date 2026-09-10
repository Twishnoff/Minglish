import { CONFIG } from './config.js';

// Calls Azure AI Speech's Pronunciation Assessment REST API (the "short
// audio" recognition endpoint with a Pronunciation-Assessment header) and
// returns a normalized result. Docs:
// https://learn.microsoft.com/azure/ai-services/speech-service/how-to-pronunciation-assessment
//
// `audioBuffer` is the raw bytes the browser recorded (see frontend/app.js
// -- we ask MediaRecorder for audio/webm;codecs=opus, which the REST
// endpoint accepts via the Content-Type header below). `referenceText` is
// the word/phrase being tested.
export async function assessPronunciation(env, audioBuffer, referenceText, contentType) {
  const region = env.AZURE_SPEECH_REGION;
  const key = env.AZURE_SPEECH_KEY;

  const pronAssessmentConfig = {
    ReferenceText: referenceText,
    GradingSystem: 'HundredMark',
    Granularity: 'Phoneme',
    Dimension: 'Comprehensive',
    EnableMiscue: true,
  };
  const pronAssessmentHeader = btoa(JSON.stringify(pronAssessmentConfig));

  const url =
    `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1` +
    `?language=en-US&format=detailed`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': contentType || 'audio/webm; codecs=opus',
      Accept: 'application/json',
      'Pronunciation-Assessment': pronAssessmentHeader,
    },
    body: audioBuffer,
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Azure Speech API error ${resp.status}: ${errText}`);
  }

  const data = await resp.json();

  // RecognitionStatus is "Success" only when Azure's recognizer actually
  // matched the audio to the reference text with reasonable confidence --
  // this is our first pass ("is this even the right word").
  const recognized = data.RecognitionStatus === 'Success';
  const best = (data.NBest && data.NBest[0]) || null;
  const accuracyScore = best?.PronunciationAssessment?.AccuracyScore ?? 0;
  const mispronouncedRanges = buildMispronunciationRanges(referenceText, best?.Words || []);

  return {
    recognized,
    recognizedText: data.DisplayText || best?.Display || '',
    accuracyScore,
    mispronouncedRanges,
    raw: data, // kept for debugging/logging; not persisted to D1
  };
}

// Turns Azure's per-word/per-phoneme accuracy breakdown into character
// ranges within `referenceText` that scored poorly, so the frontend can
// underline the rough spots directly on the word/phrase as displayed.
//
// Word-level ranges are exact: Azure's Words[] already segments the
// response by the actual words in the phrase (with its own AccuracyScore
// per word), so we just line those up against referenceText's own
// whitespace-split tokens in order.
//
// Sub-word ranges are a heuristic: Azure returns an AccuracyScore per
// phoneme (the requested Granularity: 'Phoneme'), but not which letters of
// the written word that phoneme corresponds to -- English spelling doesn't
// map onto sounds 1:1, and Azure doesn't return that alignment. As an
// approximation, we split each word's letters evenly across its phoneme
// count, in order, and flag the letter-range for any phoneme scoring below
// MISPRONUNCIATION_HIGHLIGHT_THRESHOLD. Good enough to point at roughly
// where the trouble is (e.g. "the back half of this word"), not a precise
// grapheme-to-phoneme alignment -- flagging this here since it's the kind
// of assumption worth sanity-checking against how it actually looks/feels
// in use.
function buildMispronunciationRanges(referenceText, azureWords) {
  const tokens = [];
  let cursor = 0;
  for (const raw of referenceText.split(/(\s+)/)) {
    if (raw.trim().length === 0) {
      cursor += raw.length;
      continue;
    }
    tokens.push({ text: raw, start: cursor, end: cursor + raw.length });
    cursor += raw.length;
  }

  const ranges = [];
  // Azure's Words[] should line up 1:1 with our whitespace tokens for a
  // correctly-attempted phrase. If EnableMiscue caused an extra/missing
  // word, lengths can drift -- zip only as far as both lists agree rather
  // than risk highlighting the wrong word.
  const n = Math.min(tokens.length, azureWords.length);
  for (let i = 0; i < n; i++) {
    const token = tokens[i];
    const aw = azureWords[i];
    const wordScore = aw?.PronunciationAssessment?.AccuracyScore;
    const errorType = aw?.PronunciationAssessment?.ErrorType;
    const phonemes = aw?.Phonemes || [];

    // Whole word reads as trouble (omitted entirely, or Azure gave no
    // phoneme breakdown to drill into) -- underline the whole token.
    if (errorType === 'Omission' || phonemes.length === 0) {
      if (errorType === 'Omission' || (typeof wordScore === 'number' && wordScore < CONFIG.MISPRONUNCIATION_HIGHLIGHT_THRESHOLD)) {
        ranges.push({ start: token.start, end: token.end });
      }
      continue;
    }

    const letters = token.text.length;
    const step = letters / phonemes.length;
    let open = null;
    phonemes.forEach((p, idx) => {
      const score = p?.PronunciationAssessment?.AccuracyScore;
      const segStart = token.start + Math.round(idx * step);
      const segEnd = token.start + Math.round((idx + 1) * step);
      const bad = typeof score === 'number' && score < CONFIG.MISPRONUNCIATION_HIGHLIGHT_THRESHOLD;
      if (bad) {
        if (open && open.end === segStart) {
          open.end = segEnd; // merge adjacent bad phonemes into one underline
        } else {
          open = { start: segStart, end: segEnd };
          ranges.push(open);
        }
      } else {
        open = null;
      }
    });
  }
  return ranges;
}

// Calls Azure AI Speech's Text-to-Speech REST API with a Neural voice and
// returns the raw MP3 bytes. Reuses the same Azure Speech key/region secrets
// as pronunciation assessment above -- no new secret needed. Azure's free
// tier includes a monthly Neural TTS character quota, which is the "free
// way to sound more natural" this replaces the browser's built-in
// (robotic-sounding) SpeechSynthesis voice with; the frontend falls back to
// SpeechSynthesis if this call fails for any reason (quota, network, etc).
export async function synthesizeSpeech(env, text) {
  const region = env.AZURE_SPEECH_REGION;
  const key = env.AZURE_SPEECH_KEY;

  const ssml =
    `<speak version="1.0" xml:lang="en-US">` +
    `<voice name="${CONFIG.TTS_VOICE}">${escapeSsml(text)}</voice>` +
    `</speak>`;

  const resp = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'minglish-pronunciation-tool',
    },
    body: ssml,
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Azure TTS error ${resp.status}: ${errText}`);
  }

  return resp.arrayBuffer();
}

function escapeSsml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
