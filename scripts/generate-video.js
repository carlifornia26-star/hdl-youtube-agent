import fs from "node:fs/promises";
import path from "node:path";
import { pickTodaysBook } from "./catalog.js";
import { generateScript, translateMeta, VIDEO_LANGS } from "./cf-ai.js";
import { fetchStockClip } from "./assets.js";
import { buildScene, concatScenes, buildSrt, generateThumbnail } from "./render.js";
import { uploadVideo, uploadCaptionTrack, uploadThumbnail } from "./youtube.js";

const BUILD_DIR = path.resolve("build");
const TARGET_TOTAL_SECONDS = 600; // 10 minutes
const READING_WORDS_PER_SECOND = 2.3; // ~140wpm on-screen reading pace, a bit slower than speech
const PADDING_SECONDS = 1.5; // per-scene buffer so a line isn't yanked away the instant it's readable
const MIN_SCENE_SECONDS = 5;
const MAX_SCENE_SECONDS = 45;

// No narrator voice: scene length is derived from how long the line takes to read on screen,
// then every scene is scaled by the same factor so the whole video lands close to 10 minutes
// regardless of how many scenes the script ended up with. The stock clip's own ambient audio
// plays (unmuted) instead of a voice track.
function computeSceneDurations(scenes) {
  const raw = scenes.map((s) => {
    const words = s.line.trim().split(/\s+/).filter(Boolean).length;
    return words / READING_WORDS_PER_SECOND + PADDING_SECONDS;
  });
  const rawTotal = raw.reduce((a, b) => a + b, 0);
  const scale = TARGET_TOTAL_SECONDS / rawTotal;
  return raw.map((d) => Math.min(MAX_SCENE_SECONDS, Math.max(MIN_SCENE_SECONDS, d * scale)));
}

async function main() {
  await fs.mkdir(BUILD_DIR, { recursive: true });

  const book = pickTodaysBook();
  console.log(`Today's book: ${book.title}`);

  // 1) Script (teaser-only, scene count set by the model within the schema's range)
  const scenes = await generateScript(book);
  const durations = computeSceneDurations(scenes);
  console.log(`Generated ${scenes.length} scenes, total runtime ~${Math.round(durations.reduce((a, b) => a + b, 0) / 60)} min`);

  // 2) Per-scene: stock clip, burned caption, clip's own audio (no narration) -> scene_N.mp4
  const built = [];
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const duration = durations[i];
    const clipPath = path.join(BUILD_DIR, `clip_${i}.mp4`);
    const outPath = path.join(BUILD_DIR, `scene_${i}.mp4`);

    const keyword = book.stockKeywords[i % book.stockKeywords.length];
    await fetchStockClip(keyword, clipPath);

    const built_scene = await buildScene({ clipPath, duration, text: scene.line, outPath });
    built.push({ ...scene, duration, outPath: built_scene.outPath });
  }

  // 3) Concat scenes — each scene keeps its own stock-clip audio, no separate mix step needed
  const listFile = path.join(BUILD_DIR, "concat.txt");
  const finalPath = path.join(BUILD_DIR, "final.mp4");
  await concatScenes(built.map((b) => b.outPath), listFile, finalPath);

  // 4) English metadata
  const enTitle = `${book.title} — ${book.angle} | HDL Group`;
  const enDescription =
    `${book.title} explores ${book.angle}. Available in English only, exclusively on Google Play Books.\n` +
    `Read the full book: ${book.pageUrl}\n\n` +
    `#HDLGroup #${book.slug.replace(/-/g, "")}`;

  // 5) Translated titles/descriptions -> YouTube localizations map
  const localizations = {};
  for (const lang of VIDEO_LANGS) {
    try {
      const t = await translateMeta(enTitle, enDescription, lang);
      localizations[lang] = { title: t.title, description: t.description };
    } catch (e) {
      console.warn(`Translation failed for ${lang}, skipping:`, e.message);
    }
  }

  // 6) Upload video
  const uploaded = await uploadVideo({
    videoPath: finalPath,
    title: enTitle,
    description: enDescription,
    tags: [book.title, "HDL Group", book.angle, "ebook"],
    localizations,
  });
  console.log(`Uploaded: https://youtube.com/watch?v=${uploaded.id}`);

  // 6b) Custom thumbnail — grabs a frame from the middle scene, overlays the book title
  const midClip = path.join(BUILD_DIR, `clip_${Math.floor(scenes.length / 2)}.mp4`);
  const thumbPath = path.join(BUILD_DIR, "thumbnail.jpg");
  await generateThumbnail({ clipPath: midClip, title: book.title, outPath: thumbPath });
  await uploadThumbnail({ videoId: uploaded.id, imagePath: thumbPath });

  // 7) Caption tracks — English first, then translated languages (reusing the same scene lines).
  // Captions are the ONLY narration now, so these matter more than before — every viewer reads them.
  const enSrt = buildSrt(built, built.map((b) => b.line));
  const enSrtPath = path.join(BUILD_DIR, "captions_en.srt");
  await fs.writeFile(enSrtPath, enSrt);
  await uploadCaptionTrack({ videoId: uploaded.id, language: "en", srtPath: enSrtPath, name: "English" });

  for (const lang of VIDEO_LANGS) {
    if (!localizations[lang]) continue;
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
      await uploadCaptionTrack({ videoId: uploaded.id, language: lang, srtPath, name: lang });
    } catch (e) {
      console.warn(`Caption upload failed for ${lang}, skipping:`, e.message);
    }
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
