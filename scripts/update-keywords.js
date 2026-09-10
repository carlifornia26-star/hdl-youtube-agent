import fs from "node:fs/promises";
import fetch from "node-fetch";
import { getMyChannelBranding, setChannelKeywords, getYoutubeClient } from "./youtube.js";
import { translateTermToEnglish } from "./cf-ai.js";
import { CATALOG } from "./catalog.js";

// Two schedules now feed the same keyword pipeline (see the two workflows:
// hdl-keyword-update.yml [weekly] and hdl-keyword-update-daily.yml [daily]), each running the
// same two-phase compute-then-apply pattern because the trending lookups only need to happen
// ONCE per run, not once per channel:
//   - WEEKLY, Monday 5am Africa/Johannesburg: computes the top 2 trending terms (by combined
//     cross-market signal strength) and writes keywords-weekly.json. These 2 words sit right
//     after the 5 fixed keywords and hold for the whole week.
//   - DAILY, every day 5pm Africa/Johannesburg: computes a fuller trending set (excluding
//     whatever's already locked in as this week's top 2, so it's genuinely "the rest") and
//     writes keywords-daily.json. This is the part that actually refreshes every day.
// MODE picks which phase/schedule this run is:
//   MODE=compute-weekly -> fetch trends, write keywords-weekly.json (top 2 terms only)
//   MODE=compute-daily  -> fetch trends, write keywords-daily.json (the rest)
//   MODE=apply          -> read BOTH files (whichever exist), build the combined channel
//                           keywords string fresh, call setChannelKeywords for THIS channel
//                           (uses the same YT_CLIENT_ID/SECRET/REFRESH_TOKEN env vars every
//                           other script here uses). Run after EITHER compute phase, so the
//                           channel always reflects the latest of both the weekly-2 and the
//                           daily-rest, whichever just changed.
const MODE = process.env.KEYWORDS_MODE || "compute-weekly";
const WEEKLY_FILE = "keywords-weekly.json";
const DAILY_FILE = "keywords-daily.json";
const CHANNEL_KEYWORDS_MAX = 500; // same brandingSettings.channel.keywords hard cap as customize-channel.js

// These 5 never change, regardless of what's trending — always kept, and always survive the
// 500-char truncation below since they're added first.
const FIXED_KEYWORDS = ["Google", "YouTube", "MrBeast", "Artificial Intelligence (AI)", "Mirror Movie"];

// How many terms the weekly run locks in right after the fixed keywords. Requested as "2 words".
const WEEKLY_TOP_N = 2;

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

// Ranks every trending term seen across BOTH sources into one ordered list, so "top N" has a
// single well-defined meaning instead of two separately-ordered lists. Google Trends terms are
// already ordered by how many markets they trended in (fetchGoogleTrendsWorldwideApprox), so
// their rank position gives a weighted score; YouTube per-country appearances each add a smaller
// bump. Ties resolve toward whichever term has broader cross-source support.
function rankAllTrendingTerms({ googleTrendsApprox, youtubeTopTermsByCountry }) {
  const scores = new Map(); // lowercase -> { term, score }
  function bump(term, amount) {
    const t = String(term || "").trim();
    if (!t) return;
    const key = t.toLowerCase();
    if (!scores.has(key)) scores.set(key, { term: t, score: 0 });
    scores.get(key).score += amount;
  }
  googleTrendsApprox.forEach((term, i) => bump(term, (googleTrendsApprox.length - i) * 2));
  for (const terms of Object.values(youtubeTopTermsByCountry || {})) {
    (terms || []).forEach((term) => bump(term, 1));
  }
  return [...scores.values()].sort((a, b) => b.score - a.score).map((e) => e.term);
}

// Combines fixed keywords + this week's top-2 trending terms + book/brand terms (same as
// customize-channel.js's buildChannelKeywords) + the rest of today's trending terms into a
// single string under the channel Keywords field's 500-char cap, in the requested order:
// consistent keywords, then the weekly 2 words, then everything else. Fixed + weekly-2 + brand
// terms are added FIRST so they always survive truncation — the daily "rest" fills whatever
// room is left.
function buildCombinedKeywordString({ weeklyTop2, dailyRest }) {
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
  (weeklyTop2 || []).forEach(add);
  ["HDL Group", "High Definition Learning", "digital textbooks", "ebooks"].forEach(add);
  for (const book of CATALOG) {
    add(book.angle);
    add(book.title);
  }
  (dailyRest || []).forEach(add);

  const quoted = phrases.map((p) => (p.includes(" ") ? `"${p}"` : p));
  let result = "";
  for (const p of quoted) {
    const next = result ? `${result} ${p}` : p;
    if (next.length > CHANNEL_KEYWORDS_MAX) break;
    result = next;
  }
  return result;
}

const KEYWORD_HISTORY_DIR = "keyword-history";
const MAX_SOURCE_ATTEMPTS = 3;
const RETRY_BASE_MS = 4000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectFreshTrendsWithRetry() {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_SOURCE_ATTEMPTS; attempt++) {
    try {
      console.log(`Trend collection attempt ${attempt}/${MAX_SOURCE_ATTEMPTS}...`);

      const [googleTrendsApprox, youtubeTopTermsByCountry] = await Promise.all([
        fetchGoogleTrendsWorldwideApprox(),
        fetchYoutubeTopTermsByCountry(),
      ]);

      const youtubeCountriesWithData = Object.values(youtubeTopTermsByCountry)
        .filter((terms) => Array.isArray(terms) && terms.length > 0).length;

      // Do not replace a known-good weekly file with an empty/broken collection.
      // At least one Google trend AND one YouTube market must return data.
      if (googleTrendsApprox.length === 0 || youtubeCountriesWithData === 0) {
        throw new Error(
          `Insufficient trend data: Google=${googleTrendsApprox.length} terms, ` +
          `YouTube=${youtubeCountriesWithData} markets with data.`
        );
      }

      return { googleTrendsApprox, youtubeTopTermsByCountry };
    } catch (error) {
      lastError = error;
      console.warn(`Trend collection attempt ${attempt} failed: ${error.message}`);

      if (attempt < MAX_SOURCE_ATTEMPTS) {
        const delay = RETRY_BASE_MS * 2 ** (attempt - 1);
        console.log(`Waiting ${delay}ms before retry...`);
        await sleep(delay);
      }
    }
  }

  throw new Error(
    `Fresh trend collection failed after ${MAX_SOURCE_ATTEMPTS} attempts. ` +
    `The previous keyword file was NOT replaced. Last error: ${lastError?.message || "unknown error"}`
  );
}

function validateWeeklyData(data) {
  if (!data || typeof data !== "object") throw new Error("Weekly keyword data is not an object.");
  if (!Array.isArray(data.fixed)) throw new Error("Weekly keyword data is missing fixed[].");
  if (!Array.isArray(data.weeklyTop2)) throw new Error("Weekly keyword data is missing weeklyTop2[].");
  if (!data.updatedAt || Number.isNaN(Date.parse(data.updatedAt))) {
    throw new Error("Weekly keyword data has an invalid updatedAt timestamp.");
  }
  return data;
}

function validateDailyData(data) {
  if (!data || typeof data !== "object") throw new Error("Daily keyword data is not an object.");
  if (!Array.isArray(data.dailyRest)) throw new Error("Daily keyword data is missing dailyRest[].");
  if (!Array.isArray(data.googleTrendsApprox)) throw new Error("Daily keyword data is missing googleTrendsApprox[].");
  if (!data.youtubeTopTermsByCountry || typeof data.youtubeTopTermsByCountry !== "object") {
    throw new Error("Daily keyword data is missing youtubeTopTermsByCountry.");
  }
  if (!Array.isArray(data.youtubeTopTermsFlat)) throw new Error("Daily keyword data is missing youtubeTopTermsFlat[].");
  if (!data.updatedAt || Number.isNaN(Date.parse(data.updatedAt))) {
    throw new Error("Daily keyword data has an invalid updatedAt timestamp.");
  }
  return data;
}

async function readWeeklyFileIfPresent() {
  try {
    return validateWeeklyData(JSON.parse(await fs.readFile(WEEKLY_FILE, "utf8")));
  } catch {
    return null; // no weekly file yet (first-ever run) or it's malformed — treated as "no top 2 yet"
  }
}

async function readDailyFileIfPresent() {
  try {
    return validateDailyData(JSON.parse(await fs.readFile(DAILY_FILE, "utf8")));
  } catch {
    return null; // no daily file yet (first-ever run) or it's malformed — treated as "no rest yet"
  }
}

// Runs Monday 5am Africa/Johannesburg. Picks the single top-2 trending terms (by combined
// cross-market signal, see rankAllTrendingTerms) and locks them in for the week, right after the
// 5 fixed keywords.
async function runComputeWeekly() {
  console.log("Computing this week's top 2 trending keywords with bounded retries...");

  const { googleTrendsApprox, youtubeTopTermsByCountry } = await collectFreshTrendsWithRetry();
  const ranked = rankAllTrendingTerms({ googleTrendsApprox, youtubeTopTermsByCountry });
  const weeklyTop2 = ranked.slice(0, WEEKLY_TOP_N);

  const data = validateWeeklyData({
    updatedAt: new Date().toISOString(),
    fixed: FIXED_KEYWORDS,
    weeklyTop2,
  });

  await fs.writeFile(WEEKLY_FILE, JSON.stringify(data, null, 2) + "\n", "utf8");

  await fs.mkdir(KEYWORD_HISTORY_DIR, { recursive: true });
  const historyPath = `${KEYWORD_HISTORY_DIR}/weekly-${data.updatedAt.slice(0, 10)}.json`;
  await fs.writeFile(historyPath, JSON.stringify(data, null, 2) + "\n", "utf8");

  console.log(`Wrote ${WEEKLY_FILE} (top 2: ${weeklyTop2.join(", ") || "(none found)"}) and ${historyPath}.`);
}

// Runs every day 5pm Africa/Johannesburg. Computes a fuller trending set, excluding this week's
// locked-in top 2 (so it's genuinely "the rest" — no duplicate tag entries), and writes it as
// the part of the keyword pool that actually refreshes daily.
async function runComputeDaily() {
  console.log("Computing today's trending keyword set with bounded retries...");

  const weekly = await readWeeklyFileIfPresent();
  const excludeSet = new Set((weekly?.weeklyTop2 || []).map((t) => t.toLowerCase()));

  const { googleTrendsApprox, youtubeTopTermsByCountry } = await collectFreshTrendsWithRetry();
  const youtubeTopTermsFlat = [...new Set(Object.values(youtubeTopTermsByCountry).flat())];
  const ranked = rankAllTrendingTerms({ googleTrendsApprox, youtubeTopTermsByCountry });
  const dailyRest = ranked.filter((t) => !excludeSet.has(t.toLowerCase()));

  const data = validateDailyData({
    updatedAt: new Date().toISOString(),
    dailyRest,
    googleTrendsApprox,
    youtubeTopTermsByCountry,
    youtubeTopTermsFlat,
  });

  await fs.writeFile(DAILY_FILE, JSON.stringify(data, null, 2) + "\n", "utf8");

  await fs.mkdir(KEYWORD_HISTORY_DIR, { recursive: true });
  const historyPath = `${KEYWORD_HISTORY_DIR}/daily-${data.updatedAt.slice(0, 10)}.json`;
  await fs.writeFile(historyPath, JSON.stringify(data, null, 2) + "\n", "utf8");

  console.log(`Wrote ${DAILY_FILE} (${dailyRest.length} terms after excluding this week's top 2) and ${historyPath}.`);
}

// Reads both files (whichever exist), rebuilds the combined channel keywords string fresh, and
// pushes it to THIS channel. Run after either compute phase, so the channel always reflects the
// latest of both the weekly-2 and the daily-rest.
async function runApply() {
  const weekly = await readWeeklyFileIfPresent();
  const daily = await readDailyFileIfPresent();
  if (!weekly && !daily) {
    throw new Error(
      `Neither ${WEEKLY_FILE} nor ${DAILY_FILE} found — at least one compute phase must run and commit first.`
    );
  }

  const channelKeywordsString = buildCombinedKeywordString({
    weeklyTop2: weekly?.weeklyTop2 || [],
    dailyRest: daily?.dailyRest || [],
  });

  console.log("Fetching current channel branding...");
  const channel = await getMyChannelBranding();
  console.log(`Channel: "${channel.snippet.title}" (${channel.id})`);
  console.log(
    `Applying keywords (${channelKeywordsString.length} chars; weekly updated ` +
    `${weekly?.updatedAt || "never"}, daily updated ${daily?.updatedAt || "never"}):`
  );
  console.log(channelKeywordsString);

  await setChannelKeywords({
    channelId: channel.id,
    keywords: channelKeywordsString,
    currentBranding: channel.brandingSettings,
  });

  // Verify against the live YouTube channel after the mutation. Do not report success based
  // solely on the update request returning HTTP 200.
  const verified = await getMyChannelBranding();
  const actual = verified.brandingSettings?.channel?.keywords || "";
  if (actual !== channelKeywordsString) {
    throw new Error(
      `Channel keyword verification failed for "${verified.snippet.title}" (${verified.id}). ` +
      `Expected ${channelKeywordsString.length} chars but YouTube returned ${actual.length}.`
    );
  }

  console.log(`Channel keywords updated AND verified successfully for ${verified.snippet.title}.`);
}

async function main() {
  if (MODE === "compute-weekly") await runComputeWeekly();
  else if (MODE === "compute-daily") await runComputeDaily();
  else if (MODE === "apply") await runApply();
  else {
    throw new Error(
      `Unknown KEYWORDS_MODE "${MODE}" — expected "compute-weekly", "compute-daily", or "apply".`
    );
  }
}

main().catch((e) => {
  console.error("update-keywords.js failed:", e);
  process.exit(1);
});
