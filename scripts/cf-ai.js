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
- PAYOFF RULE — the curiosity built throughout must feel rewarded by the end, even though the book's actual chapters/frameworks/conclusions stay withheld. The closing scenes should land as a genuine synthesis or a satisfying "here's the real shape of the problem" moment, not just one more promise stacked on the pile — a script that only ever teases and never pays off trains the viewer to stop trusting the next hook.
- AUTHORITY RULE — don't stay in constant "expert mode." Alternate a sharp, precise, authoritative line ("this is the single biggest ranking factor almost nobody optimizes for") with a plain, relatable one right after it ("and yeah, most creators get this wrong for years without knowing it"). That shift between "insider explaining something precisely" and "friend leveling with you" is what makes a narrator sound like a real expert rather than a script reciting facts. Never more than 2-3 sentences of pure declaration before a plainer beat.
- REVERSAL RULE — use at least one "you'd think X — but actually Y" moment per script: state an expectation, then contradict it. It works because it briefly makes the listener wrong, which is inherently engaging.
- RHETORICAL QUESTION RULE — ask 1-2 rhetorical questions across the whole script (not more — overuse flattens the effect), engaging the listener's inner voice directly instead of only asserting. Let the question hang for a beat before answering it.
- CALLBACK RULE — reference something said 2-3 scenes earlier at least once ("remember that number from before?"). This makes the video feel like one connected argument built by someone in command of the material, not a disconnected list of facts.
- MICRO-SCENE RULE — at least once, replace an abstract claim with a tiny vignette instead of stating it generally. "Someone posts daily for six months, does everything right, and still can't break 200 views" carries more weight than "many creators struggle with this."
- RETURN HOOK RULE — beyond the video's own payoff (see PAYOFF RULE), the very last scene should also name one specific, concrete angle the video deliberately didn't cover — not "there's so much more" (vague), but something named, framed as continuing elsewhere. This is what makes someone remember the channel later, not just finish this video.
- NAMED PATTERN RULE — at least once, label a recurring idea as if it were a known concept (e.g. "call this the plateau trap") rather than just describing it, so it reads as a reusable insight instead of a one-off observation.
- OBJECTION RULE — at least once, state the listener's likely pushback before they think it ("you're probably thinking that's just algorithm luck — it's not") and answer it in the same scene.
- HEDGE RULE — qualify claims that aren't universal ("in most cases," "this holds maybe 80% of the time") rather than stating everything as an absolute. Reserve fully unqualified statements for the one or two points that matter most, so those land harder by contrast.
- SELF-CORRECTION RULE — somewhere in the middle third, include one brief beat where the narrator revises an earlier assumption ("I used to think it was X — turns out that's backwards"). This builds more trust than a flat assertion because it shows the narrator arriving at the conclusion rather than just stating it.
- STAKES-FORWARD RULE — at least once, state what happens if the listener does nothing ("if you don't fix this, you'll spend another year posting into silence") before offering the fix. Loss-framing lands harder than a plain benefit statement.
- FALSE-SUMMARY RULE — at least once, write a line that sounds like it's wrapping up ("so that's really all there is to it —") immediately followed by a contradiction ("except that's exactly the version that fails"). Mimics a speaker catching themselves mid-thought.
- SELF-AWARE ADDRESS RULE — at least once, predict the listener's own in-the-moment behavior rather than just their situation ("you're going to want to skip this part, don't"). Makes the video feel aware of itself as something being watched right now.
- CONTRAST-PAIR RULE — at least once, state a named binary instead of a single flat claim ("most people optimize for X. The ones who actually grow optimize for Y."). More quotable and stickier than one claim alone.
- RUNWAY RULE — right before the single biggest claim in the script, add a small, almost throwaway line ("here's the part nobody talks about") that primes attention just ahead of where the payoff lands.
- DENIAL-NAMING RULE — at least once, name the specific story the listener tells themselves, not just their emotion ("you keep telling yourself it's the algorithm"). More precise than naming a feeling — reads as the narrator seeing through them specifically.
- ONE-LINER BREAK RULE — occasionally break the standard 3-4 sentence scene pattern with a single scene that's just one short sentence standing alone. The rhythm break itself functions like a vocal pause, letting something land.
- TRUST-STATEMENT RULE — a rare, explicit line like "I'm not going to sugarcoat this" or "I'll be straight with you" may appear AT MOST ONCE in the whole script, and only where the point genuinely warrants it. Used once it reads as sincerity; used more than once it reads as a tic — never repeat it.
- FUTURE-PACING RULE — at least once, paint a specific, sensory picture of life after the fix ("picture opening your analytics in six months and actually recognizing the numbers"). Works best placed near a STAKES-FORWARD line for a before/after contrast.
- IDENTITY-ADDRESS RULE — at least once, speak to a specific type of person rather than a generic viewer ("if you're the creator who's tried everything on the checklist twice"). More precise than plain "you" — makes the right viewer feel singled out.
- PERMISSION RULE — at least once, briefly tell the listener it's okay to have felt a certain way ("it's not stupid that this confused you — almost nobody explains it right") right before delivering a correction, so the correction doesn't land as an attack.
- INVENTED-TERM RULE — at least once, coin a short label for a mechanism and use that exact term again later in the script ("what I call the discovery ceiling"), introduced explicitly as a defined term rather than just dropped in — reads as specialized vocabulary, distinct from NAMED PATTERN RULE's more casual callback.
- SCALE-CONTRAST RULE — at least once, state what the coming point is NOT before saying what it is ("this isn't a 1% tweak — it's a full rebuild of how you think about X"). Cheap, sharp, sets expectations for how big the point is about to be.
- URGENCY RULE — AT MOST ONCE per script, a line implying the window to act is closing ("this only works while most people still don't know it"). Cap it like TRUST-STATEMENT RULE — overused it reads as manipulative rather than motivating.`;

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
- Every scene needs a concrete, sensory detail (not an abstract claim) and should escalate slightly past the previous scene's stakes rather than repeating the same weight of point. Use direct "you" language addressing the viewer. Vary sentence length within each scene rather than uniform-length sentences. At least one of these scenes should plant a specific, unresolved curiosity hook without revealing the book's actual chapters/frameworks/conclusions.
- DELIVERY — alternate sharp/authoritative lines with plain, human ones; don't stay in constant expert mode. If space allows across these ${count} scenes: one reversal ("you'd think X, but actually Y"), one rhetorical question, one callback-style reference to an earlier idea, one named pattern, one micro-scene instead of a flat claim, a brief self-correction beat, a stakes-forward line, a false-summary-then-twist, a named contrast pair, one single-sentence one-liner scene, an identity-address line, or a scale-contrast line. Never force more than one or two of these into a single scene.`;

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

// --- Narration pause safety net --------------------------------------------------------------
// Kokoro (voice.js) has no SSML/break-tag support — every pause it produces comes purely from
// punctuation in the text. Several prompt rules above (SELF-AWARE ADDRESS, reversals, false-
// summary-then-twist, self-correction, denial-naming) deliberately ask the model for lines that
// splice two clauses together mid-sentence ("you're going to want to skip this part, don't").
// The model is asked to keep a comma at that splice point, but doesn't always — when it's
// dropped, the two clauses run together with no punctuation and Kokoro reads them as one
// unbroken clause, which throws listeners off. This is a deterministic text-level fix applied to
// every scene line right after generation, so playback is safe regardless of what the model
// outputs, rather than a fixed list of exact phrases (which only ever catches the specific
// wording it was written for and misses every new variant the model comes up with).
//
// Two passes:
//  1) General "don't"/"do not" run-on fix — the class of bug originally reported ("skip this
//     don't"). Whenever "don't"/"do not" is glued directly to a preceding word with no
//     punctuation, a comma is inserted UNLESS that preceding word is a normal subject pronoun
//     ("you don't", "I don't", "it don't") — those are ordinary subject+verb pairs that never
//     need a pause. Anything else immediately before "don't" ("skip this don't", "worth it
//     don't", "easy don't") is treated as two clauses run together and gets the comma.
//  2) "but" run-on fix, same idea — "but" glued to a preceding word gets a comma UNLESS that
//     word is one where "but" is idiomatically used to mean "except" ("nothing but", "anything
//     but", "all but"), which never wants a pause before it.
// Both passes are deliberately narrow (no blind fix for "however"/"actually"/"though"/"yet",
// which are used constantly as plain adverbs mid-clause and would get false-positive commas far
// more often than genuine run-ons) plus a short list of other known high-risk exact phrasings
// the same rhetorical prompt rules tend to produce.
// Deliberately excludes "this"/"that"/"there" even though they can grammatically be subjects
// ("this don't work") — in this narration style they're overwhelmingly the OBJECT of a prior
// imperative ("skip this", "stay right there") with a new "don't ..." clause immediately after,
// which is exactly the run-on bug being fixed. Treating them as safe subjects would silently
// un-fix the original reported case ("skip this don't").
const DONT_SUBJECT_WHITELIST = new Set([
  "you", "i", "we", "they", "he", "she", "it", "who", "which",
  "people", "folks", "everyone", "everybody", "nobody", "most", "some", "others", "y'all",
]);

const BUT_EXCEPT_IDIOM_WHITELIST = new Set([
  "nothing", "anything", "everything", "all", "none", "no one", "nowhere", "never",
]);

function fixDontRunOns(text) {
  return text.replace(/\b([A-Za-z']+)\s+(don'?t|do not)\b/g, (match, prevWord, dontPhrase) => {
    if (DONT_SUBJECT_WHITELIST.has(prevWord.toLowerCase())) return match;
    return `${prevWord}, ${dontPhrase}`;
  });
}

function fixButRunOns(text) {
  return text.replace(/\b([A-Za-z']+)\s+(but)\b/gi, (match, prevWord, butWord) => {
    if (BUT_EXCEPT_IDIOM_WHITELIST.has(prevWord.toLowerCase())) return match;
    return `${prevWord}, ${butWord}`;
  });
}

// A short list of other exact splice phrasings the same reversal/self-correction/false-summary
// prompt rules are known to produce, glued together with no punctuation — covered literally
// since "wait"/"actually"/"though" can't get the same general treatment as "don't"/"but" without
// misfiring on their much more common plain-adverb use ("it actually works", "wait a second").
const NARRATION_PAUSE_LITERAL_FIXES = [
  { pattern: /\b(stay right here|keep watching|stick around)\s+(don'?t|do not)\b/gi, replace: "$1, $2" },
  { pattern: /\b(wait)\s+(no|actually)\b/gi, replace: "$1, $2" },
  { pattern: /\b(or does it|think again|plot twist|spoiler|here's the catch|here's the thing)\s+([a-z])/gi, replace: "$1, $2" },
];

export function sanitizeNarrationPauses(text) {
  let out = text;
  out = fixDontRunOns(out);
  out = fixButRunOns(out);
  for (const { pattern, replace } of NARRATION_PAUSE_LITERAL_FIXES) {
    out = out.replace(pattern, replace);
  }
  return out;
}

// Applies sanitizeNarrationPauses to every scene's `line` — call this on the array returned by
// generateScript()/generateBonusScenes() before scenes are used for TTS or captions.
export function sanitizeScenePauses(scenes) {
  return scenes.map((s) => ({ ...s, line: sanitizeNarrationPauses(s.line) }));
}

// --- Curiosity-based titles -------------------------------------------------------------------
// Only ONE of the 3 channels uses a curiosity-based title on any given day (rotation handled by
// caller, see pickCuriosityChannel in generate-video.js) — the other two keep the plain,
// functional "<angle> | HDL Group" title. This keeps the channels from all looking like they're
// running the same clickbait-title playbook on the same day, and keeps at least 2/3 of daily
// uploads reading as calm and literal.
//
// Deliberately steered AWAY from generic AI clickbait shape ("You Won't Believe...", "This One
// Trick...", ALL CAPS, excessive punctuation/emoji) and toward a real editorial curiosity title:
// specific to the book's actual topic, reads like a human editor wrote it, no more than one
// rhetorical device per title (a question OR a specific-but-withheld detail OR a contrast — not
// all three stacked). Falls back to the plain title format on any failure.
export async function generateCuriosityTitle(book) {
  const prompt = `Write ONE YouTube video title for a teaser video about the topic "${book.angle}" (the video does not name the ebook title itself, only the topic).

Requirements:
- Under 70 characters.
- Curiosity-driven: it should make someone want to know the answer/outcome, WITHOUT resorting to generic clickbait phrasing.
- Do NOT use any of these overused patterns: "You Won't Believe...", "This One Trick...", "The Truth About...", "Nobody Talks About...", "Here's Why...", ALL CAPS words, excessive punctuation (no "!!", no "?!"), emoji.
- Sound like a specific, well-informed editor wrote it about this exact topic — not a generic template that could apply to any video.
- Use AT MOST one of: a direct question, a specific-but-withheld detail, a stated contrast/tension. Do not stack more than one of these devices in the same title.
- If a concrete number fits naturally (a count of items, mistakes, steps, minutes, signs, etc. — something structurally true of the content, NOT a fabricated statistic or claim), include it. Skip it if it would feel forced for this particular topic.
- Title Case every major word (capitalize each significant word, skip small connector words like "a", "the", "of", "to") — matches the convention most high-performing video titles use. Do not write in ALL CAPS or plain sentence case.
- Output ONLY the title text, nothing else — no quotes, no explanation.`;

  const result = await run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [{ role: "user", content: prompt }],
    max_tokens: 60,
    response_format: {
      type: "json_schema",
      json_schema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
      },
    },
  });

  let title;
  if (result?.response && typeof result.response === "object" && typeof result.response.title === "string") {
    title = result.response.title;
  } else if (typeof result?.response === "string") {
    try {
      title = JSON.parse(result.response).title;
    } catch {
      title = result.response;
    }
  }
  title = (title || "").trim().replace(/^["']|["']$/g, "");
  if (!title) throw new Error("generateCuriosityTitle: model returned no title");
  return title.slice(0, 100); // YouTube's hard title cap, same as everywhere else titles are used
}

// --- Reverse translation (foreign -> English) for weekly trending keywords -------------------
// update-keywords.js pulls trending terms from Google Trends and YouTube's trending chart in
// non-English-speaking markets — this translates those terms/phrases INTO English before they're
// used as channel keywords or video/Short tags, using the same m2m100 model as translateMeta
// above, just pointed the other direction (foreign source_lang -> "english" target_lang).
//
// sourceLang is a full language name ("hindi", "japanese", "portuguese", etc.), matching the
// format translateMeta already uses for its own source_lang: "english" call above — Workers AI's
// m2m100 endpoint accepts spelled-out language names, not just ISO codes.
//
// Deliberately permissive about failure: a term that fails to translate, comes back empty, or
// looks like a runaway repeat (see looksLikeRunawayTranslation above) just falls back to the
// ORIGINAL term rather than being dropped — an untranslated keyword is still a usable keyword,
// worth keeping rather than losing entirely over one bad translation call.
export async function translateTermToEnglish(term, sourceLang) {
  const original = String(term || "").trim();
  if (!original) return original;
  if (!sourceLang || sourceLang === "english") return original; // already English, nothing to do

  try {
    const result = await run("@cf/meta/m2m100-1.2b", {
      text: original,
      source_lang: sourceLang,
      target_lang: "english",
    });
    const translated = (result.translated_text || "").trim();
    if (!translated) return original;
    if (looksLikeRunawayTranslation(original, translated)) {
      console.warn(`translateTermToEnglish: "${original}" (${sourceLang}) looked like a runaway repeat, keeping original.`);
      return original;
    }
    return translated;
  } catch (e) {
    console.warn(`translateTermToEnglish: "${original}" (${sourceLang}) failed, keeping original:`, e.message);
    return original;
  }
  }
