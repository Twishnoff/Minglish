// ---- Attempt-recording store -----------------------------------------------
//
// Keeps the most recent voice recording for each word so the user can replay
// what they just said (the replay button next to the mic).
//
// Deliberately client-side only: audio never goes to the Worker or D1, which
// keeps the "we don't store recordings" property of the backend intact. Held
// in IndexedDB rather than plain memory so a page refresh (easy to do by
// accident on a phone) doesn't wipe the playback, and scoped by the server's
// Pacific-time date string so recordings disappear on their own when the
// calendar day rolls over. Logging out clears everything immediately.
//
// Exposes a single global, `RecordingStore`, loaded before app.js. The
// existence check (`has`) is synchronous against an in-memory key set
// hydrated at init, so the button's enabled/disabled state can be decided
// during a render without an async round trip (and therefore without a
// visible flicker).

const RecordingStore = (() => {
  const DB_NAME = 'minglish-recordings';
  const DB_VERSION = 1;
  const STORE = 'recordings';

  let db = null;              // IDBDatabase, or null if IndexedDB is unusable
  let currentDate = null;     // the Pacific date string recordings are scoped to
  const keys = new Set();     // keys known to exist, for synchronous has()
  const memoryFallback = new Map(); // key -> Blob, used when IndexedDB fails

  function keyFor(date, wordId) {
    return `${date}:${wordId}`;
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      if (!self.indexedDB) return reject(new Error('IndexedDB unavailable'));
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const database = req.result;
        if (!database.objectStoreNames.contains(STORE)) {
          const store = database.createObjectStore(STORE, { keyPath: 'key' });
          store.createIndex('date', 'date', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    });
  }

  function tx(mode) {
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  function promisify(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // Opens the database, drops anything left over from a previous calendar
  // day, and loads the surviving keys into memory. Safe to call again when
  // the date changes (a session left open past midnight Pacific) -- it just
  // re-purges against the new date.
  async function init(date) {
    currentDate = date;
    keys.clear();

    if (!db) {
      try {
        db = await openDb();
      } catch (err) {
        console.warn('Recording playback falling back to memory only:', err);
        db = null;
        // Memory fallback still has to respect the day boundary.
        for (const key of [...memoryFallback.keys()]) {
          if (!key.startsWith(`${date}:`)) memoryFallback.delete(key);
        }
        for (const key of memoryFallback.keys()) keys.add(key);
        return;
      }
    }

    try {
      const all = await promisify(tx('readonly').getAllKeys());
      const stale = all.filter((key) => !String(key).startsWith(`${date}:`));
      if (stale.length) {
        const store = tx('readwrite');
        stale.forEach((key) => store.delete(key));
      }
      all.filter((key) => String(key).startsWith(`${date}:`)).forEach((key) => keys.add(String(key)));
    } catch (err) {
      console.warn("Couldn't read stored recordings:", err);
    }
  }

  // Stores (and replaces) the recording for one word. Normalizes the blob's
  // type to plain audio/wav -- what MediaRecorder/our encoder produce carries
  // extra codec parameters that some browsers won't accept back as an
  // <audio> source.
  async function save(date, wordId, blob) {
    const key = keyFor(date, wordId);
    const playable = new Blob([await blob.arrayBuffer()], { type: 'audio/wav' });

    if (!db) {
      memoryFallback.set(key, playable);
      keys.add(key);
      return;
    }

    try {
      await promisify(tx('readwrite').put({ key, date, wordId, blob: playable, savedAt: Date.now() }));
      keys.add(key);
    } catch (err) {
      // Quota exhausted, private-mode restrictions, etc. Replay still works
      // for this session, it just won't survive a refresh.
      console.warn("Couldn't persist recording, keeping it in memory:", err);
      memoryFallback.set(key, playable);
      keys.add(key);
    }
  }

  async function get(date, wordId) {
    const key = keyFor(date, wordId);
    if (memoryFallback.has(key)) return memoryFallback.get(key);
    if (!db) return null;
    try {
      const row = await promisify(tx('readonly').get(key));
      return row ? row.blob : null;
    } catch (err) {
      console.warn("Couldn't read back recording:", err);
      return null;
    }
  }

  // Synchronous, so render code can decide the replay button's state inline.
  function has(date, wordId) {
    return keys.has(keyFor(date, wordId));
  }

  async function clear() {
    keys.clear();
    memoryFallback.clear();
    if (!db) return;
    try {
      await promisify(tx('readwrite').clear());
    } catch (err) {
      console.warn("Couldn't clear stored recordings:", err);
    }
  }

  return { init, save, get, has, clear, get currentDate() { return currentDate; } };
})();
