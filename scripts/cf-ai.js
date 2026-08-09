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

// Produces a teaser script: an array of { line } scenes. No narration track anymore — the video
// is text-on-screen over silent/ambient stock clips, so scene count is left flexible (18-26) and
// the actual on-screen duration per scene is computed from word count in generate-video.js, then
// scaled so the whole video lands close to 10 minutes regardless of how many scenes this returns.
// Each scene's line is now burned in as MrBeast-style flowing word-chunk captions (render.js)
// rather than one sentence held static on screen, so lines can safely carry more words per scene
// than before without feeling like a wall of text — this is what actually fills the 10 minutes
// with more on-screen words instead of the same short line just sitting there longer.
export async function generateScript(book) {
  const prompt = `You are writing a 10-minute YouTube TEASER video script for the ebook "${book.title}" (topic: ${book.angle}), sold exclusively in English on Google Play Books via High Definition Learning Group.

This video has NO narrator voice — viewers read the text on screen, a few words at a time in a fast-paced flowing caption style, over silent/ambient background footage. Write accordingly: each scene's line is the only thing communicating that moment, so it must stand alone and build momentum even broken into short bursts.

Strict rules:
- This is a TEASER, not a summary. Never reveal specific chapters, frameworks, numbered steps, or concrete conclusions from the book.
- Build curiosity: pose the problem the book addresses, why it matters right now, and what kind of reader it's for — without giving away the answers.
- Explicitly mention once, naturally, that the book is available in English only.
- End with a call to action to read the full book on the High Definition Learning Group website.
- Do not use quotation marks of any kind inside a line's text — rephrase instead of quoting anything.
- Produce between 18 and 26 scenes. Each scene's line is 2-4 sentences (roughly 30-50 words) of punchy, momentum-building copy — short declarative sentences work better than long ones, since the line displays as a rapid sequence of 2-3 word bursts rather than one static sentence.`;

  const result = await run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [{ role: "user", content: prompt }],
    max_tokens: 2600, // raised from 1400 — scene lines are now ~3x longer (30-50 words vs 1-2 short sentences)
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
            minItems: 18,
            maxItems: 26,
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

// YouTube caps snippet.title (and each localization's title) at 100 characters.
const YT_TITLE_MAX = 100;

export async function translateMeta(title, description, targetLang) {
  // Title and description are translated as two SEPARATE calls, not joined with a
  // separator and split back apart afterward. A joined "title\n---\ndescription" string
  // is unreliable: the translation model doesn't always preserve "---", so the split can
  // fail and dump the whole translated blob (title + description) into the title field —
  // which then blows past YouTube's 100-char title limit and fails the whole upload with
  // a generic "invalidVideoMetadata" error, with no indication of which field caused it.
  const titleResult = await run("@cf/meta/m2m100-1.2b", {
    text: title,
    source_lang: "english",
    target_lang: targetLang,
  });
  const tTitle = (titleResult.translated_text || "").trim();

  let tDesc = "";
  if (description) {
    const descResult = await run("@cf/meta/m2m100-1.2b", {
      text: description,
      source_lang: "english",
      target_lang: targetLang,
    });
    tDesc = (descResult.translated_text || "").trim();
  }

  return {
    // Hard truncate as a safety net even if a future translation somehow still comes back long.
    title: (tTitle || title).slice(0, YT_TITLE_MAX),
    description: tDesc || description,
  };
  }
