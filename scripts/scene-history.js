// Persists which Pexels video IDs were used recently, across daily runs, so a repeat keyword
// (books only have a handful of stockKeywords/visual phrases, so keywords DO repeat) doesn't
// keep resolving to the exact same clip every time the book comes back around in the rotation.
// One file per channel, same suffix pattern as videos-manifest.json (manifest.js) so channels
// 2/3 don't clobber channel 1's history.
import fs from "node:fs/promises";
import path from "node:path";

const CHANNEL_ID = process.env.CHANNEL_ID || "1";
const HISTORY_PATH = path.resolve(CHANNEL_ID === "1" ? "used-clips.json" : `used-clips-${CHANNEL_ID}.json`);

// Comfortably larger than one video's scene count (up to ~76 scenes with top-ups) so a clip
// used earlier THIS video is also avoided later in the SAME video, plus enough headroom that a
// book's small stockKeywords/visual pool doesn't start repeating again for many days.
const MAX_HISTORY = 400;

export async function loadUsedClipIds() {
  try {
    const raw = await fs.readFile(HISTORY_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.ids) ? parsed.ids : [];
  } catch {
    return []; // first run, or file doesn't exist yet
  }
}

export async function saveUsedClipIds(ids) {
  const trimmed = ids.slice(-MAX_HISTORY);
  await fs.writeFile(
    HISTORY_PATH,
    JSON.stringify({ ids: trimmed, updated_at: new Date().toISOString() }, null, 2) + "\n"
  );
  return trimmed;
}
