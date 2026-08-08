import fetch from "node-fetch";

const BASE = (accountId) => `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`;

async function run(model, body) {
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
- Output ONLY a JSON array of exactly 9 objects, each { "line": "<one narration sentence, 15-25 words>" }. No commentary, no markdown fences.`;

  const result = await run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [{ role: "user", content: prompt }],
    max_tokens: 900,
  });

  // Workers AI usually returns { response: "<text>" }, but depending on model/account
  // config it can come back OpenAI-style ({ choices: [{ message: { content } }] }) or
  // similar. Extract text defensively instead of assuming result.response is a string.
  let text = result?.response;
  if (typeof text !== "string") {
    text = result?.choices?.[0]?.message?.content
      ?? result?.choices?.[0]?.text
      ?? (Array.isArray(result?.response) ? result.response.join("") : undefined);
  }
  if (typeof text !== "string") {
    console.error("Unexpected Workers AI result shape:", JSON.stringify(result));
    throw new Error("Script generation: could not find text in Workers AI response — see logged result shape above");
  }

  const raw = text.trim().replace(/^```json|```$/g, "").trim();
  const scenes = JSON.parse(raw);
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

// Text-to-speech via Workers AI MeloTTS. Returns raw audio bytes (mp3/wav depending on model version).
export async function synthesizeVoice(text) {
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
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
      }
