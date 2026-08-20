import fs from "node:fs/promises";
import path from "node:path";
import { fetchUnsplashPhoto, unsplashAttributionLine } from "./assets.js";
import { translateMeta, VIDEO_LANGS } from "./cf-ai.js";

// IMPORTANT — read this before assuming this posts anything automatically:
// The YouTube Data API has no endpoint to create a Community-tab post. Google has never
// exposed one — Studio's community posts (text/image/poll updates) are only creatable through
// youtube.com/studio itself, not via youtube.videos.insert or any other public method. This is
// confirmed by YouTube's own API reference (channels/videos/playlists/comments/captions only)
// and by open feature requests asking Google for exactly this that have gone unanswered for
// years. So unlike the video and Short (which upload via youtube.videos.insert), there is no
// API call this script can make to actually publish the Community post.
//
// What this DOES do: produce everything needed to post it by hand in under a minute —
// a downloaded Unsplash image and a single caption with all 16 languages stacked (English +
// the same 15 languages used for the video/Short localizations, since a Community post has no
// per-viewer-locale mechanism the way video metadata does). Both are written to
// community-posts/YYYY-MM-DD.{md,jpg} and committed to the repo, so opening the repo on your
// phone each morning gives you a ready image + ready caption to paste into the Studio app.
const LANG_NAMES = {
  en: "English",
  es: "Español",
  fr: "Français",
  pt: "Português",
  de: "Deutsch",
  hi: "हिन्दी",
  ar: "العربية",
  id: "Bahasa Indonesia",
  sw: "Kiswahili",
  ja: "日本語",
  ru: "Русский",
  ko: "한국어",
  zh: "中文",
  it: "Italiano",
  tr: "Türkçe",
  vi: "Tiếng Việt",
};

export async function buildDailyCommunityPost(book, buildDir) {
  const enLine = `${book.title} — ${book.angle}. Available now, exclusively on Google Play Books. #HDLGroup`;

  const sections = [`${LANG_NAMES.en}\n${enLine}`];
  for (const lang of VIDEO_LANGS) {
    try {
      const t = await translateMeta(book.title, enLine, lang);
      sections.push(`${LANG_NAMES[lang] || lang}\n${t.description}`);
    } catch (e) {
      console.warn(`Community post translation failed for ${lang}, skipping:`, e.message);
    }
  }
  const postText = sections.join("\n\n");

  // A different keyword/index than the thumbnail (index 3 vs the thumbnail's mid-scene index)
  // so the daily post image isn't just a duplicate of today's thumbnail.
  const imgPath = path.join(buildDir, "community-post.jpg");
  let attribution;
  try {
    attribution = await fetchUnsplashPhoto(book.stockKeywords[0], imgPath, 3);
  } catch (e) {
    console.warn("Community post image fetch failed:", e.message);
    return null;
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  const outDir = path.resolve("community-posts");
  await fs.mkdir(outDir, { recursive: true });
  const outTextPath = path.join(outDir, `${dateStr}.md`);
  const outImgPath = path.join(outDir, `${dateStr}.jpg`);

  await fs.copyFile(imgPath, outImgPath);
  await fs.writeFile(
    outTextPath,
    `# Community post draft — ${dateStr}\n\n` +
      `Image: ${dateStr}.jpg\n` +
      `${unsplashAttributionLine(attribution)}\n\n` +
      `To post: open the YouTube Studio app -> Community -> New post -> Image, ` +
      `attach ${dateStr}.jpg, paste the text below, Post.\n\n` +
      `---\n\n${postText}\n\n---\n` +
      `(${postText.length} characters total — trim languages if the Studio app truncates it)\n`
  );

  console.log(`Community post draft written: community-posts/${dateStr}.md + ${dateStr}.jpg (post manually — see note above).`);
  return { textPath: outTextPath, imgPath: outImgPath };
    }
