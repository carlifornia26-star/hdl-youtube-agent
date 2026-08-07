import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);

export async function probeDuration(filePath) {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  return parseFloat(stdout.trim());
}

// Loops/trims the stock clip to match narration length, burns the caption line in, mutes original audio.
export async function buildScene({ clipPath, audioPath, text, outPath }) {
  const dur = await probeDuration(audioPath);
  const safeText = text.replace(/:/g, "\\:").replace(/'/g, "\u2019");

  await run("ffmpeg", [
    "-y",
    "-stream_loop", "-1", "-i", clipPath,
    "-i", audioPath,
    "-filter_complex",
    `[0:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,` +
      `drawtext=text='${safeText}':fontcolor=white:fontsize=34:box=1:boxcolor=black@0.55:boxborderw=14:` +
      `x=(w-text_w)/2:y=h-160:line_spacing=6[v]`,
    "-map", "[v]",
    "-map", "1:a",
    "-t", String(dur),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-c:a", "aac",
    outPath,
  ]);
  return { outPath, duration: dur };
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
      `drawtext=text='${safeTitle}':fontcolor=white:fontsize=54:fontweight=bold:box=1:boxcolor=black@0.6:boxborderw=20:` +
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
    }
