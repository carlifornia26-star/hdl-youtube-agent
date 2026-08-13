import fetch from "node-fetch";
import fs from "node:fs/promises";

// incompetech.com (Kevin MacLeod) publishes a real, documented catalog at
// incompetech.com/music/royalty-free/pieces.json, with files served from
// incompetech.com/music/royalty-free/mp3-royaltyfree/{filename}. License: Creative Commons
// By Attribution 4.0 — free including commercial/monetized use, attribution required
// (track title, "Kevin MacLeod", link to incompetech.com — see ATTRIBUTION_LINE below,
// appended to every video/Short description this runs on).
//
// This is a curated, hardcoded shortlist rather than a live catalog fetch+pick — keeps the
// music predictable (calm/neutral, won't clash with any book's topic) and avoids the run
// picking something like "Farting Around" or "Circus of Freaks", both real tracks in that
// catalog. Rotates by day-of-year, same pattern as catalog.js's book rotation.
const TRACKS = [
  { title: "Sincerely", filename: "Sincerely.mp3" },
  { title: "Wholesome", filename: "Wholesome.mp3" },
  { title: "Late Night Radio", filename: "Late Night Radio.mp3" },
  { title: "Ancient Winds", filename: "Ancient Winds.mp3" },
  { title: "Deep Relaxation", filename: "Deep Relaxation.mp3" },
  { title: "Kalimba Relaxation Music", filename: "Kalimba Relaxation Music.mp3" },
];

export function pickTodaysTrack(date = new Date()) {
  const start = new Date(date.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((date - start) / 86400000);
  return TRACKS[dayOfYear % TRACKS.length];
}

// Downloads today's track to outPath. Returns the track { title, filename } for attribution.
export async function fetchBackgroundMusic(outPath, date = new Date()) {
  const track = pickTodaysTrack(date);
  const url = `https://incompetech.com/music/royalty-free/mp3-royaltyfree/${encodeURIComponent(track.filename)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Incompetech music download failed: ${res.status} for "${track.filename}"`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(outPath, buf);
  return track;
}

export function attributionLine(track) {
  return `Music: "${track.title}" by Kevin MacLeod (incompetech.com) — licensed under Creative Commons: By Attribution 4.0 (creativecommons.org/licenses/by/4.0/)`;
  }
