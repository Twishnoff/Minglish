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
