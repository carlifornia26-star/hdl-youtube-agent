import fetch from "node-fetch";

const BASE = (accountId) => `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`;

// Workers AI occasionally returns transient 500s (e.g. internal error code 3043) that
// succeed on retry — this is a known, documented-nowhere flakiness on Cloudflare's side,
// not something a request change fixes. Retry a few times with backoff before giving up.
//
// A 4xx (e.g. "target_lang is not one of [...]") is NOT one of those flaky cases — it's the
// API rejecting the request as permanently invalid. Retrying it just repeats the exact same
// call and gets the exact same rejection, burning ~1s+2s of backoff and two extra HTTP calls
// per failure for nothing. Mark 4xx errors non-retryable so withRetry gives up immediately.
class WorkersAIError extends Error {
  constructor(message, { retryable }) {
    super(message);
    this.retryable = retryable;
  }
}

async function withRetry(label, fn, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = err.retryable !== false; // unknown/non-WorkersAIError errors default to retryable
      const isLast = i === attempts || !retryable;
      console.error(`${label}: attempt ${i}/${attempts} failed${isLast ? "" : ", retrying"}: ${err.message}`);
      if (!isLast) {
        await new Promise((r) => setTimeout(r, 1000 * i)); // 1s, 2s, ...
      }
      if (!retryable) break;
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
      const text = await res.text();
      // 4xx = the request itself is invalid (bad target_lang, malformed body, etc.) — retrying
      // an identical request won't change that. 5xx/network = worth the existing retry/backoff.
      const retryable = !(res.status >= 400 && res.status < 500);
      throw new WorkersAIError(`Workers AI ${model} failed: ${res.status} ${text}`, { retryable });
    }
    const json = await res.json();
    if (!json.success) throw new WorkersAIError(`Workers AI ${model} error: ${JSON.stringify(json.errors)}`, { retryable: true });
    return json.result;
  });
}

// Produces a teaser script: an array of { line } scenes. Each line is BOTH spoken (Kokoro TTS,
// voice.js) and burned in as MrBeast-style flowing word-chunk captions (render.js) synced to
// the actual narration audio. Scene duration comes directly from how long the voice line
// actually takes to speak (measured after synthesis, see generate-video.js) — the scene/word
// counts below are a starting target aimed at landing near 10 minutes, not a guarantee, since
// the exact reading pace depends on the TTS voice. generate-video.js measures the REAL total
// runtime after synthesis and tops it up with generateBonusScenes() below if it still lands
// short, so the finished video's length isn't purely at the mercy of these targets.
const SCRIPT_MIN_SCENES = 36;
const SCRIPT_MAX_SCENES = 46;

// Shared by generateScript and generateBonusScenes — requests a `{ scenes: [{line}] }` array
// via Workers AI's JSON Schema mode (validated/parsed server-side, so no manual JSON.parse
// tripping over an unescaped quote in a sentence) and normalizes the response shape.
async function requestSceneScript(prompt, minItems, maxItems, maxTokens) {
  const result = await run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [{ role: "user", content: prompt }],
    max_tokens: maxTokens,
    response_format: {
      type: "json_schema",
      json_schema: {
        type: "object",
        properties: {
          scenes: {
            type: "array",
            minItems,
            maxItems,
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

export async function generateScript(book) {
  const prompt = `You are writing a 10-minute YouTube TEASER video script for the ebook "${book.title}" (topic: ${book.angle}), sold exclusively in English on Google Play Books via High Definition Learning Group.

This video has a spoken AI narrator voice reading each scene's line aloud, with the same words also burned in on screen as fast-paced flowing captions timed to the narration. Write each line to sound natural when spoken aloud — short, punchy, declarative sentences work best both for narration pacing and for the on-screen caption bursts.

Strict rules:
- This is a TEASER, not a summary. Never reveal specific chapters, frameworks, numbered steps, or concrete conclusions from the book.
- Build curiosity: pose the problem the book addresses, why it matters right now, and what kind of reader it's for — without giving away the answers.
- Explicitly mention once, naturally, that the book is available in English only.
- End with a call to action to read the full book on the High Definition Learning Group website.
- Do not use quotation marks of any kind inside a line's text — rephrase instead of quoting anything.
- Mention the book's exact title, "${book.title}", naturally exactly 3 times across the whole script — once early to introduce it, once in the middle to reinforce it, and once in the closing call to action. Do not use the title any other number of times; refer to it as "the book," "this guide," or similar in between.
- Produce between ${SCRIPT_MIN_SCENES} and ${SCRIPT_MAX_SCENES} scenes — more, shorter scenes than a typical script, so the visuals cut more often. Each scene's line is 3-4 sentences (roughly 40-55 words) written to be spoken naturally in about 15-22 seconds — the total script across all scenes should land around 2000-2300 words so the finished narration runs close to 10 minutes.`;

  return requestSceneScript(prompt, SCRIPT_MIN_SCENES, SCRIPT_MAX_SCENES, 6000);
}

// Called by generate-video.js only when the built video still lands under the 8-minute target
// after the main script's scenes have all been synthesized and their REAL durations measured.
// Requests `count` ADDITIONAL scenes to insert into the video — no title mention, no CTA, no
// "English only" line (all three are already covered by the main script and are checked for
// separately) — so these can just be appended to the existing scene list with no bookkeeping.
export async function generateBonusScenes(book, count) {
  const prompt = `You are extending an existing YouTube TEASER video script for the ebook "${book.title}" (topic: ${book.angle}), sold exclusively in English on Google Play Books via High Definition Learning Group. The intro, main body, and closing call-to-action already exist — you're writing ${count} ADDITIONAL supporting scenes to insert into the video, deepening the curiosity without revealing the book's actual chapters, frameworks, steps, or conclusions.

Same style as the rest of the video: an AI narrator speaks each line aloud, natural and punchy, with the same words burned in on screen as fast-paced captions.

Strict rules:
- Do NOT use the book's title, "${book.title}" — refer to it only as "the book," "this guide," or similar; the title is already covered elsewhere in the video.
- Do NOT include a call to action or say where to read/buy it — that's already covered elsewhere.
- Do NOT restate that it's available in English only — that's already covered elsewhere.
- Do NOT use quotation marks of any kind inside a line's text.
- Each scene's line is 3-4 sentences (roughly 40-55 words), written to be spoken naturally in about 15-22 seconds.
- Produce exactly ${count} scenes building curiosity about who this book helps, what problem it solves, and why it matters right now — varied angles, no two scenes making the same point.`;

  return requestSceneScript(prompt, count, count, 3000);
}

// Translates {title, description} into a small set of target languages for YouTube `localizations`.
// Kept intentionally smaller than the 56-language article pipeline to stay inside the daily
// Workers AI neuron budget you're already spending on articles — see SETUP.md.
export const VIDEO_LANGS = ["es", "fr", "pt", "de", "hi", "ar", "id", "sw", "ja", "ru", "ko", "zh", "it", "tr", "vi"];

// YouTube caps snippet.title (and each localization's title) at 100 characters, and
// description at 5000 characters: https://developers.google.com/youtube/v3/docs/videos
const YT_TITLE_MAX = 100;
const YT_DESCRIPTION_MAX = 5000;

// m2m100-1.2b (like most small MT models) occasionally goes into a runaway repetition loop
// on a given input — it keeps repeating a phrase instead of terminating normally — producing
// output many times longer than the source. Guard against that here so ONE bad translation
// can't balloon past YT_DESCRIPTION_MAX and take the whole upload down with a generic
// "invalidVideoMetadata" error. The ratio is generous (some languages are legitimately more
// verbose than English) but a 3x length blowup on the same content is always a loop, never a
// real translation.
function looksLikeRunawayTranslation(source, translated) {
  return translated.length > Math.max(200, source.length * 3);
}

export async function translateMeta(title, description, targetLang) {
  // Title and description are translated as two SEPARATE calls, not joined with a
  // separator and split back apart afterward. A joined "title\n---\ndescription" string
  // is unreliable: the translation model doesn't always preserve "---", so the split can
  // fail and dump the whole translated blob (title + description) into the title field —
  // which then blows past YouTube's 100-char title limit and fails the whole upload with
  // a generic "invalidVideoMetadata" error, with no indication of which field caused it.
  //
  // Callers should pass ONLY translatable body text here — never credit lines, URLs, or other
  // content with proper names/query strings baked in. The model reliably mangles those
  // (corrupted domains, translated query-param values), and long repeated boilerplate is
  // exactly the kind of input that triggers the repetition-loop failure mode below.
  const titleResult = await run("@cf/meta/m2m100-1.2b", {
    text: title,
    source_lang: "english",
    target_lang: targetLang,
  });
  let tTitle = (titleResult.translated_text || "").trim();
  if (tTitle && looksLikeRunawayTranslation(title, tTitle)) {
    console.warn(`Translated title (${targetLang}) looked like a runaway repeat, falling back to English.`);
    tTitle = "";
  }

  let tDesc = "";
  if (description) {
    const descResult = await run("@cf/meta/m2m100-1.2b", {
      text: description,
      source_lang: "english",
      target_lang: targetLang,
    });
    tDesc = (descResult.translated_text || "").trim();
    if (tDesc && looksLikeRunawayTranslation(description, tDesc)) {
      console.warn(`Translated description (${targetLang}) looked like a runaway repeat, falling back to English.`);
      tDesc = "";
    }
  }

  return {
    // Hard truncate as a safety net even if a future translation somehow still comes back long.
    title: (tTitle || title).slice(0, YT_TITLE_MAX),
    description: (tDesc || description).slice(0, YT_DESCRIPTION_MAX),
  };
    }
