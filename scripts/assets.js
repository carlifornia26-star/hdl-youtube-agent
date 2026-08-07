import fetch from "node-fetch";
import fs from "node:fs/promises";

// Pexels license permits commercial use, including monetized YouTube videos, without attribution
// (attribution appreciated but not required) — https://www.pexels.com/license/
export async function fetchStockClip(keyword, outPath) {
  const res = await fetch(
    `https://api.pexels.com/videos/search?query=${encodeURIComponent(keyword)}&orientation=landscape&size=medium&per_page=5`,
    { headers: { Authorization: process.env.PEXELS_API_KEY } }
  );
  if (!res.ok) throw new Error(`Pexels search failed: ${res.status}`);
  const data = await res.json();
  const video = data.videos?.[0];
  if (!video) throw new Error(`No Pexels results for "${keyword}"`);

  // pick a moderate-resolution file (keeps ffmpeg + upload fast on a free GitHub runner)
  const file =
    video.video_files.find((f) => f.width && f.width <= 1280 && f.file_type === "video/mp4") ||
    video.video_files[0];

  const clip = await fetch(file.link);
  const buf = Buffer.from(await clip.arrayBuffer());
  await fs.writeFile(outPath, buf);
  return outPath;
                }
