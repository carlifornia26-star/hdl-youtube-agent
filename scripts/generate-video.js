import fs from "node:fs/promises";
import path from "node:path";
import { pickTodaysBook } from "./catalog.js";
import { generateScript, translateMeta, synthesizeVoice, VIDEO_LANGS } from "./cf-ai.js";
import { fetchStockClip } from "./assets.js";
import { buildScene, concatScenes, buildSrt, generateThumbnail } from "./render.js";
import { uploadVideo, uploadCaptionTrack, uploadThumbnail } from "./youtube.js";

const BUILD_DIR = path.resolve("build");

async function main() {
  await fs.mkdir(BUILD_DIR, { recursive: true });

  const book = pickTodaysBook();
  console.log(`Today's book: ${book.title}`);

  // 1) Script (teaser-only, 9 scenes)
  const scenes = await generateScript(book);

  // 2) Per-scene: voiceover + stock clip + burned caption -> scene_N.mp4
  const built = [];
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const audioPath = path.join(BUILD_DIR, `voice_${i}.mp3`);
    const clipPath = path.join(BUILD_DIR, `clip_${i}.mp4`);
    const outPath = path.join(BUILD_DIR, `scene_${i}.mp4`);

    const voice = await synthesizeVoice(scene.line);
    await fs.writeFile(audioPath, voice);

    const keyword = book.stockKeywords[i % book.stockKeywords.length];
    await fetchStockClip(keyword, clipPath);

    const built_scene = await buildScene({ clipPath, audioPath, text: scene.line, outPath });
    built.push({ ...scene, ...built_scene });
  }

  // 3) Concat scenes — narration only, no background music
  const listFile = path.join(BUILD_DIR, "concat.txt");
  const finalPath = path.join(BUILD_DIR, "final.mp4");
  await concatScenes(built.map((b) => b.outPath), listFile, finalPath);

  // 4) English metadata
  const enTitle = `${book.title} — ${book.angle} | HDL Group`;
  const enDescription =
    `${book.title} explores ${book.angle}. Available in English only, exclusively on Google Play Books.\n\n` +
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

  // 7) Caption tracks — English first, then translated languages (reusing the same scene lines)
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
