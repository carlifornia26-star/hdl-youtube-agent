// videos-manifest.json — the single source of truth the site's _worker.js reads (via
// raw.githubusercontent.com) to embed each day's video on its matching book page, list every
// video on /videos.html, and generate /sitemap-videos.xml. Written here, right after each
// upload, and committed/pushed by the workflow step in daily-video.yml.
import fs from "node:fs/promises";
import path from "node:path";

// CHANNEL_ID is passed in by the workflow (see daily-video.yml). Channel 1 keeps the original
// unsuffixed filename so the site's existing worker/sitemap references keep working untouched;
// channels 2/3 get their own file so their video histories don't overwrite each other.
const CHANNEL_ID = process.env.CHANNEL_ID || "1";
const MANIFEST_PATH = path.resolve(CHANNEL_ID === "1" ? "videos-manifest.json" : `videos-manifest-${CHANNEL_ID}.json`);
// Bounded so the file (and the site's per-request fetch of it) can't grow forever —
// at 1 video/day this is well over a year of history, plenty for a sitemap/hub page.
const MAX_ENTRIES = 500;

export async function loadManifest() {
  try {
    const raw = await fs.readFile(MANIFEST_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.videos) ? parsed : { videos: [] };
  } catch {
    return { videos: [] }; // first run — file doesn't exist yet
  }
}

// Newest titles across ALL channels' manifests (each file is newest-first), used by
// generate-video.js so a new title can be checked against what every channel has recently posted.
// Reads the sibling manifest files directly (channel 1 unsuffixed, 2-4 suffixed) — a missing or
// unreadable file is just skipped.
export async function loadRecentTitles(perChannel = 6) {
  const files = ["videos-manifest.json", "videos-manifest-2.json", "videos-manifest-3.json", "videos-manifest-4.json"];
  const titles = [];
  for (const f of files) {
    try {
      const parsed = JSON.parse(await fs.readFile(path.resolve(f), "utf8"));
      for (const v of (parsed.videos || []).slice(0, perChannel)) {
        if (v?.title) titles.push(String(v.title));
      }
    } catch {
      // file missing or unreadable — skip
    }
  }
  return titles;
}

// entry: { video_id, short_video_id, book_slug, page_url, title, description,
//          thumbnail_url, duration_seconds, published_at }
export async function appendVideoEntry(entry) {
  const manifest = await loadManifest();
  manifest.videos.unshift(entry); // newest first — the site matches the FIRST hit per book page
  if (manifest.videos.length > MAX_ENTRIES) manifest.videos.length = MAX_ENTRIES;
  manifest.updated_at = new Date().toISOString();
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
  }
