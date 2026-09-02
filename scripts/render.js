import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { exiftool } from "exiftool-vendored";

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
const POP_IN_SECONDS = 0.08;

// Rotates the burned-caption LOOK day to day — same reasoning as FORMAT_POOL in cf-ai.js:
// captions are the single most visually dominant, most-of-the-runtime element in every video,
// so a fixed caption style is one of the strongest "every video looks identical" signals a
// reviewer (human or automated) can spot at a glance, independent of the actual footage.
// Own independent day-of-year cycle (4 styles) so it drifts against the script-format pool
// (5) and voice pool (11) instead of always landing on the same combination.
// wordsPerChunk changes the pop-in rhythm/pacing; colors is the alternating chunk-color
// sequence; yFrac is the vertical caption position as a fraction of frame height.
const CAPTION_STYLE_POOL = [
  { id: "classic-pop", label: "Classic Pop (mid, white/yellow, 3-word)", wordsPerChunk: 3, colors: ["white", "yellow"], yFrac: 0.38 },
  { id: "punchy-duo", label: "Punchy Duo (mid, white/cyan, 2-word)", wordsPerChunk: 2, colors: ["white", "cyan"], yFrac: 0.38 },
  { id: "lower-third", label: "Lower Third (low, white/yellow, 3-word)", wordsPerChunk: 3, colors: ["white", "yellow"], yFrac: 0.78 },
  { id: "wide-orange", label: "Wide Orange (mid, white/orange, 4-word)", wordsPerChunk: 4, colors: ["white", "orange"], yFrac: 0.4 },
];

export function pickTodaysCaptionStyle(date = new Date(), channelOffset = 0) {
  const start = new Date(date.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((date - start) / 86400000);
  return CAPTION_STYLE_POOL[(dayOfYear + channelOffset) % CAPTION_STYLE_POOL.length];
}

function escapeDrawtext(str) {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/'/g, "\u2019");
}

function buildCaptionChunks(text, duration, style) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const chunkTexts = [];
  for (let i = 0; i < words.length; i += style.wordsPerChunk) {
    chunkTexts.push(words.slice(i, i + style.wordsPerChunk).join(" ").toUpperCase());
  }
  const totalWords = words.length;
  let t = 0;
  return chunkTexts.map((chunkText, i) => {
    const chunkWords = chunkText.split(/\s+/).length;
    const isLast = i === chunkTexts.length - 1;
    const start = t;
    const end = isLast ? duration : t + (chunkWords / totalWords) * duration;
    t = end;
    return { text: chunkText, start, end, color: style.colors[i % style.colors.length] };
  });
}

// Ambient bed level when a voice track is mixed in underneath it — low enough to not
// compete with narration, high enough that the stock clip doesn't feel muted.
const AMBIENT_DUCK_VOLUME = 0.12;

// Landscape (main video) vs vertical (Shorts, 9:16) output dimensions and caption sizing.
// Bumped from 720p to full 1080p (Ch. 25's recommended minimum) — fontsize scaled up 1.5x
// (720->1080 ratio) so burned captions keep the same visual proportion on the larger frame
// rather than looking small relative to it.
const DIMENSIONS = {
  landscape: { w: 1920, h: 1080, fontsize: 96 },
  vertical: { w: 1080, h: 1920, fontsize: 78 },
};

export async function buildScene({ clipPath, duration, text, outPath, voicePath, orientation = "landscape", captionStyle = CAPTION_STYLE_POOL[0] }) {
  const dim = DIMENSIONS[orientation] || DIMENSIONS.landscape;
  const captionY = `h*${captionStyle.yFrac}`;
  const clipHasAudio = await hasAudioStream(clipPath);
  const hasVoice = Boolean(voicePath);

  const inputs = ["-stream_loop", "-1", "-i", clipPath];
  if (hasVoice) {
    inputs.push("-i", voicePath);
  } else if (!clipHasAudio) {
    inputs.push("-f", "lavfi", "-i", `anullsrc=channel_layout=stereo:sample_rate=${OUTPUT_SAMPLE_RATE}`);
  }

  // Audio graph, built as part of the same -filter_complex as the caption drawtext chain below:
  //  - voice + clip audio: duck the clip's ambient sound and mix the narration on top
  //  - voice, silent clip: narration is the only audio
  //  - no voice, clip has audio: pass the clip's own audio through unchanged (old behavior)
  //  - no voice, silent clip: silence (old behavior)
  let audioFilter = null;
  let audioMap;
  if (hasVoice && clipHasAudio) {
    audioFilter = `[0:a]volume=${AMBIENT_DUCK_VOLUME}[amb];[1:a]volume=1.0[voice];[amb][voice]amix=inputs=2:duration=first:normalize=0[a]`;
    audioMap = ["-map", "[a]"];
  } else if (hasVoice) {
    // apad: the clip has no ambient bed, so once the voice clip ends there's nothing to fill
    // the padding buffer with — pad it with silence rather than let -shortest cut the scene
    // short right at the last word.
    audioFilter = `[1:a]volume=1.0,apad[a]`;
    audioMap = ["-map", "[a]"];
  } else if (clipHasAudio) {
    audioMap = ["-map", "0:a"];
  } else {
    audioMap = ["-map", "1:a"];
  }

  const chunks = buildCaptionChunks(text, duration, captionStyle);
  const captionFilters = chunks
    .map(({ text: chunkText, start, end, color }) => {
      const safe = escapeDrawtext(chunkText);
      const s = start.toFixed(3);
      const fadeEnd = Math.min(start + POP_IN_SECONDS, end).toFixed(3);
      return (
        `drawtext=fontfile=${CAPTION_FONT}:text='${safe}':fontcolor=${color}:fontsize=${dim.fontsize}:` +
        `box=1:boxcolor=black@0.6:boxborderw=18:x=(w-text_w)/2:y=${captionY}-text_h/2:` +
        `alpha='if(lt(t,${s}),0,if(lt(t,${fadeEnd}),(t-${s})/${POP_IN_SECONDS},1))':` +
        `enable='between(t,${s},${end.toFixed(3)})'`
      );
    })
    .join(",");

  const filterComplex =
    `[0:v]scale=${dim.w}:${dim.h}:force_original_aspect_ratio=increase,crop=${dim.w}:${dim.h}` +
    (captionFilters ? `,${captionFilters}` : "") +
    `[v]` +
    (audioFilter ? `;${audioFilter}` : "");

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
    "-crf", "18", // near-visually-lossless / "high-bitrate" export target (PDF's Resolution &
    // Visual Badges item). Left at 1080p rather than jumping to 4K: this content is a narrated
    // stock-clip slideshow, not native 4K footage (Unsplash/Pexels source clips top out around
    // 1080p-1440p anyway, so exporting at 4K would just be 1080p upscaled — no real quality gain,
    // just ~4x the render time and file size on runners that are already timeboxed). If you
    // later want the 4K badge specifically, the source clip pool needs to support it too.
    "-c:a", "aac",
    "-shortest",
    outPath,
  ]);
  return { outPath, duration };
}

// Mixes a looped background music track under a finished video's existing audio (narration +
// ambient, already mixed by buildScene). Runs as a separate pass AFTER concatScenes rather than
// per-scene, so the music plays continuously across scene cuts instead of restarting each scene.
const MUSIC_VOLUME = 0.35; // audible bed under the narration (~0.18 was ~-15dB, still too quiet to hear clearly)
export async function mixBackgroundMusic({ videoPath, musicPath, outPath }) {
  const duration = await probeDuration(videoPath);
  await run("ffmpeg", [
    "-y",
    "-i", videoPath,
    "-stream_loop", "-1", "-i", musicPath, // loop the track in case it's shorter than the video
    "-filter_complex",
    `[1:a]volume=${MUSIC_VOLUME}[music];[0:a][music]amix=inputs=2:duration=first:normalize=0[a]`,
    "-map", "0:v",
    "-map", "[a]",
    "-t", String(duration),
    "-c:v", "copy", // video stream is untouched, no need to re-encode it
    "-c:a", "aac",
    outPath,
  ]);
  return outPath;
}

// Pre-masters the finished mix to YouTube's own target (-14 LUFS integrated) instead of relying
// on YouTube's playback-time normalization, which only ever turns audio DOWN to match -14 —
// anything already quieter than that stays quiet. Single-pass loudnorm (not the more "accurate"
// two-pass form, which needs a first analysis-only run) — the difference matters for mastering
// studios chasing broadcast-spec precision, not for a teaser video, and two-pass would double
// ffmpeg's runtime on every single video for a gain not worth it here.
// Runs as the LAST audio-touching step, after mixBackgroundMusic (or straight after concatScenes
// if music failed) — so it's normalizing the actual final mix, not narration alone.
const LOUDNESS_TARGET_LUFS = -14;
const LOUDNESS_TRUE_PEAK = -1.5; // dBTP ceiling, keeps normalization from clipping on peaks
const LOUDNESS_RANGE = 11; // LRA target — ffmpeg's own loudnorm default, fine for narration+music
export async function normalizeLoudness({ videoPath, outPath }) {
  await run("ffmpeg", [
    "-y",
    "-i", videoPath,
    "-af", `loudnorm=I=${LOUDNESS_TARGET_LUFS}:TP=${LOUDNESS_TRUE_PEAK}:LRA=${LOUDNESS_RANGE}`,
    "-c:v", "copy", // video stream is untouched, no need to re-encode it
    "-c:a", "aac",
    outPath,
  ]);
  return outPath;
}

export async function concatScenes(sceneOutPaths, listFile, outPath) {
  const content = sceneOutPaths.map((p) => `file '${path.resolve(p)}'`).join("\n");
  await fs.writeFile(listFile, content);
  await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", outPath]);
  return outPath;
}

// Breaks a title into up to 2 lines of roughly maxCharsPerLine each, for the bold-text
// thumbnail variant below. Not true text-measurement (ffmpeg drawtext has no easy way to query
// glyph widths ahead of time from execFile), just a word-count heuristic — good enough for a
// thumbnail overlay where a slightly uneven wrap is harmless.
function wrapTitle(text, maxCharsPerLine = 18, maxLines = 2) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w;
    if (candidate.length > maxCharsPerLine && cur) {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines) break;
    } else {
      cur = candidate;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  return lines.join("\n");
}

// Thumbnail generation, with an optional bold title-text overlay for A/B style testing
// (see thumbnailVariant in generate-video.js). Without titleText: just the Unsplash photo (or
// fallback video frame), cropped to YouTube's 1280x720 thumbnail size — no overlay burned in.
// With titleText: same photo, plus a bold white-on-black-stroke title across the top, MrBeast-
// thumbnail style — this is "variant B", compared against the plain "variant A" over time.
const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024; // YouTube's hard cap on thumbnails.set
export async function generateThumbnail({ imagePath, outPath, titleText }) {
  const vf = [`scale=1280:720:force_original_aspect_ratio=increase`, `crop=1280:720`];
  if (titleText) {
    const wrapped = escapeDrawtext(wrapTitle(titleText.toUpperCase()));
    vf.push(
      `drawtext=fontfile=${CAPTION_FONT}:text='${wrapped}':fontcolor=white:fontsize=84:` +
        `bordercolor=black:borderw=10:line_spacing=14:x=(w-text_w)/2:y=50`
    );
  }
  // qscale 2 = ffmpeg's near-max JPEG quality (scale is 2-31, lower is better). At 1280x720
  // this normally lands well under the 2MB cap on its own; the loop below is a safety net for
  // the rare source photo that doesn't (busy/high-entropy image), stepping quality down until
  // it fits rather than silently uploading a thumbnail YouTube would reject.
  for (const q of [2, 4, 8, 14]) {
    await run("ffmpeg", ["-y", "-i", imagePath, "-vf", vf.join(","), "-frames:v", "1", "-q:v", String(q), outPath]);
    const { size } = await fs.stat(outPath);
    if (size <= THUMBNAIL_MAX_BYTES) break;
    console.warn(`Thumbnail is ${(size / 1024 / 1024).toFixed(2)}MB at q=${q}, over the 2MB cap — trying lower quality.`);
  }
  return outPath;
}

// Embeds descriptive container metadata into the finished mp4 (PDF checklist item: "Container &
// File Metadata Optimization"). Re-muxes only (-c copy), no re-encode, so this costs a few
// seconds regardless of video length. Worth calibrating expectations on this one: YouTube
// strips essentially all embedded container metadata on ingest and ranks off the Data API
// fields this pipeline already sets on videos.insert (title/description/tags/defaultLanguage/
// defaultAudioLanguage — see youtube.js), not off file-level tags. This doesn't hurt and gives
// the raw file itself useful metadata for anywhere else it might end up, but it isn't a real
// YouTube ranking lever the way the Data API fields are.
export async function tagVideoMetadata({ videoPath, title, comment, keywords, language = "eng" }) {
  const tmpPath = videoPath.replace(/(\.[^./]+)$/, "-tagged$1");
  await run("ffmpeg", [
    "-y",
    "-i", videoPath,
    "-map", "0",
    "-map_metadata", "-1",
    "-c", "copy",
    "-metadata", `title=${title}`,
    "-metadata", `comment=${comment}`,
    "-metadata", `keywords=${keywords}`,
    "-metadata:s:v:0", `language=${language}`,
    "-metadata:s:a:0", `language=${language}`,
    tmpPath,
  ]);
  await fs.rename(tmpPath, videoPath);
  return videoPath;
}

// Same idea as tagVideoMetadata, applied to the thumbnail JPEG (IPTC/EXIF/XMP keywords + title —
// the other half of the PDF's "Container & File Metadata Optimization" item). Uses
// exiftool-vendored, which bundles its own exiftool binary via npm, so no apt-get step is
// needed in the workflow. Same caveat as above: thumbnails.set reads the pixels, not the file's
// embedded metadata, so this doesn't move YouTube ranking — it's for completeness/anywhere else
// the file gets reused (the website, social posts, etc).
export async function tagThumbnailMetadata({ imagePath, title, keywords }) {
  await exiftool.write(imagePath, {
    "IPTC:ObjectName": title.slice(0, 64), // IPTC ObjectName has a real 64-char field limit
    "IPTC:Keywords": keywords,
    "XMP:Title": title,
    "XMP:Subject": keywords,
  });
  return imagePath;
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
