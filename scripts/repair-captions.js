// Caption-debt repair: add ONLY the missing translated caption tracks to a video that is
// already uploaded (private/scheduled or public). Never deletes or overwrites existing
// tracks - a language that already has a standard track is skipped, so re-runs are safe.
//
// Flow: list current tracks -> download the uploaded English SRT -> translate each missing
// language locally with scripts/translate-captions.py (same Argos engine + garble guards as
// the daily pipeline) -> upload the new tracks -> re-list to verify. Exit 1 if any requested
// language is still missing at the end, so the run fails loudly.
//
// Env:
//   VIDEO_ID      required, the YouTube video ID to repair
//   REPAIR_LANGS  required, comma-separated pipeline language codes (e.g. "zh" or "ar")
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { getYoutubeClient, uploadCaptionTrack } from "./youtube.js";

// Same mapping the daily pipeline uses (scripts/generate-video.js).
const YT_LOCALE_MAP = { zh: "zh-Hans" };

function parseSrt(srt) {
  const blocks = [];
  for (const chunk of srt.replace(/\r\n/g, "\n").split(/\n\n+/)) {
    const lines = chunk.split("\n").filter((l) => l.length > 0);
    if (lines.length < 2) continue;
    const timingIdx = lines.findIndex((l) => l.includes("-->"));
    if (timingIdx < 0) continue;
    blocks.push({ index: lines[0], timing: lines[timingIdx], textLines: lines.slice(timingIdx + 1) });
  }
  return blocks;
}

function buildSrt(blocks) {
  return blocks.map((b) => `${b.index}\n${b.timing}\n${b.textLines.join("\n")}`).join("\n\n") + "\n";
}

function translateLines(lines, lang) {
  const res = spawnSync("python3", ["scripts/translate-captions.py"], {
    input: JSON.stringify({ lines, lang }),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.status !== 0) {
    throw new Error(`translate-captions.py exited ${res.status} for ${lang}: ${(res.stderr || "").trim()}`);
  }
  const out = JSON.parse(res.stdout);
  if (!Array.isArray(out.lines) || out.lines.length !== lines.length) {
    throw new Error(`translate-captions.py returned ${out.lines?.length} lines for ${lines.length} inputs (${lang})`);
  }
  return out.lines;
}

async function main() {
  const youtube = getYoutubeClient();
  const videoId = String(process.env.VIDEO_ID || "").trim();
  const langs = String(process.env.REPAIR_LANGS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!videoId) throw new Error("VIDEO_ID is required.");
  if (!langs.length) throw new Error("REPAIR_LANGS is required (comma-separated).");

  // 1) Ground truth: what tracks does the video actually have right now?
  const before = await youtube.captions.list({ part: ["snippet"], videoId });
  const tracks = before.data.items || [];
  console.log(`Current tracks on ${videoId} (${tracks.length}):`);
  for (const t of tracks) {
    console.log(`  ${t.snippet.language} kind=${t.snippet.trackKind || "standard"} name="${t.snippet.name || ""}" id=${t.id}`);
  }
  const standardLangs = new Set(tracks.filter((t) => t.snippet.trackKind !== "asr").map((t) => t.snippet.language));

  const toRepair = langs.filter((lang) => !standardLangs.has(YT_LOCALE_MAP[lang] ?? lang));
  const skipped = langs.filter((lang) => standardLangs.has(YT_LOCALE_MAP[lang] ?? lang));
  if (skipped.length) console.log(`Already present, skipping (no duplicates): ${skipped.join(", ")}`);
  if (!toRepair.length) {
    console.log("Nothing to repair - all requested languages already have tracks.");
    return;
  }

  // 2) English source track (the uploaded one, not auto-generated ASR).
  const enTrack = tracks.find((t) => t.snippet.language === "en" && t.snippet.trackKind !== "asr");
  if (!enTrack) throw new Error("No uploaded English caption track found to translate from.");
  console.log(`Using English track id=${enTrack.id} as translation source.`);
  const dl = await youtube.captions.download({ id: enTrack.id, tfmt: "srt" }, { responseType: "text" });
  const enSrt = typeof dl.data === "string" ? dl.data : Buffer.from(dl.data).toString("utf8");
  const blocks = parseSrt(enSrt);
  if (!blocks.length) throw new Error("English track downloaded but no SRT blocks parsed.");
  console.log(`English SRT: ${blocks.length} blocks.`);

  // 3) Translate + upload each missing language. Existing tracks are never touched.
  const failed = [];
  for (const lang of toRepair) {
    const ytLang = YT_LOCALE_MAP[lang] ?? lang;
    try {
      const allLines = blocks.flatMap((b) => b.textLines);
      const translated = translateLines(allLines, lang);
      let k = 0;
      const outBlocks = blocks.map((b) => {
        const n = b.textLines.length;
        const textLines = translated.slice(k, k + n);
        k += n;
        return { index: b.index, timing: b.timing, textLines };
      });
      const srtPath = path.join(os.tmpdir(), `repair_${videoId}_${lang}.srt`);
      await fs.writeFile(srtPath, buildSrt(outBlocks));
      await uploadCaptionTrack({ videoId, language: ytLang, srtPath, name: lang });
      console.log(`Repaired ${lang} (${ytLang}): ${blocks.length} blocks uploaded.`);
    } catch (e) {
      failed.push(lang);
      console.error(`Repair FAILED for ${lang}: ${e.message}`);
    }
  }

  // 4) Verify final track list.
  const after = await youtube.captions.list({ part: ["snippet"], videoId });
  const finalLangs = new Set((after.data.items || []).filter((t) => t.snippet.trackKind !== "asr").map((t) => t.snippet.language));
  console.log(`Final tracks on ${videoId} (${after.data.items.length}): ${[...finalLangs].sort().join(", ")}`);
  const stillMissing = langs.filter((lang) => !finalLangs.has(YT_LOCALE_MAP[lang] ?? lang));
  if (stillMissing.length || failed.length) {
    console.error(`Caption repair INCOMPLETE: still missing [${[...new Set([...stillMissing, ...failed])].join(", ")}]`);
    process.exitCode = 1;
  } else {
    console.log(`Caption repair COMPLETE for ${videoId}: ${langs.join(", ")} all present.`);
  }
}

main().catch((err) => {
  console.error("repair-captions.js crashed:", err);
  process.exitCode = 1;
});
