import fs from "node:fs/promises";
import path from "node:path";
import { pickTodaysBook } from "./catalog.js";
import { generateScript, generateBonusScenes, translateMeta, VIDEO_LANGS } from "./cf-ai.js";
import { fetchStockClip, fetchUnsplashPhoto, unsplashAttributionLine } from "./assets.js";
import { synthesizeVoice, pickTodaysVoice } from "./voice.js";
import { fetchBackgroundMusic, attributionLine } from "./music.js";
import { buildScene, concatScenes, buildSrt, generateThumbnail, probeDuration, mixBackgroundMusic } from "./render.js";
import { uploadVideo, uploadCaptionTrack, uploadThumbnail, addVideoToPlaylist } from "./youtube.js";
import { appendVideoEntry } from "./manifest.js";
import { buildDailyCommunityPost } from "./community-post.js";

const BUILD_DIR = path.resolve("build");
const SITE_URL = "https://highdefinitionlearning.pages.dev/"; // every description link points here, not the per-book page
const PADDING_SECONDS = 0.8; // per-scene buffer after the voice line finishes, before the next scene cuts in
const MIN_SCENE_SECONDS = 4;
const MAX_SCENE_SECONDS = 45;
const SHORT_MIN_SECONDS = 40; // Short target window — comfortably inside YouTube's Shorts duration
const SHORT_MAX_SECONDS = 65; // limit under either the old 60s rule or the current 3-minute one

const TARGET_MIN_SECONDS = 8.5 * 60; // 510s — a bit above the 8:00 floor so small variance still clears it
const MAX_TOPUP_ROUNDS = 4;
const TOPUP_SCENES_PER_ROUND = 10;

const MIN_CHAPTER_GAP_SECONDS = 10;
const MIN_CHAPTERS_TO_INCLUDE = 3;

const VOICE_FAILURE_THRESHOLD = 0.2; // 20%

const YT_LOCALE_MAP = {
  zh: "zh-Hans",
};

function formatTimestamp(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function chapterLabel(line, index) {
  if (index === 0) return "Intro";
  const words = line.trim().split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
  return words.length > 0 ? words : `Part ${index + 1}`;
}

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

async function main() {
  await fs.mkdir(BUILD_DIR, { recursive: true });

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

  const narratorVoice = pickTodaysVoice();
  console.log(`Today's narrator voice: ${narratorVoice}`);

  const scenes = await generateScript(book);
  console.log(`Generated ${scenes.length} scenes`);

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

  const voicelessCount = built.filter((b) => !b.voicePath).length;
  const voicelessRatio = built.length ? voicelessCount / built.length : 0;
  if (voicelessCount > 0) {
    console.warn(`${voicelessCount}/${built.length} scenes (${Math.round(voicelessRatio * 100)}%) have no narration.`);
  }

  const titleMentions = built
    .map((b) => b.line.toLowerCase().split(book.title.toLowerCase()).length - 1)
    .reduce((a, b) => a + b, 0);
  if (titleMentions !== 3) {
    console.warn(`Expected the title mentioned exactly 3 times, script actually has ${titleMentions}.`);
  }

  const listFile = path.join(BUILD_DIR, "concat.txt");
  const finalPath = path.join(BUILD_DIR, "final.mp4");
  await concatScenes(built.map((b) => b.outPath), listFile, finalPath);

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
  const thumbSourcePath = thumbnailVariant === "A" ? thumbSourcePathA : thumbSourcePathB;
  try {
    await generateThumbnail({ imagePath: thumbSourcePath, outPath: thumbPath });
  } catch (e) {
    const otherSourcePath = thumbnailVariant === "A" ? thumbSourcePathB : thumbSourcePathA;
    console.warn(`Thumbnail generation (variant ${thumbnailVariant}) failed, retrying with the other photo:`, e.message);
    await generateThumbnail({ imagePath: otherSourcePath, outPath: thumbPath });
  }

  // 3d) Chapters
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
  const translatableDescription = `${book.title} explores ${book.angle}. Available in English only, exclusively on Google Play Books.`;
  const untranslatedSuffix = `\nRead the full book: ${SITE_URL}\n\n#HDLGroup #${book.slug.replace(/-/g, "")}`;
  const baseDescription = translatableDescription + chaptersBlock + untranslatedSuffix;
  let attributionSuffix = "";
  if (musicTrack) attributionSuffix += `\n\n${attributionLine(musicTrack)}`;
  if (thumbAttributionA) attributionSuffix += `\n\n${unsplashAttributionLine(thumbAttributionA)}`;
  if (thumbAttributionB && thumbAttributionB.photoId !== thumbAttributionA?.photoId) {
    attributionSuffix += `\n\n${unsplashAttributionLine(thumbAttributionB)}`;
  }
  const enDescription = baseDescription + attributionSuffix;

  // 5) Translated titles/descriptions -> YouTube localizations map
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

  // 5b) Multilingual keyword tags — translates the book's short "angle" phrase into each of the
  // 15 languages and folds those into the flat `tags` array sent to YouTube. `snippet.tags` isn't
  // per-locale (one array for the whole video), but mixing in translated keyword equivalents
  // means a search in French, Hindi, etc. still gets a tag-match hit on top of what the
  // per-locale title/description already do. Reuses translateMeta's title-only-input shape
  // (same as the caption-line translations below) — no new API surface, zero YouTube quota cost
  // since this only changes what's sent inside the ALREADY-happening videos.insert call.
  const translatedTagKeywords = [];
  for (const lang of VIDEO_LANGS) {
    const ytLang = YT_LOCALE_MAP[lang] ?? lang;
    if (!localizations[ytLang]) continue; // skip languages whose main translation already failed
    try {
      const t = await translateMeta(book.angle, "", lang);
      const keyword = t.title.trim().slice(0, 30); // safety margin under YouTube's per-tag length limit
      if (keyword && !translatedTagKeywords.includes(keyword)) translatedTagKeywords.push(keyword);
    } catch (e) {
      console.warn(`Tag keyword translation failed for ${lang}, skipping:`, e.message);
    }
  }
  // YouTube caps snippet.tags at 500 characters total across all tags combined — base tags go
  // in first, then translated keywords are added only while there's room, so a long book.angle
  // can never push the request over the limit and fail the whole upload.
  const baseTags = [book.title, "HDL Group", book.angle, "ebook"];
  const tags = [...baseTags];
  let tagCharCount = baseTags.join(",").length;
  for (const kw of translatedTagKeywords) {
    if (tagCharCount + kw.length + 1 > 480) break; // margin under the 500-char cap
    tags.push(kw);
    tagCharCount += kw.length + 1;
  }
  console.log(`Tags (${tags.length}): ${tags.join(", ")}`);

  // 6) Upload video
  const uploaded = await uploadVideo({
    videoPath: uploadPath,
    title: enTitle,
    description: enDescription,
    tags,
    localizations,
  });
  console.log(`Uploaded: https://youtube.com/watch?v=${uploaded.id}`);

  await uploadThumbnail({ videoId: uploaded.id, imagePath: thumbPath });

  try {
    const playlistsRaw = await fs.readFile(path.resolve("playlists.json"), "utf8");
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

  let shortVideoId = null;
  let shortSceneCount = 0;

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
          voicePath: s.voicePath,
          orientation: "vertical",
        });
        shortBuilt.push(built_scene.outPath);
      }

      const shortListFile = path.join(BUILD_DIR, "concat_short.txt");
      const shortFinalPath = path.join(BUILD_DIR, "short.mp4");
      await concatScenes(shortBuilt, shortListFile, shortFinalPath);

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

      const shortTitle = `${book.title} #Shorts`.slice(0, 100);
      const shortTranslatableDescription = `${book.title} — ${book.angle}.`;
      const shortUntranslatedSuffix =
        `\nWatch the full video: https://youtube.com/watch?v=${uploaded.id}\n` +
        `Read the full book: ${SITE_URL}\n\n` +
        `#Shorts #HDLGroup #${book.slug.replace(/-/g, "")}`;
      const shortBaseDescription = shortTranslatableDescription + shortUntranslatedSuffix;
      const shortAttributionSuffix = musicTrack ? `\n\n${attributionLine(musicTrack)}` : "";
      const shortDescription = shortBaseDescription + shortAttributionSuffix;

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

      let uploadedShort;
      try {
        uploadedShort = await uploadVideo({
          videoPath: shortUploadPath,
          title: shortTitle,
          description: shortDescription,
          tags: [book.title, "HDL Group", book.angle, "Shorts"],
          localizations: shortLocalizations,
        });
      } catch (e) {
        console.warn("Short upload with localizations failed, retrying English-only:", e.message);
        uploadedShort = await uploadVideo({
          videoPath: shortUploadPath,
          title: shortTitle,
          description: shortDescription,
          tags: [book.title, "HDL Group", book.angle, "Shorts"],
          localizations: {},
        });
        console.log("Short uploaded English-only after localizations retry.");
      }
      console.log(`Uploaded Short (~${Math.round(shortTotal)}s): https://youtube.com/watch?v=${uploadedShort.id}`);
      shortVideoId = uploadedShort.id;
      shortSceneCount = shortScenes.length;
    }
  } catch (e) {
    console.warn("Short build/upload failed, continuing without it:", e.message);
  }

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

  try {
    await buildDailyCommunityPost(book, BUILD_DIR);
  } catch (e) {
    console.warn("Community post draft failed, continuing:", e.message);
  }

  await new Promise((r) => setTimeout(r, 5000));

  const enSrt = buildSrt(built, built.map((b) => b.line));
  const enSrtPath = path.join(BUILD_DIR, "captions_en.srt");
  await fs.writeFile(enSrtPath, enSrt);
  try {
    await uploadCaptionTrack({ videoId: uploaded.id, language: "en", srtPath: enSrtPath, name: "English" });
  } catch (e) {
    console.warn("English caption upload failed:", e.message);
  }

  const translatedCaptionLines = {};
  for (const lang of VIDEO_LANGS) {
    const ytLang = YT_LOCALE_MAP[lang] ?? lang;
    if (!localizations[ytLang]) continue;
    try {
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
