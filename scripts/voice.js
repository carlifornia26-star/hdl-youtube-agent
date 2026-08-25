import fetch from "node-fetch";
import fs from "node:fs/promises";

// --- Kokoro (local, free, no API) -----------------------------------------------------------
// Kokoro-82M: Apache 2.0, 82M params, runs on CPU (no GPU needed) via ONNX — fast enough on a
// standard GitHub Actions runner. Model weights (~300MB) download fresh each run since the
// runner is wiped after every job; nothing persists, nothing to host or maintain. This is the
// primary narration path — Fish Audio below is only a fallback.
// KOKORO_VOICE (optional): overrides the rotation below and pins every video to one fixed voice.
// Leave unset to let the daily rotation (see VOICE_POOL / pickTodaysVoice) pick automatically.
const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

// One narrator voice per video, rotating day to day — never mixed voices within a single video.
// Same day-of-year rotation as pickTodaysBook() in catalog.js, but on its own cycle (11 voices
// vs. 7 books) so voice and book drift independently instead of always pairing the same two up.
// All English (US + UK) so translated-metadata videos still get an English narrator; a mix of
// genders/accents so the channel doesn't sound identical every day.
const VOICE_POOL = [
  "af_heart", // US female — warm, friendly
  "am_michael", // US male — grounded, professional
  "bf_emma", // UK female — sophisticated
  "am_adam", // US male — energetic
  "af_bella", // US female — elegant
  "bm_george", // UK male — authoritative
  "af_nicole", // US female — professional
  "am_liam", // US male — clear, confident
  "bf_isabella", // UK female — elegant
  "am_fenrir", // US male — deep
  "af_sarah", // US female — clear, articulate
];

export function pickTodaysVoice(date = new Date()) {
  if (process.env.KOKORO_VOICE) return process.env.KOKORO_VOICE; // manual override wins
  const start = new Date(date.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((date - start) / 86400000);
  return VOICE_POOL[dayOfYear % VOICE_POOL.length];
}

let kokoroPromise = null;
function getKokoro() {
  if (!kokoroPromise) {
    // Dynamic import so a load failure (missing package, ONNX runtime issue, etc.) is caught by
    // the try/catch in synthesizeVoice below and falls through to Fish Audio, rather than
    // crashing the whole module at import time.
    kokoroPromise = import("kokoro-js").then(({ KokoroTTS }) =>
      KokoroTTS.from_pretrained(KOKORO_MODEL_ID, { dtype: "q8", device: "cpu" })
    );
  }
  return kokoroPromise;
}

// KOKORO_SPEED (optional): Kokoro's own speed multiplier, 1.0 = its natural pace. Defaults to
// a touch under natural (0.92) — gives every scene slightly more runtime for the same word
// count, which combines with the duration top-up in generate-video.js to reliably land the
// finished video above the 8-minute floor without sounding rushed. Override via env if a
// finished video still consistently runs too short/long for your taste.
async function synthesizeVoiceKokoro(text, outPath, voice) {
  const tts = await getKokoro();
  const speed = Number(process.env.KOKORO_SPEED || 0.92);
  const audio = await tts.generate(text, { voice, speed });
  // Writes real WAV bytes regardless of outPath's .mp3 extension — ffmpeg/ffprobe read the
  // actual container format from the file's contents, not its name, so this is safe as-is.
  await audio.save(outPath);
  return outPath;
}

// --- Fish Audio (fallback) --------------------------------------------------------------------
// Fish Audio's free-tier TTS API (api.fish.audio/v1/tts). Kept as a fallback in case Kokoro
// fails for any reason — not the primary path anymore, so this only runs if Kokoro's attempts
// above are exhausted.
//
// FISH_API_KEY (optional now — only needed if you want the fallback to work): fish.audio/app/api-keys
// FISH_VOICE_ID (optional): a "reference_id" for a specific cloned/library voice. If unset,
//   the request omits reference_id and Fish Audio falls back to its default model voice.
//
// NOTE (Aug 2026): Fish Audio's S2.1 Pro model was free under fair use through Aug 31, 2026,
// via the `model: s2.1-pro-free` header — confirm current terms at fish.audio/pricing, since
// that window may have ended or changed. If it has, this fallback will simply fail too, which
// is fine — Kokoro above needs nothing from Fish Audio to keep working.
const FISH_API_URL = "https://api.fish.audio/v1/tts";
const FISH_MODEL_HEADER = "s2.1-pro-free";
// Slightly faster than natural (1.0) reading pace — lets the higher word count per video fit
// inside ~10 minutes without artificially extending runtime.
const NARRATION_SPEED = 1.05;

async function withRetry(label, fn, attempts = 3, baseDelayMs = 1500) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isLast = i === attempts;
      console.error(`${label}: attempt ${i}/${attempts} failed${isLast ? "" : ", retrying"}: ${err.message}`);
      if (!isLast) await new Promise((r) => setTimeout(r, baseDelayMs * i));
    }
  }
  throw lastErr;
}

async function synthesizeVoiceFishAudio(text, outPath) {
  const apiKey = process.env.FISH_API_KEY;
  if (!apiKey) throw new Error("FISH_API_KEY is not set — fallback unavailable");

  return withRetry("Fish Audio TTS", async () => {
    const body = {
      text,
      format: "mp3",
      sample_rate: 44100,
      normalize: true,
      prosody: { speed: NARRATION_SPEED, volume: 0, normalize_loudness: true },
    };
    if (process.env.FISH_VOICE_ID) body.reference_id = process.env.FISH_VOICE_ID;

    const res = await fetch(FISH_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        model: FISH_MODEL_HEADER,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Fish Audio TTS failed: ${res.status} ${await res.text()}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(outPath, buffer);
    return outPath;
  });
}

// --- Public entry point -------------------------------------------------------------------
// Synthesizes `text` to speech and writes an audio file to `outPath`, using `voice` (a Kokoro
// voice id — see VOICE_POOL above) for every call. Callers should compute the voice ONCE per
// video via pickTodaysVoice() and pass the same value into every scene, so one video always has
// one consistent narrator; only the NEXT video's voice differs. Tries Kokoro (local, free)
// first; falls back to Fish Audio only if Kokoro fails after retries. Throws only if BOTH fail —
// the caller (generate-video.js) already treats that as "no narration for this scene" and falls
// back to captions-only, so this function doesn't need its own final fallback.
let engineAnnounced = false; // logs which engine narrated the video exactly once per run, not once per scene
export async function synthesizeVoice(text, outPath, voice = pickTodaysVoice()) {
  try {
    const result = await withRetry("Kokoro TTS (local)", () => synthesizeVoiceKokoro(text, outPath, voice), 2, 1000);
    if (!engineAnnounced) {
      console.log("Narration engine: Kokoro (local, free).");
      engineAnnounced = true;
    }
    return result;
  } catch (kokoroErr) {
    console.warn(`Kokoro TTS failed (${kokoroErr.message}), falling back to Fish Audio`);
    try {
      const result = await synthesizeVoiceFishAudio(text, outPath);
      if (!engineAnnounced) {
        console.log("Narration engine: Fish Audio (fallback).");
        engineAnnounced = true;
      }
      return result;
    } catch (fishErr) {
      throw new Error(`Both Kokoro (${kokoroErr.message}) and Fish Audio (${fishErr.message}) failed`);
    }
  }
  }
