import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
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

const OUTPUT_FPS = 25;
const OUTPUT_SAMPLE_RATE = 44100;
const OUTPUT_CHANNELS = 2;

// MrBeast-style burned-in captions: the line is chopped into short word-chunks that pop up
// one after another in sync with reading pace, alternating white/yellow.
// fontfile points at DejaVu Bold, preinstalled on GitHub's ubuntu-latest runners
// (fonts-dejavu-core). If a runner is missing it: `apt-get install -y fonts-dejavu-core`
// in the workflow, or drop the `fontfile=` clause to fall back to ffmpeg's default font.
const CAPTION_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const WORDS_PER_CHUNK = 3;
const CHUNK_COLORS = ["white", "yellow"];
const POP_IN_SECONDS = 0.08;

function escapeDrawtext(str) {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/'/g, "\u2019");
}

function buildCaptionChunks(text, duration) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const chunkTexts = [];
  for (let i = 0; i < words.length; i += WORDS_PER_CHUNK) {
    chunkTexts.push(words.slice(i, i + WORDS_PER_CHUNK).join(" ").toUpperCase());
  }
  const totalWords = words.length;
  let t = 0;
  return chunkTexts.map((chunkText, i) => {
    const chunkWords = chunkText.split(/\s+/).length;
    const isLast = i === chunkTexts.length - 1;
    const start = t;
    const end = isLast ? duration : t + (chunkWords / totalWords) * duration;
    t = end;
    return { text: chunkText, start, end, color: CHUNK_COLORS[i % CHUNK_COLORS.length] };
  });
}

export async function buildScene({ clipPath, duration, text, outPath }) {
  const clipHasAudio = await hasAudioStream(clipPath);

  const inputs = clipHasAudio
    ? ["-stream_loop", "-1", "-i", clipPath]
    : ["-stream_loop", "-1", "-i", clipPath, "-f", "lavfi", "-i", `anullsrc=channel_layout=stereo:sample_rate=${OUTPUT_SAMPLE_RATE}`];
  const audioMap = clipHasAudio ? ["-map", "0:a"] : ["-map", "1:a"];

  const chunks = buildCaptionChunks(text, duration);
  const captionFilters = chunks
    .map(({ text: chunkText, start, end, color }) => {
      const safe = escapeDrawtext(chunkText);
      const s = start.toFixed(3);
      const fadeEnd = Math.min(start + POP_IN_SECONDS, end).toFixed(3);
      return (
        `drawtext=fontfile=${CAPTION_FONT}:text='${safe}':fontcolor=${color}:fontsize=64:` +
        `box=1:boxcolor=black@0.6:boxborderw=18:x=(w-text_w)/2:y=h*0.38-text_h/2:` +
        `alpha='if(lt(t,${s}),0,if(lt(t,${fadeEnd}),(t-${s})/${POP_IN_SECONDS},1))':` +
        `enable='between(t,${s},${end.toFixed(3)})'`
      );
    })
    .join(",");

  const filterComplex =
    `[0:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720` +
    (captionFilters ? `,${captionFilters}` : "") +
    `[v]`;

  await run("ffmpeg", [
    "-y",
    ...inputs,
    "-filter_complex",
    filterComplex,
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

export async function generateThumbnail({ clipPath, title, outPath }) {
  const safeTitle = escapeDrawtext(title.toUpperCase());
  await run("ffmpeg", [
    "-y",
    "-i", clipPath,
    "-vf",
    `scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,` +
      `drawtext=fontfile=${CAPTION_FONT}:text='${safeTitle}':fontcolor=yellow:fontsize=64:` +
      `box=1:boxcolor=black@0.6:boxborderw=20:x=(w-text_w)/2:y=(h-text_h)/2`,
    "-frames:v", "1",
    outPath,
  ]);
  return outPath;
}

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
