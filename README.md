# English Speaking Practice — V1 Prototype

A daily pronunciation-practice tool: one Speaking Practice box, a login
streak + performance top bar, and a performance-over-time chart. Built for
one specific user (plus a test account), not a general signup product.

## Architecture

- **Frontend** (`index.html`, `styles.css`, `app.js`, at the repo root):
  static HTML/CSS/JS, meant to be served from GitHub Pages. No build step.
  Living at the root means your Pages URL is `https://yourusername.github.io/reponame/`
  with no extra path segment.
- **Backend** (`worker/`): a Cloudflare Worker that holds the Azure/Claude
  API keys, checks the email allowlist, and reads/writes Cloudflare D1.
- **Database**: Cloudflare D1 (serverless SQLite), schema in
  `worker/schema.sql`.
- **Pronunciation scoring**: Azure AI Speech's Pronunciation Assessment
  (free tier).
- **Word-list generation**: the Claude API, called from the Worker.

GitHub Pages can only serve static files — it can't hold API keys or run
server logic — which is why the backend lives on Cloudflare instead.

## One-time setup

### 1. Cloudflare D1 + Worker

```
cd worker
npm install -g wrangler   # if you don't have it
wrangler login
wrangler d1 create pronunciation-tool-db
```

Copy the `database_id` it prints into `worker/wrangler.toml` (replace
`REPLACE_WITH_YOUR_D1_DATABASE_ID`), then apply the schema:

```
wrangler d1 execute pronunciation-tool-db --remote --file=./schema.sql
```

Set the secrets (these are never committed to git):

```
wrangler secret put ALLOWED_EMAILS
# comma-separated, e.g.: you@gmail.com,test@gmail.com

wrangler secret put ANTHROPIC_API_KEY
wrangler secret put AZURE_SPEECH_KEY
wrangler secret put AZURE_SPEECH_REGION
# e.g. "eastus" -- must match the region of your Azure Speech resource
```

Deploy:

```
wrangler deploy
```

Note the `*.workers.dev` URL it prints — you'll need it in step 2.

### 2. Azure AI Speech resource

Create a free-tier Speech resource in the Azure Portal (portal.azure.com
→ Create a resource → search "Speech" -- it may show up as "Create an AI
Services resource for Speech" under the newer Foundry branding, same
underlying resource → pricing tier Free F0, 5 audio hours/month). Once it
deploys, go to the resource → Keys and Endpoint to grab the key and
region -- those are the two secrets above.

### 3. Frontend

Edit `app.js` and set `WORKER_URL` to the `*.workers.dev` URL from step
1. Then push this whole project to a GitHub repo and enable GitHub Pages
(Settings → Pages → deploy from branch, root as the source folder --
`index.html` sits at the repo root, so no subfolder is needed).

Once you know the GitHub Pages URL, also set `ALLOWED_ORIGIN` in
`worker/wrangler.toml` to that URL (e.g.
`https://yourusername.github.io`) and re-run `wrangler deploy`, so the
Worker only accepts requests from your page rather than any site (`*`).

### 4. Try it

Open the GitHub Pages URL, log in with one of the allowed emails, and
you should see a freshly generated 10-word practice set (this first call
also triggers the Claude word-list generation, so it may take a few
seconds).

## Sept 2026 update — feature-request round

Implements the requests from the "Minglish Feature Requests" doc: a working
performance chart, a simplified word popup (Mandarin translation + close
only), IPA transcription + speak button moved below the word, an example
sentence per word, accuracy-only attempt feedback, plus best-effort takes on
the three "see if there's a way" asks (mispronunciation highlighting, a more
natural TTS voice, faster scoring). Deploying it requires two things beyond
the usual `wrangler deploy`:

**1. Migrate the existing database.** This adds `ipa`/`example` columns to
`word_pool` and a `late_success` column to `daily_log` (see below):

```
cd worker
wrangler d1 execute pronunciation-tool-db --remote --file=./migrations/0001_add_ipa_example_and_late_success.sql
```

(A fresh install doesn't need this — `schema.sql` already has the new
columns.)

**2. Backfill IPA/example for the existing word pool.** New words get their
IPA transcription and example sentence generated automatically (same Claude
call that already generates the word/mandarin pair). Words already sitting
in the pool from before this change won't have them until either they
naturally cycle out after their 7-day cooldown, or you run this once per
user (repeat until `remaining` is 0 — each call processes one batch of 20):

```
curl -X POST https://your-worker-url.workers.dev/api/admin/backfill-details \
  -H "X-User-Email: you@gmail.com"
```

No new secrets needed — TTS reuses `AZURE_SPEECH_KEY`/`AZURE_SPEECH_REGION`,
and the backfill route reuses `ANTHROPIC_API_KEY`.

### What changed, and a few notes

- **Performance chart**: was only ever plotting days that already had a
  `daily_log` row, so a brand-new user's history could look empty even
  after practicing. `getHistory` (`worker/src/db.js`) now returns one entry
  for every calendar day from the user's first login through today,
  defaulting missing days to 0, per the spec. A past day's score freezes
  naturally once the date rolls over (new daily words live under a new
  date, so nothing can touch yesterday's rows anymore) — no separate
  snapshot/cron job needed. Today's entry keeps updating live as you
  answer, same as the top bar.
- **Mispronunciation highlighting**: Azure's Pronunciation Assessment
  already returns per-word AccuracyScore (exact) and per-phoneme
  AccuracyScore (via `Granularity: 'Phoneme'`, already requested). Word-level
  highlighting is exact; *within* a word, Azure doesn't tell us which
  letters map to which phoneme, so `buildMispronunciationRanges` in
  `worker/src/azure.js` approximates by splitting the word's letters evenly
  across its phonemes in order and underlining the ones that scored below
  `MISPRONUNCIATION_HIGHLIGHT_THRESHOLD` (60, in `config.js` — separate
  from the 80-point pass bar). Worth watching in practice to see if the
  underlined spans feel right; a real grapheme-to-phoneme aligner would be
  the next step up if not.
- **TTS voice**: swapped the popup's browser `SpeechSynthesisUtterance` for
  Azure's Neural TTS (`en-US-AvaNeural` by default, `TTS_VOICE` in
  `config.js`) via a new `/api/tts` route that proxies the request so the
  Azure key stays server-side. Azure's free tier includes a monthly Neural
  TTS character quota. Falls back to the old browser voice automatically if
  the Azure call fails for any reason (quota, network, etc).
- **Faster scoring**: the frontend now trims leading/trailing near-silence
  from a recording (with a small padding buffer) before encoding/uploading
  it, so tap-to-start/tap-to-stop dead air doesn't add to what Azure has to
  process. `format=detailed` is still required (that's what carries the
  phoneme data the highlighting feature above needs), so that wasn't
  something to trade off.
- **Fixed along the way**: the "late success" (yellow — "wrong today, but
  you eventually got it right") status was already fully built in the
  frontend/CSS and described in this README, but the deployed `daily_log`
  table never had a `late_success` column and `scoring.js` never set it, so
  that status could never actually fire — every retry-until-right word just
  stayed red for the day. Closed the loop: schema + migration now include
  the column, and `scoring.js` sets it. Also found a stray, unused `db.js`
  at the repo root (not the real one — that's `worker/src/db.js`, which is
  what's actually deployed) with an earlier, inconsistent draft of some of
  this logic; left it alone since nothing references it, but flagging it in
  case it's confusing to run into later.

## Decisions made while building this — please sanity-check

A few points in the spec were ambiguous or needed a concrete
implementation choice. Flagging them here so they're easy to revisit:

- **Scored-tries window** (`worker/src/config.js` → `MAX_SCORED_TRIES`):
  implemented as exactly 2 scored attempts — succeed on either and it's
  "correct," fail both and it locks in as "incorrect" for the day. The
  original doc said "wrong after three or more tries," which was a little
  ambiguous about whether a 3rd attempt gets to happen before locking.
  Easy to change to 3 if you'd rather give a third scored try.
- **A late success after lockout**: if a word is already locked in as
  "incorrect" for the day but the user keeps practicing and eventually
  nails it, today's score stays frozen (per your instructions), but the
  word is marked `passed` in the pool so it won't be re-selected
  tomorrow and enters the 7-day cooldown. If you'd rather a late success
  still show up again tomorrow (since it didn't count today), that's a
  one-line change in `scoring.js`.
- **Two-pass scoring criteria**: implemented as (1) Azure's speech
  recognizer actually matched the audio to the target text
  (`RecognitionStatus === "Success"`), and (2) the phoneme-level
  `AccuracyScore >= 80`. In practice, Azure's accuracy score already
  tends to be very low for a wrong word, so these two checks overlap
  somewhat — this is the most direct mapping of your two stated
  criteria onto what Azure actually returns.
- **Word-pool size**: soft target of ~100 total entries per user,
  topped up via Claude whenever the number of *eligible* words
  (untested, failed, or past their 7-day cooldown) drops below 20 —
  tunable in `config.js`.
- **Mic recording UX**: no fixed duration or silence detection — tap to
  start, tap again to stop and submit. Simplest thing that works; happy
  to add auto-stop-on-silence later if it feels clunky in practice.
- **Login**: no password, no session token — the browser just remembers
  the email in `localStorage` and the Worker re-checks it against the
  allowlist on every request. Fine for a private two-person tool; not
  meant to resist a determined attacker.
- **Chart**: uses Chart.js from cdnjs (no build step) and plots every
  day of history — with one user, the dataset stays small, so no
  windowing was added.

## Not yet built (out of scope for this V1 per our discussion)

Anything beyond the top bar, Speaking Practice box, and performance
chart — the doc mentions additional boxes "to be defined later."
