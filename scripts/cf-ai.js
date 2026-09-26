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
//
// `priorLines` (optional) seeds the opening/six-gram maps with lines from scenes that already
// exist elsewhere in the SAME video — the main script and/or earlier top-up rounds — so a new
// batch is checked against everything already said, not just against itself. Without this, each
// generateBonusScenes() call only ever compares its own 10 scenes to each other, so two separate
// top-up rounds (or a top-up round and the main script) can both reach for the same obvious
// opening line with nothing catching it.
function countRepetition(scenes, priorLines = []) {
  const openings = new Map();
  const sixGrams = new Map();
  let dupes = 0;
  for (const line of priorLines) {
    const words = line.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const opening = words.slice(0, 4).join(" ");
    if (opening) openings.set(opening, (openings.get(opening) || 0) + 1);
    for (let i = 0; i + 6 <= words.length; i++) {
      const gram = words.slice(i, i + 6).join(" ");
      sixGrams.set(gram, (sixGrams.get(gram) || 0) + 1);
    }
  }
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

// Catches the "tells me to go buy the book constantly" retention killer: the prompt's CTA
// CONCENTRATION RULE tells the model buy/visit-the-website language belongs in exactly one
// scene, but nothing used to VERIFY that — an LLM instruction with no check behind it fails
// silently often enough to matter. `ctaMode` is "finalOnly" for the main script (CTA belongs in
// the last scene only), "never" for top-up scenes (no CTA belongs anywhere in them), or "none"
// to skip this check entirely. Counts once per OFFENDING SCENE (not per phrase match within a
// scene), consistent with countRepetition's "count of problems to fix," not "count of matches."
const CTA_LEAK_PATTERNS = [
  /\bread it now\b/i,
  /\bwhy wait\b/i,
  /\bdon'?t miss out\b/i,
  /\bwhat are you waiting for\b/i,
  /\bget your copy\b/i,
  /\bstart your journey today\b/i,
  /\bvisit (the )?(website|site)\b/i,
  /\bhead (over |on )?to (the )?website\b/i,
  /\bgo to (the )?website\b/i,
  /\bcheck out (the )?website\b/i,
  /\blink in (the )?description\b/i,
  /\bavailable now on\b/i,
  /\bbuy (the |this )?book\b/i,
  /\bread the full book\b/i,
  /\bhigh definition learning( group)?('s)? website\b/i,
  // Owner request (Sep 23): the brand name belongs ONLY in the closing scene, said once.
  /\bhigh definition learning\b/i,
  /\bthe time is now\b/i,
];

// Pushy urgency lines the owner asked to drop entirely — counted as a leak in EVERY scene,
// including the closing one ("what are you waiting for... the time is now" said too much).
const URGENCY_PATTERNS = [
  /\bwhat are you waiting for\b/i,
  /\bthe time is now\b/i,
  /\bdon'?t miss out\b/i,
  /\bwhy wait\b/i,
  /\bact now\b/i,
];

function countCTALeakage(scenes, ctaMode = "none") {
  if (ctaMode === "none" || !scenes.length) return 0;
  const lastIndex = scenes.length - 1;
  let leaks = 0;
  scenes.forEach((s, i) => {
    const isAllowedScene = ctaMode === "finalOnly" && i === lastIndex;
    if (isAllowedScene) {
      if (URGENCY_PATTERNS.some((p) => p.test(s.line))) leaks++;
      return;
    }
    if (CTA_LEAK_PATTERNS.some((p) => p.test(s.line))) leaks++;
  });
  return leaks;
}

// Catches the "keeps saying the same subject word over and over" retention killer (e.g. a
// Pet Friendly script leaning on "pet" in nearly every scene) — a real word, correctly on-topic,
// but monotonous when it's the ONLY word used for the book's subject scene after scene. Counts
// a word once per scene it appears in (not per raw occurrence), so a single scene using it twice
// doesn't skew the result — this is about SPREAD across the script, not local repetition.
// Short/common words are excluded via STOPWORDS so this only ever flags a real content word.
const OVERUSE_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with", "at", "by", "from",
  "as", "is", "are", "was", "were", "be", "been", "being", "this", "that", "these", "those", "it",
  "its", "you", "your", "yours", "yourself", "they", "their", "them", "he", "she", "his", "her",
  "we", "our", "us", "not", "so", "if", "because", "while", "when", "where", "what", "who",
  "which", "how", "why", "just", "really", "actually", "one", "every", "most", "some", "all",
  "no", "yes", "do", "does", "did", "done", "can", "could", "will", "would", "should", "might",
  "have", "has", "had", "get", "gets", "getting", "into", "out", "up", "down", "about", "than",
  "then", "now", "today", "here", "there", "more", "much", "many", "even", "still", "again",
  "also", "only", "like", "around", "over", "under", "after", "before", "between", "without",
  "book", "guide",
]);

function findOverusedWord(scenes) {
  const sceneCounts = new Map();
  for (const s of scenes) {
    const words = (s.line.toLowerCase().match(/[a-z']+/g) || []).filter(
      (w) => w.length >= 3 && !OVERUSE_STOPWORDS.has(w)
    );
    for (const w of new Set(words)) {
      sceneCounts.set(w, (sceneCounts.get(w) || 0) + 1);
    }
  }
  let worst = null;
  for (const [word, count] of sceneCounts) {
    if (!worst || count > worst.count) worst = { word, count };
  }
  // Flag only when it's landing in a large majority of scenes AND at least 6 times outright —
  // avoids false-triggering on a book's genuinely central term used at a normal rate.
  const threshold = Math.max(6, Math.ceil(scenes.length * 0.6));
  return worst && worst.count >= threshold ? worst : null;
}

// Shared by generateScript and generateBonusScenes — requests a `{ scenes: [{line, visual}] }`
// array via Workers AI's JSON Schema mode (validated/parsed server-side, so no manual JSON.parse
// tripping over an unescaped quote in a sentence) and normalizes the response shape.
//
// If the model still produces repeated phrasing/openings, leaks CTA/buy language into scenes
// where it doesn't belong, or leans on one subject word in nearly every scene despite the
// prompt's rules against all three, this retries (up to 3 total attempts) with an extra, sharper
// reminder appended — an LLM given the same prompt again usually varies enough on the next pass,
// and a couple of retries is cheap compared to shipping a video that repeats itself or nags the
// viewer to buy the book every other scene.
// `priorLines` (optional): lines from scenes that already exist elsewhere in this same video
// (main script and/or earlier top-up rounds). Passed through to countRepetition() so dupes are
// caught across the whole video, not just within this one batch — see countRepetition above.
// `ctaMode` (optional): "finalOnly" (main script — buy/visit-website language belongs ONLY in the
// last scene), "never" (top-up scenes — it belongs nowhere), or "none" (skip the check).
// `model` (optional): Workers AI model id. Defaults to the 70B model; top-up scenes pass the much
// cheaper 8B model (~6x fewer neurons) to stay inside the free 10,000-neuron daily allowance.
const SCRIPT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const CHEAP_SCRIPT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
async function requestSceneScript(prompt, minItems, maxItems, maxTokens, priorLines = [], ctaMode = "none", model = SCRIPT_MODEL) {
  async function attempt(promptText) {
    const result = await run(model, {
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

  // Composite issue score: phrase/opening repetition + CTA leakage (weighted higher — a stray
  // "visit the website" mid-video is a worse retention hit than a repeated sentence structure) +
  // whether one subject word is carrying nearly every scene. Logged separately so it's still
  // clear from the console which specific problem(s) triggered a retry.
  function scoreIssues(scenes) {
    const dupes = countRepetition(scenes, priorLines);
    const ctaLeaks = countCTALeakage(scenes, ctaMode);
    const overused = findOverusedWord(scenes);
    return { dupes, ctaLeaks, overused, total: dupes + ctaLeaks * 2 + (overused ? 2 : 0) };
  }

  let scenes = await attempt(prompt);
  let issues = scoreIssues(scenes);

  const ctaReminder =
    ctaMode === "finalOnly"
      ? `\nAlso: buy/read-now/website-visit language ("read it now," "visit the website," "get your copy," etc.) leaked into a scene where it doesn't belong. That language may appear in ONLY the final call-to-action scene — remove it from every other scene and replace it with pure curiosity-building instead.`
      : ctaMode === "never"
      ? `\nAlso: buy/read-now/website-visit language leaked into these top-up scenes, where it must NEVER appear — remove it entirely and replace it with pure curiosity-building instead.`
      : "";
  const overuseReminder = (overused) =>
    overused
      ? `\nAlso: the word "${overused.word}" was used in nearly every scene, which reads as monotonous rather than deliberate. Rotate it with natural synonyms, more specific references, or pronouns where the meaning is already clear from context.`
      : "";

  // Keep retrying (up to 2 extra attempts, 3 total) as long as ANY of these issues remain,
  // always tracking the best (lowest total-score) attempt seen so far — a single retry too often
  // still left the video shipping with a repeated line or a leaked CTA, since accepting any retry
  // that was merely "somewhat better" than the first wasn't a high enough bar. Stops early once a
  // fully clean attempt is found, so it doesn't burn extra calls once nothing is left to fix.
  // Free-tier budget (Sep 23): retries were the biggest neuron cost (up to 3 full 70B calls per
  // batch, mostly chasing repeated phrases). Now: at most ONE retry, and only when CTA/brand/urgency
  // language leaked — the owner's priority. Repeats are logged but no longer trigger a retry.
  for (let i = 0; issues.ctaLeaks > 0 && i < 1; i++) {
    console.warn(
      `Script generation: attempt ${i + 1}/2 had ${issues.dupes} repeated opening(s)/phrase(s), ${issues.ctaLeaks} CTA leak(s)${issues.overused ? `, overused word "${issues.overused.word}" (${issues.overused.count} scenes)` : ""} — retrying with a stronger reminder.`
    );
    const retryPrompt =
      prompt +
      `\n\nIMPORTANT CORRECTION: your previous attempt at this reused the same sentence opening or the same phrase (6+ words) in more than one scene${priorLines.length ? ", OR reused an opening/phrase that was already used earlier in this same video (listed above as ALREADY COVERED)" : ""}. Every scene must start differently from every other scene${priorLines.length ? ", and differently from anything already covered earlier in the video" : ""}, and no phrase of 6 or more words may appear in more than one scene anywhere in the script${priorLines.length ? " or repeat something already said earlier in the video" : ""}.${ctaReminder}${overuseReminder(issues.overused)} Re-write the whole script from scratch with all of this fixed.`;
    const retryScenes = await attempt(retryPrompt);
    const retryIssues = scoreIssues(retryScenes);
    // Only keep the retry if it actually improved things — a worse or equal retry isn't worth
    // discarding a still-usable earlier attempt over.
    if (retryIssues.total < issues.total) {
      scenes = retryScenes;
      issues = retryIssues;
    }
  }
  // Sep 23: CTA leaks still shipped after the one retry (channel 4 run had 2). Instead of paying
  // for more AI calls, remove them in code: drop any non-final scene that contains buy/website
  // language, and strip urgency sentences from the final scene. Costs no neurons.
  if (issues.ctaLeaks > 0 && ctaMode !== "none") {
    const last = scenes.length - 1;
    const cleaned = [];
    scenes.forEach((s, i) => {
      if (ctaMode === "finalOnly" && i === last) {
        if (URGENCY_PATTERNS.some((p) => p.test(s.line))) {
          const kept = s.line.split(/(?<=[.!?])\s+/).filter((x) => !URGENCY_PATTERNS.some((p) => p.test(x)));
          cleaned.push({ ...s, line: kept.length ? kept.join(" ") : s.line });
        } else cleaned.push(s);
      } else if (!CTA_LEAK_PATTERNS.some((p) => p.test(s.line))) {
        cleaned.push(s);
      }
    });
    if (cleaned.length >= Math.max(1, Math.ceil(scenes.length / 2))) {
      console.warn(`Script generation: removed ${scenes.length - cleaned.length} scene(s) with leaked CTA language (no extra AI call).`);
      scenes = cleaned;
      issues = scoreIssues(scenes);
    }
  }
  if (issues.total > 0) {
    console.warn(
      `Script generation: shipping with ${issues.dupes} unresolved repeat(s), ${issues.ctaLeaks} CTA leak(s)${issues.overused ? `, overused word "${issues.overused.word}"` : ""} — best available without more AI calls.`
    );
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

// Rotating phrasing for the two compliance disclaimers, keyed by book.complianceTopic (see
// catalog.js). Given ONE fixed instruction, every finance-book video would phrase this near-
// identically forever — same day-of-year rotation pattern as FORMAT_POOL/VOICE_POOL so the
// exact wording varies run to run instead of becoming a repeated, robotic tell.
const DISCLAIMER_POOL = {
  finance: [
    "and to be clear, none of this is financial advice — it's here to inform you, not to tell you what to do with your money",
    "and worth saying plainly: this is educational, not a recommendation to buy, sell, or invest in anything",
    "quick disclaimer, because it matters: this is general education, not personalized financial advice",
  ],
  health: [
    "and to be clear, this is informational, not a substitute for advice from your own doctor or a licensed healthcare provider",
    "worth saying plainly: nothing here replaces personalized guidance from a licensed healthcare practitioner",
    "quick disclaimer, because it matters: this is general education, not a diagnosis or medical advice for your specific situation",
  ],
  vet: [
    "and to be clear, this is general information, not a substitute for guidance from your own veterinarian",
    "worth saying plainly: every animal is different — check anything here against advice from a licensed veterinarian",
    "quick disclaimer, because it matters: this is educational, not a replacement for your vet's judgment on your specific pet",
  ],
};

// Same day-of-year + channel-offset rotation as pickTodaysFormat/pickTodaysVoice. Returns null
// when the book has no complianceTopic (see catalog.js) — most of the catalog doesn't need one,
// and forcing a disclaimer onto unrelated topics (AI strategy, YouTube growth) would just read
// as a non-sequitur.
function pickTodaysDisclaimer(topic, date = new Date(), channelOffset = 0) {
  if (!topic || !DISCLAIMER_POOL[topic]) return null;
  const pool = DISCLAIMER_POOL[topic];
  const start = new Date(date.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((date - start) / 86400000);
  return pool[(dayOfYear + channelOffset) % pool.length];
}

// GROUNDING_LIBRARY: hand-verified, real quotes/beliefs, statistics, historical dates, and
// cultural customs — one pool per book slug. This is the ONLY source of specific citations the
// model is allowed to use. It exists because the model cannot verify facts on its own, and the
// old approach (just telling it "don't invent a study") produced narration with zero concrete
// substance rather than risking a fabricated one. Every entry here should be something you (or
// Claude, via web search) have actually checked — never let the model add an entry live.
// `type` just helps the model vary its phrasing; `fact` is the exact detail to paraphrase
// (never quote verbatim — the script already bans quotation marks); `source` is for your own
// records and is never spoken on screen.
// Expand this over time — 3-5 items per topic is a reasonable minimum so the daily rotation
// (see pickTodaysGrounding) doesn't repeat the same 2-3 facts every week.
const GROUNDING_LIBRARY = {
  "age-one": [
    { type: "historical", fact: "in 1956 a small group of researchers coined the term \"artificial intelligence\" at a summer workshop at Dartmouth College, wagering the whole field could be cracked in a single summer", source: "Dartmouth Summer Research Project on Artificial Intelligence, 1956" },
    { type: "quote", fact: "Alan Turing opened his 1950 paper on machine intelligence by posing the question that still defines the field: can a machine think", source: "Alan Turing, 'Computing Machinery and Intelligence', 1950" },
    { type: "stat", fact: "a McKinsey global survey published in 2025 found 78% of organizations now use AI in at least one business function, up from 72% just a year earlier", source: "McKinsey, 'The state of AI: How organizations are rewiring to capture value', 2025" },
    { type: "stat", fact: "that same 2025 McKinsey survey found 71% of organizations report regularly using generative AI specifically", source: "McKinsey, 2025 State of AI survey" },
    { type: "historical", fact: "in 2012 a neural network called AlexNet's breakthrough win at the ImageNet competition is widely credited with kicking off the modern deep-learning boom", source: "ImageNet Large Scale Visual Recognition Challenge, 2012" },
    { type: "historical", fact: "Nikola Tesla believed alternating current was superior to Thomas Edison's direct current, and proved it during the so-called 'War of Currents' in the late 1880s and 1890s — AC went on to become the worldwide standard for power transmission", source: "widely documented history of the War of Currents, 1880s-1890s" },
    { type: "stat", fact: "ChatGPT reached 100 million monthly users within about two months of its late-2022 launch, according to a UBS analysis — making it, at the time, the fastest-growing consumer application in internet history, beating TikTok's nine months and Instagram's two and a half years to the same milestone", source: "UBS/Similarweb analysis reported by Reuters, February 2023" },
    { type: "historical", fact: "in May 1997, IBM's Deep Blue became the first computer to defeat a reigning world chess champion, Garry Kasparov, in a full match under standard tournament time controls", source: "IBM Deep Blue vs. Garry Kasparov rematch, May 1997" },
    { type: "historical", fact: "in 2024, John Hopfield and Geoffrey Hinton won the Nobel Prize in Physics for foundational neural-network discoveries that underpin today's machine learning — the first time a Nobel science prize went to AI research", source: "Royal Swedish Academy of Sciences, 2024 Nobel Prize in Physics" },
    { type: "historical", fact: "AI has crashed before — a critical 1973 government report by mathematician James Lighthill led the UK to slash academic AI funding almost overnight, kicking off what researchers still call the first 'AI winter'", source: "The Lighthill Report, UK Science Research Council, 1973" },
    { type: "book", fact: "the book walks through today's leading AI platforms one by one — Anthropic's Claude, OpenAI's ChatGPT and GPT-5, Google's Gemini, DeepSeek, and visual-generation tools like Runway, Sora, Kling, Veo and Seedance — mapping out what each one is actually built to do", source: "AGE ONE, Part II: Mastering AI Platforms" },
    { type: "book", fact: "it frames mass communication as having moved through three distinct historical eras — the printing press, then broadcast television and radio, then today's AI-driven internet — with each shift quietly lowering the barrier for an ordinary person to reach an audience", source: "AGE ONE, Chapter 1" },
  ],
  "bitcoin-standard": [
    { type: "historical", fact: "on October 31, 2008, someone using the pseudonym Satoshi Nakamoto published the Bitcoin white paper, and their real identity has never been confirmed", source: "Bitcoin: A Peer-to-Peer Electronic Cash System, 2008" },
    { type: "custom", fact: "the first known real-world Bitcoin purchase was in 2010, when someone paid 10,000 bitcoin for two pizzas — an event now marked every May 22nd as 'Bitcoin Pizza Day'", source: "widely documented Bitcoin history, 2010" },
    { type: "stat", fact: "Bitcoin's total supply is hard-capped at 21 million coins, a limit written into its original code and unchangeable by any single party", source: "Bitcoin protocol design" },
    { type: "custom", fact: "in 2021, El Salvador became the first country in the world to adopt Bitcoin as legal tender", source: "El Salvador Bitcoin Law, 2021" },
    { type: "quote", fact: "back in 1999 — nearly a decade before Bitcoin existed — the economist Milton Friedman predicted that a reliable, anonymous form of electronic cash would soon develop on the internet", source: "Milton Friedman, National Taxpayers Union/Foundation interview, 1999" },
    { type: "historical", fact: "the Mt. Gox exchange once handled over 70% of all bitcoin trades worldwide before it collapsed in 2014, after roughly 850,000 bitcoin went missing in a years-long, undetected theft", source: "Mt. Gox collapse, February 2014" },
    { type: "stat", fact: "Bitcoin's mining reward is programmed to cut in half roughly every four years — from 50 coins per block in 2009 down to 3.125 today after the most recent halving in April 2024 — a built-in scarcity mechanism that runs until around the year 2140", source: "Bitcoin protocol halving schedule; most recent halving, April 2024" },
    { type: "book", fact: "the book breaks Bitcoin's security down to the cryptographic primitives underneath it — SHA-256 hashing, ECDSA and Schnorr signatures, and the elliptic curve math that actually guarantees a coin can't be forged", source: "The Bitcoin Standard, Ch. 3: Cryptographic Primitives and Monetary Sovereignty" },
    { type: "book", fact: "it includes a full institutional-grade self-custody audit protocol and a catalog of over 100 documented wallet and hardware failure modes, each paired with its own recovery path", source: "The Bitcoin Standard, Ch. 7 & Ch. 11" },
    { type: "book", fact: "one entire chapter is built around reading a live mempool for fee-timing and trading signals, rather than just treating fees as a fixed cost", source: "The Bitcoin Standard, Ch. 9: Node Operations and Mempool Intelligence" },
  ],
  "science-of-feeling-great": [
    { type: "stat", fact: "the Harvard Study of Adult Development, running since 1938 and still active today, found that the strongest predictor of long-term health and happiness wasn't wealth or fame — it was the quality of a person's close relationships", source: "Harvard Study of Adult Development; Waldinger & Schulz, 'The Good Life', 2023" },
    { type: "custom", fact: "researchers studying so-called 'Blue Zones' — regions like Okinawa, Japan and Sardinia, Italy — found unusually high numbers of people living past 100, tied largely to diet, daily movement, and strong social ties", source: "Dan Buettner's Blue Zones research" },
    { type: "custom", fact: "in Japan, the practice of 'shinrin-yoku', or forest bathing, became part of official national public health guidance in the 1980s", source: "Japanese Ministry of Agriculture, Forestry and Fisheries, shinrin-yoku program, 1982" },
    { type: "historical", fact: "the World Health Organization's founding constitution in 1948 defined health not merely as the absence of disease, but as a state of complete physical, mental, and social well-being", source: "WHO Constitution, adopted 1948" },
    { type: "stat", fact: "the CDC recommends that adults get at least 7 hours of sleep per night, and identifies chronic short sleep as linked to higher long-term risk for conditions like obesity and heart disease", source: "US Centers for Disease Control and Prevention, sleep guidance" },
    { type: "stat", fact: "the World Health Organization recommends adults get at least 150 to 300 minutes of moderate-intensity physical activity every week, or 75 to 150 minutes of vigorous activity, to meaningfully cut the risk of heart disease, diabetes, and some cancers", source: "WHO Guidelines on Physical Activity and Sedentary Behaviour, updated 2020" },
    { type: "custom", fact: "in 2010, UNESCO added the Mediterranean diet to its list of Intangible Cultural Heritage, recognizing it as a shared way of eating, farming, and gathering across communities in Italy, Greece, Spain, and Morocco — not just a list of foods", source: "UNESCO Intangible Cultural Heritage inscription, November 2010" },
    { type: "book", fact: "the book opens with sleep, walking through the glymphatic system — the brain's own overnight waste-clearance process — and how a disrupted night quietly carries over into next-day emotional regulation", source: "The Science of Feeling Great, Ch. 1: Sleep — The Master Reset" },
    { type: "book", fact: "it devotes a full chapter to the gut-brain axis, covering how food choices interact with gene expression in what the book calls epigenetic eating", source: "The Science of Feeling Great, Ch. 2: Nutrition as Information" },
  ],
  "art-of-joy": [
    { type: "stat", fact: "the Harvard Study of Adult Development, running since 1938, found that close relationships mattered more for long-term happiness than money or career success", source: "Harvard Study of Adult Development; Waldinger & Schulz, 'The Good Life', 2023" },
    { type: "custom", fact: "the United Nations has published an annual World Happiness Report since 2012, ranking countries by self-reported wellbeing", source: "World Happiness Report, UN Sustainable Development Solutions Network, since 2012" },
    { type: "custom", fact: "in Denmark, the concept of 'hygge' — a deliberate sense of coziness and togetherness — is frequently cited as one reason Nordic countries top global happiness rankings", source: "commonly cited in World Happiness Report coverage of Nordic countries" },
    { type: "historical", fact: "the field of positive psychology — the scientific study of what makes life good, rather than just what makes it go wrong — was formally established after psychologist Martin Seligman made it his central theme as president of the American Psychological Association in 1998", source: "Martin Seligman, APA presidency, 1998" },
    { type: "custom", fact: "in 1972, Bhutan's king declared that Gross National Happiness mattered more than Gross National Product, and the country still tracks an official Gross National Happiness Index today alongside its economic statistics", source: "Bhutan's Gross National Happiness policy, established 1972" },
    { type: "historical", fact: "over 2,300 years ago, Aristotle argued in his Nicomachean Ethics that eudaimonia — often translated as flourishing or living well — was the ultimate goal of human life, not pleasure or wealth for their own sake", source: "Aristotle, Nicomachean Ethics" },
    { type: "historical", fact: "psychologists Philip Brickman and Donald Campbell coined the term 'hedonic treadmill' in 1971, and a 1978 follow-up study found lottery winners were no happier than a control group about a year after their win, while accident victims who'd been paralyzed had returned close to their prior baseline happiness too", source: "Brickman & Campbell, 1971; Brickman, Coates & Janoff-Bulman, 'Lottery Winners and Accident Victims: Is Happiness Relative?', 1978" },
    { type: "book", fact: "the book opens with a 20-question Joy Audit designed to pinpoint exactly where a reader's own sense of joy has gone missing, before offering a single technique to fix it", source: "The Art of Joy, Introduction: The Joy Diagnosis" },
    { type: "book", fact: "it includes a dedicated section on staying joyful during genuinely hard times, including how grief and joy can coexist in the same moment rather than canceling each other out", source: "The Art of Joy, Part Four: Joy in Hard Times" },
  ],
  "youtube-algorithms": [
    { type: "stat", fact: "YouTube's own engineering team confirmed in 2017 that viewers were collectively watching over 1 billion hours of video on the platform every single day", source: "YouTube VP of Engineering Cristos Goodrow, 2017 announcement" },
    { type: "historical", fact: "around 2012, YouTube shifted its recommendation algorithm to prioritize total watch time over raw view counts, changing what creators had to optimize for", source: "widely reported YouTube algorithm history, 2012" },
    { type: "stat", fact: "creators upload more than 500 hours of new video to YouTube every single minute", source: "YouTube platform statistics, widely reported" },
    { type: "historical", fact: "YouTube was founded in 2005 by three former PayPal employees, and the very first video ever uploaded to the platform — an 18-second clip called 'Me at the zoo' — went up on April 23, 2005", source: "YouTube company history; first upload, April 23, 2005" },
    { type: "historical", fact: "YouTube launched its short-form video feature, Shorts, in 2020, explicitly built to compete with the format popularized by TikTok", source: "YouTube Shorts launch, 2020" },
    { type: "historical", fact: "Google bought YouTube for $1.65 billion in an all-stock deal in November 2006 — just under two years after YouTube's founding, and at the time the largest acquisition in Google's history", source: "Google-YouTube acquisition, announced October 2006, closed November 2006" },
    { type: "book", fact: "the book traces YouTube's recommendation system back to a 2016 Google Brain research paper on deep neural networks for YouTube recommendations, and walks through the two-stage system it described — first narrowing down candidates, then ranking them", source: "YouTube Algorithms, Ch. 1: The Architecture of Influence" },
    { type: "book", fact: "it names the specific technique, Multi-gate Mixture of Experts, that YouTube's ranking model reportedly uses to balance watch time, satisfaction, and engagement all at the same time rather than optimizing for just one signal", source: "YouTube Algorithms, Ch. 1" },
  ],
  "pet-friendly": [
    { type: "historical", fact: "dogs are believed to have been domesticated from wolves at least 15,000 years ago, making them humanity's oldest domestic animal companion", source: "widely cited archaeological and genetic dating of dog domestication" },
    { type: "custom", fact: "in ancient Egypt, cats were revered highly enough that killing one — even by accident — could carry the death penalty, and many households mummified their pet cats", source: "well-documented ancient Egyptian history" },
    { type: "historical", fact: "most of today's recognizable dog breeds took shape during the Victorian era in 19th-century England, when kennel clubs began formalizing breed standards", source: "The Kennel Club, founded 1873, and Victorian-era breed standardization" },
    { type: "stat", fact: "45.5% of U.S. households now own a dog and 32.1% own a cat, according to the AVMA's 2024 survey — both figures up sharply from 1996, when dog and cat ownership sat at 31.6% and 27.3%", source: "American Veterinary Medical Association, 2024 Pet Ownership and Demographic Sourcebook" },
    { type: "stat", fact: "cats typically sleep 12 to 16 hours a day — meaning an average house cat spends roughly 70% of its entire life asleep", source: "widely documented feline sleep behavior" },
    { type: "historical", fact: "the world's first guide dog school opened in Germany in August 1916, founded by Dr. Gerhard Stalling to train dogs for soldiers who'd been blinded in World War I", source: "Dr. Gerhard Stalling's guide dog school, Oldenburg, Germany, 1916" },
    { type: "stat", fact: "a dog's nose holds up to 300 million olfactory receptors, compared to roughly 6 million in a human nose — one reason dogs can be trained to detect everything from explosives to certain diseases by scent alone", source: "widely documented canine olfaction research" },
    { type: "book", fact: "the book notes that some genetic estimates now push dog domestication back as far as 40,000 years — well beyond the widely cited 15,000-year figure — suggesting an even longer shared history between the two species", source: "Pet Friendly, Ch. 3: Dogs — Your Loyal Adventure Partner" },
    { type: "book", fact: "it points to real neuroscience research showing a dog's caudate nucleus — a brain region tied to positive emotion — activates the same way when they see their owner as when humans feel romantic love", source: "Pet Friendly, Ch. 3" },
  ],
};
// age-one-premium starts from the same base facts as age-one (same brand, same broad AI/business
// topic), then adds its own entries below for the premium edition's additional chapters — prompt
// engineering, no-code AI agents, and Lightning Network business strategy — which age-one (the
// standard edition) doesn't cover. Spread (not alias) so future edits to one book's array never
// silently affect the other.
GROUNDING_LIBRARY["age-one-premium"] = [
  ...GROUNDING_LIBRARY["age-one"],
  { type: "book", fact: "beyond the basics, the premium edition treats prompt engineering as its own professional discipline and walks through building no-code AI agents with tools like Make, Zapier, and n8n", source: "AGE ONE: Premium Edition, Part II & III" },
  { type: "book", fact: "it also covers the Lightning Network as a business tool for instant Bitcoin payments, and closes with five real, fully worked business-blueprint case studies", source: "AGE ONE: Premium Edition, Ch. 12 & Ch. 20" },
];

// Rotates in a small, varying subset of a book's verified facts — same day-of-year +
// channelOffset pattern as pickTodaysFormat/pickTodaysDisclaimer, but stepped by a different
// multiplier (dayOfYear * 5) so it doesn't happen to sync with which FORMAT_POOL/VOICE_POOL
// entries land on the same day. Returns [] (never null) when the book has no library yet, so
// callers can always safely spread/map the result without a null check.
function pickTodaysGrounding(slug, count = 3, date = new Date(), channelOffset = 0) {
  const pool = GROUNDING_LIBRARY[slug];
  if (!pool || !pool.length) return [];
  const start = new Date(date.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((date - start) / 86400000);
  const startIdx = (dayOfYear * 5 + channelOffset) % pool.length;
  const picked = [];
  for (let i = 0; i < Math.min(count, pool.length); i++) {
    picked.push(pool[(startIdx + i) % pool.length]);
  }
  return picked;
}

// Renders the picked grounding facts into a prompt block, plus the phrasing-variety guidance
// that keeps this from turning into a fixed "As so-and-so once said" template every time.
function renderGroundingBlock(items) {
  if (!items.length) return "";
  const list = items.map((it, i) => `  ${i + 1}. [${it.type}] ${it.fact}`).join("\n");
  return `

VERIFIED GROUNDING LIBRARY — the ONLY specific citations you're allowed to use in this script:
${list}

- GROUNDING RULE — naturally weave in 2 to 4 of the items above, wherever they genuinely support a point being made — never all of them crammed in, never forced into a scene they don't fit. Paraphrase each one into your own sentence (no quotation marks, per the rule above) but never change the name, number, date, or attribution given — use it exactly as stated. Do NOT invent any additional named study, statistic, historical date, quote, or custom beyond this list — if a point would benefit from a citation but nothing above fits, stay general ("researchers have found," "it's well documented that") instead of manufacturing one. A fabricated fact is worse than no fact.
- PHRASING VARIETY RULE — never introduce two of these with the same lead-in, and don't default to "As [name] once said" every single time. Rotate across different natural framings depending on what fits the sentence — for example: naming the year first ("Back in [year]..."), naming the number first ("Here's a number that still surprises people..."), naming the source first ("A [institution] survey found..."), framing it as a belief held before it was proven right ("Long before anyone agreed with them, [name] was convinced that..."), or framing it as an established custom ("This isn't new — [place] has treated it as ordinary for [time period]..."). Pick whichever reads most naturally for that specific fact; never force the same lead-in twice in one script.`;
}

export async function generateScript(book, format = FORMAT_POOL[0], channelOffset = 0, trend = null) {
  const disclaimer = pickTodaysDisclaimer(book.complianceTopic, new Date(), channelOffset);
  // Today's trending Google search term (see daily-trend.js), or null. When present the script must
  // work that exact term in twice — as an honest hook, never as a claim about the term itself,
  // since the model can't verify current events. A news-headline scene is inserted by
  // generate-video.js right after scene 2, so the script is told not to describe any headline.
  const trendRule = trend?.term
    ? `\n- TRENDING TIE-IN RULE — the search term ${trend.term} is trending on Google right now. Say that exact term (spelled exactly like that) in EXACTLY two lines of the script: once in scene 1 or scene 2, as a quick hook that connects it to ${book.angle} (a suggested connection: ${trend.tieIn || `what people search for right now says something about ${book.angle}`} — improve on it if you can), and once more in the middle stretch (roughly the 45%-55% mark) as a brief callback or analogy. Each time, keep it to ONE sentence. Say only that people are searching for it or that it is in the conversation right now — do NOT state any facts, events, scores, results, quotes, or claims about ${trend.term} itself (you cannot verify current events), and never suggest the book is about ${trend.term}. The tie-in must feel honest, not forced, and everything else in the script stays about the book. A separate news-headline beat is inserted automatically right after scene 2, so do NOT mention or describe any headline yourself.`
    : "";
  const grounding = pickTodaysGrounding(book.slug, 3, new Date(), channelOffset);
  const prompt = `You are the Universal Master Narrator — a polymathic, warm, sharply engaging storyteller equally at home with a curious teenager and a skeptical adult, fluent across science, history, technology, culture, and everyday life. You blend real intellectual rigor with plain-spoken clarity, dry wit, and genuine emotional depth — never dry-lecture, never robotic.

You are writing a 10-minute YouTube TEASER video script for the ebook "${book.title}" (topic: ${book.angle}), available in 50+ languages on Google Play Books via High Definition Learning Group.

This video has a spoken AI narrator voice reading each scene's line aloud, with the same words also burned in on screen as fast-paced flowing captions timed to the narration. Write each line to sound natural when spoken aloud — short, punchy, declarative sentences work best both for narration pacing and for the on-screen caption bursts.

Strict rules:
- EXAMPLE-ISOLATION RULE — this prompt illustrates several rules below with a quoted example line (e.g. the VIVIDNESS RULE's "3am, phone light on your face, refreshing numbers that haven't moved"). Those quoted examples exist ONLY to demonstrate a technique — they were written for a different book's topic and are almost certainly wrong for "${book.title}" (topic: ${book.angle}). NEVER copy, lightly reword, or adapt any quoted example from this prompt into the actual script. Every line you write must be invented fresh, specific to ${book.angle}, and something that could not be mistaken for content about a different book.
- This is a TEASER, not a summary. Never reveal specific chapters, frameworks, numbered steps, or concrete conclusions from the book.
- Build curiosity: pose the problem the book addresses, why it matters right now, and what kind of reader it's for — without giving away the answers.
- Scene 1 is the single highest-leverage moment in the whole video for whether a viewer keeps watching past the first 15-22 seconds — most of the video's session-time performance is decided right there. Today's opening technique (${format.label}): ${format.opening} Do NOT open with throat-clearing, a generic greeting, or a soft, overused opener like "Have you ever wondered..." or "In today's fast-paced world...". The book's title mention (see below) can land in scene 1 or scene 2 — it doesn't have to be the first sentence itself.
- Explicitly mention once, naturally, that the book is available in more than 50 languages.
- End with ONE short, calm closing scene (the final scene only) that says the full book, "${book.title}", is on the High Definition Learning Group website. Say "High Definition Learning Group" exactly once and the title exactly once in that line, and nowhere else in the script. Keep it to one or two plain sentences with no urgency phrases at all (never "what are you waiting for," "the time is now," "don't miss out," "why wait," or similar).
- CTA CONCENTRATION RULE — buy/read-now urgency language ("read it now," "why wait," "don't miss out," "what are you waiting for," "get your copy," "start your journey today," "visit the website," "check out the website," or any close paraphrase of these) may appear in EXACTLY ONE scene: the final call-to-action scene required above. This is the single most common way a script fails: every other scene must build curiosity ONLY and must not mention the website, mention buying/reading the book, or nudge the viewer toward action in any way, even softly. If you find yourself writing anything sale- or website-adjacent before the last scene, cut it and replace it with a pure curiosity beat instead — a script that pushes the sale in six different scenes reads as desperate and makes viewers leave well before the actual CTA lands.
- VOCABULARY VARIETY RULE — when the book's core subject is a single common noun (e.g. "pet," "AI," "Bitcoin"), do not default to that exact same word in nearly every scene — it reads as monotonous and repetitive even though it's technically on-topic. Rotate between the plain term, natural synonyms, more specific references (a named type, a concrete example), and pronouns where the meaning is already clear from context, the same way a human writer would vary their word choice across a 10-minute piece.
- Do not use quotation marks of any kind inside a line's text — rephrase instead of quoting anything.
- Mention the book's exact title, "${book.title}", exactly ONCE in the whole script — only in the final closing scene. Everywhere else, refer to it as "the book," "this guide," or similar. Do not say "High Definition Learning Group" anywhere except that same final scene.
- Produce between ${SCRIPT_MIN_SCENES} and ${SCRIPT_MAX_SCENES} scenes — more, shorter scenes than a typical script, so the visuals cut more often. Each scene's line is 3-4 sentences (roughly 40-55 words) written to be spoken naturally in about 15-22 seconds — the total script across all scenes should land around 2000-2300 words so the finished narration runs close to 10 minutes.
- RETENTION RULE — no two scenes may start the same way or make the same point twice. Every single scene must open with a different sentence structure than every other scene: do not let more than one scene begin with the same few words (e.g. never open two scenes with "The algorithm is...", "You'll learn how to...", "But to do so, you need...", or any other repeated template). If you notice yourself about to reuse an opening or restate a point already made earlier in the script, rewrite it as a genuinely new angle, a new example, or skip it.
- Avoid vague marketing filler that could apply to literally any topic — phrases like "a powerful tool," "a complex system," "a comprehensive approach," "valuable insights," "the ever-changing landscape," "take control of," "unlock your potential." Every line should say something SPECIFIC to this exact book's angle — a concrete scenario, a specific kind of person, a specific consequence — not an abstract claim that could be pasted into a script about any other topic.
- For every scene, also write a "visual" field: a short, concrete, literally-filmable phrase (3-8 words) describing exactly what should be shown on screen while that line is spoken, matching the line's actual content. Only describe things a camera could actually film — a specific kind of person doing a specific action in a specific setting (e.g. "exhausted creator staring at laptop at night", "crowded city street rush hour", "person smiling reading book on couch"). Never describe an abstract concept, a graph, an icon, or anything not physically filmable. Vary the people/settings/actions across scenes — do not describe the same visual twice.
- SPECIFICITY RULE — every scene must contain at least one concrete, checkable-feeling detail: a number, a named consequence, a precise scenario, a specific kind of person or moment. A line that could be pasted into a script about a completely different topic without anyone noticing has failed this rule — rewrite it until it could ONLY belong to this book's exact angle.
- VIVIDNESS RULE — this isn't only scene 1's job. Throughout the script, put the listener inside a specific, sensory moment rather than describing things in the abstract: a time of day, a physical sensation, a sound, a small recognizable detail from real life — but that moment must be something a reader of THIS exact book (${book.angle}) would recognize from their own life, not a generic anxiety scene borrowed from an unrelated topic. ("Creators often feel discouraged" is too abstract regardless of topic — but so is any vivid moment that doesn't specifically belong to ${book.angle}.)
- OPEN LOOP RULE — plant a specific, concrete curiosity hook (something named but deliberately not yet explained) at least once every 3-4 scenes, and periodically resolve an earlier hook (just enough to reward attention, without revealing the book's actual chapters/frameworks/conclusions) while opening a new one. At almost any point in the script, at least one hook should be actively unresolved — that unresolved thread is what keeps someone listening into the next scene.
- ESCALATION RULE — order the script so each new point raises the stakes beyond the last one (more surprising, more consequential, more personally pointed), not a flat list of equally-weighted facts. The back third of the script should feel like it's building toward something, not repeating the same register as the opening third.
- RHYTHM RULE — vary sentence length within and across scenes: mix short, blunt sentences with a longer one that lets a thought build, then land on another short one. A scene where every sentence is roughly the same length reads as monotone even through narration — avoid that.
- DIRECT-ADDRESS RULE — use second-person "you" language addressing the viewer's specific situation regularly across the WHOLE script, not only in scenes using today's Direct Address opening technique. Talking about "creators" or "readers" in the abstract is weaker than speaking to the one person watching.
- PAYOFF RULE — the curiosity built throughout must feel rewarded by the end, even though the book's actual chapters/frameworks/conclusions stay withheld. The closing scenes should land as a genuine synthesis or a satisfying "here's the real shape of the problem" moment, not just one more promise stacked on the pile — a script that only ever teases and never pays off trains the viewer to stop trusting the next hook.
- AUTHORITY RULE — don't stay in constant "expert mode." Alternate a sharp, precise, authoritative line ("this is the single biggest ranking factor almost nobody optimizes for") with a plain, relatable one right after it ("and yeah, most creators get this wrong for years without knowing it"). That shift between "insider explaining something precisely" and "friend leveling with you" is what makes a narrator sound like a real expert rather than a script reciting facts. Never more than 2-3 sentences of pure declaration before a plainer beat.
- POLYMATH-TO-CHILD RULE — whenever a line touches a dense, technical, or abstract idea, follow it immediately with a vivid, everyday metaphor or an ELI5-style analogy that makes it instantly picturable, without ever sounding condescending.
- GROUNDING RULE — see the VERIFIED GROUNDING LIBRARY block below for the specific citations you're allowed to use, and its rules for how many to include and how to phrase them.
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
- URGENCY RULE — AT MOST ONCE per script, a line implying the window to act is closing ("this only works while most people still don't know it"). Cap it like TRUST-STATEMENT RULE — overused it reads as manipulative rather than motivating.
- MID-VIDEO PEAK RULE — place your single most surprising reversal, statistic, or hook of the entire script somewhere between the 45% and 55% mark of the scene count (the middle stretch) — a sharp, unmistakable jolt of curiosity timed for exactly when a long-form viewer's attention is statistically most likely to wander. Don't hold your best material for the end or spend it all in the opening third; something genuinely startling needs to land right in the middle.${
    disclaimer
      ? `\n- COMPLIANCE RULE — somewhere between the one-third and two-thirds mark of the scenes (never in the first third, where it would undercut the opening hook right as it's landing), work in this exact idea as a natural, spoken aside (not a legal footnote): ${disclaimer}`
      : ""
  }${trendRule}${renderGroundingBlock(grounding)}`;

  return requestSceneScript(prompt, SCRIPT_MIN_SCENES, SCRIPT_MAX_SCENES, 6000, [], "finalOnly");
}

// Builds a compact "already covered" list from previously generated scene lines (main script
// and/or earlier top-up rounds) so a new generateBonusScenes() call knows what's already been
// said — first ~8 words of each prior line, not the full text, to keep prompt size bounded even
// after several top-up rounds. Used both to steer the model away from repeats on the first try
// and (via requestSceneScript's priorLines param) to hard-check the result afterward.
function summarizeCoveredOpenings(existingLines) {
  return existingLines
    .map((line) => line.trim().split(/\s+/).slice(0, 8).join(" "))
    .filter(Boolean)
    .map((s) => `- ${s}...`)
    .join("\n");
}

// Called by generate-video.js only when the built video still lands under the 8-minute target
// after the main script's scenes have all been synthesized and their REAL durations measured.
// Requests `count` ADDITIONAL scenes to insert into the video — no title mention, no CTA, no
// "English only" line (all three are already covered by the main script and are checked for
// separately) — so these can just be appended to the existing scene list with no bookkeeping.
// `existingLines` (optional): the spoken line from every scene already built for this video so
// far — the main script plus any earlier top-up rounds. Passed so this round (a) is steered away
// from repeating ideas/openings already used, and (b) gets hard-checked against them afterward
// via requestSceneScript's priorLines param — see countRepetition in this file for why that
// cross-round check matters (each top-up round used to be checked only against itself).
export async function generateBonusScenes(book, count, existingLines = []) {
  const coveredBlock = existingLines.length
    ? `\n\nALREADY COVERED in this video (main script + any earlier top-up scenes) — do not reuse these openings or make the same point again, even reworded:\n${summarizeCoveredOpenings(existingLines)}`
    : "";
  const prompt = `You are the Universal Master Narrator — the same polymathic, warm, sharply engaging voice used throughout this video — extending an existing YouTube TEASER video script for the ebook "${book.title}" (topic: ${book.angle}), available in 50+ languages on Google Play Books via High Definition Learning Group. The intro, main body, and closing call-to-action already exist — you're writing ${count} ADDITIONAL supporting scenes to insert into the video, deepening the curiosity without revealing the book's actual chapters, frameworks, steps, or conclusions.${coveredBlock}

Same style as the rest of the video: an AI narrator speaks each line aloud, natural and punchy, with the same words burned in on screen as fast-paced captions. Where it fits, follow the POLYMATH-TO-CHILD approach — a dense idea immediately paired with a vivid everyday metaphor. Ground claims in well-established, general terms rather than inventing specific studies, statistics, or named sources.

Strict rules:
- EXAMPLE-ISOLATION RULE — any quoted example line elsewhere in this prompt illustrates a technique only, written for a different book — never copy or reword it into the actual script. Every line must be invented fresh and specific to ${book.angle}.
- Do NOT use the book's title, "${book.title}" — refer to it only as "the book," "this guide," or similar; the title is already covered elsewhere in the video.
- Do NOT include a call to action or say where to read/buy it — that's already covered elsewhere.
- Do NOT restate that the book is available in 50+ languages — that's already covered elsewhere.
- Do NOT use quotation marks of any kind inside a line's text.
- Each scene's line is 3-4 sentences (roughly 40-55 words), written to be spoken naturally in about 15-22 seconds.
- Produce exactly ${count} scenes building curiosity about who this book helps, what problem it solves, and why it matters right now — varied angles, no two scenes making the same point.
- RETENTION RULE — no two scenes may start the same way or make the same point twice, and avoid vague filler ("a powerful tool," "a complex system," "valuable insights," "the ever-changing landscape") in favor of specific scenarios and consequences.
- VOCABULARY VARIETY RULE — if the book's core subject is a single common noun (e.g. "pet," "AI," "Bitcoin"), don't default to that exact word in nearly every one of these scenes — rotate it with natural synonyms, more specific references, and pronouns where the meaning is already clear.
- Do NOT include any buy/read-now/website-visit language ("read it now," "visit the website," "get your copy," or similar) anywhere in these scenes — that belongs only in the main script's dedicated closing scene, which already exists elsewhere in the video.
- For every scene, also write a "visual" field: a short, concrete, literally-filmable phrase (3-8 words) describing exactly what should be shown on screen while that line is spoken — a specific person doing a specific action in a specific setting. Never an abstract concept, graph, or icon. Vary it across scenes.
- Every scene needs a concrete, sensory detail (not an abstract claim) and should escalate slightly past the previous scene's stakes rather than repeating the same weight of point. Use direct "you" language addressing the viewer. Vary sentence length within each scene rather than uniform-length sentences. At least one of these scenes should plant a specific, unresolved curiosity hook without revealing the book's actual chapters/frameworks/conclusions.
- DELIVERY — alternate sharp/authoritative lines with plain, human ones; don't stay in constant expert mode. If space allows across these ${count} scenes: one reversal ("you'd think X, but actually Y"), one rhetorical question, one callback-style reference to an earlier idea, one named pattern, one micro-scene instead of a flat claim, a brief self-correction beat, a stakes-forward line, a false-summary-then-twist, a named contrast pair, one single-sentence one-liner scene, an identity-address line, or a scale-contrast line. Never force more than one or two of these into a single scene.`;

  return requestSceneScript(prompt, count, count, 3000, existingLines, "never", CHEAP_SCRIPT_MODEL);
}

// Trending-news segment (owner request, Sep 23): instead of one "this is trending today" line,
// the narrator spends 2+ minutes explaining WHY the term is trending, over 3+ real news-headline
// screenshots. The model is given the actual headlines (from Google News RSS, see
// fetchTopHeadlines in daily-trend.js) and must stay strictly inside what they say — it cannot
// verify current events on its own, so it may only restate, connect, and give general background.
// No book title, no brand, no call to action in this segment (those stay in the closing scene).
// `cheap` (optional): use the 8B model instead of 70B for this segment. Channel 2 passes true
// (owner asked for less AI use on channel 2, Sep 23).
export async function generateTrendExplainer(book, trend, headlines, sceneCount = 14, cheap = false) {
  const headlineBlock = headlines
    .map((h, i) => `${i + 1}. "${h.headline}" (${h.source || "News"}, ${h.dateText || "recent"})`)
    .join("\n");
  const prompt = `You are the narrator of a YouTube video. Mid-video there is a short news segment about why the search term ${trend.term} is trending on Google right now. The viewer sees these real news headlines on screen, one after another:

${headlineBlock}

Write ${sceneCount} scenes that explain, in plain spoken English, why ${trend.term} is trending right now, walking through the headlines above in order.

Strict rules:
- Use ONLY what the headlines above actually say, plus widely known general background (what the term is, who is involved in general terms). Never invent numbers, scores, quotes, dates, names, or events that are not in the headlines. If the headlines leave something unclear, say it is still developing instead of guessing.
- Scene 1 sets up the segment (people are searching ${trend.term}, here is why). The last scene briefly connects the story to ${book.angle} in one sentence, without naming the book.
- Refer to headline 1, headline 2 and headline 3 (and more if listed) by what they report, in that order, spreading them across the segment.
- Do NOT mention the book, its title, High Definition Learning Group, a website, or anything to buy or read. No call to action of any kind.
- Each scene's line is 2-3 sentences (roughly 28-40 words), natural when spoken aloud. The whole segment must run at least 2 minutes when read aloud (at least 330 words total).
- No quotation marks inside a line's text. No two scenes start the same way.
- For every scene, also write a "visual" field: a short, concrete, literally-filmable phrase (3-8 words) for generic stock footage that fits the line (people, places, actions). Never a real named person, logo, broadcast, or news footage.`;
  return requestSceneScript(prompt, Math.max(10, sceneCount - 2), sceneCount + 4, 2500, [], "never", cheap ? CHEAP_SCRIPT_MODEL : SCRIPT_MODEL);
}

// Translates {title, description} into a small set of target languages for YouTube `localizations`.
// Kept intentionally smaller than the 56-language article pipeline to stay inside the daily
// Workers AI neuron budget you're already spending on articles — see SETUP.md.
// SKIP_TRANSLATIONS=true (set per channel in daily-video.yml) turns translation off: an empty list
// means no localized titles/descriptions and no translated caption tracks — English only.
export const VIDEO_LANGS = process.env.SKIP_TRANSLATIONS === "true"
  ? []
  : ["es", "fr", "pt", "de", "hi", "ar", "id", "sw", "ja", "ru", "ko", "zh", "it", "tr", "vi"];

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
  // Sep 23: an empty scene line (e.g. a silent/visual-only scene) made m2m100 return 400
  // "Length of '/text' must be >= 1", which failed that WHOLE caption language after ~60 other
  // lines had already been translated (wasted neurons). Skip the call for empty text.
  if (!title || !String(title).trim()) {
    return { title: title || "", description: (description || "").slice(0, YT_DESCRIPTION_MAX) };
  }
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

// Catches accidental immediate word doubling ("the the", "is is", "to to") — a known LLM glitch
// that shows up as a spoken/captioned stutter ("word errors" a viewer would notice mid-sentence).
// Case-insensitive so "The the" is caught too; keeps the first occurrence's original casing.
// Word boundary + same-word-twice-in-a-row only — never touches intentional repetition across
// separate words ("very very" is arguably a style choice elsewhere, but back-to-back identical
// function/content words reads as a glitch far more often than as intentional emphasis, so this
// still collapses it; if a script ever wants "no no" or "come on come on" as a deliberate beat,
// that's rare enough to not be worth carving out an exception for here).
function fixDoubledWords(text) {
  return text.replace(/\b(\w+)\s+\1\b/gi, "$1");
}

export function sanitizeNarrationPauses(text) {
  let out = text;
  out = fixDontRunOns(out);
  out = fixButRunOns(out);
  for (const { pattern, replace } of NARRATION_PAUSE_LITERAL_FIXES) {
    out = out.replace(pattern, replace);
  }
  out = fixDoubledWords(out);
  return out;
}

// Applies sanitizeNarrationPauses to every scene's `line` — call this on the array returned by
// generateScript()/generateBonusScenes() before scenes are used for TTS or captions.
export function sanitizeScenePauses(scenes) {
  return scenes.map((s) => ({ ...s, line: sanitizeNarrationPauses(s.line) }));
}

// --- Video titles -------------------------------------------------------------------------------
// Every channel gets a generated title every day (number-driven on some channels, curiosity-driven
// on the rest — rotation lives in generate-video.js). The old plain "<angle> | HDL Group" title is
// now only a fallback if generation fails, because with just six books it repeated verbatim.
//
// Why titles used to look identical: the prompts always asked for the same shape ("X Impacts N
// Lives", "X Reveal N Secrets") and the model never saw what it had already written. Two fixes:
//   1. TITLE_STYLES — each day/channel gets a DIFFERENT structural style (question, mistake,
//      contrast, scenario, list, ...), so the sentence shape itself changes, not just the topic.
//   2. RECENT TITLES — the last titles used across all channels are shown to the model as "do not
//      echo these", and the result is checked in code (first/last 3 words) and regenerated with a
//      different style if it still resembles one of them.
const TITLE_STYLES = [
  { id: "question", rule: "Write it as one specific question a curious person would really ask about this topic (not a rhetorical 'Did You Know')." },
  { id: "mistake", rule: "Name one specific, common mistake or misunderstanding about this topic — what people do or believe that quietly works against them." },
  { id: "contrast", rule: "Set two things against each other: two approaches, a before/after, or 'what most people do' vs 'what works'. Do not use the word 'vs' more than once." },
  { id: "scenario", rule: "Open with a tiny concrete scenario in plain words (what happens when someone does or skips a specific thing). No invented personal stories, no claims to have personally tested anything." },
  { id: "explainer", rule: "Make it a plain 'how' or 'why' explainer about one specific mechanism inside this topic, like a good documentary episode title." },
  { id: "counterintuitive", rule: "State an expectation and hint that reality runs the other way — something that sounds backwards but is checkable." },
  { id: "list", rule: "Structure it as a count of concrete things (signs, habits, steps, reasons, questions) that genuinely fits this topic." },
  { id: "direct-address", rule: "Speak to one specific kind of person (a beginner, a busy parent, a first-time creator — whoever fits the topic) rather than a generic viewer." },
  { id: "plain-statement", rule: "A calm, flat declarative statement of one interesting fact or idea about the topic. No question, no hook trick, no teaser — confident and plain." },
  { id: "beginner-lens", rule: "Frame it around what beginners usually get backwards, skip, or misjudge at the start of this topic." },
  { id: "timeline", rule: "Frame it around time: what changes after a week, a month, a year — or the first day versus the ninetieth. Keep it believable, not a miracle claim." },
  { id: "short-punchy", rule: "Very short: 2 to 5 words, evocative and specific, no colon, no subtitle." },
];

// Different channels get different styles on the same day (offset 3 apart, 12 styles / 4 channels
// = all distinct), and every channel moves to a new style each day.
export function pickTitleStyleIndex(dayOfYear, channelId) {
  return (dayOfYear + (Number(channelId) - 1) * 3) % TITLE_STYLES.length;
}

const TITLE_STOPWORDS_RE = /[^a-z0-9\s]/g;
function normalizeTitleWords(title, number) {
  let t = String(title || "").toLowerCase();
  if (number) t = t.replace(String(number).toLowerCase(), " ");
  return t.replace(TITLE_STOPWORDS_RE, " ").split(/\s+/).filter(Boolean);
}

// True if `title` starts or ends like any recent title (first 3 words or last 2 words match).
// Catches the "X Impacts N Lives" / "<angle> | HDL Group" style repeats even when the topic differs.
function titleTooSimilar(title, recentTitles, number = null) {
  const words = normalizeTitleWords(title, number);
  if (!words.length) return false;
  const head = words.slice(0, 3).join(" ");
  const tail = words.slice(-2).join(" ");
  return recentTitles.some((r) => {
    const rw = normalizeTitleWords(r, /\d{1,3}(,\d{3})+/.exec(r)?.[0] || null);
    if (!rw.length) return false;
    if (rw.slice(0, 3).join(" ") === head) return true;
    return rw.length >= 3 && words.length >= 3 && rw.slice(-2).join(" ") === tail;
  });
}

function buildTitleStyleBlock(styleIdx, recentTitles) {
  const style = TITLE_STYLES[styleIdx % TITLE_STYLES.length];
  const recent = recentTitles.length
    ? `\n- VARIETY: these titles were already used recently on our channels. Do NOT reuse or closely echo their opening words, closing words, or sentence shape:\n${recentTitles.map((t) => `  * ${t}`).join("\n")}`
    : "";
  return `- TITLE STYLE (required for this title): ${style.rule}${recent}
- Never invent statistics, studies, quotes, or claims of personal experience. The title must be true to what a general video on this topic can honestly promise.`;
}

// Shared by both title generators: one Workers AI call in JSON-schema mode, returns the cleaned
// title text (or "" if the model returned nothing usable).
async function requestTitle(prompt, maxTokens) {
  const result = await run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [{ role: "user", content: prompt }],
    max_tokens: maxTokens,
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
  return (title || "").trim().replace(/^["']|["']$/g, "");
}

// Up to 3 attempts, each with a different style, until the title no longer resembles a recent one.
// If all 3 still look similar the last one is used anyway — a slightly familiar title beats failing.
// mustInclude (optional): a phrase (today's trending search term) the title has to contain. Checked
// case-insensitively with whitespace normalised. If 3 attempts still miss it this THROWS instead of
// returning a title without it, so the caller can fall back to a normal, non-trend title.
function titleHasPhrase(title, phrase) {
  const norm = (x) => String(x || "").toLowerCase().replace(/\s+/g, " ").trim();
  return norm(title).includes(norm(phrase));
}

async function generateDistinctTitle({ label, buildPrompt, styleIdx, recentTitles, number = null, maxTokens, mustInclude = null }) {
  let title = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const idx = (styleIdx + attempt * 5) % TITLE_STYLES.length;
    title = await requestTitle(buildPrompt(idx), maxTokens);
    if (!title) throw new Error(`${label}: model returned no title`);
    if (mustInclude && !titleHasPhrase(title, mustInclude)) {
      console.warn(`${label}: "${title}" is missing the trending term "${mustInclude}", retrying (attempt ${attempt + 1}/3).`);
      continue;
    }
    if (!titleTooSimilar(title, recentTitles, number)) return title;
    console.warn(`${label}: "${title}" too close to a recent title, retrying with a different style (attempt ${attempt + 1}/3).`);
  }
  if (mustInclude && !titleHasPhrase(title, mustInclude)) {
    throw new Error(`${label}: no title containing the trending term "${mustInclude}" after 3 attempts`);
  }
  return title;
}

// Prompt line shared by both title generators when a trending term is in play.
function trendTitleLine(trendTerm) {
  if (!trendTerm) return "";
  return `\n- TRENDING WORD (required): the title MUST contain this exact word/phrase, spelled exactly like this: ${trendTerm}. Use it as an honest tie-in to the topic (for example what it shows about, or how it relates to, the topic) — never imply the video is about ${trendTerm} itself or about the news, never invent facts about it, and keep the title readable, not stuffed.`;
}

// Curiosity title (no number). Steered AWAY from generic AI clickbait ("You Won't Believe...",
// ALL CAPS, emoji) toward a specific, human-editor-sounding title in today's TITLE_STYLE.
export async function generateCuriosityTitle(book, styleIdx = 0, recentTitles = [], trendTerm = null) {
  const buildPrompt = (idx) => `Write ONE YouTube video title for a teaser video about the topic "${book.angle}" (the video does not name the ebook title itself, only the topic).

Requirements:
- Under 70 characters.
- Curiosity-driven: it should make someone want to know the answer/outcome, WITHOUT resorting to generic clickbait phrasing.
- Do NOT use any of these overused patterns: "You Won't Believe...", "This One Trick...", "The Truth About...", "Nobody Talks About...", "Here's Why...", "Impacts ... Lives", "Experts Reveal", ALL CAPS words, excessive punctuation (no "!!", no "?!"), emoji.
- Sound like a specific, well-informed editor wrote it about this exact topic — not a generic template that could apply to any video.
${buildTitleStyleBlock(idx, recentTitles)}
- Use a concrete number only if it fits naturally and is structurally true of the content (a count of items, signs, steps, minutes). Skip it if forced.${trendTitleLine(trendTerm)}
- Title Case every major word (capitalize each significant word, skip small connector words like "a", "the", "of", "to"). Do not write in ALL CAPS or plain sentence case.
- Output ONLY the title text, nothing else — no quotes, no explanation.`;

  const title = await generateDistinctTitle({ label: "generateCuriosityTitle", buildPrompt, styleIdx, recentTitles, maxTokens: trendTerm ? 80 : 60, mustInclude: trendTerm });
  return title.slice(0, 100); // YouTube's hard title cap, same as everywhere else titles are used
}

// Number title. formattedNumber is generated in generate-video.js (random integer between
// 100,000,000 and 2,000,000,000, comma-formatted) — NOT by this model, since an LLM can't be
// trusted to reproduce a long digit string with exact comma placement. This function builds a
// natural-sounding title AROUND that exact number, in today's TITLE_STYLE.
export async function generateNumberTitle(book, formattedNumber, styleIdx = 0, recentTitles = [], trendTerm = null) {
  const buildPrompt = (idx) => `Write ONE YouTube video title for a teaser video about the topic "${book.angle}" (the video does not name the ebook title itself, only the topic).

The title MUST include this exact number, written EXACTLY as given below, somewhere natural in the sentence: ${formattedNumber}

Requirements:
- Under 100 characters total (the number itself is long, so budget space for it).
- Reproduce the number EXACTLY as given — same digits, same comma placement. Do not spell it out in words, do not round it, do not add or remove a comma or digit.
- Curiosity-driven and specific to this exact topic — treat the big, oddly-specific number as the hook itself. This is a stylistic curiosity device, not a literal financial claim about the book or company.
- Do NOT use these overused frames: "<Topic> Impacts <number> Lives", "<Topic> Experts Reveal <number> ...", "<number> People ...", "You Won't Believe...", "This One Trick...", "The Truth About...", ALL CAPS words, excessive punctuation (no "!!", no "?!"), emoji.
- Sound like a specific, well-informed editor wrote it about this exact topic — not a generic template that could apply to any video.
${buildTitleStyleBlock(idx, recentTitles)}${trendTitleLine(trendTerm)}
- Title Case every major word (capitalize each significant word, skip small connector words like "a", "the", "of", "to"). Do not write in ALL CAPS or plain sentence case.
- Output ONLY the title text, nothing else — no quotes, no explanation.`;

  let title = await generateDistinctTitle({ label: "generateNumberTitle", buildPrompt, styleIdx, recentTitles, number: formattedNumber, maxTokens: 90, mustInclude: trendTerm });

  // The model is unreliable at preserving an exact long digit string verbatim — if it dropped,
  // rounded, or reformatted the number, append it directly rather than trusting a retry to get
  // it right. The number appearing exactly as generated is the one hard requirement here.
  if (!title.includes(formattedNumber)) {
    console.warn(`generateNumberTitle: model didn't reproduce "${formattedNumber}" exactly, appending it directly.`);
    title = `${title} — ${formattedNumber}`;
  }

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

// --- Trending-term selection ---------------------------------------------------------------
// daily-trend.js hands over a shortlist of today's trending Google search terms (already stripped
// of obviously sensitive ones). This asks the model to pick the ONE that can be tied to the book's
// topic most honestly — or none. Returns { index (0-based), fit (0-10), tieIn } or null when
// nothing fits. Kept in this file because `run` (the Workers AI caller) is private here.
export async function selectTrendTieIn(book, candidates) {
  if (!candidates?.length) return null;
  const list = candidates.map((t, i) => `${i + 1}. ${t}`).join("\n");
  const prompt = `A book-teaser YouTube channel wants to weave ONE currently trending Google search term into a video about the topic "${book.angle}" (from the ebook "${book.title}").

Trending search terms right now:
${list}

Pick the ONE term that can be tied to the topic most honestly and naturally — as an analogy, a contrast, or a hook like "this is what people are searching for right now, and here is what it says about ${book.angle}".

Hard rules:
- Never pick anything about a death, illness, crime, disaster, war, politics or elections, lawsuits, scandal, or adult content.
- Avoid terms that are the name of one specific real person (celebrity, athlete, politician, victim, suspect) — tying a real individual to a book they have nothing to do with is misleading. Teams, shows, games, products, events, holidays, places and general topics are fine.
- If nothing can be tied in honestly without stretching, answer choice 0.

Answer as JSON: choice = the number of the term (1-${candidates.length}) or 0 for none; fit = 0-10 for how natural and honest the tie-in is; tie_in = ONE short sentence (max 25 words) describing the connection between the term and ${book.angle}, making no claims about news or facts regarding the term.`;

  const result = await run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [{ role: "user", content: prompt }],
    max_tokens: 200,
    response_format: {
      type: "json_schema",
      json_schema: {
        type: "object",
        properties: {
          choice: { type: "integer" },
          fit: { type: "integer" },
          tie_in: { type: "string" },
        },
        required: ["choice", "fit", "tie_in"],
      },
    },
  });

  let parsed = result?.response;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const choice = Number(parsed.choice);
  const fit = Number(parsed.fit);
  if (!Number.isInteger(choice) || choice < 1 || choice > candidates.length) return null;
  return { index: choice - 1, fit: Number.isFinite(fit) ? fit : 0, tieIn: String(parsed.tie_in || "").trim().slice(0, 240) };
    }
