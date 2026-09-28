import fetch from "node-fetch";
import fs from "node:fs/promises";

// Pexels license permits commercial use, including monetized YouTube videos, without attribution
// (attribution appreciated but not required) — https://www.pexels.com/license/
//
// per_page=80 (Pexels' max) instead of 15: a fixed query against Pexels' search returns a
// STABLE ranking, so with only 15 candidates and a deterministic `index % results.length` pick,
// the same keyword resolved to the exact same top clip on every single day a book came back
// around in the rotation — this is the "every AGE ONE video reuses the same familiar scenes"
// bug. A bigger pool plus `avoidIds` (recently-used Pexels video IDs, persisted across runs via
// scene-history.js) means a repeat keyword only lands on a clip actually not used recently,
// instead of deterministically re-picking the same one.
//
// `index` still seeds which candidate is tried first within the (unused, or full if all are
// recently used) pool, so multiple scenes sharing a keyword in the SAME video still tend to land
// on different clips from each other, same as before.
export async function fetchStockClip(keyword, outPath, { index = 0, avoidIds = new Set() } = {}) {
  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(keyword)}&orientation=landscape&size=medium&per_page=80`;
  let res;
  for (let attempt = 1; attempt <= 4; attempt++) {
    res = await fetch(url, { headers: { Authorization: process.env.PEXELS_API_KEY } });
    if (res.ok) break;
    // Transient upstream failures must not kill the whole day's upload on first sight.
    // Permanent auth/config errors still fail immediately rather than burning the quota.
    if (![429, 500, 502, 503, 504].includes(res.status) || attempt === 4) {
      throw new Error(`Pexels search failed: ${res.status} after ${attempt} attempt(s)`);
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(30000, retryAfter * 1000) : attempt * 2500;
    console.warn(`Pexels search ${res.status} for scene keyword, retry ${attempt}/3 in ${waitMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  const data = await res.json();
  const results = data.videos || [];
  if (results.length === 0) throw new Error(`No Pexels results for "${keyword}"`);

  const unused = results.filter((v) => !avoidIds.has(String(v.id)));
  // If every result for this keyword has been used recently (a narrow niche keyword with few
  // Pexels matches), fall back to the full pool rather than fail the scene outright.
  const pool = unused.length > 0 ? unused : results;
  const video = pool[index % pool.length];

  // pick a moderate-resolution file (keeps ffmpeg + upload fast on a free GitHub runner)
  const file =
    video.video_files.find((f) => f.width && f.width <= 1280 && f.file_type === "video/mp4") ||
    video.video_files[0];

  const clip = await fetch(file.link);
  const buf = Buffer.from(await clip.arrayBuffer());
  await fs.writeFile(outPath, buf);
  return { outPath, id: String(video.id) };
}

// Unsplash: free forever, 50 requests/hour on the demo tier — plenty for the ~1 call/day this
// makes. Photos are free for commercial use under the Unsplash License, but the API Guidelines
// separately require (a) crediting the photographer + Unsplash with a link when a photo pulled
// via the API is displayed, and (b) pinging the download-tracking endpoint whenever a photo is
// actually used, not just searched. Both handled here — see unsplashAttributionLine() below,
// appended to the video description the same way music.js's attribution line is.
export async function fetchUnsplashPhoto(keyword, outPath, index = 0) {
  const accessKey = process.env.UNSPLASH_ACCESS_KEY;
  const searchRes = await fetch(
    `https://api.unsplash.com/search/photos?query=${encodeURIComponent(keyword)}&orientation=landscape&per_page=10`,
    { headers: { Authorization: `Client-ID ${accessKey}` } }
  );
  if (!searchRes.ok) throw new Error(`Unsplash search failed: ${searchRes.status}`);
  const data = await searchRes.json();
  const results = data.results || [];
  if (results.length === 0) throw new Error(`No Unsplash results for "${keyword}"`);
  const photo = results[index % results.length];

  const imgRes = await fetch(photo.urls.regular);
  if (!imgRes.ok) throw new Error(`Unsplash image download failed: ${imgRes.status}`);
  const buf = Buffer.from(await imgRes.arrayBuffer());
  await fs.writeFile(outPath, buf);

  // Required by the API Guidelines whenever a photo is actually used — best-effort, a failure
  // here shouldn't fail the run since the image itself already downloaded successfully.
  try {
    await fetch(`${photo.links.download_location}&client_id=${accessKey}`);
  } catch (e) {
    console.warn("Unsplash download-tracking ping failed (non-fatal):", e.message);
  }

  return {
    photoId: photo.id, // lets callers confirm two fetches actually returned different photos
    photographerName: photo.user.name,
    photographerProfileUrl: `${photo.user.links.html}?utm_source=hdl_group&utm_medium=referral`,
  };
}

export function unsplashAttributionLine({ photographerName, photographerProfileUrl }) {
  return `Thumbnail photo by ${photographerName} on Unsplash (${photographerProfileUrl})`;
}
