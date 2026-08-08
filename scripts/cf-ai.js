import fetch from "node-fetch";

const BASE = (accountId) => `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`;

// Workers AI occasionally returns transient 500s (e.g. internal error code 3043) that
// succeed on retry — this is a known, documented-nowhere flakiness on Cloudflare's side,
// not something a request change fixes. Retry a few times with backoff before giving up.
async function withRetry(label, fn, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isLast = i === attempts;
      console.error(`${label}: attempt ${i}/${attempts} failed${isLast ? "" : ", retrying"}: ${err.message}`);
      if (!isLast) {
        await new Promise((r) => setTimeout(r, 1000 * i)); // 1s, 2s, ...
      }
    }
  }
  throw lastErr;
}

async function run(model, body) {
  return withRetry(`Workers AI ${model}`, async () => {
    const accountId = process.env.CF_ACCOUNT_ID;
    const token = process.env.CF_API_TOKEN;
    const res = await fetch(`${BASE(accountId)}/${model}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Workers AI ${model} failed: ${res.status} ${await res.text()}`);
    }
    const json = await res.json();
    if (!json.success) throw new Error(`Workers AI ${model} error: ${JSON.stringify(json.errors)}`);
    return json.result;
  });
}

// Produces a teaser script: an array of { line, seconds } scenes, ~9-10 scenes to fill ~10 minutes
// at typical narration pace. Strict "teaser, not full content" prompt — mirrors the article engine's rule.
export async function generateScript(book) {
  const prompt = `You are writing a ${book.title.length > 0 ? "" : ""}10-minute YouTube TEASER video script for the ebook "${book.title}" (topic: ${book.angle}), sold exclusively in English on Google Play Books via High Definition Learning Group.

Strict rules:
- This is a TEASER, not a summary. Never reveal specific chapters, frameworks, numbered steps, or concrete conclusions from the book.
- Build curiosity: pose the problem the book addresses, why it matters right now, and what kind of reader it's for — without giving away the answers.
- Explicitly mention once, naturally, that the book is available in English only.
- End with a call to action to read the full book on the High Definition Learning Group website.
- Do not use quotation marks of any kind inside a line's text — rephrase instead of quoting anything.
- Produce exactly 9 scenes, each with one narration sentence of 15-25 words.`;

  const result = await run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [{ role: "user", content: prompt }],
    max_tokens: 900,
    // JSON Schema mode: Cloudflare validates/parses the output server-side, so we get
    // back a real object instead of free text that can contain JSON-breaking characters
    // (e.g. an unescaped quote inside a sentence) that trips a manual JSON.parse.
    response_format: {
      type: "json_schema",
      json_schema: {
        type: "object",
        properties: {
          scenes: {
            type: "array",
            minItems: 9,
            maxItems: 9,
            items: {
              type: "object",
              properties: { line: { type: "string" } },
              required: ["line"],
            },
          },
        },
        required: ["scenes"],
      },
    },
  });

  // In JSON Schema mode, result.response is already a parsed object: { scenes: [...] }.
  // Fall back to treating it as a JSON string (older behavior / other model configs) for safety.
  let scenes;
  if (result?.response && typeof result.response === "object" && Array.isArray(result.response.scenes)) {
    scenes = result.response.scenes;
  } else {
    let text = result?.response;
    if (typeof text !== "string") {
      text = result?.choices?.[0]?.message?.content ?? result?.choices?.[0]?.text;
    }
    if (typeof text !== "string") {
      console.error("Unexpected Workers AI result shape:", JSON.stringify(result));
      throw new Error("Script generation: could not find scenes in Workers AI response — see logged result shape above");
    }
    const raw = text.trim().replace(/^```json|```$/g, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error("Script generation: failed to parse model output as JSON. Raw text was:\n", raw);
      throw err;
    }
    scenes = Array.isArray(parsed) ? parsed : parsed?.scenes;
  }

  if (!Array.isArray(scenes) || scenes.length === 0) throw new Error("Script generation returned no scenes");
  return scenes.map((s) => ({ line: s.line }));
}

// Translates {title, description} into a small set of target languages for YouTube `localizations`.
// Kept intentionally smaller than the 56-language article pipeline to stay inside the daily
// Workers AI neuron budget you're already spending on articles — see SETUP.md.
export const VIDEO_LANGS = ["es", "fr", "pt", "de", "hi", "ar", "id", "sw", "ja", "ru", "ko", "zh", "it", "tr", "vi"];

export async function translateMeta(title, description, targetLang) {
  const result = await run("@cf/meta/m2m100-1.2b", {
    text: `${title}\n---\n${description}`,
    source_lang: "english",
    target_lang: targetLang,
  });
  const [tTitle, tDesc] = (result.translated_text || "").split("\n---\n");
  return { title: tTitle?.trim() || title, description: tDesc?.trim() || description };
}

// Text-to-speech via Workers AI MeloTTS. Returns raw audio bytes (mp3).
// NOTE: the REST endpoint returns a JSON envelope — { result: { audio: "<base64 mp3>" }, success, ... } —
// not raw binary, even though other Workers AI endpoints (e.g. image models) work the same way.
// Reading the HTTP body directly as bytes (res.arrayBuffer()) saves the JSON text itself as the
// "audio" file, which ffmpeg then fails to parse ("Header missing", "0 channels", "Duration: N/A").
export async function synthesizeVoice(text) {
  return withRetry("Workers AI @cf/myshell-ai/melotts", async () => {
    const accountId = process.env.CF_ACCOUNT_ID;
    const token = process.env.CF_API_TOKEN;
    const res = await fetch(`${BASE(accountId)}/@cf/myshell-ai/melotts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt: text, lang: "en" }),
    });
    if (!res.ok) throw new Error(`TTS failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    if (!json.success) throw new Error(`TTS error: ${JSON.stringify(json.errors)}`);
    const b64 = json.result?.audio;
    if (typeof b64 !== "string" || b64.length === 0) {
      console.error("Unexpected MeloTTS result shape:", JSON.stringify(json));
      throw new Error("TTS: no base64 audio found in Workers AI response — see logged result shape above");
    }
    return Buffer.from(b64, "base64");
  });
    }
