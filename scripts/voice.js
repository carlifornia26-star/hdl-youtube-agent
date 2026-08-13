import fetch from "node-fetch";
import fs from "node:fs/promises";

// Fish Audio's free-tier TTS API (api.fish.audio/v1/tts). Real REST endpoint, callable with
// just an API key from a GitHub Actions runner — no browser, no login session, same shape as
// the Cloudflare Workers AI calls in cf-ai.js.
//
// FISH_API_KEY (required): fish.audio/app/api-keys
// FISH_VOICE_ID (optional): a "reference_id" for a specific cloned/library voice. If unset,
//   the request omits reference_id and Fish Audio falls back to its default model voice.
//
// NOTE (Aug 2026): Fish Audio's S2.1 Pro model is free under fair use through Aug 31, 2026,
// via the `model: s2.1-pro-free` header — confirm current terms at fish.audio/pricing before
// this ships, since that free window has already been extended once and could change or end.
// The free tier's stated commercial-use terms should also be double-checked given this is a
// monetized channel — see the note left in SETUP.md.
const FISH_API_URL = "https://api.fish.audio/v1/tts";
const FISH_MODEL_HEADER = "s2.1-pro-free";
// Slightly faster than natural (1.0) reading pace — lets the higher word count per video fit
// inside ~10 minutes without artificially extending runtime. 1.05 is a light nudge, closer to
// natural pace than a previous, too-brisk 1.15 — raise or lower to taste.
const NARRATION_SPEED = 1.05;

async function withRetry(label, fn, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isLast = i === attempts;
      console.error(`${label}: attempt ${i}/${attempts} failed${isLast ? "" : ", retrying"}: ${err.message}`);
      if (!isLast) await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
  throw lastErr;
}

// Synthesizes `text` to speech and writes an mp3 to `outPath`. Returns outPath.
export async function synthesizeVoice(text, outPath) {
  const apiKey = process.env.FISH_API_KEY;
  if (!apiKey) throw new Error("FISH_API_KEY is not set");

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
