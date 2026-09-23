// Daily trending-topic tie-in for the video pipeline.
//
// What this does, in order (all called from generate-video.js):
//   1. pickTodaysTrend()   — pulls today's trending Google searches (Google Trends' public RSS feed,
//                            aggregated across English-language markets), drops anything sensitive,
//                            and has the model pick the ONE term that ties to today's book most
//                            honestly. Returns null when nothing fits — the video then runs exactly
//                            as it did before (no trend in the title/script, no news scene).
//   2. fetchTopHeadline()  — finds the top fresh news headline for that term (Google News RSS
//                            search, falling back to the news item attached to the trend itself).
//                            The headline is later drawn as an animated card (render.js) — it is
//                            NOT a screenshot of a publisher's page.
//   3. buildNewsSceneLine() — the short narration line spoken over the news card.
//   4. recordTrendPick()   — remembers the pick in trend-history.json so the same term isn't
//                            reused by another channel today or by any channel for a week.
//
// Nothing here touches YouTube quota. Every network call is best-effort: a failure returns
// "no trend today", never a failed run.
import fetch from "node-fetch";
import fs from "node:fs/promises";
import path from "node:path";
import { selectTrendTieIn } from "./cf-ai.js";

const HISTORY_PATH = path.resolve("trend-history.json");
const HISTORY_MAX_ENTRIES = 80;
const AVOID_REUSE_DAYS = 7; // same term isn't reused by ANY channel within this many days
const MIN_FIT = 5; // model's 0-10 "how honest is this tie-in" score must reach this
const SHORTLIST_SIZE = 15; // how many candidates the model gets to choose from
const FETCH_TIMEOUT_MS = 15000;

// "Worldwide" approximation: Google publishes trends per country, not globally. English-language
// markets are used so terms come back in English with no translation step, and terms are ranked
// by how many of these markets they appear in (then by Google's traffic estimate).
const TREND_MARKETS = ["US", "GB", "CA", "AU", "IN", "ZA", "NG", "PH", "IE", "NZ", "SG", "KE"];

// Brand-safety filter, applied to trend terms AND to headlines. Deliberately broad: this channel
// is educational, so a topic that needs a second thought (death, crime, disaster, war, politics,
// health scares, adult content) is skipped in favour of the next one.
const SENSITIVE_RE = new RegExp(
  "\\b(" +
    [
      "dead", "dies", "died", "death", "deaths", "dying", "killed", "kills", "killing",
      "murder(?:ed|s)?", "shooting", "gunman", "stabbing", "stabbed", "massacre",
      "terror(?:ist|ists|ism)?", "bomb(?:ing|ings)?", "explosion", "crash(?:ed|es)?",
      "earthquake", "hurricane", "tsunami", "flood(?:s|ing)?", "wildfire", "victims?",
      "rape", "rapist", "sexual assault", "abuse", "suicide", "overdose", "hostages?",
      "war", "missiles?", "invasion", "airstrikes?", "arrest(?:ed|s)?", "indict(?:ed|ment)",
      "convicted", "sentenced", "lawsuit", "scandal", "obituary", "funeral", "cancer",
      "outbreak", "epidemic", "pandemic", "election", "elections", "ballot", "senate",
      "congress", "parliament", "president", "prime minister", "trump", "biden", "harris",
      "putin", "zelensky", "netanyahu", "gaza", "israel", "palestin\\w*", "ukraine", "russia",
      "nazi", "porn", "nsfw", "onlyfans", "nude", "leaked", "tragedy", "tragic", "mourn\\w*", "rip",
    ].join("|") +
    ")\\b",
  "i"
);

export function isSensitive(text) {
  return SENSITIVE_RE.test(String(text || ""));
}

// ---------- small helpers ----------

function decodeXml(str) {
  return String(str || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, "") // any stray inline markup
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tagText(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decodeXml(m[1]) : "";
}

function tagAttr(block, name, attr) {
  const m = block.match(new RegExp(`<${name}\\s[^>]*${attr}="([^"]*)"`));
  return m ? decodeXml(m[1]) : "";
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; HDLVideoAgent/1.0)", Accept: "application/rss+xml, application/xml, text/xml, */*" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseTraffic(label) {
  const m = String(label || "").replace(/,/g, "").match(/([\d.]+)\s*([KkMm]?)/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const mult = m[2].toLowerCase() === "m" ? 1e6 : m[2].toLowerCase() === "k" ? 1e3 : 1;
  return Math.round(n * mult);
}

function toDisplayTerm(term) {
  const t = String(term || "").trim();
  if (t !== t.toLowerCase()) return t; // already has its own capitalisation (e.g. "iPhone 17", "AI")
  return t
    .split(" ")
    .map((w, i) => (i > 0 && ["vs", "of", "the", "and", "in", "on", "at", "for", "to"].includes(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

function usableTerm(term) {
  const t = String(term || "").trim();
  if (t.length < 3 || t.length > 40) return false;
  const letters = (t.match(/[a-z]/gi) || []).length;
  const nonSpace = t.replace(/\s/g, "").length;
  if (letters < 3 || letters < nonSpace * 0.7) return false; // mostly non-Latin / numeric — not narratable in English
  if (/https?:|www\.|@|#/.test(t)) return false;
  return true;
}

function significantWords(term) {
  const stop = new Set(["the", "and", "vs", "for", "with", "from", "news", "live", "today", "score", "match"]);
  return String(term || "")
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((w) => w.length >= 3 && !stop.has(w));
}

function mentionsTerm(headline, term) {
  const words = significantWords(term);
  if (!words.length) return true;
  const h = String(headline || "").toLowerCase();
  return words.some((w) => h.includes(w));
}

// ---------- Google Trends (live) ----------

// One <item> per trending search. Field names follow Google's public Trends RSS (`ht:` namespace).
// Everything but the title is optional — a missing field just means less context.
export function parseTrendsFeed(xml) {
  const items = [...String(xml || "").matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  return items
    .map((block) => {
      const term = tagText(block, "title");
      if (!term || /daily search trends/i.test(term)) return null;
      const headline = tagText(block, "ht:news_item_title");
      return {
        term,
        traffic: parseTraffic(tagText(block, "ht:approx_traffic")),
        news: headline
          ? { headline, source: tagText(block, "ht:news_item_source"), url: tagText(block, "ht:news_item_url") }
          : null,
      };
    })
    .filter(Boolean);
}

async function fetchLiveTrends() {
  const merged = new Map(); // lowercase term -> { term, markets:Set, traffic, news }
  let okMarkets = 0;
  await Promise.all(
    TREND_MARKETS.map(async (geo) => {
      try {
        const xml = await fetchText(`https://trends.google.com/trending/rss?geo=${geo}`);
        const items = parseTrendsFeed(xml);
        if (items.length) okMarkets++;
        for (const it of items) {
          const key = it.term.toLowerCase();
          const cur = merged.get(key) || { term: it.term, markets: new Set(), traffic: 0, news: null };
          cur.markets.add(geo);
          cur.traffic = Math.max(cur.traffic, it.traffic);
          if (!cur.news && it.news) cur.news = it.news;
          merged.set(key, cur);
        }
      } catch (e) {
        console.warn(`Trends feed for ${geo} failed, skipping: ${e.message}`);
      }
    })
  );
  console.log(`Google Trends: ${merged.size} distinct terms from ${okMarkets}/${TREND_MARKETS.length} markets.`);
  return [...merged.values()]
    .map((t) => ({ term: t.term, markets: t.markets.size, traffic: t.traffic, news: t.news }))
    .sort((a, b) => b.markets - a.markets || b.traffic - a.traffic);
}

// Fallback if the live feeds are all unreachable: the terms the daily keyword job already saved.
// Up to ~a day old, but still real trends — better than no tie-in at all.
async function trendsFromDailyKeywordFile() {
  try {
    const data = JSON.parse(await fs.readFile(path.resolve("keywords-daily.json"), "utf8"));
    return (data.googleTrendsApprox || []).map((term) => ({ term: String(term), markets: 1, traffic: 0, news: null }));
  } catch {
    return [];
  }
}

// ---------- history (so terms don't repeat) ----------

async function loadHistory() {
  try {
    const parsed = JSON.parse(await fs.readFile(HISTORY_PATH, "utf8"));
    return Array.isArray(parsed.picks) ? parsed : { picks: [] };
  } catch {
    return { picks: [] };
  }
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function recentlyUsedTerms(history, days = AVOID_REUSE_DAYS) {
  const cutoff = Date.now() - days * 86400000;
  return new Set(
    history.picks
      .filter((p) => p.term && new Date(p.date).getTime() >= cutoff)
      .map((p) => String(p.term).toLowerCase())
  );
}

export async function recordTrendPick({ channelId, term, headline = null }) {
  try {
    const history = await loadHistory();
    history.picks.unshift({ date: todayIso(), channel: String(channelId), term, headline });
    if (history.picks.length > HISTORY_MAX_ENTRIES) history.picks.length = HISTORY_MAX_ENTRIES;
    history.updated_at = new Date().toISOString();
    await fs.writeFile(HISTORY_PATH, JSON.stringify(history, null, 2) + "\n");
  } catch (e) {
    console.warn("Could not update trend-history.json (continuing):", e.message);
  }
}

// ---------- main entry: choose today's trend ----------

// Returns { term, tieIn, fit, markets, source, trendsNews } or null (no fitting/safe trend today).
export async function pickTodaysTrend({ book, channelId }) {
  let trends = [];
  let source = "live Google Trends";
  try {
    trends = await fetchLiveTrends();
  } catch (e) {
    console.warn("Live Google Trends failed:", e.message);
  }
  if (!trends.length) {
    trends = await trendsFromDailyKeywordFile();
    source = "keywords-daily.json fallback";
  }
  if (!trends.length) {
    console.log("No trending terms available today — continuing without a trend tie-in.");
    return null;
  }

  const history = await loadHistory();
  const blocked = recentlyUsedTerms(history);
  const shortlist = trends
    .filter((t) => usableTerm(t.term) && !isSensitive(t.term) && !(t.news && isSensitive(t.news.headline)) && !blocked.has(t.term.toLowerCase()))
    .slice(0, SHORTLIST_SIZE);
  console.log(`Trend shortlist (${source}): ${shortlist.map((t) => t.term).join(" | ") || "(empty)"}`);
  if (!shortlist.length) return null;

  const pick = await selectTrendTieIn(book, shortlist.map((t) => t.term));
  if (!pick) {
    console.log("No trending term could be tied to today's topic honestly — continuing without one.");
    return null;
  }
  if (pick.fit < MIN_FIT) {
    console.log(`Best trend "${shortlist[pick.index].term}" scored ${pick.fit}/10 (needs ${MIN_FIT}+) — skipping the tie-in.`);
    return null;
  }

  const chosen = shortlist[pick.index];
  const trend = {
    term: toDisplayTerm(chosen.term),
    tieIn: pick.tieIn,
    fit: pick.fit,
    markets: chosen.markets,
    source,
    trendsNews: chosen.news,
  };
  console.log(`Today's trend (channel ${channelId}): "${trend.term}" — fit ${pick.fit}/10 — ${pick.tieIn}`);
  await recordTrendPick({ channelId, term: trend.term });
  return trend;
}

// ---------- top headline (for the animated news card) ----------

export function parseNewsFeed(xml) {
  const items = [...String(xml || "").matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  return items
    .map((block) => {
      const rawTitle = tagText(block, "title");
      let outlet = tagText(block, "source");
      let headline = rawTitle;
      // Google News titles look like "Headline text - Outlet Name"; strip that outlet suffix.
      const cut = rawTitle.lastIndexOf(" - ");
      if (cut > 10) {
        const tail = rawTitle.slice(cut + 3).trim();
        if (!outlet || tail.toLowerCase() === outlet.toLowerCase()) {
          headline = rawTitle.slice(0, cut).trim();
          if (!outlet) outlet = tail;
        }
      }
      return { headline, source: outlet, url: tagText(block, "link"), pubDate: tagText(block, "pubDate") };
    })
    .filter((i) => i.headline);
}

function formatDateText(pubDate) {
  const d = pubDate ? new Date(pubDate) : new Date();
  const safe = Number.isNaN(d.getTime()) ? new Date() : d;
  return safe.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function tidyHeadline(h) {
  let out = String(h || "").trim();
  if (out.length > 150) {
    out = out.slice(0, 150).replace(/\s+\S*$/, "");
    out = out.replace(/[.,;:!?\s]+$/, "") + "…";
  }
  return out;
}

// Returns { headline, source, url, dateText } or null. Skips sensitive or off-topic headlines
// rather than blindly taking item #1 — "first" means first SAFE, relevant, fresh result.
export async function fetchTopHeadline(trend) {
  const term = trend?.term;
  if (!term) return null;

  for (const window of ["1d", "7d"]) {
    try {
      const q = encodeURIComponent(`${term} when:${window}`);
      const xml = await fetchText(`https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`);
      for (const item of parseNewsFeed(xml)) {
        if (isSensitive(item.headline)) continue;
        if (!mentionsTerm(item.headline, term)) continue;
        console.log(`News headline (${window}): "${item.headline}" — ${item.source || "unknown source"}`);
        return { headline: tidyHeadline(item.headline), source: item.source || "News", url: item.url, dateText: formatDateText(item.pubDate) };
      }
    } catch (e) {
      console.warn(`Google News search (${window}) for "${term}" failed: ${e.message}`);
    }
  }

  // Fallback: the news item Google attached to the trend itself.
  const tn = trend.trendsNews;
  if (tn?.headline && !isSensitive(tn.headline)) {
    console.log(`News headline (from the trend's own news item): "${tn.headline}" — ${tn.source || "unknown source"}`);
    return { headline: tidyHeadline(tn.headline), source: tn.source || "News", url: tn.url || "", dateText: formatDateText(null) };
  }
  console.log(`No safe, relevant headline found for "${term}" — skipping the news scene.`);
  return null;
}

// Up to `max` distinct, safe, relevant headlines for the trend (1-day window first, then 7-day,
// then the trend's own news item) — feeds the multi-screenshot news segment. Returns [] if none.
export async function fetchTopHeadlines(trend, max = 4) {
  const term = trend?.term;
  if (!term) return [];
  const out = [];
  const seen = new Set();
  const add = (h) => {
    const key = String(h.headline || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 60);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(h);
  };
  for (const window of ["1d", "7d"]) {
    if (out.length >= max) break;
    try {
      const q = encodeURIComponent(`${term} when:${window}`);
      const xml = await fetchText(`https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`);
      for (const item of parseNewsFeed(xml)) {
        if (out.length >= max) break;
        if (isSensitive(item.headline)) continue;
        if (!mentionsTerm(item.headline, term)) continue;
        add({ headline: tidyHeadline(item.headline), source: item.source || "News", url: item.url, dateText: formatDateText(item.pubDate) });
      }
    } catch (e) {
      console.warn(`Google News search (${window}) for "${term}" failed: ${e.message}`);
    }
  }
  const tn = trend.trendsNews;
  if (out.length < max && tn?.headline && !isSensitive(tn.headline)) {
    add({ headline: tidyHeadline(tn.headline), source: tn.source || "News", url: tn.url || "", dateText: formatDateText(null) });
  }
  console.log(`News headlines for "${term}": ${out.length} found.` + out.map((h, i) => `\n  ${i + 1}. ${h.headline} (${h.source})`).join(""));
  return out;
}

// ---------- the line spoken over the news card ----------

const NEWS_LINE_TEMPLATES = [
  (t) => `${t} is trending in searches right now, and here is the top headline behind it.`,
  (t) => `${t} is climbing the search charts right now. Here is the headline at the top of the news.`,
  (t) => `Search trends say a lot about what people care about. Right now, ${t} is one of them, and this is the top headline for it.`,
  (t) => `Take ${t}, which is all over search right now. This is the headline the news is leading with.`,
  (t) => `Right now, plenty of people are searching ${t}. Here is the headline that tops the news for it.`,
];

export function buildNewsSceneLine(term, channelId = "1") {
  const dayOfYear = Math.floor((new Date() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
  const idx = (dayOfYear + Number(channelId || 1)) % NEWS_LINE_TEMPLATES.length;
  return NEWS_LINE_TEMPLATES[idx](term);
}

