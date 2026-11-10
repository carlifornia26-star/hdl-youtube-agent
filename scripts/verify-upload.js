// Read-only upload verification for videos already on YouTube (private/scheduled or public).
// Prints everything it finds; changes nothing. Exit 1 only on API/lookup failure, so a
// broken check fails loudly instead of silently passing.
//
// For each video id:
//   1. status + contentDetails + fileDetails (owner-only part): privacy, publishAt,
//      container duration, audio/video stream codec+count+bitrate from YouTube's own
//      record of the uploaded file.
//   2. Downloads the uploaded English caption track (the script text) AND YouTube's own
//      auto-ASR track (YouTube's transcription of the actual uploaded audio) and compares
//      them. If YouTube's ASR of the file matches the script, the uploaded audio really
//      speaks the script - a spoken-content check that needs no Studio sign-in.
//
// Env:
//   VIDEO_IDS  required, comma-separated YouTube video IDs
import { getYoutubeClient } from "./youtube.js";

function isoDurationToSeconds(iso) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/.exec(iso || "");
  if (!m) return null;
  return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
}

// SRT -> normalized word sequence (timing/index lines stripped).
function srtWords(srt) {
  const words = [];
  for (const raw of String(srt).replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line || /^\d+$/.test(line) || line.includes("-->")) continue;
    for (const w of line.toLowerCase().replace(/<[^>]+>/g, " ").replace(/[^\p{L}\p{N}' ]/gu, " ").split(/\s+/)) {
      if (w) words.push(w);
    }
  }
  return words;
}

// YouTube ASR SRTs use rolling captions: each block repeats the previous block's tail
// plus new words ("hello world" -> "world this is"). Collapse consecutive duplicate
// words so the comparison isn't skewed by that overlap.
function dedupeRolling(words) {
  const out = [];
  for (const w of words) {
    if (out[out.length - 1] !== w) out.push(w);
  }
  return out;
}

// LCS length ratio against the shorter sequence: word-order-sensitive similarity.
function lcsRatio(a, b) {
  if (!a.length || !b.length) return 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[b.length] / Math.min(a.length, b.length);
}

// Bag-of-words coverage: fraction of script words present in the ASR word multiset.
function bagCoverage(scriptWords, asrWords) {
  const counts = new Map();
  for (const w of asrWords) counts.set(w, (counts.get(w) || 0) + 1);
  let hit = 0;
  for (const w of scriptWords) {
    const c = counts.get(w) || 0;
    if (c > 0) { hit++; counts.set(w, c - 1); }
  }
  return scriptWords.length ? hit / scriptWords.length : 0;
}

async function downloadTrack(youtube, track) {
  const dl = await youtube.captions.download({ id: track.id, tfmt: "srt" }, { responseType: "text" });
  return typeof dl.data === "string" ? dl.data : Buffer.from(dl.data).toString("utf8");
}

async function main() {
  const youtube = getYoutubeClient();
  const videoIds = String(process.env.VIDEO_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!videoIds.length) throw new Error("VIDEO_IDS is required (comma-separated).");

  for (const videoId of videoIds) {
    console.log("\n==================================================");
    console.log(`VERIFY ${videoId}`);
    console.log("==================================================");

    const v = await youtube.videos.list({ part: ["status", "contentDetails", "fileDetails"], id: [videoId] });
    const item = (v.data.items || [])[0];
    if (!item) { console.error(`videos.list returned no item for ${videoId}`); process.exitCode = 1; continue; }
    const st = item.status || {};
    const cd = item.contentDetails || {};
    const fd = item.fileDetails || {};
    console.log(`privacyStatus=${st.privacyStatus} publishAt=${st.publishAt || "(none)"} uploadStatus=${st.uploadStatus}`);
    const secs = isoDurationToSeconds(cd.duration);
    console.log(`contentDetails.duration=${cd.duration} (${secs == null ? "?" : secs.toFixed(1)}s) definition=${cd.definition} caption=${cd.caption}`);
    if (fd.durationMs != null) console.log(`fileDetails.durationMs=${fd.durationMs} (${(fd.durationMs / 1000).toFixed(1)}s) fileSize=${fd.fileSize} container=${fd.container}`);
    for (const vs of fd.videoStreams || []) console.log(`  videoStream: codec=${vs.codec} ${vs.widthPixels}x${vs.heightPixels} fps=${vs.frameRateFps} bitrateBps=${vs.bitrateBps}`);
    for (const as of fd.audioStreams || []) console.log(`  audioStream: codec=${as.codec} channels=${as.channelCount} bitrateBps=${as.bitrateBps}`);
    if (!(fd.audioStreams || []).length) console.error(`  WARNING: no audioStreams in fileDetails for ${videoId}`);

    const caps = await youtube.captions.list({ part: ["snippet"], videoId });
    const tracks = caps.data.items || [];
    const enStd = tracks.find((t) => t.snippet.language === "en" && t.snippet.trackKind !== "asr");
    const enAsr = tracks.find((t) => t.snippet.language === "en" && t.snippet.trackKind === "asr");
    console.log(`tracks=${tracks.length} enStandard=${enStd ? "yes" : "NO"} enAsr=${enAsr ? "yes" : "not yet (YouTube may still be processing)"}`);
    if (!enStd || !enAsr) continue;

    const scriptWords = srtWords(await downloadTrack(youtube, enStd));
    const asrWords = dedupeRolling(srtWords(await downloadTrack(youtube, enAsr)));
    const lcs = lcsRatio(scriptWords, asrWords);
    const bag = bagCoverage(scriptWords, asrWords);
    console.log(`script words=${scriptWords.length} asr words=${asrWords.length}`);
    console.log(`SPOKEN-CONTENT MATCH: word-sequence LCS=${(lcs * 100).toFixed(1)}% vocabulary coverage=${(bag * 100).toFixed(1)}%`);
    console.log("---- script text (uploaded en track) ----");
    console.log(scriptWords.join(" "));
    console.log("---- YouTube ASR text (its transcription of the uploaded audio) ----");
    console.log(asrWords.join(" "));
    console.log("---- end ----");
  }
}

main().catch((err) => {
  console.error("verify-upload.js crashed:", err);
  process.exitCode = 1;
});
