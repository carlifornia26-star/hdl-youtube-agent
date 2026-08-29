import fs from "node:fs/promises";
import path from "node:path";
import { pickTodaysBook } from "./catalog.js";
import { generateScript, generateBonusScenes, translateMeta, VIDEO_LANGS } from "./cf-ai.js";
import { fetchStockClip, fetchUnsplashPhoto, unsplashAttributionLine } from "./assets.js";
import { synthesizeVoice, pickTodaysVoice } from "./voice.js";
import { fetchBackgroundMusic, attributionLine } from "./music.js";
import { buildScene, concatScenes, buildSrt, generateThumbnail, probeDuration, mixBackgroundMusic, normalizeLoudness } from "./render.js";
import { uploadVideo, uploadCaptionTrack, uploadThumbnail, addVideoToPlaylist } from "./youtube.js";
import { appendVideoEntry } from "./manifest.js";
import { buildDailyCommunityPost } from "./community-post.js";

// Passed in by the workflow (see daily-video.yml). Channel 1 keeps unsuffixed filenames so
// its existing history isn't disturbed; channels 2/3 get their own suffixed files so their
// playlists/manifest don't overwrite each other.
const CHANNEL_ID = process.env.CHANNEL_ID || "1";

// YouTube's official video category IDs (snippet.categoryId) per channel.
// 1 = Science & Technology, 2 = Entertainment, 3 = Education.
const CHANNEL_CATEGORY_IDS = { 1: "28", 2: "24", 3: "27" };
const CATEGORY_ID = CHANNEL_CATEGORY_IDS[CHANNEL_ID] || CHANNEL_CATEGORY_IDS[1];

const BUILD_DIR = path.resolve("build");
const SITE_URL = "https://highdefinitionlearning.pages.dev/"; // every description link points here, not the per-book page
const PADDING_SECONDS = 0.8; // per-scene buffer after the voice line finishes, before the next scene cuts in
const MIN_SCENE_SECONDS = 4;
const MAX_SCENE_SECONDS = 45;
const SHORT_MIN_SECONDS = 40; // Short target window — comfortably inside YouTube's Shorts duration
const SHORT_MAX_SECONDS = 65; // limit under either the old 60s rule or the current 3-minute one

// The main script's scene/word counts (cf-ai.js) are tuned to land near 10 minutes, but the
// exact result depends on the TTS voice's actual reading pace, which can drift. Rather than
// trust that estimate, the REAL total runtime is measured after synthesis (every scene's
// duration comes from its actual audio file, not a word-count guess) and topped up with extra
// scenes if it still lands under this floor — so "above 8 minutes" is enforced directly against
// measured audio, not against a script-length assumption that can go stale.
const TARGET_MIN_SECONDS = 8.5 * 60; // 510s — a bit above the 8:00 floor so small variance still clears it
const MAX_TOPUP_ROUNDS = 4;
const TOPUP_SCENES_PER_ROUND = 10;

// YouTube's auto-rendered chapter bar requires: first chapter at 0:00, at least 3 chapters
// total, and each at least this many seconds apart from the previous one, in ascending order.
const MIN_CHAPTER_GAP_SECONDS = 10;
const MIN_CHAPTERS_TO_INCLUDE = 3;

// snippet.tags is a single flat array (not per-locale) — YouTube also rejects the whole upload
// if the combined tags string goes over roughly 500 characters, so multilingual tags are added
// up to this budget rather than unconditionally for all 15 languages.
const TAGS_CHAR_BUDGET = 460;
const MAX_TAG_LENGTH = 100; // YouTube rejects any single tag over 100 chars

// If more than this fraction of scenes end up with no narration (Fish Audio down, key revoked,
// the Aug 31 2026 free-model promo ending, etc.), the run still PUBLISHES everything as normal —
// captions-only fallback is fine for an occasional flaky scene — but throws at the very end so
// GitHub Actions shows a red X and you actually notice, instead of silently shipping an
// all-silent video indefinitely. The throw happens after uploads, so it never blocks publishing.
const VOICE_FAILURE_THRESHOLD = 0.2; // 20%

// Cloudflare's m2m100 model uses its own short codes (zh, es, fr...) for translation —
// those must stay untouched in VIDEO_LANGS. YouTube's localizations map, however, requires
// proper BCP-47 tags and rejects a couple of the short codes outright (most notably plain
// "zh", which YouTube wants as zh-Hans or zh-Hant) — an unrecognized code anywhere in the
// localizations map fails the ENTIRE upload with a generic, useless "invalidVideoMetadata"
// error. This maps Cloudflare's code -> the YouTube-safe equivalent only where they differ.
const YT_LOCALE_MAP = {
  zh: "zh-Hans",
};

// mm:ss for anything under an hour, h:mm:ss beyond that — matches YouTube's own timestamp format.
function formatTimestamp(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// First chapter is always "Intro"; later ones use the first few words of that scene's line as a
// free label — costs nothing extra (no translation call, no new data), since `built[i].line`
// already exists. Left in English even inside translated descriptions (see chaptersBlock below)
// to avoid a second translateMeta pass just for chapter labels — the timestamps do the real work.
function chapterLabel(line, index) {
  if (index === 0) return "Intro";
  const words = line.trim().split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
  return words.length > 0 ? words : `Part ${index + 1}`;
}

// Walks the already-built scene list and picks out chapter marks at least MIN_CHAPTER_GAP_SECONDS
// apart, always starting at 0:00. Scenes shorter than the gap get merged under whichever chapter
// mark they fall inside, so the spacing rule holds even with a lot of short scenes.
function buildChapters(scenes) {
  const chapters = [];
  let elapsed = 0;
  let lastChapterTime = -Infinity;
  for (let i = 0; i < scenes.length; i++) {
    if (i === 0 || elapsed - lastChapterTime >= MIN_CHAPTER_GAP_SECONDS) {
      chapters.push({ time: elapsed, label: chapterLabel(scenes[i].line, i) });
      lastChapterTime = elapsed;
    }
    elapsed += scenes[i].duration;
  }
  return chapters;
}

// Reuses the translated titles already fetched for `localizations` (zero extra Cloudflare
// calls). Pulls the core keyword phrase out of each language's translated title — dropping the
// " — angle | HDL Group" boilerplate — and adds it as a tag, up to TAGS_CHAR_BUDGET so the
// combined tags string never risks YouTube's ~500-char limit on the whole video.
function buildMultilingualTags(localizations, baseTags) {
  const tags = [];
  let usedChars = baseTags.join(",").length;
  for (const loc of Object.values(localizations)) {
    if (!loc?.title) continue;
    const coreKeyword = loc.title.split(/[—|]/)[0].trim();
    if (!coreKeyword || coreKeyword.length > MAX_TAG_LENGTH) continue;
    const addLen = coreKeyword.length + 1; // +1 for the join comma
    if (usedChars + addLen > TAGS_CHAR_BUDGET) break;
    tags.push(coreKeyword);
    usedChars += addLen;
  }
  return tags;
}

async function main() {
  await fs.mkdir(BUILD_DIR, { recursive: true });

  // Preflight: confirm the local Kokoro TTS package actually resolves before burning through a
  // whole script's worth of scenes finding out the hard way. `npm install` should always put this
  // in node_modules since it's a normal (non-optional) dependency in package.json — if this warns,
  // the run WILL still complete (Fish Audio picks up every scene instead), just check that
  // `kokoro-js` is really listed in package.json and that "Install dependencies" in the Actions
  // log shows it actually being fetched (dozens of packages, several seconds+) rather than a
  // suspiciously instant no-op.
  try {
    await import("kokoro-js");
    console.log("Preflight: kokoro-js resolved OK.");
  } catch (e) {
    console.warn(
      `Preflight WARNING: kokoro-js failed to import (${e.message}). Every scene will fall back ` +
        `to Fish Audio (or captions-only if that's also unavailable) for this entire run.`
    );
  }

  const book = pickTodaysBook();
  console.log(`Today's book: ${book.title}`);

  // One narrator voice for the ENTIRE video (main + Short), computed once here and passed into
  // every synthesizeVoice() call below — never mixed voices within one video. Tomorrow's video
  // gets the next voice in the rotation (see VOICE_POOL in voice.js).
  const narratorVoice = pickTodaysVoice();
  console.log(`Today's narrator voice: ${narratorVoice}`);

  // 1) Script (teaser-only, scene count set by the model within the schema's range)
  const scenes = await generateScript(book);
  console.log(`Generated ${scenes.length} scenes`);

  // 2) Per-scene: stock clip + Kokoro narration + burned caption -> scene_N.mp4.
  // Scene duration comes from the ACTUAL narration length (probed after synthesis), not an
  // estimate — captions and the video cut are timed to the real voice track.
  // If TTS fails for a scene (rate limit, transient API error) after retries, that one scene
  // falls back to captions-only over the stock clip's ambient sound rather than failing the
  // entire day's video. `index` drives both the filename and the stock-keyword cycling, and
  // must stay globally unique across the main script AND any top-up scenes added below —
  // callers pass built.length so it keeps counting up rather than restarting at 0.
  async function buildOneScene(scene, index) {
    const clipPath = path.join(BUILD_DIR, `clip_${index}.mp4`);
    const voicePath = path.join(BUILD_DIR, `voice_${index}.mp3`);
    const outPath = path.join(BUILD_DIR, `scene_${index}.mp4`);

    const keyword = book.stockKeywords[index % book.stockKeywords.length];
    await fetchStockClip(keyword, clipPath, index);

    let usableVoicePath = null;
    let duration = MIN_SCENE_SECONDS;
    try {
      await synthesizeVoice(scene.line, voicePath, narratorVoice);
      const voiceDuration = await probeDuration(voicePath);
      duration = Math.min(MAX_SCENE_SECONDS, Math.max(MIN_SCENE_SECONDS, voiceDuration + PADDING_SECONDS));
      usableVoicePath = voicePath;
    } catch (e) {
      console.warn(`Voice synthesis failed for scene ${index}, falling back to captions-only:`, e.message);
      // Rough fallback so the scene still gets a reasonable amount of screen time to be read.
      const words = scene.line.trim().split(/\s+/).filter(Boolean).length;
      duration = Math.min(MAX_SCENE_SECONDS, Math.max(MIN_SCENE_SECONDS, words / 2.3 + PADDING_SECONDS));
    }

    const built_scene = await buildScene({ clipPath, duration, text: scene.line, outPath, voicePath: usableVoicePath });
    return { ...scene, duration, outPath: built_scene.outPath, clipPath, voicePath: usableVoicePath };
  }

  const built = [];
  for (let i = 0; i < scenes.length; i++) {
    built.push(await buildOneScene(scenes[i], i));
  }
  let totalSeconds = built.reduce((a, b) => a + b.duration, 0);
  console.log(`Runtime after main script: ~${Math.round(totalSeconds / 60)} min (${built.length} scenes)`);

  // 2b) Duration top-up: if the measured runtime still lands under the 8-minute-ish floor
  // (TARGET_MIN_SECONDS), generate and build extra scenes and append them, re-measuring after
  // each round, until the target is hit or MAX_TOPUP_ROUNDS is reached. Bounded so a persistent
  // shortfall (or a flaky Workers AI response) can't loop the run forever — if still short after
  // the cap, publish anyway with a warning rather than fail a day's video over runtime length.
  let topupRound = 0;
  while (totalSeconds < TARGET_MIN_SECONDS && topupRound < MAX_TOPUP_ROUNDS) {
    topupRound++;
    console.log(
      `Runtime ~${Math.round(totalSeconds / 60)} min is under the target, generating ` +
        `${TOPUP_SCENES_PER_ROUND} bonus scenes (round ${topupRound}/${MAX_TOPUP_ROUNDS})...`
    );
    let bonusScenes;
    try {
      bonusScenes = await generateBonusScenes(book, TOPUP_SCENES_PER_ROUND);
    } catch (e) {
      console.warn("Bonus scene generation failed, stopping top-up early:", e.message);
      break;
    }
    for (const scene of bonusScenes) {
      built.push(await buildOneScene(scene, built.length));
    }
    totalSeconds = built.reduce((a, b) => a + b.duration, 0);
  }

  console.log(
    `Total runtime ~${Math.round(totalSeconds / 60)} min (${built.length} scenes)` +
      (topupRound ? ` after ${topupRound} top-up round(s)` : "")
  );
  if (totalSeconds < TARGET_MIN_SECONDS) {
    console.warn(
      `Still under the ${Math.round(TARGET_MIN_SECONDS / 60)}-min target after ${MAX_TOPUP_ROUNDS} top-up rounds — publishing anyway.`
    );
  }

  // Track how many scenes had no narration at all — checked at the very end of the run (see
  // VOICE_FAILURE_THRESHOLD above), after everything has already been uploaded.
  const voicelessCount = built.filter((b) => !b.voicePath).length;
  const voicelessRatio = built.length ? voicelessCount / built.length : 0;
  if (voicelessCount > 0) {
    console.warn(`${voicelessCount}/${built.length} scenes (${Math.round(voicelessRatio * 100)}%) have no narration.`);
  }

  // Soft check on the "mention the title exactly 3 times" prompt instruction — an LLM
  // following a numeric instruction isn't guaranteed, so this just makes drift visible in the
  // log rather than silently trusting the model got it right. Bonus top-up scenes are
  // instructed never to mention the title at all, so they shouldn't move this count.
  const titleMentions = built
    .map((b) => b.line.toLowerCase().split(book.title.toLowerCase()).length - 1)
    .reduce((a, b) => a + b, 0);
  if (titleMentions !== 3) {
    console.warn(`Expected the title mentioned exactly 3 times, script actually has ${titleMentions}.`);
  }

  // 3) Concat scenes — each scene already has its narration mixed in, no separate mix step needed
  const listFile = path.join(BUILD_DIR, "concat.txt");
  const finalPath = path.join(BUILD_DIR, "final.mp4");
  await concatScenes(built.map((b) => b.outPath), listFile, finalPath);

  // 3b) Loudness normalization (Ch. 25: audio quality is a bigger retention killer than video
  // quality, and YouTube auto-normalizes playback to -14 LUFS anyway — anything already quieter
  // just stays quiet turned-down relative to everyone else's pre-mastered audio). Runs on the
  // narration/ambient mix BEFORE music is added — loudnorm's single-pass mode is a dynamic
  // filter tuned to the loudest element in the stream (narration), so if it ran AFTER music was
  // mixed in it would squash the quiet music bed toward inaudibility instead of preserving the
  // MUSIC_VOLUME ratio. Normalizing narration-only first, then adding music after at a fixed
  // volume, keeps the music level deterministic regardless of what loudnorm does to narration.
  // A failure here should never block publishing — falls back to the un-normalized mix.
  let uploadPath = finalPath;
  try {
    const normalizedPath = path.join(BUILD_DIR, "final_normalized.mp4");
    await normalizeLoudness({ videoPath: uploadPath, outPath: normalizedPath });
    uploadPath = normalizedPath;
  } catch (e) {
    console.warn("Loudness normalization failed, uploading un-normalized audio:", e.message);
  }

  // 3b2) Background music — a real, free, attribution-licensed track (see music.js), mixed in
  // as a quiet bed under the now-normalized narration. Runs AFTER loudnorm (see above) so the
  // music's audibility isn't at the mercy of loudnorm's dynamic gain curve. If the download or
  // mix fails for any reason, fall back to uploading without music rather than failing the run.
  let musicTrack = null;
  try {
    const musicPath = path.join(BUILD_DIR, "music.mp3");
    musicTrack = await fetchBackgroundMusic(musicPath);
    const musicOutPath = path.join(BUILD_DIR, "final_with_music.mp4");
    await mixBackgroundMusic({ videoPath: uploadPath, musicPath, outPath: musicOutPath });
    uploadPath = musicOutPath;
  } catch (e) {
    console.warn("Background music failed, uploading without it:", e.message);
  }

  // 3c) Thumbnail image — TWO different real Unsplash photos matching the book's topic.
  // Variant A is the plain, text-free photo. Variant B is the same kind of photo but with a
  // short high-contrast title overlay burned in (see thumbTitleText below) — a deliberate
  // plain-vs-text A/B test, not two copies of the same style.
  // Falls back to a grabbed video frame if Unsplash fails entirely (missing key, rate limit,
  // network hiccup) so a thumbnail always gets set either way. Done here, BEFORE metadata is
  // built, so both photographers' attribution can be included in the description —
  // uploadThumbnail itself still happens later, once a videoId exists.
  const thumbPath = path.join(BUILD_DIR, "thumbnail.jpg");
  let thumbAttributionA = null;
  let thumbAttributionB = null;
  let thumbSourcePathA;
  let thumbSourcePathB;
  try {
    const thumbKeyword = book.stockKeywords[0];
    const baseIndex = Math.floor(scenes.length / 2);
    const thumbPhotoPathA = path.join(BUILD_DIR, "thumb_photo_a.jpg");
    const thumbPhotoPathB = path.join(BUILD_DIR, "thumb_photo_b.jpg");
    thumbAttributionA = await fetchUnsplashPhoto(thumbKeyword, thumbPhotoPathA, baseIndex);

    // Guarantee variant B is a genuinely different photo, not the one already picked for A —
    // fetchUnsplashPhoto picks results[index % results.length], so a small result pool can
    // otherwise hand back the exact same photo for two different index values. Walk forward
    // through the result list until the photo id actually differs (or give up after 5 tries —
    // only happens if Unsplash returned fewer than ~6 usable results for this keyword).
    let bIndex = baseIndex + 1;
    for (let attempt = 0; attempt < 5; attempt++) {
      thumbAttributionB = await fetchUnsplashPhoto(thumbKeyword, thumbPhotoPathB, bIndex);
      if (thumbAttributionB.photoId !== thumbAttributionA.photoId) break;
      bIndex++;
    }
    thumbSourcePathA = thumbPhotoPathA;
    thumbSourcePathB = thumbPhotoPathB;
  } catch (e) {
    console.warn("Unsplash thumbnail photos failed, falling back to a video frame:", e.message);
    thumbSourcePathA = path.join(BUILD_DIR, `clip_${Math.floor(scenes.length / 2)}.mp4`);
    thumbSourcePathB = thumbSourcePathA;
    thumbAttributionA = null;
    thumbAttributionB = null;
  }

  // A/B thumbnail testing: YouTube's native "Test & compare" tool lives in Studio only and
  // isn't reachable through the Data API, and since this channel publishes a different one-off
  // book each day there's no repeat audience to split-test *within* a single video anyway.
  // Instead this alternates which of the two DIFFERENT plain photos above becomes the actual
  // uploaded thumbnail, day to day — same day-of-year rotation pattern as the narrator voice.
  // scripts/thumbnail-report.js runs weekly (see .github/workflows/thumbnail-report.yml),
  // pulls real per-video CTR from the YouTube Analytics API, and writes thumbnail-winner.json
  // with a decided variant once there's enough data and a clear lead. If that file names a
  // winner, EVERY video uses it from here on — no manual step. Otherwise (file missing, no
  // winner yet, or not enough data) this keeps alternating exactly as before.
  const dayOfYear = Math.floor((new Date() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
  let thumbnailVariant = dayOfYear % 2 === 0 ? "A" : "B";
  try {
    const winnerRaw = await fs.readFile(path.resolve("thumbnail-winner.json"), "utf8");
    const winnerData = JSON.parse(winnerRaw);
    if (winnerData.winner === "A" || winnerData.winner === "B") {
      thumbnailVariant = winnerData.winner;
      console.log(`thumbnail-winner.json has a decided winner: variant ${thumbnailVariant}. Using it (no more alternating).`);
    }
  } catch {
    // No winner file yet (first run before thumbnail-report.js has ever run) — keep alternating.
  }
  // Variant A stays the plain, text-free photo exactly as before. Variant B now gets a short,
  // high-contrast title overlay (book's Ch. 8: face/text thumbnails beat plain photos 2-4x on
  // CTR) — this is a deliberate A/B test between the two styles, not a replacement of A.
  // thumbTitleText is capped at ~5 words / 40 chars so drawtext in generateThumbnail doesn't
  // have to wrap or shrink to illegible size on a 1280x720 canvas.
  const thumbTitleWords = book.title.split(/\s+/).slice(0, 5).join(" ");
  const thumbTitleText = thumbTitleWords.slice(0, 40).toUpperCase();

  const thumbSourcePath = thumbnailVariant === "A" ? thumbSourcePathA : thumbSourcePathB;
  const thumbTitleTextForVariant = thumbnailVariant === "B" ? thumbTitleText : null;
  try {
    await generateThumbnail({ imagePath: thumbSourcePath, outPath: thumbPath, titleText: thumbTitleTextForVariant });
  } catch (e) {
    const otherSourcePath = thumbnailVariant === "A" ? thumbSourcePathB : thumbSourcePathA;
    console.warn(`Thumbnail generation (variant ${thumbnailVariant}) failed, retrying with the other photo:`, e.message);
    // Keep the same text/no-text treatment on the fallback photo — only the source image
    // changes, not which variant's style is being attempted.
    await generateThumbnail({ imagePath: otherSourcePath, outPath: thumbPath, titleText: thumbTitleTextForVariant });
  }

  // 3d) Chapters — built from the already-measured scene durations, zero extra API calls or
  // translation cost. Skipped entirely (chaptersBlock stays "") if fewer than 3 valid marks
  // come out of buildChapters, since YouTube won't render a chapter bar below that anyway.
  const chapterEntries = buildChapters(built);
  let chaptersBlock = "";
  if (chapterEntries.length >= MIN_CHAPTERS_TO_INCLUDE) {
    chaptersBlock = "\n\n" + chapterEntries.map((c) => `${formatTimestamp(c.time)} ${c.label}`).join("\n");
    console.log(`Chapters: ${chapterEntries.length} marks.`);
  } else {
    console.log(`Only ${chapterEntries.length} chapter mark(s) (need ${MIN_CHAPTERS_TO_INCLUDE}+) — skipping chapters block.`);
  }

  // 4) English metadata
  const enTitle = `${book.title} — ${book.angle} | HDL Group`;
  // Only the plain descriptive sentence goes to the translation model. Everything else —
  // the URL, the hashtags, the chapters block, and (further below) the music/thumbnail credit
  // lines — is appended AFTER translation, untranslated, for every language including English.
  // This used to only apply to the credit lines; the URL was still being sent through
  // translation and Cloudflare's model was silently corrupting it in every single non-English
  // localization (e.g. "highdefinitionlearning.pages.dev" coming back as
  // "hbhefinitionlearning.pages.d ev" — a broken link in the description of every translated
  // video). Hashtags and chapter timestamps are static identifiers too, so they're pulled out
  // for the same reason even though they're lower-risk than a URL.
  const translatableDescription = `${book.title} explores ${book.angle}. Available in English only, exclusively on Google Play Books.`;
  const untranslatedSuffix = `\nRead the full book: ${SITE_URL}\n\n#HDLGroup #${book.slug.replace(/-/g, "")}`;
  const baseDescription = translatableDescription + chaptersBlock + untranslatedSuffix;
  let attributionSuffix = "";
  if (musicTrack) attributionSuffix += `\n\n${attributionLine(musicTrack)}`;
  // Credit both thumbnail photographers, not just whichever photo ended up as the actual
  // thumbnail — both photos were sourced and rendered for this video's A/B test.
  if (thumbAttributionA) attributionSuffix += `\n\n${unsplashAttributionLine(thumbAttributionA)}`;
  if (thumbAttributionB && thumbAttributionB.photoId !== thumbAttributionA?.photoId) {
    attributionSuffix += `\n\n${unsplashAttributionLine(thumbAttributionB)}`;
  }
  const enDescription = baseDescription + attributionSuffix;

  // 5) Translated titles/descriptions -> YouTube localizations map
  // Translate with Cloudflare's own code (`lang`), but key the localizations object with
  // the YouTube-safe code (`ytLang`) so a mismatch like "zh" vs "zh-Hans" can't happen.
  // Only translatableDescription goes to the model — untranslatedSuffix (URL + hashtags),
  // chaptersBlock, and attributionSuffix are appended AFTER, untranslated, exactly once
  // (see comment above).
  const localizations = {};
  for (const lang of VIDEO_LANGS) {
    const ytLang = YT_LOCALE_MAP[lang] ?? lang;
    try {
      const t = await translateMeta(enTitle, translatableDescription, lang);
      const description = t.description + chaptersBlock + untranslatedSuffix + attributionSuffix;
      localizations[ytLang] = { title: t.title, description };
    } catch (e) {
      console.warn(`Translation failed for ${lang}, skipping:`, e.message);
    }
  }

  // 5b) Multilingual keyword tags — reuses the translated titles already fetched above for
  // localizations, so this costs zero extra Cloudflare calls and zero extra YouTube quota
  // (tags ride inside the same videos.insert call). See buildMultilingualTags for the budget
  // logic that keeps the combined tags string under YouTube's ~500-char limit.
  const baseTags = [book.title, "HDL Group", book.angle, "ebook"];
  const tags = [...baseTags, ...buildMultilingualTags(localizations, baseTags)];

  // 6) Upload video
  const uploaded = await uploadVideo({
    videoPath: uploadPath,
    title: enTitle,
    description: enDescription,
    tags,
    localizations,
    categoryId: CATEGORY_ID,
  });
  console.log(`Uploaded: https://youtube.com/watch?v=${uploaded.id}`);

  // 6b) Upload the thumbnail generated back in step 3c
  await uploadThumbnail({ videoId: uploaded.id, imagePath: thumbPath });

  // 6b2) Add today's video to its book's playlist (if one exists — see setup-playlists.js).
  // Non-fatal: a missing or failed playlist add should never take down an otherwise-successful
  // publish — the video is already live on the channel either way.
  try {
    const playlistsPath = path.resolve(CHANNEL_ID === "1" ? "playlists.json" : `playlists-${CHANNEL_ID}.json`);
    const playlistsRaw = await fs.readFile(playlistsPath, "utf8");
    const playlists = JSON.parse(playlistsRaw);
    const playlistId = playlists[book.slug];
    if (playlistId) {
      await addVideoToPlaylist({ playlistId, videoId: uploaded.id });
      console.log(`Added to playlist: https://youtube.com/playlist?list=${playlistId}`);
    } else {
      console.log(`No playlist configured for ${book.slug} yet — run setup-playlists.js first.`);
    }
  } catch (e) {
    console.warn("Adding video to playlist failed, continuing:", e.message);
  }

  // Tracked across the Short block below (stays null if the Short fails/skips) so the
  // manifest entry written in 6d can still record it when it succeeds, without blocking on it.
  let shortVideoId = null;
  let shortSceneCount = 0; // how many of `built`'s leading scenes the Short used — set below, read by the Short-caption block in step 7

  // 6c) YouTube Short — the opening few scenes (the strongest hook, since this is a teaser),
  // re-rendered vertical (9:16) instead of a new upload. Reuses the SAME stock clips already
  // fetched for the main video — no extra Pexels calls, just a second ffmpeg pass on files
  // already on disk. Scenes WITHOUT narration are still included (captions-only, same fallback
  // as the main video) rather than skipped — a total Fish Audio outage should still produce a
  // Short, just a silent one, instead of no Short at all. Stops accumulating scenes once it's
  // inside the SHORT_MIN/MAX window. No chapters here — Shorts are too short for them to matter.
  try {
    const shortScenes = [];
    let shortTotal = 0;
    for (const scene of built) {
      if (shortTotal >= SHORT_MIN_SECONDS && shortTotal + scene.duration > SHORT_MAX_SECONDS) break;
      shortScenes.push(scene);
      shortTotal += scene.duration;
      if (shortTotal >= SHORT_MIN_SECONDS) break;
    }

    if (shortScenes.length === 0) {
      console.warn("No scenes available for a Short — skipping Short upload.");
    } else {
      const shortBuilt = [];
      for (let i = 0; i < shortScenes.length; i++) {
        const s = shortScenes[i];
        const outPath = path.join(BUILD_DIR, `short_scene_${i}.mp4`);
        const built_scene = await buildScene({
          clipPath: s.clipPath,
          duration: s.duration,
          text: s.line,
          outPath,
          voicePath: s.voicePath, // null is fine — buildScene falls back to captions-only
          orientation: "vertical",
        });
        shortBuilt.push(built_scene.outPath);
      }

      const shortListFile = path.join(BUILD_DIR, "concat_short.txt");
      const shortFinalPath = path.join(BUILD_DIR, "short.mp4");
      await concatScenes(shortBuilt, shortListFile, shortFinalPath);

      // Same normalization as the main video (step 3b) — runs BEFORE music, same reasoning:
      // the Short is its own separate upload with its own audio mix, so it needs its own pass
      // rather than inheriting the main video's.
      let shortUploadPath = shortFinalPath;
      try {
        const shortNormalizedPath = path.join(BUILD_DIR, "short_normalized.mp4");
        await normalizeLoudness({ videoPath: shortUploadPath, outPath: shortNormalizedPath });
        shortUploadPath = shortNormalizedPath;
      } catch (e) {
        console.warn("Short loudness normalization failed, uploading un-normalized audio:", e.message);
      }

      // Same track as the main video today, already downloaded — just mix it in again, after
      // normalization so its volume stays fixed regardless of loudnorm's dynamic gain curve.
      if (musicTrack) {
        try {
          const musicPath = path.join(BUILD_DIR, "music.mp3");
          const shortMusicOutPath = path.join(BUILD_DIR, "short_with_music.mp4");
          await mixBackgroundMusic({ videoPath: shortUploadPath, musicPath, outPath: shortMusicOutPath });
          shortUploadPath = shortMusicOutPath;
        } catch (e) {
          console.warn("Short background music failed, uploading without it:", e.message);
        }
      }

      const shortTitle = `${book.title} #Shorts`.slice(0, 100); // YouTube's 100-char title cap
      // Same URL-safety fix as the main video's description above: only the plain sentence goes
      // to the translation model. The two URLs (YouTube link + book link) and the hashtags are
      // appended after, untranslated, so they can't come back corrupted in any language.
      const shortTranslatableDescription = `${book.title} — ${book.angle}.`;
      const shortUntranslatedSuffix =
        `\nWatch the full video: https://youtube.com/watch?v=${uploaded.id}\n` +
        `Read the full book: ${SITE_URL}\n\n` +
        `#Shorts #HDLGroup #${book.slug.replace(/-/g, "")}`;
      const shortBaseDescription = shortTranslatableDescription + shortUntranslatedSuffix;
      const shortAttributionSuffix = musicTrack ? `\n\n${attributionLine(musicTrack)}` : "";
      const shortDescription = shortBaseDescription + shortAttributionSuffix;

      // Translated title/description, matching the main video — same 15 languages + English.
      // Same rule as the main video: only the translatable sentence goes to the model; the URLs,
      // hashtags, and credit line are appended after, untranslated.
      const shortLocalizations = {};
      for (const lang of VIDEO_LANGS) {
        const ytLang = YT_LOCALE_MAP[lang] ?? lang;
        try {
          const t = await translateMeta(shortTitle, shortTranslatableDescription, lang);
          const description = t.description + shortUntranslatedSuffix + shortAttributionSuffix;
          shortLocalizations[ytLang] = { title: t.title, description };
        } catch (e) {
          console.warn(`Short translation failed for ${lang}, skipping:`, e.message);
        }
      }

      // Same multilingual keyword tags as the main video, built from the Short's own translated
      // titles (different phrase from the main video's, so kept separate rather than reused).
      const shortBaseTags = [book.title, "HDL Group", book.angle, "Shorts"];
      const shortTags = [...shortBaseTags, ...buildMultilingualTags(shortLocalizations, shortBaseTags)];

      // One bad/unrecognized translation anywhere in `localizations` fails the ENTIRE upload
      // with YouTube's generic invalidVideoMetadata error (see YT_LOCALE_MAP note above) — so a
      // single mistranslated title can cost the whole Short instead of just that one language.
      // Retry once with localizations stripped: an English-only Short beats no Short at all.
      let uploadedShort;
      try {
        uploadedShort = await uploadVideo({
          videoPath: shortUploadPath,
          title: shortTitle,
          description: shortDescription,
          tags: shortTags,
          localizations: shortLocalizations,
          categoryId: CATEGORY_ID,
        });
      } catch (e) {
        console.warn(
          "Short upload with localizations failed, retrying English-only:",
          e.message
        );
        uploadedShort = await uploadVideo({
          videoPath: shortUploadPath,
          title: shortTitle,
          description: shortDescription,
          tags: shortBaseTags,
          localizations: {},
          categoryId: CATEGORY_ID,
        });
        console.log("Short uploaded English-only after localizations retry.");
      }
      console.log(`Uploaded Short (~${Math.round(shortTotal)}s): https://youtube.com/watch?v=${uploadedShort.id}`);
      shortVideoId = uploadedShort.id;
      shortSceneCount = shortScenes.length;
    }
  } catch (e) {
    // A failed Short should never take down the main video, which has already uploaded successfully.
    console.warn("Short build/upload failed, continuing without it:", e.message);
  }

  // 6d) Record today's video in videos-manifest.json — this is what the website reads (via
  // raw.githubusercontent.com, see the site's _worker.js) to embed the video on book's page,
  // list it on /videos.html, and include it in /sitemap-videos.xml. Written AFTER upload
  // succeeds, using the same real title/description/thumbnail already sent to YouTube, so the
  // site never shows anything that isn't actually live. A failure here should never take down
  // an otherwise-successful publish — logged and swallowed, same pattern as the Short above.
  try {
    await appendVideoEntry({
      video_id: uploaded.id,
      short_video_id: shortVideoId,
      book_slug: book.slug,
      page_url: book.pageUrl,
      title: enTitle,
      description: translatableDescription,
      thumbnail_url: `https://i.ytimg.com/vi/${uploaded.id}/maxresdefault.jpg`,
      thumbnail_variant: thumbnailVariant,
      duration_seconds: Math.round(totalSeconds),
      published_at: new Date().toISOString(),
    });
    console.log("videos-manifest.json updated.");
  } catch (e) {
    console.warn("Failed to update videos-manifest.json (video is still live on YouTube):", e.message);
  }

  // 6e) Daily Community-tab post draft (image + 16-language caption) — NOT auto-published,
  // the YouTube API has no endpoint for that. See community-post.js for why and what this
  // produces instead. A failure here should never take down the run.
  try {
    await buildDailyCommunityPost(book, BUILD_DIR);
  } catch (e) {
    console.warn("Community post draft failed, continuing:", e.message);
  }

  // 7) Caption tracks — English first, then translated languages (reusing the same scene lines).
  // These mirror the spoken narration on screen, and are the only thing viewers watching muted see.
  // A short wait before the first caption call: calling captions.insert immediately after
  // videos.insert can otherwise hit YouTube before it's finished registering the new video
  // (uploadCaptionTrack also retries internally — this just makes the first attempt more
  // likely to succeed). Every caption upload is wrapped in try/catch: a caption failure should
  // never take down the run — the video has already uploaded successfully by this point.
  await new Promise((r) => setTimeout(r, 5000));

  const enSrt = buildSrt(built, built.map((b) => b.line));
  const enSrtPath = path.join(BUILD_DIR, "captions_en.srt");
  await fs.writeFile(enSrtPath, enSrt);
  try {
    await uploadCaptionTrack({ videoId: uploaded.id, language: "en", srtPath: enSrtPath, name: "English" });
  } catch (e) {
    console.warn("English caption upload failed:", e.message);
  }

  // Stashes each language's per-scene translated lines as they're produced below, so the Short
  // captions block right after can reuse them for its own SRT (same scenes, same translations,
  // just the first shortSceneCount of them, re-timed to start at 0) instead of re-calling
  // translateMeta for lines it already has.
  const translatedCaptionLines = {};
  for (const lang of VIDEO_LANGS) {
    const ytLang = YT_LOCALE_MAP[lang] ?? lang;
    if (!localizations[ytLang]) continue;
    try {
      // Translate each scene line individually for caption timing accuracy
      const lines = [];
      for (const scene of built) {
        const t = await translateMeta(scene.line, "", lang);
        lines.push(t.title);
      }
      translatedCaptionLines[lang] = lines;
      const srt = buildSrt(built, lines);
      const srtPath = path.join(BUILD_DIR, `captions_${lang}.srt`);
      await fs.writeFile(srtPath, srt);
      await uploadCaptionTrack({ videoId: uploaded.id, language: ytLang, srtPath, name: lang });
    } catch (e) {
      console.warn(`Caption upload failed for ${lang}, skipping:`, e.message);
    }
  }

  // 7b) Short captions — previously the Short had NO caption track at all (only the burned-in
  // MrBeast-style text), leaving it with no real CC/subtitle track for viewers who toggle
  // captions on. shortScenes is always the leading shortSceneCount entries of `built` (see the
  // Short block above), so its lines and translations are just a slice of what was already
  // computed above — zero extra translateMeta calls needed. Re-timed from 0 since the Short is
  // its own, shorter file.
  if (shortVideoId && shortSceneCount > 0) {
    const shortBuiltScenes = built.slice(0, shortSceneCount);

    const shortEnSrt = buildSrt(shortBuiltScenes, shortBuiltScenes.map((b) => b.line));
    const shortEnSrtPath = path.join(BUILD_DIR, "captions_short_en.srt");
    await fs.writeFile(shortEnSrtPath, shortEnSrt);
    try {
      await uploadCaptionTrack({ videoId: shortVideoId, language: "en", srtPath: shortEnSrtPath, name: "English" });
    } catch (e) {
      console.warn("Short English caption upload failed:", e.message);
    }

    for (const lang of VIDEO_LANGS) {
      const ytLang = YT_LOCALE_MAP[lang] ?? lang;
      const lines = translatedCaptionLines[lang];
      if (!lines) continue;
      try {
        const shortSrt = buildSrt(shortBuiltScenes, lines.slice(0, shortSceneCount));
        const shortSrtPath = path.join(BUILD_DIR, `captions_short_${lang}.srt`);
        await fs.writeFile(shortSrtPath, shortSrt);
        await uploadCaptionTrack({ videoId: shortVideoId, language: ytLang, srtPath: shortSrtPath, name: lang });
      } catch (e) {
        console.warn(`Short caption upload failed for ${lang}, skipping:`, e.message);
      }
    }
  }

  console.log("Done.");

  // Final check, after everything above has already published successfully: if too many
  // scenes had no narration, fail the run NOW so GitHub Actions shows a red X and you get
  // notified — the video/Short are already live, this is purely an alert, not a rollback.
  if (voicelessRatio > VOICE_FAILURE_THRESHOLD) {
    throw new Error(
      `Voice synthesis failed for ${voicelessCount}/${built.length} scenes (${Math.round(voicelessRatio * 100)}%), ` +
        `above the ${Math.round(VOICE_FAILURE_THRESHOLD * 100)}% threshold. The video and Short published anyway, ` +
        `but check FISH_API_KEY and your Fish Audio plan/promo status — narration is likely broken.`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
