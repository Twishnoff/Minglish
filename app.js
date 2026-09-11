// ---- Configuration -----------------------------------------------------
// Set this to your deployed Worker's URL after `wrangler deploy`, e.g.
// "https://pronunciation-tool.yourname.workers.dev". No trailing slash.
const WORKER_URL = 'https://pronunciation-tool.tyler-wishnoff.workers.dev';

const STORAGE_KEY = 'pronunciation-tool-email';

// ---- State ---------------------------------------------------------------
let state = null;        // last /api/state response
let currentIndex = 0;    // index into state.today.words
let recorder = null;
let recordedChunks = [];
let isRecording = false;

// ---- Elements --------------------------------------------------------------
const el = {
  loginScreen: document.getElementById('login-screen'),
  appScreen: document.getElementById('app-screen'),
  loginForm: document.getElementById('login-form'),
  loginEmail: document.getElementById('login-email'),
  loginError: document.getElementById('login-error'),
  logoutBtn: document.getElementById('logout-btn'),

  streakValue: document.getElementById('streak-value'),
  performanceValue: document.getElementById('performance-value'),

  practiceBox: document.getElementById('practice-box'),
  wordCounter: document.getElementById('word-counter'),
  wordDisplay: document.getElementById('word-display'),
  wordIpa: document.getElementById('word-ipa'),
  speakBtn: document.getElementById('speak-btn'),
  wordPopup: document.getElementById('word-popup'),
  popupMandarin: document.getElementById('popup-mandarin'),
  popupClose: document.getElementById('popup-close'),

  micBtn: document.getElementById('mic-btn'),
  replayBtn: document.getElementById('replay-btn'),
  micStatus: document.getElementById('mic-status'),
  attemptFeedback: document.getElementById('attempt-feedback'),

  prevBtn: document.getElementById('prev-btn'),
  nextBtn: document.getElementById('next-btn'),
  exampleSentence: document.getElementById('example-sentence'),

  chartCanvas: document.getElementById('performance-chart'),
  chartEmpty: document.getElementById('chart-empty'),
};

let chartInstance = null;
let ttsAudio = null;    // currently-playing Azure TTS <audio>, if any
let replayAudio = null; // currently-playing attempt-playback <audio>, if any

// The word that was on screen when recording started. Used instead of
// re-reading currentWord() once recording stops, so a swipe/arrow press
// mid-recording can't file the audio (or the resulting score) against a
// different word than the one the user was actually looking at.
let recordingWord = null;

// ---- Login / logout --------------------------------------------------------

el.loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = el.loginEmail.value.trim().toLowerCase();
  el.loginError.hidden = true;
  try {
    const resp = await fetch(`${WORKER_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (!resp.ok) throw new Error('not-recognized');
    localStorage.setItem(STORAGE_KEY, email);
    await startApp(email);
  } catch {
    el.loginError.textContent = "That email isn't recognized.";
    el.loginError.hidden = false;
  }
});

el.logoutBtn.addEventListener('click', async () => {
  localStorage.removeItem(STORAGE_KEY);
  state = null;
  stopReplay();
  // Attempt recordings are session-scoped -- logging out drops them.
  await RecordingStore.clear();
  el.appScreen.hidden = true;
  el.loginScreen.hidden = false;
});

async function startApp(email) {
  currentIndex = 0;
  el.loginScreen.hidden = true;
  el.appScreen.hidden = false;
  await loadState(email);
}

// ---- Loading state ----------------------------------------------------------

async function loadState(email) {
  const resp = await fetch(`${WORKER_URL}/api/state`, {
    headers: { 'X-User-Email': email },
  });
  if (resp.status === 401) {
    localStorage.removeItem(STORAGE_KEY);
    el.appScreen.hidden = true;
    el.loginScreen.hidden = false;
    return;
  }
  state = await resp.json();
  currentIndex = 0;
  // Scope stored recordings to the server's Pacific date, so anything left
  // over from a previous day is dropped rather than replayed under today's
  // words. Must finish before the first renderWord(), which reads the store
  // to decide whether the replay button is enabled.
  await RecordingStore.init(state.today.date);
  renderTopBar();
  renderWord();
  renderChart();
}

function currentEmail() {
  return localStorage.getItem(STORAGE_KEY);
}

// ---- Top bar ------------------------------------------------------------

function renderTopBar() {
  el.streakValue.textContent = state.streak;
  const pct = state.today.percent;
  el.performanceValue.textContent = pct === null ? '—' : `${pct}%`;
  el.performanceValue.classList.remove('perf-green', 'perf-orange', 'perf-red');
  if (pct !== null) {
    if (pct > 80) el.performanceValue.classList.add('perf-green');
    else if (pct >= 65) el.performanceValue.classList.add('perf-orange');
    else el.performanceValue.classList.add('perf-red');
  }
}

// ---- Speaking Practice box ------------------------------------------------

function currentWord() {
  return state.today.words[currentIndex];
}

// White/neutral = untried, or one failed try so far (still undecided).
// Green = correct within the first 2 scored tries.
// Yellow = eventually got it right, but only after being marked wrong.
// Light red = wrong after 2 tries, not redeemed yet.
function wordBoxClass(w) {
  if (w.finalStatus === 'correct') return 'status-correct';
  if (w.finalStatus === 'incorrect') return w.lateSuccess ? 'status-late' : 'status-incorrect';
  return '';
}

function applyBoxClass(w) {
  el.practiceBox.classList.remove('status-correct', 'status-late', 'status-incorrect');
  const cls = wordBoxClass(w);
  if (cls) el.practiceBox.classList.add(cls);
}

function renderWord() {
  const words = state.today.words;
  el.wordPopup.hidden = true;
  el.attemptFeedback.hidden = true;
  // Playback belongs to the word that was on screen -- moving off it stops
  // whatever is mid-play rather than letting it run over the next word.
  stopReplay();
  updateReplayButton();

  if (!words || words.length === 0) {
    setWordDisplayText('No words available today.');
    el.wordIpa.textContent = '';
    el.exampleSentence.textContent = '';
    el.wordCounter.textContent = '0/0';
    el.micBtn.disabled = true;
    el.prevBtn.disabled = true;
    el.nextBtn.disabled = true;
    el.practiceBox.classList.remove('status-correct', 'status-late', 'status-incorrect');
    return;
  }

  const w = words[currentIndex];
  setWordDisplayText(w.text);
  el.wordIpa.textContent = w.ipa || '';
  el.popupMandarin.textContent = w.mandarin;
  el.exampleSentence.textContent = w.example || '';
  el.wordCounter.textContent = `${currentIndex + 1}/${words.length}`;
  el.micBtn.disabled = false;

  el.prevBtn.disabled = currentIndex === 0;
  el.nextBtn.disabled = currentIndex === words.length - 1;

  applyBoxClass(w);

  if (w.finalStatus === 'correct') {
    showFeedback('correct', 'Marked correct for today.');
  } else if (w.finalStatus === 'incorrect') {
    showFeedback(
      w.lateSuccess ? 'late' : 'incorrect',
      w.lateSuccess
        ? 'Marked incorrect for today\'s score, but you eventually got it right — nice work.'
        : "Marked incorrect for today — you can keep practicing this one."
    );
  }
}

// Sets the practice word's plain text, clearing any mispronunciation
// underline left over from a previous attempt (see renderMispronunciation).
function setWordDisplayText(text) {
  el.wordDisplay.textContent = text;
}

// Popup now shows just the Mandarin translation + a close button (per the
// Sept 2026 feature-request doc). It opens on a word click, and closes on
// its own close button OR a click/tap anywhere else on the page.
el.wordDisplay.addEventListener('click', (e) => {
  e.stopPropagation();
  el.wordPopup.hidden = !el.wordPopup.hidden;
});

el.popupClose.addEventListener('click', (e) => {
  e.stopPropagation();
  el.wordPopup.hidden = true;
});

// Stop clicks inside the popup itself from bubbling to the document-level
// "close on any click" handler below (otherwise the popup could never be
// interacted with -- every click on it would immediately close it).
el.wordPopup.addEventListener('click', (e) => {
  e.stopPropagation();
});

document.addEventListener('click', () => {
  if (!el.wordPopup.hidden) el.wordPopup.hidden = true;
});

// ---- Speak button (Azure Neural TTS, falls back to the browser's voice) ---

el.speakBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  const text = currentWord().text;
  try {
    await playAzureTts(text);
  } catch (err) {
    console.error('Azure TTS failed, falling back to browser voice:', err);
    speakWithBrowserVoice(text);
  }
});

function speakWithBrowserVoice(text) {
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'en-US';
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utter);
}

async function playAzureTts(text) {
  const email = currentEmail();
  const resp = await fetch(`${WORKER_URL}/api/tts?text=${encodeURIComponent(text)}`, {
    headers: { 'X-User-Email': email },
  });
  if (!resp.ok) throw new Error('TTS request failed');
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  if (ttsAudio) {
    ttsAudio.pause();
    URL.revokeObjectURL(ttsAudio.src);
  }
  ttsAudio = new Audio(url);
  await ttsAudio.play();
}

// ---- Replay the user's own last attempt ------------------------------------
// Recordings live only in the browser (see recordings.js) -- audio is never
// uploaded, and the store is scoped to today's date and cleared on logout.

// Enables the button only when there's a recording stored for the word
// currently on screen, and keeps the tooltip honest about why it's off.
function updateReplayButton() {
  const words = state?.today?.words;
  const w = words && words.length > 0 ? words[currentIndex] : null;
  const available = !!w && RecordingStore.has(state.today.date, w.wordId);

  el.replayBtn.disabled = !available;
  el.replayBtn.title = available
    ? 'Hear your last attempt at this word'
    : 'Record an attempt first to hear it back';
}

function stopReplay() {
  if (!replayAudio) return;
  replayAudio.pause();
  URL.revokeObjectURL(replayAudio.src);
  replayAudio = null;
  el.replayBtn.classList.remove('playing');
}

el.replayBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  if (el.replayBtn.disabled) return;

  // Pressing it again while it's playing stops the playback.
  if (replayAudio) {
    stopReplay();
    return;
  }

  const w = currentWord();
  const blob = await RecordingStore.get(state.today.date, w.wordId);
  if (!blob) {
    // Store and button state drifted apart somehow -- resync rather than
    // leaving a button that looks live but does nothing.
    updateReplayButton();
    return;
  }

  // Don't talk over the reference pronunciation if that's still playing.
  if (ttsAudio) ttsAudio.pause();

  replayAudio = new Audio(URL.createObjectURL(blob));
  replayAudio.addEventListener('ended', stopReplay);
  replayAudio.addEventListener('error', stopReplay);
  el.replayBtn.classList.add('playing');
  try {
    await replayAudio.play();
  } catch (err) {
    console.error('Playback failed:', err);
    stopReplay();
  }
});

el.prevBtn.addEventListener('click', () => {
  if (currentIndex > 0) {
    currentIndex -= 1;
    renderWord();
  }
});

el.nextBtn.addEventListener('click', () => {
  if (currentIndex < state.today.words.length - 1) {
    currentIndex += 1;
    renderWord();
  }
});

// ---- Swipe navigation (mobile) ---------------------------------------------
// Left swipe -> next word, right swipe -> previous word. Reuses the same
// arrow buttons' click handlers so the enabled/disabled-at-the-ends logic
// only lives in one place.
(function setUpSwipeNav() {
  let startX = 0;
  let startY = 0;

  el.practiceBox.addEventListener(
    'touchstart',
    (e) => {
      startX = e.changedTouches[0].screenX;
      startY = e.changedTouches[0].screenY;
    },
    { passive: true }
  );

  el.practiceBox.addEventListener(
    'touchend',
    (e) => {
      const dx = e.changedTouches[0].screenX - startX;
      const dy = e.changedTouches[0].screenY - startY;
      const SWIPE_THRESHOLD = 50;
      // Require a mostly-horizontal gesture so vertical scrolling (or a
      // simple tap on the mic/word/arrows) doesn't get mistaken for a swipe.
      if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) < Math.abs(dy)) return;
      if (dx < 0 && !el.nextBtn.disabled) {
        el.nextBtn.click();
      } else if (dx > 0 && !el.prevBtn.disabled) {
        el.prevBtn.click();
      }
    },
    { passive: true }
  );
})();

function showFeedback(kind, message) {
  el.attemptFeedback.hidden = false;
  el.attemptFeedback.className = `attempt-feedback ${kind}`;
  el.attemptFeedback.textContent = message;
}

// ---- Mic recording --------------------------------------------------------

el.micBtn.addEventListener('click', async () => {
  if (isRecording) {
    stopRecording();
  } else {
    await startRecording();
  }
});

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    // Pin the word as of when recording began -- everything downstream
    // (the saved recording, the score, the feedback line) is filed against
    // this word even if the user navigates away while it's in flight.
    recordingWord = currentWord();
    const targetWord = recordingWord;
    stopReplay();
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const rawBlob = new Blob(recordedChunks, { type: recorder.mimeType });
      try {
        // Different browsers hand MediaRecorder different default codecs
        // (Chrome/Android: webm/opus, Safari/iOS: mp4/AAC) and Azure's
        // speech endpoint doesn't reliably handle all of them -- on iOS in
        // particular this was coming back as recognized text "." (i.e.
        // nothing usable). Converting to a plain 16kHz mono WAV client-side
        // sidesteps the whole issue by always sending a format Azure
        // definitely supports, regardless of what the phone recorded in.
        const wavBlob = await convertToWav(rawBlob);
        // Store it before scoring, not after: if the Azure call fails or
        // the network drops, the user can still hear what they said.
        await RecordingStore.save(state.today.date, targetWord.wordId, wavBlob);
        updateReplayButton();
        submitAttempt(wavBlob, targetWord);
      } catch (err) {
        console.error('Audio conversion failed:', err);
        el.micStatus.textContent = "Couldn't process that recording -- try again.";
      }
    };
    recorder.start();
    isRecording = true;
    el.micBtn.classList.add('recording');
    el.micStatus.textContent = 'Listening… tap again when you’re done.';
  } catch (err) {
    el.micStatus.textContent = "Couldn't access your microphone. Check your browser's permission settings.";
  }
}

function stopRecording() {
  if (recorder && recorder.state !== 'inactive') {
    recorder.stop();
  }
  isRecording = false;
  el.micBtn.classList.remove('recording');
  el.micStatus.textContent = 'Scoring your pronunciation…';
}

// Decodes whatever the browser recorded (webm/opus, mp4/aac, etc.) and
// re-encodes it as 16kHz mono 16-bit PCM WAV -- the format Azure's speech
// endpoint expects most reliably across every browser/OS combination.
async function convertToWav(blob) {
  const TARGET_SAMPLE_RATE = 16000;
  const arrayBuffer = await blob.arrayBuffer();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const decodeCtx = new AudioCtx();
  let audioBuffer;
  try {
    audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer);
  } finally {
    decodeCtx.close();
  }

  const offlineCtx = new OfflineAudioContext(
    1,
    Math.ceil(audioBuffer.duration * TARGET_SAMPLE_RATE),
    TARGET_SAMPLE_RATE
  );
  const source = offlineCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offlineCtx.destination);
  source.start(0);
  const rendered = await offlineCtx.startRendering();
  const samples = rendered.getChannelData(0);

  return encodeWav(samples, TARGET_SAMPLE_RATE);
}

// Trims leading/trailing near-silence so we upload (and Azure has to
// process) only the part of the recording that actually has speech in it --
// shaves noticeable time off scoring for recordings with dead air at the
// start/end, which tap-to-start/tap-to-stop recording produces a lot of.
// Keeps a small padding buffer on each side so the word itself never gets
// clipped.
function trimSilence(samples, sampleRate) {
  const SILENCE_THRESHOLD = 0.015; // amplitude below this counts as silence
  const PADDING_MS = 150;
  const padding = Math.round((PADDING_MS / 1000) * sampleRate);

  let start = 0;
  while (start < samples.length && Math.abs(samples[start]) < SILENCE_THRESHOLD) start++;
  let end = samples.length - 1;
  while (end > start && Math.abs(samples[end]) < SILENCE_THRESHOLD) end--;

  // Recording was entirely (near-)silent -- send it through untouched
  // rather than trimming it to nothing, so Azure still returns a real
  // (failing) result instead of us fabricating one.
  if (end <= start) return samples;

  const trimmedStart = Math.max(0, start - padding);
  const trimmedEnd = Math.min(samples.length, end + padding);
  return samples.subarray(trimmedStart, trimmedEnd);
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);        // PCM chunk size
  view.setUint16(20, 1, true);         // audio format: 1 = PCM
  view.setUint16(22, 1, true);         // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (sampleRate * blockAlign)
  view.setUint16(32, 2, true);         // block align (channels * bytesPerSample)
  view.setUint16(34, 16, true);        // bits per sample
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Blob([buffer], { type: 'audio/wav; codecs=audio/pcm; samplerate=16000' });
}

async function submitAttempt(blob, word) {
  const w = word || currentWord();
  const email = currentEmail();
  try {
    const resp = await fetch(
      `${WORKER_URL}/api/attempt?wordId=${w.wordId}&text=${encodeURIComponent(w.text)}`,
      {
        method: 'POST',
        headers: {
          'X-User-Email': email,
          'Content-Type': blob.type || 'audio/wav; codecs=audio/pcm; samplerate=16000',
        },
        body: blob,
      }
    );
    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      throw new Error(errBody.error || 'Scoring failed.');
    }
    const result = await resp.json();
    applyAttemptResult(result, w);
  } catch (err) {
    el.micStatus.textContent = err.message || 'Something went wrong scoring that attempt.';
  }
}

function applyAttemptResult(result, word) {
  el.micStatus.textContent = 'Tap the mic to begin speaking the word. Tap again when finished to submit.';

  // Update local word state so re-rendering reflects tries/finalStatus
  // without a full reload.
  const w = word || currentWord();
  w.tries = result.tries;
  if (result.finalStatus) w.finalStatus = result.finalStatus;
  if (typeof result.lateSuccess === 'boolean') w.lateSuccess = result.lateSuccess;

  // If the user navigated to a different word while this attempt was being
  // scored, the stored state above is still correct, but painting this
  // result onto the screen would attach it to the wrong word. Update the
  // data, skip the display.
  if (w !== currentWord()) {
    refreshPerformanceOnly();
    return;
  }

  applyBoxClass(w);

  renderMispronunciation(w.text, result.mispronouncedRanges || []);

  const acc = Math.round(result.accuracyScore ?? 0);
  const accLine = `Your pronunciation accuracy - ${acc}%.`;

  if (result.finalStatus === 'correct') {
    showFeedback('correct', `${accLine} Marked correct for today.`);
  } else if (result.finalStatus === 'incorrect' && result.passed) {
    // Locked in wrong for today, but they just proved they can say it --
    // today's tally doesn't change, but it won't come back tomorrow either.
    showFeedback('late', `${accLine} Won't change today's score, but nice work getting there.`);
  } else if (result.finalStatus === 'incorrect') {
    showFeedback('incorrect', `${accLine} Marked incorrect for today — keep practicing, it'll come back tomorrow.`);
  } else if (result.passed) {
    // Passed a free retry on an already-correct word.
    showFeedback('correct', `${accLine} That one sounded right.`);
  } else {
    showFeedback('pending', `${accLine} Not quite — try again.`);
  }

  // Refresh top-bar performance from the server so the percentage stays
  // authoritative (cheap call, keeps client/server in sync).
  refreshPerformanceOnly();

  // Deliberately no auto-advance on a correct answer: the user stays on the
  // word so they can replay the attempt, hear the reference pronunciation,
  // or just say it again. Moving on is always an explicit arrow press or
  // swipe.
}

// Redraws the practice word with the letters Azure's pronunciation
// assessment scored lowest on (per the most recent attempt) underlined in
// deep red -- see azure.js buildMispronunciationRanges on the backend for
// how those ranges are derived (word-level is exact; sub-word placement
// within a word is a heuristic approximation).
function renderMispronunciation(text, ranges) {
  if (!ranges || ranges.length === 0) {
    setWordDisplayText(text);
    return;
  }
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  el.wordDisplay.textContent = '';
  let cursor = 0;
  for (const r of sorted) {
    const start = Math.max(cursor, Math.min(r.start, text.length));
    const end = Math.max(start, Math.min(r.end, text.length));
    if (start > cursor) el.wordDisplay.appendChild(document.createTextNode(text.slice(cursor, start)));
    if (end > start) {
      const span = document.createElement('span');
      span.className = 'mispronounced';
      span.textContent = text.slice(start, end);
      el.wordDisplay.appendChild(span);
    }
    cursor = Math.max(cursor, end);
  }
  if (cursor < text.length) el.wordDisplay.appendChild(document.createTextNode(text.slice(cursor)));
}

async function refreshPerformanceOnly() {
  const email = currentEmail();
  const resp = await fetch(`${WORKER_URL}/api/state`, { headers: { 'X-User-Email': email } });
  if (!resp.ok) return;
  const fresh = await resp.json();
  state.streak = fresh.streak;
  state.today.correct = fresh.today.correct;
  state.today.total = fresh.today.total;
  state.today.percent = fresh.today.percent;
  state.history = fresh.history;
  renderTopBar();
  renderChart();
}

// ---- Chart ----------------------------------------------------------------

function renderChart() {
  const history = state.history || [];
  if (history.length === 0) {
    el.chartEmpty.hidden = false;
    el.chartCanvas.hidden = true;
    return;
  }
  el.chartEmpty.hidden = true;
  el.chartCanvas.hidden = false;

  const labels = history.map((h) => h.date);
  const data = history.map((h) => h.score);

  if (chartInstance) {
    chartInstance.data.labels = labels;
    chartInstance.data.datasets[0].data = data;
    chartInstance.update();
    return;
  }

  chartInstance = new Chart(el.chartCanvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Daily performance %',
        data,
        borderColor: '#4f46e5',
        backgroundColor: 'rgba(79, 70, 229, 0.1)',
        tension: 0.25,
        fill: true,
        pointRadius: 3,
      }],
    },
    options: {
      responsive: true,
      scales: { y: { min: 0, max: 100 } },
      plugins: { legend: { display: false } },
    },
  });
}

// ---- Boot -------------------------------------------------------------------

(async function init() {
  const savedEmail = currentEmail();
  if (savedEmail) {
    await startApp(savedEmail);
  }
})();
