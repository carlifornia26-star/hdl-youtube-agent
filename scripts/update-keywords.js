import fs from "node:fs/promises";
import fetch from "node-fetch";
import { getMyChannelBranding, setChannelKeywords, getYoutubeClient } from "./youtube.js";
import { translateTermToEnglish } from "./cf-ai.js";
import { CATALOG } from "./catalog.js";

// Runs every Monday 5am (see .github/workflows/hdl-keyword-update.yml) in two phases, because
// the trending lookups (Google Trends + YouTube's per-country trending charts) only need to
// happen ONCE a week, not once per channel — phase 1 computes a single shared keyword set and
// commits it to the repo; phase 2 (one job per channel, run right after) reads that committed
// file and pushes it to each channel's Keywords field. MODE picks which phase this run is:
//   MODE=compute -> fetch trends, write keywords-weekly.json (no YouTube channel writes)
//   MODE=apply   -> read keywords-weekly.json, call setChannelKeywords for THIS channel (uses
//                   the same YT_CLIENT_ID/SECRET/REFRESH_TOKEN env vars every other script here uses)
const MODE = process.env.KEYWORDS_MODE || "compute";
const OUT_FILE = "keywords-weekly.json";
const CHANNEL_KEYWORDS_MAX = 500; // same brandingSettings.channel.keywords hard cap as customize-channel.js

// These 5 never change, regardless of what's trending — always kept, and always survive the
// 500-char truncation below since they're added first.
const FIXED_KEYWORDS = ["Google", "YouTube", "MrBeast", "Artificial Intelligence (AI)", "Mirror Movie"];

// Top 10 countries by population that ALSO have a working YouTube "most popular" chart via the
// Data API. NOTE: China's regionCode=CN has historically returned empty/unreliable results on
// videos.list?chart=mostPopular&regionCode=CN (YouTube itself is blocked/restricted there), so
// it was swapped out before — it's included again here by request. fetchYoutubeTopTermsByCountry
// below already wraps each country in try/catch and logs+skips on failure, so if CN comes back
// empty this will just show "(none found)" in the log for China rather than breaking the run —
// keep an eye on the compute-keywords log after this change to confirm whether CN actually
// returns data or not.
const YOUTUBE_TRENDING_COUNTRIES = [
  { name: "India", region: "IN" },
  { name: "United States", region: "US" },
  { name: "Indonesia", region: "ID" },
  { name: "Pakistan", region: "PK" },
  { name: "China", region: "CN" },
  { name: "Brazil", region: "BR" },
  { name: "Bangladesh", region: "BD" },
  { name: "Mexico", region: "MX" },
  { name: "Japan", region: "JP" },
  { name: "Philippines", region: "PH" },
];

// Google doesn't publish one single "worldwide trending" feed — trends.google.com/trending is
// always scoped to a geo. This approximates "worldwide top 10" by pulling each major market's
// daily-trends RSS feed and keeping whichever terms show up as trending in the MOST markets at
// once (a term trending in 5 different countries this week is a much stronger "genuinely global"
// signal than a term trending in only 1). Documented here and in SETUP.md as an approximation,
// not an official Google "worldwide" ranking, since no such official ranking exists.
const TRENDS_MARKETS = ["US", "GB", "IN", "BR", "JP", "DE", "FR", "ID", "CN", "MX", "PH", "KR"];

// Dominant language each market's trending terms come back in, for the foreign -> English
// translation pass below (translateTermToEnglish in cf-ai.js). "english" markets are skipped
// entirely (no translation call made). A market being mapped to a language doesn't mean every
// term from it is actually in that language — plenty of trending terms in India or the
// Philippines are already plain English (e.g. "food") — translateTermToEnglish handles that case
// fine too: translating an already-English word/phrase from a stated source language reliably
// comes back unchanged (m2m100 recognizes valid English text), it's just a wasted call, not a
// wrong result — cheap insurance against silently leaving a genuinely foreign term untranslated.
//
// IMPORTANT: these must be values Workers AI's m2m100-1.2b model actually accepts as source_lang
// (it wants full language names, e.g. "tagalog", not the ISO code "tl", and NOT the informal
// name "filipino" — that used to be here and made every Philippines-market translation call
// fail with a 400 "not one of [...]" error; it fell back to keeping the original term, so no
// crash, but every single term stayed untranslated).
const MARKET_LANGUAGE = {
  US: "english",
  GB: "english",
  CN: "chinese",
  IN: "hindi",
  BR: "portuguese",
  JP: "japanese",
  DE: "german",
  FR: "french",
  ID: "indonesian",
  MX: "spanish",
  PH: "tagalog",
  KR: "korean",
  PK: "urdu",
  BD: "bengali",
};

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "was", "were",
  "with", "at", "by", "from", "this", "that", "it", "its", "how", "what", "why", "vs", "new",
  "official", "video", "full", "part", "ft", "feat", "shorts", "short", "trailer", "live",
]);

function tally(map, term) {
  const key = term.trim();
  if (!key) return;
  map.set(key, (map.get(key) || 0) + 1);
}

// --- Phase A: Google Trends RSS across major markets, aggregated by how many markets a term
// appears in (see TRENDS_MARKETS comment above). RSS is small/plain text, so a light regex pull
// of <title> entries is enough here rather than pulling in a full XML parser dependency.
//
// Each market's titles are translated to English (where the market isn't already English-
// language, see MARKET_LANGUAGE) BEFORE being tallied — translating first means a term trending
// in both Brazil and Portugal-equivalent markets under the same underlying English name gets
// correctly counted as ONE cross-market trend instead of two separately-tracked native-language
// entries, which also makes the "trended in the most markets" ranking below more accurate.
async function fetchGoogleTrendsWorldwideApprox() {
  const perTermMarkets = new Map(); // (English) term -> Set of market codes it trended in

  for (const geo of TRENDS_MARKETS) {
    try {
      const res = await fetch(`https://trends.google.com/trending/rss?geo=${geo}`);
      if (!res.ok) {
        console.warn(`Google Trends RSS for ${geo} returned ${res.status}, skipping.`);
        continue;
      }
      const xml = await res.text();
      // Skip the very first <title> (the feed's own title, "Daily Search Trends"), keep the rest.
      const titles = [...xml.matchAll(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/g)]
        .map((m) => m[1].trim())
        .filter((t) => t && !/daily search trends/i.test(t));

      const lang = MARKET_LANGUAGE[geo] || "english";
      for (const t of titles) {
        const englishTerm = await translateTermToEnglish(t, lang);
        if (!perTermMarkets.has(englishTerm)) perTermMarkets.set(englishTerm, new Set());
        perTermMarkets.get(englishTerm).add(geo);
      }
    } catch (e) {
      console.warn(`Google Trends RSS for ${geo} failed, skipping:`, e.message);
    }
  }

  const ranked = [...perTermMarkets.entries()]
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 10)
    .map(([term]) => term);

  console.log(`Google Trends (aggregated, worldwide approximation, translated to English): ${ranked.join(", ") || "(none found)"}`);
  return ranked;
}

// --- Phase B: YouTube's own "most popular" chart per country, tallying words/tags across the
// top 25 videos in each of the 10 countries above. Cheap on quota: videos.list costs 1 unit per
// call regardless of maxResults, so 10 calls = 10 units against the 10,000/day budget.
//
// Video TITLES are translated to English first (whole phrase, not word-by-word — MT quality
// degrades badly translating isolated single words out of context) before being split into
// individual word-tags. `tags` (v.snippet.tags) are left as-is: uploaders very often set tags in
// English regardless of the video's spoken language, and translating every tag on every video
// individually would multiply the Workers AI call count for comparatively little benefit.
async function fetchYoutubeTopTermsByCountry() {
  const youtube = getYoutubeClient();
  const byCountry = {};

  for (const { name, region } of YOUTUBE_TRENDING_COUNTRIES) {
    const lang = MARKET_LANGUAGE[region] || "english";
    try {
      const res = await youtube.videos.list({
        part: ["snippet"],
        chart: "mostPopular",
        regionCode: region,
        maxResults: 25,
      });
      const counts = new Map();
      for (const v of res.data.items || []) {
        const rawTitle = v.snippet?.title || "";
        const englishTitle = await translateTermToEnglish(rawTitle, lang);
        const words = englishTitle.split(/[\s|:—\-,.!?()"']+/).filter(Boolean);
        for (const w of words) {
          const lw = w.toLowerCase();
          if (lw.length < 3 || STOPWORDS.has(lw)) continue;
          tally(counts, w);
        }
        for (const tag of v.snippet?.tags || []) tally(counts, tag);
      }
      const top = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([term]) => term);
      byCountry[region] = top;
      console.log(`YouTube top terms (${name}, ${region}, translated to English): ${top.join(", ") || "(none found)"}`);
    } catch (e) {
      console.warn(`YouTube trending chart for ${name} (${region}) failed, skipping:`, e.message);
      byCountry[region] = [];
    }
  }
  return byCountry;
}

// Combines fixed keywords + book/brand terms (same as customize-channel.js's buildChannelKeywords)
// + this week's trending terms into a single string under the channel Keywords field's 500-char
// cap. Fixed keywords and brand terms are added FIRST so they always survive truncation —
// trending terms fill whatever room is left.
function buildCombinedKeywordString({ googleTrendsApprox, youtubeTopTermsFlat }) {
  const seen = new Set();
  const phrases = [];
  function add(term) {
    const t = String(term || "").trim();
    const key = t.toLowerCase();
    if (!t || seen.has(key)) return;
    seen.add(key);
    phrases.push(t);
  }

  FIXED_KEYWORDS.forEach(add);
  ["HDL Group", "High Definition Learning", "digital textbooks", "ebooks"].forEach(add);
  for (const book of CATALOG) {
    add(book.angle);
    add(book.title);
  }
  googleTrendsApprox.forEach(add);
  youtubeTopTermsFlat.forEach(add);

  const quoted = phrases.map((p) => (p.includes(" ") ? `"${p}"` : p));
  let result = "";
  for (const p of quoted) {
    const next = result ? `${result} ${p}` : p;
    if (next.length > CHANNEL_KEYWORDS_MAX) break;
    result = next;
  }
  return result;
}

async function runCompute() {
  console.log("Computing this week's trending keyword set...");
  const [googleTrendsApprox, youtubeTopTermsByCountry] = await Promise.all([
    fetchGoogleTrendsWorldwideApprox(),
    fetchYoutubeTopTermsByCountry(),
  ]);
  const youtubeTopTermsFlat = [...new Set(Object.values(youtubeTopTermsByCountry).flat())];

  const data = {
    updatedAt: new Date().toISOString(),
    fixed: FIXED_KEYWORDS,
    googleTrendsApprox,
    youtubeTopTermsByCountry,
    youtubeTopTermsFlat,
    channelKeywordsString: buildCombinedKeywordString({ googleTrendsApprox, youtubeTopTermsFlat }),
  };

  await fs.writeFile(OUT_FILE, JSON.stringify(data, null, 2) + "\n", "utf8");
  console.log(`Wrote ${OUT_FILE} (${data.channelKeywordsString.length}/${CHANNEL_KEYWORDS_MAX} chars for channel keywords).`);
}

async function runApply() {
  const raw = await fs.readFile(OUT_FILE, "utf8").catch(() => null);
  if (!raw) throw new Error(`${OUT_FILE} not found — the "compute" phase must run and commit it first.`);
  const data = JSON.parse(raw);
  if (!data.channelKeywordsString) throw new Error(`${OUT_FILE} has no channelKeywordsString.`);

  console.log("Fetching current channel branding...");
  const channel = await getMyChannelBranding();
  console.log(`Channel: "${channel.snippet.title}" (${channel.id})`);
  console.log(`Applying keywords (${data.channelKeywordsString.length} chars, computed ${data.updatedAt}):`);
  console.log(data.channelKeywordsString);

  await setChannelKeywords({
    channelId: channel.id,
    keywords: data.channelKeywordsString,
    currentBranding: channel.brandingSettings,
  });
  console.log("Channel keywords updated.");
}

async function main() {
  if (MODE === "compute") await runCompute();
  else if (MODE === "apply") await runApply();
  else throw new Error(`Unknown KEYWORDS_MODE "${MODE}" — expected "compute" or "apply".`);
}

main().catch((e) => {
  console.error("update-keywords.js failed:", e);
  process.exit(1);
});
