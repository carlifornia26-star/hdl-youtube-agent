// READ-ONLY comment watch: lists recent comment threads for this channel and records the ones
// not seen before in comment-watch/<channel>.json. Posts, likes and replies NOTHING.
import fs from "node:fs/promises";
import { getYoutubeClient } from "./youtube.js";
const ch = process.env.WATCH_CHANNEL || "1";
const file = `comment-watch/channel-${ch}.json`;
const yt = getYoutubeClient();
const me = (await yt.channels.list({ part: ["id", "snippet"], mine: true })).data.items?.[0];
console.log(`channel ${ch}:`, me?.id, me?.snippet?.title);
let state = { seen: [], pending: [] };
try { state = JSON.parse(await fs.readFile(file, "utf8")); } catch {}
let r;
try {
  r = await yt.commentThreads.list({ part: ["snippet"], allThreadsRelatedToChannelId: me.id, maxResults: 50, order: "time" });
  console.log("commentThreads.list OK, returned:", (r.data.items || []).length);
} catch (e) { console.log("commentThreads.list FAILED:", e.code, e.message); process.exit(0); }
const seen = new Set(state.seen);
let added = 0;
for (const t of r.data.items || []) {
  if (seen.has(t.id)) continue;
  const s = t.snippet.topLevelComment.snippet;
  if (s.authorChannelId?.value === me.id) { seen.add(t.id); continue; } // our own comment
  state.pending.push({ thread_id: t.id, video_id: t.snippet.videoId, author: s.authorDisplayName, text: String(s.textDisplay).slice(0, 500), at: s.publishedAt, replies: t.snippet.totalReplyCount });
  seen.add(t.id); added++;
}
state.seen = [...seen].slice(-500);
await fs.mkdir("comment-watch", { recursive: true });
await fs.writeFile(file, JSON.stringify(state, null, 1));
console.log(`new comments: ${added}, pending total: ${state.pending.length}`);
