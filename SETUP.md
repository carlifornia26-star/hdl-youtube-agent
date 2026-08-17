# HDL Daily YouTube Teaser — one-time setup

Everything after this runs automatically, once a day, with no intervention. This setup can be done
entirely from a phone browser (GitHub and Google Cloud Console both work on mobile web).

## 1. Create the repo
- github.com → New repository → e.g. `hdl-youtube-agent` → **Public** (required for free unlimited
  Actions minutes — Private repos only get 2,000 free minutes/month, which this may exceed)
- Upload this whole folder's contents to it (GitHub's web uploader accepts a drag-and-drop of files,
  or a zip you extract into the repo — no `git` command line needed)

## 2. Get YouTube API credentials
1. console.cloud.google.com → new project → **APIs & Services → Library** → enable "YouTube Data API v3"
2. **APIs & Services → Credentials** → Create Credentials → OAuth client ID → type "Desktop app"
   → save the Client ID and Client Secret
3. **OAuth consent screen** → add your own Google account (the one that owns the
   @Highdefinitionlearning channel) as a test user
4. One-time only — get a refresh token: go to https://developers.google.com/oauthplayground →
   gear icon (top right) → check "Use your own OAuth credentials" → paste your Client ID/Secret →
   in the left panel find "YouTube Data API v3" → select `.../auth/youtube.upload` and
   `.../auth/youtube.force-ssl` → Authorize → sign in with the channel's Google account →
   "Exchange authorization code for tokens" → copy the **Refresh token** shown

## 3. Get a free Pexels API key
- pexels.com/api → sign up → copy your API key (free, no card, generous daily limit)

## 4. Get Cloudflare credentials (you likely already have these from the article engine)
- `CF_ACCOUNT_ID`: Cloudflare dashboard → right sidebar of any domain overview page
- `CF_API_TOKEN`: My Profile → API Tokens → Create Token → template "Workers AI" (read/edit)

## 5. Voice narration — no setup needed (local, free, automatic)
Narration now runs via Kokoro-82M (Apache 2.0, open weights), downloaded and run locally inside
the GitHub Actions job itself — no account, no API key, no cost, no expiring promo. This is the
default path and needs nothing from you.

Fish Audio is kept as a **fallback only**, in case Kokoro ever fails on a given run:
1. Optional — fish.audio → sign up → fish.audio/app/api-keys → create a key → save it as
   `FISH_API_KEY`. Leave unset entirely if you don't want a fallback; Kokoro failing without a
   fallback just means that scene (or the whole video, in a worst case) falls back to
   captions-only, same as any other narration failure.
2. If you do set it up: as of Aug 2026, Fish Audio's S2.1 Pro model was free under fair use
   through **Aug 31, 2026** — check fish.audio/pricing for current status, since it's only a
   backup path now and doesn't need to work every day.
3. Optional voice — `FISH_VOICE_ID`, same as before, only relevant if the fallback actually runs.

## 5b. Get an Unsplash access key (thumbnails)
unsplash.com/developers → create an app → copy the "Access Key" → save it as
`UNSPLASH_ACCESS_KEY`. Free forever, no card, 50 requests/hour (this uses ~1/day).

## 6. Add all secrets to the repo
Repo → Settings → Secrets and variables → Actions → New repository secret, one each for:
`CF_ACCOUNT_ID`, `CF_API_TOKEN`, `PEXELS_API_KEY`, `UNSPLASH_ACCESS_KEY`, `YT_CLIENT_ID`,
`YT_CLIENT_SECRET`, `YT_REFRESH_TOKEN`

Optional (Fish Audio fallback only): `FISH_API_KEY`, `FISH_VOICE_ID`

Optional: Settings → Secrets and variables → Actions → **Variables** tab → add `DRY_RUN_PRIVATE` = `true`
for your first few test runs, so videos upload as Private instead of Public while you check quality.
Switch it to `false` (or delete it) once you're happy.

## 7. Test it
Repo → Actions tab → "HDL Daily YouTube Teaser" → Run workflow (manual trigger button) — don't wait
for tomorrow's cron. Watch the run log; if it fails, the error will point at which step (script
generation, stock footage, voiceover, render, or upload).

---

## Honest limits to know about
- **Background music, real and licensed.** Every video/Short mixes in a quiet bed (`MUSIC_VOLUME`
  in `render.js`, 0.07 — well under the narration) from a small curated set of tracks (`scripts/music.js`),
  rotated daily. Source: incompetech.com's own documented catalog JSON
  (incompetech.com/music/royalty-free/pieces.json) — a real, free, commercially-usable source,
  not a scraped or guessed one. License is Creative Commons By Attribution 4.0: free including
  monetized use, attribution required — which is why an attribution line gets auto-appended to
  every description (English and all 15 translations). If music download/mix fails for any
  reason, the run falls back to uploading without it rather than failing.
- **Title mentioned exactly 3 times** is a prompt instruction to the script model
  (`cf-ai.js`), not something code enforces — LLMs don't always hit numeric constraints exactly.
  The Actions log will print a warning line if a run's actual count isn't 3, so you can see when
  it drifts without watching the video yourself.
- **Narration pace (`NARRATION_SPEED` in `voice.js`) is now 1.05** — a light nudge for word count,
  not the 1.15 from before. Expect actual runtime to land more like **11-12 minutes** now, not 10 —
  slower narration plus the same word target pushes it up a bit. If that's too long, either trim
  the word-count target in `cf-ai.js` or nudge `NARRATION_SPEED` back up slightly.
- **One narrator voice per video, rotating daily.** Every scene in a given day's video (and its
  Short) now uses the SAME Kokoro voice — no more mixed voices within one video. Which voice
  depends on the day, cycling through an 11-voice pool (`VOICE_POOL` in `voice.js`) so tomorrow's
  video sounds different from today's. Set the `KOKORO_VOICE` secret/env var to pin every video to
  one fixed voice instead. This only applies to the primary Kokoro path — if a run falls all the
  way back to Fish Audio (see the preflight check below), that fallback still uses whatever
  `FISH_VOICE_ID` is set to (or Fish's own default if unset), same as before.
- **Captions bug fix.** The English caption upload wasn't wrapped in a try/catch, so if it threw
  for any reason, it silently ended the whole run right after the main video and Short had already
  uploaded — which is almost certainly why your last video had no captions at all. Two fixes: (1)
  every caption upload (English and all 15 translations) now retries up to 4 times with backoff,
  since calling captions.insert immediately after the video finishes uploading is a known race —
  YouTube can reject it because the video isn't fully registered yet, and a short wait usually
  clears it; (2) every caption call is now wrapped so a failure is logged and skipped, never fatal.
  If captions still fail after this, check the Actions log for the actual error: `insufficient
  permission` or `403` means your `YT_REFRESH_TOKEN` was minted without the `youtube.force-ssl`
  scope (step 2 of this doc lists both scopes to select) — you'd need to redo the OAuth Playground
  flow and update the secret.
- **The Short now matches the main video's translations** — same 16 titles/descriptions (English +
  15 languages), same music + attribution. It still has no separate caption track of its own
  (relies on the burned-in captions).
- **⚠️ Quota is now tight — read this before you rely on daily runs.** Adding the Short pushed
  daily YouTube API usage close to the free ceiling: main video (~1,600 units) + thumbnail (~50) +
  16 caption tracks (~400 each, ~6,400) + Short upload (~1,600) ≈ **9,650 of your 10,000 daily
  units**, leaving only ~350 as buffer for retries. A single retried call on a bad day could push
  you over and fail the run. If you see `quotaExceeded` in the Actions log, your options are:
  drop a few languages from `VIDEO_LANGS` in `cf-ai.js`, or request a quota increase from Google
  (via the Cloud Console — expect a multi-week review, not guaranteed).
- **What "16 audio dubbed translations" would actually take — I did not build this, and want your
  call before I do.** I looked into it: YouTube's real multi-language *audio track* feature (where
  one video plays a different dub per viewer) is a **YouTube Studio-only feature with no public
  API** — you upload pre-made dub files by hand, in the browser, per video. There's no
  `captions.insert`-style endpoint for it. The only way to get actual dubbed AUDIO (not just
  translated captions, which you already have) through the API is to render and upload **16
  completely separate videos per day, per format** — 32 uploads/day instead of 2. That would mean:
  a full Fish Audio re-synthesis pass per language (roughly 600+ extra TTS calls/day, almost
  certainly blowing past Fish Audio's free tier), a YouTube quota need of 25,000-50,000+
  units/day (10-20x the free daily limit — you'd need Google's quota increase approved just to
  function at all), and a render/upload job that would very likely blow past this workflow's
  45-minute timeout, needing a real restructure (e.g. one job per language). I didn't want to
  quietly build something that expensive without flagging the cost first. **Translated captions +
  translated titles/descriptions (what you have now) stay free and automatable. Real dubbed audio
  does not, at this scale.**
- **If Fish Audio fails for a scene** (rate limit, transient error), that scene silently falls
  back to captions-only over the stock clip's own ambient sound rather than failing the whole
  day's video — check the Actions log for "falling back to captions-only" to see if it happened.
- **If the log shows `Cannot find package 'kokoro-js'` on every single scene** (not just one or
  two), that's not a transient Kokoro glitch — the package genuinely isn't in `node_modules` for
  that run. A new "Preflight: kokoro-js..." line now prints near the very top of every run's log
  (right after the job starts) so you don't have to scroll through dozens of retry lines to spot
  it. If it warns: double check `kokoro-js` is actually present in `package.json`'s
  `dependencies`, and check the "Install dependencies" step's own log — it should show ~50+
  packages being fetched over several seconds, not finish near-instantly. The run still completes
  either way (Fish Audio picks up every scene instead), so this degrades quality, not reliability.
- **`invalid_grant` / "Token has been expired or revoked" in the log.** This means
  `YT_REFRESH_TOKEN` is dead — every upload call in that run (video, thumbnail, all caption
  tracks) fails the same way, which is why one dead token can look like a cascade of unrelated
  errors. The log now prints one clear banner near the failure instead of just a raw error dump.
  Fix: redo the OAuth Playground flow (SETUP.md step 2.4) to mint a fresh refresh token and update
  the secret. The single most common cause is the OAuth consent screen still being in **Testing**
  mode in Google Cloud Console — tokens minted under a Testing app expire after 7 days no matter
  what. **APIs & Services → OAuth consent screen → Publish App** removes that 7-day expiry (your
  app can stay in "Testing" *or* "In production" status without needing Google's review as long as
  you're not requesting sensitive/restricted scopes beyond what you're already using).
- **Not every-minute.** This runs once a day (09:15 UTC). Daily is both the realistic cadence for a
  10+ minute video and the one that won't trip YouTube's spam detection on a new channel — this is
  even more true now that a Short uploads alongside it (2 videos/day, not 1).
- **Video quality**: stock clips + burned MrBeast-style captions + AI narration + background
  music — a genuine teaser video, not custom-shot footage. Good enough to be a real teaser, not
  cinematic.
- **This is intentionally capped at 1 video + 1 Short/day.** Going further (more videos, true
  per-language dubs) both blows the quota math above and risks YouTube's spam detection flagging
  or limiting a new channel. If you want more throughput later, the safe lever is requesting a
  quota increase first, not just raising the numbers in this repo.
- **First run will probably need one or two fixes.** This is a real, non-trivial pipeline (script →
  TTS → stock footage → ffmpeg render → OAuth upload → captions) that I can't test end-to-end from
  here since it needs your live YouTube/Google Cloud credentials. Treat the first manual run as a
  debugging pass, not a guaranteed one-shot success.
