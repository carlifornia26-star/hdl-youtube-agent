import fetch from "node-fetch";
import fs from "node:fs/promises";
import crypto from "node:crypto";

// incompetech.com (Kevin MacLeod) publishes a real, documented catalog at
// incompetech.com/music/royalty-free/pieces.json, with files served from
// incompetech.com/music/royalty-free/mp3-royaltyfree/{filename}. License: Creative Commons
// By Attribution 4.0 — free including commercial/monetized use, attribution required
// (track title, "Kevin MacLeod", link to incompetech.com — see ATTRIBUTION_LINE below,
// appended to every video/Short description this runs on).
const CATALOG_URL = "https://incompetech.com/music/royalty-free/pieces.json";
const AUDIO_BASE = "https://incompetech.com/music/royalty-free/mp3-royaltyfree/";

// A previous version of this file hardcoded a 6-track shortlist and rotated through it by
// day-of-year — which meant only 6 possible tracks ever played, and with 3 channels sharing the
// same day-of-year value, all 3 channels got the SAME track on a given day (so across a typical
// week of watching, a viewer would really only ever hear a couple of them stand out). This now
// pulls from the live catalog but ONLY uses the hand-approved tracks listed in APPROVED_TITLES
// below, so each channel gets its own pick from a short, vetted list. The 6 tracks in
// FALLBACK_TRACKS (all also on the approved list) are used only if the live catalog can't be
// fetched or none of the approved titles are found in it — so a catalog outage can't fail the
// whole day's video, and no track outside the approved list can ever play.
const FALLBACK_TRACKS = [
  { title: "Sincerely", filename: "Sincerely.mp3" },
  { title: "Wholesome", filename: "Wholesome.mp3" },
  { title: "Late Night Radio", filename: "Late Night Radio.mp3" },
  { title: "Ancient Winds", filename: "Ancient Winds.mp3" },
  { title: "Deep Relaxation", filename: "Deep Relaxation.mp3" },
  { title: "Kalimba Relaxation Music", filename: "Kalimba Relaxation Music.mp3" },
];

// APPROVED TRACKS — the ONLY tracks the pipeline will ever use as background music. One title per
// line, exactly as it appears on incompetech.com. To remove a track you don't like, delete its
// line; to add one, add its title. Titles are matched against the live catalog ignoring
// capitalisation and punctuation, and any title that isn't found is simply skipped (it is logged
// at the start of each run, so you can see which ones matched). The download uses the catalog's
// own filename, so a matched title always downloads correctly.
const APPROVED_TITLES = [
  // Already in use by the pipeline before, known to work
  "Sincerely",
  "Wholesome",
  "Late Night Radio",
  "Ancient Winds",
  "Deep Relaxation",
  "Kalimba Relaxation Music",
  // Calm / gentle / light background tracks
  "Airport Lounge",
  "Relaxing Piano Music",
  "Almost in F - Tranquility",
  "Wallpaper",
  "Carefree",
  "Easy Lemon",
  "Dreamy Flashback",
  "Local Forecast - Elevator",
  "Meditation Impromptu 01",
  "Meditation Impromptu 02",
  "Meditation Impromptu 03",
  "Healing",
  "Heartwarming",
  "Inspired",
  "Gymnopedie No 1",
  "Floating Cities",
  "Water Lily",
  "Ripples",
  "River Flute",
  "Morning",
  "Open Those Bright Eyes",
  "Elf Meditation",
  "Fluidscape",
  "Dreams Become Real",
];

function normTitle(t) {
  return String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
const APPROVED_SET = new Set(APPROVED_TITLES.map(normTitle));

let cachedCandidates = null; // per-process cache — one catalog fetch per run, not per candidate check

async function loadQualifyingTracks() {
  if (cachedCandidates) return cachedCandidates;
  const res = await fetch(CATALOG_URL);
  if (!res.ok) throw new Error(`Catalog fetch failed: HTTP ${res.status}`);
  const all = await res.json();
  if (!Array.isArray(all)) throw new Error("Catalog response was not an array");

  const seen = new Set(); // pieces.json has occasional duplicate titles (different arrangements
  const qualifying = [];  // of the same piece) — keep the first filename seen per title
  for (const entry of all) {
    const title = String(entry.title || "").trim();
    const filename = String(entry.filename || "").trim();
    if (!title || !filename || !APPROVED_SET.has(normTitle(title))) continue;
    if (seen.has(normTitle(title))) continue;
    seen.add(normTitle(title));
    qualifying.push({ title, filename });
  }

  const missing = APPROVED_TITLES.filter((t) => !seen.has(normTitle(t)));
  console.log(`Approved music: ${qualifying.length}/${APPROVED_TITLES.length} titles found in the catalog.` + (missing.length ? ` Not found (skipped): ${missing.join(", ")}` : ""));
  if (qualifying.length === 0) throw new Error("None of the approved tracks were found in the catalog");
  cachedCandidates = qualifying;
  return qualifying;
}

function seededIndex(key, mod) {
  const hash = crypto.createHash("sha256").update(key).digest();
  return hash.readUInt32BE(0) % mod;
}

// Builds the order in which to TRY candidates: starts at a position seeded from the date +
// channel (so each channel gets a different track on a given day, and the pick changes day to
// day across the whole filtered catalog, not just a handful of hardcoded options), then walks
// forward through the list. Candidates whose title is in `recentTitles` are pushed to the end
// (tried only if every fresh candidate's download fails), so recently-used tracks aren't
// repeated for a while but a download failure never has to fall back to silence just because
// every remaining option happens to be "recent".
function buildTryOrder(candidates, seedKey, recentTitles) {
  const n = candidates.length;
  const start = seededIndex(seedKey, n);
  const order = Array.from({ length: n }, (_, i) => candidates[(start + i) % n]);
  const fresh = order.filter((t) => !recentTitles.includes(t.title));
  const stale = order.filter((t) => recentTitles.includes(t.title));
  return [...fresh, ...stale];
}

// Downloads today's track to outPath. Returns the track { title, filename } for attribution.
// `channel` and `recentTitles` are optional — pass the calling channel's CHANNEL_ID and its
// recently-used track titles (see music-history.js) to spread picks across the catalog instead
// of relying on date alone. Tries a handful of candidates in order before giving up, so one
// mistyped/renamed filename in the catalog doesn't lose the day's music entirely.
export async function fetchBackgroundMusic(outPath, { date = new Date(), channel = process.env.CHANNEL_ID || "1", recentTitles = [] } = {}) {
  let candidates;
  try {
    candidates = await loadQualifyingTracks();
  } catch (e) {
    console.warn("Music catalog fetch failed, using fallback shortlist:", e.message);
    candidates = FALLBACK_TRACKS;
  }

  const dayKey = date.toISOString().slice(0, 10); // YYYY-MM-DD, UTC
  const tryOrder = buildTryOrder(candidates, `${dayKey}:${channel}`, recentTitles);
  const MAX_ATTEMPTS = 5; // network failures should be rare; this is a safety net, not the norm

  let lastErr;
  for (const track of tryOrder.slice(0, MAX_ATTEMPTS)) {
    try {
      const url = `${AUDIO_BASE}${encodeURIComponent(track.filename)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await fs.writeFile(outPath, buf);
      return track;
    } catch (e) {
      lastErr = e;
      console.warn(`Music download failed for "${track.title}" (${track.filename}), trying next candidate:`, e.message);
    }
  }
  throw new Error(`All music candidates failed to download: ${lastErr?.message}`);
}

export function attributionLine(track) {
  return `Music: "${track.title}" by Kevin MacLeod (incompetech.com) — licensed under Creative Commons: By Attribution 4.0 (creativecommons.org/licenses/by/4.0/)`;
}
