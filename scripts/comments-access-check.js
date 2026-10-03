// READ-ONLY check: can the stored token read comment threads? Posts nothing.
import { getYoutubeClient } from "./youtube.js";
const yt = getYoutubeClient();
const ch = await yt.channels.list({ part: ["id", "snippet"], mine: true });
const id = ch.data.items?.[0]?.id;
console.log("channel:", id, ch.data.items?.[0]?.snippet?.title);
try {
  const r = await yt.commentThreads.list({ part: ["snippet"], allThreadsRelatedToChannelId: id, maxResults: 5 });
  console.log("commentThreads.list OK, threads returned:", (r.data.items || []).length);
} catch (e) { console.log("commentThreads.list FAILED:", e.code, e.message); }
