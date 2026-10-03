import fs from "node:fs/promises";
import { getYoutubeClient, createPlaylist, addVideoToPlaylist } from "./youtube.js";

// Niche "magazine" playlists on channel 1. Cross-lists existing videos; never uploads.
// Idempotent: reuses playlists by title, skips videos already present, stops on quota.
const SITE = "https://highdefinitionlearning.pages.dev";
const NICHES = [
  { title: "AI & Digital Business | HDL Group", slugs: ["age-one", "age-one-premium", "youtube-algorithms"],
    description: `Short teasers on AI, the information economy and digital business, from the AGE ONE books and YouTube Algorithms by High Definition Learning Group. All books: ${SITE}` },
  { title: "Bitcoin & Finance | HDL Group", slugs: ["bitcoin-standard"],
    description: `Short teasers on Bitcoin and money, from The Bitcoin Standard: Pure Mathematics of Money by High Definition Learning Group. All books: ${SITE}` },
  { title: "Wellness & Positive Living | HDL Group", slugs: ["science-of-feeling-great", "art-of-joy"],
    description: `Short teasers on wellness, contentment and positive living, from The Science of Feeling Great and The Art of Joy by High Definition Learning Group. All books: ${SITE}` },
  { title: "Pets | HDL Group", slugs: ["pet-friendly"],
    description: `Short teasers on living with pets, from Pet Friendly by High Definition Learning Group. All books: ${SITE}` },
];

async function main() {
  const yt = getYoutubeClient();
  const manifest = JSON.parse(await fs.readFile("videos-manifest.json", "utf8")).videos;
  const mine = [];
  let token;
  do {
    const r = await yt.playlists.list({ part: ["snippet"], mine: true, maxResults: 50, pageToken: token });
    mine.push(...r.data.items); token = r.data.nextPageToken;
  } while (token);
  const state = {};
  try { Object.assign(state, JSON.parse(await fs.readFile("niche-playlists.json", "utf8"))); } catch {}
  let adds = 0;
  // Remove empty duplicates of a niche title that are not the tracked playlist.
  for (const p of mine) {
    const tracked = state[p.snippet.title];
    if (!tracked || p.id === tracked || !NICHES.some((n) => n.title === p.snippet.title)) continue;
    try {
      const r = await yt.playlistItems.list({ part: ["id"], playlistId: p.id, maxResults: 1 });
      if ((r.data.items || []).length === 0) { await yt.playlists.delete({ id: p.id }); console.log("Deleted empty duplicate", p.id, p.snippet.title); }
    } catch (e) { console.log("Dedupe skipped:", e.message); }
  }
  for (const n of NICHES) {
    let id = mine.find((p) => p.snippet.title === n.title)?.id || state[n.title];
    try {
      if (!id) { id = (await createPlaylist({ title: n.title, description: n.description, localizations: {} })).id; console.log("Created", n.title, id); }
      state[n.title] = id;
      const present = new Set();
      let t;
      try {
        do {
          const r = await yt.playlistItems.list({ part: ["contentDetails"], playlistId: id, maxResults: 50, pageToken: t });
          r.data.items.forEach((i) => present.add(i.contentDetails.videoId)); t = r.data.nextPageToken;
        } while (t);
      } catch (e) { console.log("List not ready yet (new playlist), treating as empty:", e.message); }
      for (const v of manifest.filter((m) => n.slugs.includes(m.book_slug))) {
        if (present.has(v.video_id)) continue;
        await addVideoToPlaylist({ playlistId: id, videoId: v.video_id });
        adds++; console.log("Added", v.video_id, "->", n.title);
      }
    } catch (e) {
      console.error("Failed:", n.title, e.message);
      if (e.isQuotaExceeded) { console.error("Quota exhausted - re-run after reset."); break; }
      process.exitCode = 1;
    }
  }
  await fs.writeFile("niche-playlists.json", JSON.stringify(state, null, 2) + "\n");
  console.log(`Done. ${adds} added. https://youtube.com/playlist?list=` + Object.values(state).join(" "));
}
main().catch((e) => { console.error(e.message); process.exit(1); });
