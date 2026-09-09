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

  wordCounter: document.getElementById('word-counter'),
  wordDisplay: document.getElementById('word-display'),
  wordPopup: document.getElementById('word-popup'),
  popupSpeak: document.getElementById('popup-speak'),
  popupTranslate: document.getElementById('popup-translate'),
  popupClose: document.getElementById('popup-close'),
  mandarinText: document.getElementById('mandarin-text'),

  micBtn: document.getElementById('mic-btn'),
  micStatus: document.getElementById('mic-status'),
  attemptFeedback: document.getElementById('attempt-feedback'),

  prevBtn: document.getElementById('prev-btn'),
  nextBtn: document.getElementById('next-btn'),

  chartCanvas: document.getElementById('performance-chart'),
  chartEmpty: document.getElementById('chart-empty'),
};

let chartInstance = null;

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

el.logoutBtn.addEventListener('click', () => {
  localStorage.removeItem(STORAGE_KEY);
  state = null;
  el.appScreen.hidden = true;
  el.loginScreen.hidden = false;
});

async function startApp(email) {
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

function renderWord() {
  const words = state.today.words;
  el.wordPopup.hidden = true;
  el.mandarinText.hidden = true;
  el.attemptFeedback.hidden = true;

  if (!words || words.length === 0) {
    el.wordDisplay.textContent = 'No words available today.';
    el.wordCounter.textContent = '0/0';
    el.micBtn.disabled = true;
    el.prevBtn.disabled = true;
    el.nextBtn.disabled = true;
    return;
  }

  const w = words[currentIndex];
  el.wordDisplay.textContent = w.text;
  el.mandarinText.textContent = w.mandarin;
  el.wordCounter.textContent = `${currentIndex + 1}/${words.length}`;
  el.micBtn.disabled = false;

  el.prevBtn.disabled = currentIndex === 0;
  el.nextBtn.disabled = currentIndex === words.length - 1;

  if (w.finalStatus === 'correct') {
    showFeedback('correct', 'Marked correct for today.');
  } else if (w.finalStatus === 'incorrect') {
    showFeedback('incorrect', "Marked incorrect for today — you can keep practicing this one.");
  }
}

el.wordDisplay.addEventListener('click', () => {
  el.wordPopup.hidden = !el.wordPopup.hidden;
});

el.popupSpeak.addEventListener('click', () => {
  const utter = new SpeechSynthesisUtterance(currentWord().text);
  utter.lang = 'en-US';
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utter);
});

el.popupTranslate.addEventListener('click', () => {
  el.mandarinText.hidden = !el.mandarinText.hidden;
});

el.popupClose.addEventListener('click', () => {
  el.wordPopup.hidden = true;
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
        submitAttempt(wavBlob);
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

async function submitAttempt(blob) {
  const w = currentWord();
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
    applyAttemptResult(result);
  } catch (err) {
    el.micStatus.textContent = err.message || 'Something went wrong scoring that attempt.';
  }
}

function applyAttemptResult(result) {
  el.micStatus.textContent = 'Tap the mic and say the word or phrase above.';

  // Update local word state so re-rendering reflects tries/finalStatus
  // without a full reload.
  const w = currentWord();
  w.tries = result.tries;
  if (result.finalStatus) w.finalStatus = result.finalStatus;

  const acc = Math.round(result.accuracyScore ?? 0);

  if (result.finalStatus === 'correct') {
    showFeedback('correct', `Nice — that counted as correct (heard: "${result.recognizedText}", accuracy: ${acc}%).`);
  } else if (result.finalStatus === 'incorrect') {
    showFeedback('incorrect', `Marked incorrect for today (heard: "${result.recognizedText}", accuracy: ${acc}%). Keep practicing — it'll come back tomorrow.`);
  } else if (result.passed) {
    // Passed a free retry on an already-decided word.
    showFeedback('correct', `That one sounded right (heard: "${result.recognizedText}", accuracy: ${acc}%).`);
  } else {
    showFeedback('pending', `Not quite (heard: "${result.recognizedText}", accuracy: ${acc}%) — try again.`);
  }

  // TEMPORARY: surface Azure's raw response on-screen so it can be read
  // directly off the phone while we're debugging the 0%-accuracy issue.
  // No index.html changes needed -- this builds its own element.
  if (result.debugRaw) {
    let debugEl = document.getElementById('debug-raw');
    if (!debugEl) {
      debugEl = document.createElement('pre');
      debugEl.id = 'debug-raw';
      debugEl.style.cssText =
        'white-space: pre-wrap; word-break: break-word; font-size: 11px; ' +
        'background: #f3f4f6; border-radius: 8px; padding: 10px; margin-top: 12px; ' +
        'max-height: 300px; overflow-y: auto; -webkit-user-select: text; user-select: text;';
      el.attemptFeedback.insertAdjacentElement('afterend', debugEl);
    }
    debugEl.textContent = JSON.stringify(result.debugRaw, null, 2);
  }

  // Refresh top-bar performance from the server so the percentage stays
  // authoritative (cheap call, keeps client/server in sync).
  refreshPerformanceOnly();

  // Auto-advance only when a word is *newly* decided as correct.
  if (result.finalStatus === 'correct' && currentIndex < state.today.words.length - 1) {
    setTimeout(() => {
      currentIndex += 1;
      renderWord();
    }, 1200);
  }
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
