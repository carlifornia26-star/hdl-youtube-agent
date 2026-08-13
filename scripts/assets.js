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
