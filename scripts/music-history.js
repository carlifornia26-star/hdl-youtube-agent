// Persists which background-music track titles were used recently, across daily runs, so the
// larger live catalog (see music.js) doesn't happen to pick the same track again for a while.
// One file per channel, same suffix pattern as videos-manifest.json / used-clips.json (see
// manifest.js / scene-history.js) so channels 2/3 don't clobber channel 1's history.
import fs from "node:fs/promises";
import path from "node:path";

const CHANNEL_ID = process.env.CHANNEL_ID || "1";
const HISTORY_PATH = path.resolve(CHANNEL_ID === "1" ? "used-music.json" : `used-music-${CHANNEL_ID}.json`);

// Comfortably smaller than the qualifying-track pool pulled from the live catalog, so "avoid
// anything used recently" still leaves plenty of candidates rather than forcing a repeat.
const MAX_HISTORY = 30;

export async function loadUsedMusicTitles() {
  try {
    const raw = await fs.readFile(HISTORY_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.titles) ? parsed.titles : [];
  } catch {
    return []; // first run, or file doesn't exist yet
  }
}

export async function saveUsedMusicTitles(titles) {
  const trimmed = titles.slice(-MAX_HISTORY);
  await fs.writeFile(
    HISTORY_PATH,
    JSON.stringify({ titles: trimmed, updated_at: new Date().toISOString() }, null, 2) + "\n"
  );
  return trimmed;
}
