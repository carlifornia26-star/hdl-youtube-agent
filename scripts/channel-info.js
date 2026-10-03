import { getYoutubeClient } from "./youtube.js";
const yt = getYoutubeClient();
const r = await yt.channels.list({ part: ["snippet", "brandingSettings"], mine: true });
for (const c of r.data.items || []) {
  console.log(JSON.stringify({ channel: process.env.CHANNEL_ID, id: c.id, title: c.snippet.title, customUrl: c.snippet.customUrl || null, country: c.snippet.country || null }));
}
