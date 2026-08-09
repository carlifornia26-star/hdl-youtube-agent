import { eximport { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
// ffmpeg's own console output (progress lines, and especially warnings) can run to several MB
// on a 10-minute, 20+ scene video. Node's execFile defaults to a 1MB stdout+stderr buffer and
// throws ERR_CHILD_PROCESS_STDIO_MAXBUFFER if that's exceeded — raise it well above anything
// this pipeline should realistically produce, even in a noisy/warning-heavy run.
const MAX_BUFFER = 64 * 1024 * 1024; // 64MB
function run(cmd, args) {
  return execFileAsync(cmd, args, { maxBuffer: MAX_BUFFER });
}

export async function probeDuration(filePath) {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  return parseFloat(stdout.trim());
}

async function hasAudioStream(filePath) {
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error",
      "-select_streams", "a",
      "-show_entries", "stream=index",
      "-of", "csv=p=0",
      filePath,
    ]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// Every scene is forced to the same frame rate / audio sample rate / channel layout below,
// regardless of what the source Pexels clip natively has. Different stock clips come in with
// different fps and audio formats; without normalizing each scene to identical parameters,
// concatScenes' "-c copy" (pure stream copy, no re-encoding) can't reconcile the mismatched
// timestamps between segments, producing a "Non-monotonic DTS" warning on nearly every packet
// (thousands of lines, which is also what blew past execFile's stdout/stderr buffer above).
const OUTPUT_FPS = 25;
const OUTPUT_SAMPLE_RATE = 44100;
const OUTPUT_CHANNELS = 2;

// Loops/trims the stock clip to a caller-supplied duration and burns the caption line in.
// No narration track: keeps the stock clip's own ambient audio instead of muting it. If the
// clip has no audio stream (some Pexels clips don't), a silent track is generated instead —
// every scene needs a consistent audio stream, or concatScenes' "-c copy" concat breaks on
// the mismatch between scenes that have audio and scenes that don't.
// `duration` is computed by the caller from the line's word count (see generate-video.js) —
// there's no longer a voice file to probe for length.
export async function buildScene({ clipPath, duration, text, outPath }) {
  const safeText = text.replace(/:/g, "\\:").replace(/'/g, "\u2019");
  const clipHasAudio = await hasAudioStream(clipPath);

  const inputs = clipHasAudio
    ? ["-stream_loop", "-1", "-i", clipPath]
    : ["-stream_loop", "-1", "-i", clipPath, "-f", "lavfi", "-i", `anullsrc=channel_layout=stereo:sample_rate=${OUTPUT_SAMPLE_RATE}`];
  const audioMap = clipHasAudio ? ["-map", "0:a"] : ["-map", "1:a"];

  await run("ffmpeg", [
    "-y",
    ...inputs,
    "-filter_complex",
    `[0:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,` +
      `drawtext=text='${safeText}':fontcolor=white:fontsize=34:box=1:boxcolor=black@0.55:boxborderw=14:` +
      `x=(w-text_w)/2:y=h-160:line_spacing=6[v]`,
    "-map", "[v]",
    ...audioMap,
    "-t", String(duration),
    "-r", String(OUTPUT_FPS),
    "-fps_mode", "cfr",
    "-ar", String(OUTPUT_SAMPLE_RATE),
    "-ac", String(OUTPUT_CHANNELS),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-c:a", "aac",
    "-shortest",
    outPath,
  ]);
  return { outPath, duration };
}

export async function concatScenes(sceneOutPaths, listFile, outPath) {
  const fs = await import("node:fs/promises");
  const content = sceneOutPaths.map((p) => `file '${path.resolve(p)}'`).join("\n");
  await fs.writeFile(listFile, content);
  await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", outPath]);
  return outPath;
}

// Grabs a frame from a scene clip and overlays the book title for a YouTube thumbnail (1280x720 JPG).
export async function generateThumbnail({ clipPath, title, outPath }) {
  const safeTitle = title.replace(/:/g, "\\:").replace(/'/g, "\u2019");
  await run("ffmpeg", [
    "-y",
    "-i", clipPath,
    "-vf",
    `scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,` +
      // "fontweight" is not a real drawtext option — ffmpeg has no such flag, bold text needs
      // an actual bold font file via fontfile=. Removed rather than added, to avoid depending
      // on a specific font path existing on the GitHub Actions runner.
      `drawtext=text='${safeTitle}':fontcolor=white:fontsize=54:box=1:boxcolor=black@0.6:boxborderw=20:` +
      `x=(w-text_w)/2:y=(h-text_h)/2`,
    "-frames:v", "1",
    outPath,
  ]);
  return outPath;
}

// Builds an SRT caption file from scenes (array of {line, duration}) for a given language's translated lines.
export function buildSrt(scenesWithDurations, translatedLines) {
  let t = 0;
  let out = "";
  scenesWithDurations.forEach((scene, i) => {
    const start = fmt(t);
    t += scene.duration;
    const end = fmt(t);
    out += `${i + 1}\n${start} --> ${end}\n${translatedLines[i] || scene.line}\n\n`;
  });
  return out;

  function fmt(sec) {
    const h = String(Math.floor(sec / 3600)).padStart(2, "0");
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
    const s = String(Math.floor(sec % 60)).padStart(2, "0");
    const ms = String(Math.floor((sec % 1) * 1000)).padStart(3, "0");
    return `${h}:${m}:${s},${ms}`;
  }
}￼Enter
