import fs from "node:fs/promises";
import path from "node:path";
import { pickTodaysBook } from "./catalog.js";
import { generateScript, generateBonusScenes, translateMeta, VIDEO_LANGS } from "./cf-ai.js";
import { fetchStockClip, fetchUnsplashPhoto, unsplashAttributionLine } from "./assets.js";
import { synthesizeVoice } from "./voice.js";
import { fetchBackgroundMusic, attributionLine } from "./music.js";
import { buildScene, concatScenes, buildSrt, generateThumbnail, probeDuration, mixBackgroundMusic } from "./render.js";
import { uploadVideo, uploadCaptionTrack, uploadThumbnail } from "./youtube.js";

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

async function main() {
  await fs.mkdir(BUILD_DIR, { recursive: true });

  const book = pickTodaysBook();
  console.log(`Today's book: ${book.title}`);

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
      await synthesizeVoice(scene.line, voicePath);
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

  // 3b) Background music — a real, free, attribution-licensed track (see music.js), mixed in
  // as a quiet bed under the narration that's already in finalPath. If the download or mix
  // fails for any reason, fall back to uploading without music rather than failing the run.
  let musicTrack = null;
  let uploadPath = finalPath;
  try {
    const musicPath = path.join(BUILD_DIR, "music.mp3");
    musicTrack = await fetchBackgroundMusic(musicPath);
    const musicOutPath = path.join(BUILD_DIR, "final_with_music.mp4");
    await mixBackgroundMusic({ videoPath: finalPath, musicPath, outPath: musicOutPath });
    uploadPath = musicOutPath;
  } catch (e) {
    console.warn("Background music failed, uploading without it:", e.message);
  }

  // 3c) Thumbnail image — a real Unsplash photo matching the book's topic, cropped clean with
  // no text overlay, instead of a grabbed video frame (which can land on an awkward or blurry
  // moment). Falls back to the old video-frame approach if Unsplash fails for any reason
  // (missing key, rate limit, network hiccup) so a thumbnail always gets set either way. Done
  // here, BEFORE metadata is built, so the photographer attribution (if any) can be included in
  // the description — uploadThumbnail itself still happens later, once a videoId exists.
  const thumbPath = path.join(BUILD_DIR, "thumbnail.jpg");
  let thumbAttribution = null;
  try {
    const thumbKeyword = book.stockKeywords[0];
    const thumbPhotoPath = path.join(BUILD_DIR, "thumb_photo.jpg");
    thumbAttribution = await fetchUnsplashPhoto(thumbKeyword, thumbPhotoPath, Math.floor(scenes.length / 2));
    await generateThumbnail({ imagePath: thumbPhotoPath, outPath: thumbPath });
  } catch (e) {
    console.warn("Unsplash thumbnail failed, falling back to a video frame:", e.message);
    const midClip = path.join(BUILD_DIR, `clip_${Math.floor(scenes.length / 2)}.mp4`);
    await generateThumbnail({ imagePath: midClip, outPath: thumbPath });
  }

  // 4) English metadata
  const enTitle = `${book.title} — ${book.angle} | HDL Group`;
  // Base description is the ONLY part that ever goes to the translation model. Credit lines
  // (music + thumbnail) contain proper names and raw URLs/query strings that a translation
  // model will happily mangle (corrupted domains, translated query-param values, and — with
  // long repeated legal boilerplate like this — occasional runaway repetition loops that blow
  // past YouTube's description length limit and fail the whole upload with a generic
  // "invalidVideoMetadata" error). So: build attribution separately, translate only the base,
  // and append attribution AFTER translation, untranslated, for every language including English.
  const baseDescription =
    `${book.title} explores ${book.angle}. Available in English only, exclusively on Google Play Books.\n` +
    `Read the full book: ${SITE_URL}\n\n` +
    `#HDLGroup #${book.slug.replace(/-/g, "")}`;
  let attributionSuffix = "";
  if (musicTrack) attributionSuffix += `\n\n${attributionLine(musicTrack)}`;
  if (thumbAttribution) attributionSuffix += `\n\n${unsplashAttributionLine(thumbAttribution)}`;
  const enDescription = baseDescription + attributionSuffix;

  // 5) Translated titles/descriptions -> YouTube localizations map
  // Translate with Cloudflare's own code (`lang`), but key the localizations object with
  // the YouTube-safe code (`ytLang`) so a mismatch like "zh" vs "zh-Hans" can't happen.
  // Only baseDescription is translated — attributionSuffix is appended AFTER, untranslated,
  // exactly once (see comment above).
  const localizations = {};
  for (const lang of VIDEO_LANGS) {
    const ytLang = YT_LOCALE_MAP[lang] ?? lang;
    try {
      const t = await translateMeta(enTitle, baseDescription, lang);
      const description = t.description + attributionSuffix;
      localizations[ytLang] = { title: t.title, description };
    } catch (e) {
      console.warn(`Translation failed for ${lang}, skipping:`, e.message);
    }
  }

  // 6) Upload video
  const uploaded = await uploadVideo({
    videoPath: uploadPath,
    title: enTitle,
    description: enDescription,
    tags: [book.title, "HDL Group", book.angle, "ebook"],
    localizations,
  });
  console.log(`Uploaded: https://youtube.com/watch?v=${uploaded.id}`);

  // 6b) Upload the thumbnail generated back in step 3c
  await uploadThumbnail({ videoId: uploaded.id, imagePath: thumbPath });

  // 6c) YouTube Short — the opening few scenes (the strongest hook, since this is a teaser),
  // re-rendered vertical (9:16) instead of a new upload. Reuses the SAME stock clips already
  // fetched for the main video — no extra Pexels calls, just a second ffmpeg pass on files
  // already on disk. Scenes WITHOUT narration are still included (captions-only, same fallback
  // as the main video) rather than skipped — a total Fish Audio outage should still produce a
  // Short, just a silent one, instead of no Short at all. Stops accumulating scenes once it's
  // inside the SHORT_MIN/MAX window.
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

      // Same track as the main video today, already downloaded — just mix it in again.
      let shortUploadPath = shortFinalPath;
      if (musicTrack) {
        try {
          const musicPath = path.join(BUILD_DIR, "music.mp3");
          const shortMusicOutPath = path.join(BUILD_DIR, "short_with_music.mp4");
          await mixBackgroundMusic({ videoPath: shortFinalPath, musicPath, outPath: shortMusicOutPath });
          shortUploadPath = shortMusicOutPath;
        } catch (e) {
          console.warn("Short background music failed, uploading without it:", e.message);
        }
      }

      const shortTitle = `${book.title} #Shorts`.slice(0, 100); // YouTube's 100-char title cap
      const shortBaseDescription =
        `${book.title} — ${book.angle}.\n` +
        `Watch the full video: https://youtube.com/watch?v=${uploaded.id}\n` +
        `Read the full book: ${SITE_URL}\n\n` +
        `#Shorts #HDLGroup #${book.slug.replace(/-/g, "")}`;
      const shortAttributionSuffix = musicTrack ? `\n\n${attributionLine(musicTrack)}` : "";
      const shortDescription = shortBaseDescription + shortAttributionSuffix;

      // Translated title/description, matching the main video — same 15 languages + English.
      // Same rule as the main video: only the base (translatable) text goes to the model;
      // the credit line is appended after, untranslated.
      const shortLocalizations = {};
      for (const lang of VIDEO_LANGS) {
        const ytLang = YT_LOCALE_MAP[lang] ?? lang;
        try {
          const t = await translateMeta(shortTitle, shortBaseDescription, lang);
          const description = t.description + shortAttributionSuffix;
          shortLocalizations[ytLang] = { title: t.title, description };
        } catch (e) {
          console.warn(`Short translation failed for ${lang}, skipping:`, e.message);
        }
      }

      const uploadedShort = await uploadVideo({
        videoPath: shortUploadPath,
        title: shortTitle,
        description: shortDescription,
        tags: [book.title, "HDL Group", book.angle, "Shorts"],
        localizations: shortLocalizations,
      });
      console.log(`Uploaded Short (~${Math.round(shortTotal)}s): https://youtube.com/watch?v=${uploadedShort.id}`);
    }
  } catch (e) {
    // A failed Short should never take down the main video, which has already uploaded successfully.
    console.warn("Short build/upload failed, continuing without it:", e.message);
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
      const srt = buildSrt(built, lines);
      const srtPath = path.join(BUILD_DIR, `captions_${lang}.srt`);
      await fs.writeFile(srtPath, srt);
      await uploadCaptionTrack({ videoId: uploaded.id, language: ytLang, srtPath, name: lang });
    } catch (e) {
      console.warn(`Caption upload failed for ${lang}, skipping:`, e.message);
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
