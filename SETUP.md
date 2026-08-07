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

## 5. Add all secrets to the repo
Repo → Settings → Secrets and variables → Actions → New repository secret, one each for:
`CF_ACCOUNT_ID`, `CF_API_TOKEN`, `PEXELS_API_KEY`, `YT_CLIENT_ID`, `YT_CLIENT_SECRET`, `YT_REFRESH_TOKEN`

Optional: Settings → Secrets and variables → Actions → **Variables** tab → add `DRY_RUN_PRIVATE` = `true`
for your first few test runs, so videos upload as Private instead of Public while you check quality.
Switch it to `false` (or delete it) once you're happy.

## 6. Test it
Repo → Actions tab → "HDL Daily YouTube Teaser" → Run workflow (manual trigger button) — don't wait
for tomorrow's cron. Watch the run log; if it fails, the error will point at which step (script
generation, stock footage, voiceover, render, or upload).

---

## Honest limits to know about
- **No background music.** Videos are narration-only over the stock footage — the ambient-pad
  generator was removed. If you want music back later, that's a manual asset step to re-add.
- **Not every-minute.** This runs once a day (09:15 UTC). Daily is both the realistic cadence for a
  10-minute video and the one that won't trip YouTube's spam detection on a new channel.
- **Video quality**: stock clips + burned captions + AI narration + background music — a genuine
  teaser video, not custom-shot footage. Good enough to be a real teaser, not cinematic.
- **YouTube API daily quota**: default free quota is 10,000 units/day. One upload (~1,600) +
  thumbnail set (~50) + 15 caption tracks (~400 each, ~6,000) lands around 7,650 units for one
  video/day — leaves a buffer of ~2,350 units for retries, but there's no room to also add a
  second daily video, more languages, or extra API calls without requesting a quota increase from
  Google (weeks-to-months review, not guaranteed).
- **This is intentionally capped at 1 video/day.** Uploading dozens of videos a day, especially on
  a tight cron, both blows the quota by 10-100x (captions alone don't scale — 50 languages × 50
  videos/day is over a million quota units against a 10,000 ceiling) and risks YouTube's spam
  detection flagging or limiting a new channel. If you want more throughput later, the safe lever
  is requesting a quota increase first, not just raising the numbers in this repo.
- **Translation set is 15 languages** (`VIDEO_LANGS` in `scripts/cf-ai.js`) — chosen to leave quota
  headroom for retries. You can trade language count for buffer room if uploads start failing with
  quota errors — check the Actions log, it'll say `quotaExceeded` if that's what happened.
- **First run will probably need one or two fixes.** This is a real, non-trivial pipeline (script →
  TTS → stock footage → ffmpeg render → OAuth upload → captions) that I can't test end-to-end from
  here since it needs your live YouTube/Google Cloud credentials. Treat the first manual run as a
  debugging pass, not a guaranteed one-shot success.
