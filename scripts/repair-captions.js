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

// Run the shared translator. Returns { ok, lines, failIndex } - on garble failure it
// parses the {"error","line_index","lang"} JSON the script emits on stderr so we know
// exactly which source line Argos choked on.
function tryTranslate(lines, lang) {
  const res = spawnSync("python3", ["scripts/translate-captions.py"], {
    input: JSON.stringify({ lines, lang }),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.status !== 0) {
    let failIndex = null;
    const m = /\{[^{}]*"line_index"\s*:\s*(\d+)[^{}]*\}/.exec(res.stderr || "");
    if (m) failIndex = Number(m[1]);
    return { ok: false, failIndex, stderr: (res.stderr || "").trim() };
  }
  const out = JSON.parse(res.stdout);
  if (!Array.isArray(out.lines) || out.lines.length !== lines.length) {
    throw new Error(`translate-captions.py returned ${out.lines?.length} lines for ${lines.length} inputs (${lang})`);
  }
  return { ok: true, lines: out.lines };
}

// Strip control chars / collapse whitespace - invisible junk can push Argos into the
// garble loop.
function normalizeLine(line) {
  return line.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}

function splitHalves(line) {
  const words = line.split(/\s+/);
  if (words.length < 4) return null;
  const mid = Math.ceil(words.length / 2);
  return [words.slice(0, mid).join(" "), words.slice(mid).join(" ")];
}

// Last-resort single-line translation via Workers AI m2m100 (same model + short language
// codes the daily pipeline's translateMeta uses). Result is garble-checked by the same
// looks_garbled() guard from scripts/translate-captions.py before it's accepted.
async function translateLineWorkerAI(line, lang) {
  const accountId = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_API_TOKEN;
  if (!accountId || !token) throw new Error("CF_ACCOUNT_ID/CF_API_TOKEN not set for the Workers AI fallback.");
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/meta/m2m100-1.2b`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: line, source_lang: "english", target_lang: lang }),
  });
  if (!res.ok) throw new Error(`Workers AI m2m100 failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  if (!json.success) throw new Error(`Workers AI m2m100 error: ${JSON.stringify(json.errors)}`);
  const out = String(json.result?.translated_text || "").trim();
  if (!out) throw new Error("Workers AI m2m100 returned empty text.");
  const check = spawnSync("python3", ["-c",
    "import importlib.util, sys, json; " +
    "spec = importlib.util.spec_from_file_location('tc', 'scripts/translate-captions.py'); " +
    "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); " +
    "d = json.load(sys.stdin); sys.exit(1 if m.looks_garbled(d['src'], d['out']) else 0)"],
    { input: JSON.stringify({ src: line, out }), encoding: "utf8" });
  if (check.status !== 0) throw new Error("Workers AI fallback output failed the garble guard too.");
  return out;
}

// Translate all lines, mitigating a deterministic Argos garble on one source line:
// 1) retry with the line normalized, 2) retry with the line split in halves (rejoined
//    after translation), 3) translate ONLY that line via Workers AI m2m100 and splice it
//    into the Argos results for the rest. Still failing => throw (fail loudly, as before).
async function translateLines(lines, lang) {
  let attempt = tryTranslate(lines, lang);
  if (attempt.ok) return attempt.lines;

  let idx = attempt.failIndex;
  if (idx == null || !lines[idx]) {
    throw new Error(`translate-captions.py failed for ${lang} without a usable line_index: ${attempt.stderr}`);
  }
  console.error(`Argos garble on ${lang} line_index ${idx}: "${lines[idx]}"`);

  const normalized = normalizeLine(lines[idx]);
  if (normalized && normalized !== lines[idx]) {
    console.error(`Retrying ${lang} with normalized line: "${normalized}"`);
    const patched = [...lines]; patched[idx] = normalized;
    attempt = tryTranslate(patched, lang);
    if (attempt.ok) return attempt.lines;
    idx = attempt.failIndex ?? idx;
    console.error(`Normalized retry still failed (line_index ${attempt.failIndex}).`);
  }

  const halves = splitHalves(normalizeLine(lines[idx]));
  if (halves) {
    console.error(`Retrying ${lang} with line split in halves.`);
    const patched = [...lines.slice(0, idx), ...halves, ...lines.slice(idx + 1)];
    attempt = tryTranslate(patched, lang);
    if (attempt.ok) {
      const merged = [...attempt.lines.slice(0, idx), `${attempt.lines[idx]} ${attempt.lines[idx + 1]}`.trim(), ...attempt.lines.slice(idx + 2)];
      return merged;
    }
    console.error(`Split retry still failed (line_index ${attempt.failIndex}).`);
  }

  console.error(`Falling back to Workers AI m2m100 for ${lang} line_index ${idx} only.`);
  const workerLine = await translateLineWorkerAI(normalizeLine(lines[idx]), lang);
  const rest = [...lines.slice(0, idx), ...lines.slice(idx + 1)];
  const restResult = tryTranslate(rest, lang);
  if (!restResult.ok) {
    throw new Error(`Argos also failed on ${lang} line_index ${restResult.failIndex} with the garbled line removed: ${restResult.stderr}`);
  }
  const merged = [...restResult.lines.slice(0, idx), workerLine, ...restResult.lines.slice(idx)];
  console.error(`Workers AI fallback succeeded for ${lang} line_index ${idx}: "${workerLine}"`);
  return merged;
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
      const translated = await translateLines(allLines, lang);
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
