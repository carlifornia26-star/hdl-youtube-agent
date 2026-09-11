// One-off analysis script: pulls full public metadata (title, description, tags, category,
// duration, publish time, stats) for a hardcoded list of competitor videos via videos.list,
// using the same OAuth client as the rest of this repo (getYoutubeClient() from youtube.js —
// videos.list works on ANY public video ID with just an OAuth/API-key client, no special scope
// needed). Also pulls your own channel's most recent uploads for a side-by-side comparison.
// Run via the "Analyze Competitor" GitHub Actions workflow (workflow_dispatch only, no
// schedule) — read-only, nothing is written back to YouTube or committed to the repo.
import { getYoutubeClient } from "./youtube.js";

// Edit this list to analyze different videos later.
const COMPETITOR_VIDEO_IDS = ["gTKS8SAwUzE", "Qtl8lJwbd4g", "Af6i6ChAVTw", "lVylRtlPOIE"];

// How many of YOUR most recent uploads to pull for comparison.
const OWN_RECENT_COUNT = 5;

function fmtDuration(iso) {
  // ISO 8601 duration (e.g. PT8M32S) -> "8:32"
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || "");
  if (!m) return iso || "?";
  const h = Number(m[1] || 0);
  const min = Number(m[2] || 0);
  const s = Number(m[3] || 0);
  const parts = h ? [h, String(min).padStart(2, "0"), String(s).padStart(2, "0")] : [min, String(s).padStart(2, "0")];
  return parts.join(":");
}

function printVideo(v, label) {
  const sn = v.snippet || {};
  const cd = v.contentDetails || {};
  const st = v.statistics || {};
  const tags = sn.tags || [];
  const tagsJoined = tags.join(", ");

  console.log(`\n${"=".repeat(80)}`);
  console.log(`${label}  [${v.id}]  https://www.youtube.com/watch?v=${v.id}`);
  console.log("=".repeat(80));
  console.log(`Title (${sn.title?.length ?? 0} chars): ${sn.title}`);
  console.log(`Published: ${sn.publishedAt}`);
  console.log(`Duration: ${fmtDuration(cd.duration)}`);
  console.log(`Category ID: ${sn.categoryId}`);
  console.log(`Default language / audio: ${sn.defaultLanguage || "—"} / ${sn.defaultAudioLanguage || "—"}`);
  console.log(`Views: ${st.viewCount ?? "—"}  Likes: ${st.likeCount ?? "—"}  Comments: ${st.commentCount ?? "—"}`);
  console.log(`Tags (${tags.length}, ${tagsJoined.length} chars): ${tagsJoined || "(none)"}`);
  console.log(`Description (${(sn.description || "").length} chars):`);
  console.log((sn.description || "").split("\n").map((l) => "  " + l).join("\n"));
}

async function fetchVideos(youtube, ids) {
  if (!ids.length) return [];
  const res = await youtube.videos.list({
    part: ["snippet", "contentDetails", "statistics"],
    id: ids,
  });
  return res.data.items || [];
}

async function fetchOwnRecentVideoIds(youtube, count) {
  const channelRes = await youtube.channels.list({ part: ["contentDetails"], mine: true });
  const uploadsPlaylistId = channelRes.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) {
    console.log("Could not find your uploads playlist (YT_REFRESH_TOKEN issue?) — skipping own-channel comparison.");
    return [];
  }
  const playlistRes = await youtube.playlistItems.list({
    part: ["contentDetails"],
    playlistId: uploadsPlaylistId,
    maxResults: count,
  });
  return (playlistRes.data.items || []).map((i) => i.contentDetails.videoId);
}

async function main() {
  const youtube = getYoutubeClient();

  console.log(`Fetching ${COMPETITOR_VIDEO_IDS.length} competitor video(s)...`);
  const competitorVideos = await fetchVideos(youtube, COMPETITOR_VIDEO_IDS);

  console.log(`\nFetching your last ${OWN_RECENT_COUNT} upload(s) for comparison...`);
  const ownIds = await fetchOwnRecentVideoIds(youtube, OWN_RECENT_COUNT);
  const ownVideos = await fetchVideos(youtube, ownIds);

  console.log("\n\n" + "#".repeat(80));
  console.log("# COMPETITOR VIDEOS");
  console.log("#".repeat(80));
  competitorVideos.forEach((v, i) => printVideo(v, `Competitor ${i + 1}`));

  console.log("\n\n" + "#".repeat(80));
  console.log("# YOUR RECENT VIDEOS");
  console.log("#".repeat(80));
  ownVideos.forEach((v, i) => printVideo(v, `Yours ${i + 1}`));

  // Quick numeric summary to eyeball gaps without scrolling.
  console.log("\n\n" + "#".repeat(80));
  console.log("# SUMMARY (title length / tag count / tag chars / description chars)");
  console.log("#".repeat(80));
  const summarize = (v) => ({
    id: v.id,
    titleLen: v.snippet?.title?.length ?? 0,
    tagCount: (v.snippet?.tags || []).length,
    tagChars: (v.snippet?.tags || []).join(", ").length,
    descChars: (v.snippet?.description || "").length,
  });
  console.log("Competitors:");
  competitorVideos.map(summarize).forEach((s) => console.log(`  ${s.id}: title=${s.titleLen}  tags=${s.tagCount}(${s.tagChars}ch)  desc=${s.descChars}ch`));
  console.log("Yours:");
  ownVideos.map(summarize).forEach((s) => console.log(`  ${s.id}: title=${s.titleLen}  tags=${s.tagCount}(${s.tagChars}ch)  desc=${s.descChars}ch`));
}

main().catch((err) => {
  console.error("analyze-competitor.js failed:", err);
  process.exit(1);
});
