import fetch from "node-fetch";
import fs from "node:fs/promises";

// Pexels license permits commercial use, including monetized YouTube videos, without attribution
// (attribution appreciated but not required) — https://www.pexels.com/license/
//
// `index` picks which result to use (index % results returned) instead of always the top hit.
// Keywords repeat across a day's scenes (there are only a handful per book), so without this
// every scene sharing a keyword downloaded the exact same clip — pass the scene index in so
// repeats of the same keyword still land on a different clip.
export async function fetchStockClip(keyword, outPath, index = 0) {
  const res = await fetch(
    `https://api.pexels.com/videos/search?query=${encodeURIComponent(keyword)}&orientation=landscape&size=medium&per_page=15`,
    { headers: { Authorization: process.env.PEXELS_API_KEY } }
  );
  if (!res.ok) throw new Error(`Pexels search failed: ${res.status}`);
  const data = await res.json();
  const results = data.videos || [];
  if (results.length === 0) throw new Error(`No Pexels results for "${keyword}"`);
  const video = results[index % results.length];

  // pick a moderate-resolution file (keeps ffmpeg + upload fast on a free GitHub runner)
  const file =
    video.video_files.find((f) => f.width && f.width <= 1280 && f.file_type === "video/mp4") ||
    video.video_files[0];

  const clip = await fetch(file.link);
  const buf = Buffer.from(await clip.arrayBuffer());
  await fs.writeFile(outPath, buf);
  return outPath;
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
