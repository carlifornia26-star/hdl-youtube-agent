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
// Detects two kinds of retention-killing repetition across a script's scenes:
//  - openingDupes: two+ scenes starting with the same first few words ("The algorithm is a
//    complex system...", "The algorithm is a powerful tool...") — the exact pattern that made
//    the YouTube Algorithms teaser feel like it was looping.
//  - phraseDupes: a scene-length chunk of text (6+ words) that reappears verbatim in another
//    scene, even mid-sentence ("You'll learn how to create content" showing up 3 times).
// Returns a count, not a boolean, so callers can log how bad it was even after the retry.
function countRepetition(scenes) {
  const openings = new Map();
  const sixGrams = new Map();
  let dupes = 0;
  for (const s of scenes) {
    const words = s.line.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const opening = words.slice(0, 4).join(" ");
    if (opening) {
      openings.set(opening, (openings.get(opening) || 0) + 1);
    }
    for (let i = 0; i + 6 <= words.length; i++) {
      const gram = words.slice(i, i + 6).join(" ");
      sixGrams.set(gram, (sixGrams.get(gram) || 0) + 1);
    }
  }
  for (const c of openings.values()) if (c > 1) dupes += c - 1;
  for (const c of sixGrams.values()) if (c > 1) dupes += c - 1;
  return dupes;
}

// Shared by generateScript and generateBonusScenes — requests a `{ scenes: [{line, visual}] }`
// array via Workers AI's JSON Schema mode (validated/parsed server-side, so no manual JSON.parse
// tripping over an unescaped quote in a sentence) and normalizes the response shape.
//
// If the model still produces repeated phrasing/openings despite the prompt's rules against it,
// this retries ONCE with an extra, sharper reminder appended — an LLM given the same prompt
// twice usually varies enough on the second pass to break out of the repeated pattern, and one
// retry is cheap compared to shipping a script that repeats itself on camera.
async function requestSceneScript(prompt, minItems, maxItems, maxTokens) {
  async function attempt(promptText) {
    const result = await run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [{ role: "user", content: promptText }],
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
                properties: {
                  line: { type: "string" },
                  // A short, concrete, literally-filmable phrase (people/places/actions only —
                  // no abstract nouns) describing what should be ON SCREEN while this line is
                  // spoken. Used as the stock-footage search query, so it has to match the line's
                  // actual content instead of a generic keyword unrelated to what's being said.
                  visual: { type: "string" },
                },
                required: ["line", "visual"],
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
    return scenes.map((s) => ({ line: s.line, visual: s.visual || "" }));
  }

  let scenes = await attempt(prompt);
  const dupes = countRepetition(scenes);
  if (dupes > 0) {
    console.warn(`Script generation: detected ${dupes} repeated opening(s)/phrase(s) across scenes, retrying once with a stronger anti-repetition reminder.`);
    const retryPrompt =
      prompt +
      `\n\nIMPORTANT CORRECTION: your previous attempt at this reused the same sentence opening or the same phrase (6+ words) in more than one scene. Every scene must start differently from every other scene, and no phrase of 6 or more words may appear in more than one scene anywhere in the script. Re-write the whole script from scratch with this fixed.`;
    const retryScenes = await attempt(retryPrompt);
    // Only keep the retry if it actually improved things — a worse or equal retry isn't worth
    // discarding the first (still-usable) attempt over.
    if (countRepetition(retryScenes) < dupes) scenes = retryScenes;
  }
  return scenes;
}

// Rotates which STRUCTURAL opening technique each day's script uses — this is the direct fix
// for "every video is shaped the same way," which is the core thing YouTube's 2026 inauthentic-
// content review looks for (same template, minimal variation, replicable at scale). Content
// (book/topic) already varies daily; this makes the SHAPE of the script vary too.
//
// Own independent cycle (5 formats) so it drifts against both the 11-voice pool and the 7-book
// pool instead of always lining up with either — same reasoning as VOICE_POOL in voice.js.
const FORMAT_POOL = [
  {
    id: "direct-hook",
    label: "Direct Hook",
    opening:
      "Open with a sharp, specific question the target reader would recognize themselves in, or a surprising, counter-intuitive claim about their situation — something that could not be swapped into a generic video on a different topic.",
  },
  {
    id: "myth-bust",
    label: "Myth-Bust",
    opening:
      "Open by stating a common belief or piece of advice related to this topic that most people accept as true — then, within that same opening scene, sharply contradict it. The contradiction itself is the hook; do not soften it or hedge it.",
  },
  {
    id: "cold-open",
    label: "Cold-Open Scene",
    opening:
      "Open mid-scene: describe one vivid, specific, relatable moment a reader in this situation might recognize from their own life (a specific time of day, a specific feeling, a specific small detail) — as if the video started partway through a story, not with an introduction. Only pull back to explain the topic generally in scene 2.",
  },
  {
    id: "stat-hook",
    label: "Surprising Stat/Fact",
    opening:
      "Open with a single striking, specific number, statistic, or lesser-known fact related to the topic — stated plainly, with no preamble before it. Follow immediately with why that number should matter to the viewer personally.",
  },
  {
    id: "direct-address",
    label: "Direct Address",
    opening:
      "Open by speaking directly to the viewer in second person about the exact frustration, fear, or want that brought them here — as if the narrator already knows what's on their mind. No scene-setting, no throat-clearing.",
  },
];

// Same day-of-year rotation as pickTodaysVoice/pickTodaysBook, with the same per-channel
// offset pattern as pickTodaysBook (see catalog.js) so the 3 channels don't all use the
// identical structural format on the same calendar day.
export function pickTodaysFormat(date = new Date(), channelOffset = 0) {
  const start = new Date(date.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((date - start) / 86400000);
  return FORMAT_POOL[(dayOfYear + channelOffset) % FORMAT_POOL.length];
}

export async function generateScript(book, format = FORMAT_POOL[0]) {
  const prompt = `You are writing a 10-minute YouTube TEASER video script for the ebook "${book.title}" (topic: ${book.angle}), sold exclusively in English on Google Play Books via High Definition Learning Group.

This video has a spoken AI narrator voice reading each scene's line aloud, with the same words also burned in on screen as fast-paced flowing captions timed to the narration. Write each line to sound natural when spoken aloud — short, punchy, declarative sentences work best both for narration pacing and for the on-screen caption bursts.

Strict rules:
- This is a TEASER, not a summary. Never reveal specific chapters, frameworks, numbered steps, or concrete conclusions from the book.
- Build curiosity: pose the problem the book addresses, why it matters right now, and what kind of reader it's for — without giving away the answers.
- Scene 1 is the single highest-leverage moment in the whole video for whether a viewer keeps watching past the first 15-22 seconds — most of the video's session-time performance is decided right there. Today's opening technique (${format.label}): ${format.opening} Do NOT open with throat-clearing, a generic greeting, or a soft, overused opener like "Have you ever wondered..." or "In today's fast-paced world...". The book's title mention (see below) can land in scene 1 or scene 2 — it doesn't have to be the first sentence itself.
- Explicitly mention once, naturally, that the book is available in English only.
- End with a call to action to read the full book on the High Definition Learning Group website.
- Do not use quotation marks of any kind inside a line's text — rephrase instead of quoting anything.
- Mention the book's exact title, "${book.title}", naturally exactly 3 times across the whole script — once early to introduce it, once in the middle to reinforce it, and once in the closing call to action. Do not use the title any other number of times; refer to it as "the book," "this guide," or similar in between.
- Produce between ${SCRIPT_MIN_SCENES} and ${SCRIPT_MAX_SCENES} scenes — more, shorter scenes than a typical script, so the visuals cut more often. Each scene's line is 3-4 sentences (roughly 40-55 words) written to be spoken naturally in about 15-22 seconds — the total script across all scenes should land around 2000-2300 words so the finished narration runs close to 10 minutes.
- RETENTION RULE — no two scenes may start the same way or make the same point twice. Every single scene must open with a different sentence structure than every other scene: do not let more than one scene begin with the same few words (e.g. never open two scenes with "The algorithm is...", "You'll learn how to...", "But to do so, you need...", or any other repeated template). If you notice yourself about to reuse an opening or restate a point already made earlier in the script, rewrite it as a genuinely new angle, a new example, or skip it.
- Avoid vague marketing filler that could apply to literally any topic — phrases like "a powerful tool," "a complex system," "a comprehensive approach," "valuable insights," "the ever-changing landscape," "take control of," "unlock your potential." Every line should say something SPECIFIC to this exact book's angle — a concrete scenario, a specific kind of person, a specific consequence — not an abstract claim that could be pasted into a script about any other topic.
- For every scene, also write a "visual" field: a short, concrete, literally-filmable phrase (3-8 words) describing exactly what should be shown on screen while that line is spoken, matching the line's actual content. Only describe things a camera could actually film — a specific kind of person doing a specific action in a specific setting (e.g. "exhausted creator staring at laptop at night", "crowded city street rush hour", "person smiling reading book on couch"). Never describe an abstract concept, a graph, an icon, or anything not physically filmable. Vary the people/settings/actions across scenes — do not describe the same visual twice.
- SPECIFICITY RULE — every scene must contain at least one concrete, checkable-feeling detail: a number, a named consequence, a precise scenario, a specific kind of person or moment. A line that could be pasted into a script about a completely different topic without anyone noticing has failed this rule — rewrite it until it could ONLY belong to this book's exact angle.
- VIVIDNESS RULE — this isn't only scene 1's job. Throughout the script, put the listener inside a specific, sensory moment rather than describing things in the abstract: a time of day, a physical sensation, a sound, a small recognizable detail from real life. "3am, phone light on your face, refreshing numbers that haven't moved" beats "creators often feel discouraged."
- OPEN LOOP RULE — plant a specific, concrete curiosity hook (something named but deliberately not yet explained) at least once every 3-4 scenes, and periodically resolve an earlier hook (just enough to reward attention, without revealing the book's actual chapters/frameworks/conclusions) while opening a new one. At almost any point in the script, at least one hook should be actively unresolved — that unresolved thread is what keeps someone listening into the next scene.
- ESCALATION RULE — order the script so each new point raises the stakes beyond the last one (more surprising, more consequential, more personally pointed), not a flat list of equally-weighted facts. The back third of the script should feel like it's building toward something, not repeating the same register as the opening third.
- RHYTHM RULE — vary sentence length within and across scenes: mix short, blunt sentences with a longer one that lets a thought build, then land on another short one. A scene where every sentence is roughly the same length reads as monotone even through narration — avoid that.
- DIRECT-ADDRESS RULE — use second-person "you" language addressing the viewer's specific situation regularly across the WHOLE script, not only in scenes using today's Direct Address opening technique. Talking about "creators" or "readers" in the abstract is weaker than speaking to the one person watching.
- PAYOFF RULE — the curiosity built throughout must feel rewarded by the end, even though the book's actual chapters/frameworks/conclusions stay withheld. The closing scenes should land as a genuine synthesis or a satisfying "here's the real shape of the problem" moment, not just one more promise stacked on the pile — a script that only ever teases and never pays off trains the viewer to stop trusting the next hook.`;

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
- Produce exactly ${count} scenes building curiosity about who this book helps, what problem it solves, and why it matters right now — varied angles, no two scenes making the same point.
- RETENTION RULE — no two scenes may start the same way or make the same point twice, and avoid vague filler ("a powerful tool," "a complex system," "valuable insights," "the ever-changing landscape") in favor of specific scenarios and consequences.
- For every scene, also write a "visual" field: a short, concrete, literally-filmable phrase (3-8 words) describing exactly what should be shown on screen while that line is spoken — a specific person doing a specific action in a specific setting. Never an abstract concept, graph, or icon. Vary it across scenes.
- Every scene needs a concrete, sensory detail (not an abstract claim) and should escalate slightly past the previous scene's stakes rather than repeating the same weight of point. Use direct "you" language addressing the viewer. Vary sentence length within each scene rather than uniform-length sentences. At least one of these scenes should plant a specific, unresolved curiosity hook without revealing the book's actual chapters/frameworks/conclusions.`;

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
