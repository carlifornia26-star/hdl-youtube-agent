// Reads videos-manifest.json, pulls REAL per-video thumbnail performance from the YouTube
// Analytics API (videoThumbnailImpressions / videoThumbnailImpressionsClickRate — added by
// Google on Jan 15, 2026), and decides whether thumbnail variant "A" (plain photo) or "B"
// (photo + bold title text, see generateThumbnail in render.js) is winning.
//
// Writes thumbnail-winner.json to the repo root. generate-video.js reads that file at the top
// of every run: if it names a winner, EVERY video uses that variant from then on; if not
// (not enough data yet, or no clear winner), it keeps alternating A/B by day-of-year as before.
// This is what makes the A/B test "fully automatic" — re-run on a schedule (see
// .github/workflows/thumbnail-report.yml), it can also switch the winner back later if
// performance drifts, with no manual step ever required.
//
// Requires YT_REFRESH_TOKEN to have the yt-analytics.readonly scope. If it doesn't, every
// call below fails with a 403 "insufficient authentication scopes" error — caught and
// explained clearly rather than left as a raw googleapis stack trace.
import fs from "node:fs/promises";
import path from "node:path";
import { analyticsClient } from "./youtube.js";

const MANIFEST_PATH = path.resolve("videos-manifest.json");
const WINNER_PATH = path.resolve("thumbnail-winner.json");

// Only compare videos old enough to have accumulated meaningful impressions — a video
// published yesterday would just add noise. 400+ videos/day cadence-wise this is ~3 days.
const MIN_AGE_DAYS = 3;
// Ignore anything older than this so a stale style comparison (e.g. from months ago, before
// other pipeline changes) can't distort a current decision.
const MAX_AGE_DAYS = 120;
// Don't decide a winner until each variant has this many combined thumbnail impressions —
// below this, differences are mostly noise.
const MIN_IMPRESSIONS_PER_VARIANT = 3000;
// Winning variant must lead by at least this many CTR percentage points (e.g. 8.0% vs 7.3%)
// to count as a real win rather than sampling noise close to a coin flip.
const MIN_CTR_LEAD_POINTS = 0.5;
// YouTube Analytics `filters=video==id1,id2,...` has a practical URL-length ceiling —
// chunk requests to stay well under it regardless of how large the manifest grows.
const CHUNK_SIZE = 40;

function explainIfScopeError(err) {
  const status = err?.code || err?.response?.status;
  const reason = String(err?.response?.data?.error?.message || err?.message || "");
  if (status === 403 || /insufficient.*scope/i.test(reason)) {
    console.error(
      "\n*** YT_REFRESH_TOKEN IS MISSING THE yt-analytics.readonly SCOPE ***\n" +
        "Redo the OAuth Playground flow from SETUP.md step 2.4, but also check the box for\n" +
        "https://www.googleapis.com/auth/yt-analytics.readonly alongside the two scopes you\n" +
        "already have, then update the YT_REFRESH_TOKEN repo secret with the new token.\n"
    );
  }
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function fetchThumbnailStats(videoIds) {
  if (videoIds.length === 0) return new Map();
  const youtubeAnalytics = analyticsClient();
  const stats = new Map(); // video_id -> { impressions, ctr }

  for (let i = 0; i < videoIds.length; i += CHUNK_SIZE) {
    const chunk = videoIds.slice(i, i + CHUNK_SIZE);
    try {
      const res = await youtubeAnalytics.reports.query({
        ids: "channel==MINE",
        startDate: daysAgo(MAX_AGE_DAYS),
        endDate: daysAgo(0),
        metrics: "videoThumbnailImpressions,videoThumbnailImpressionsClickRate",
        dimensions: "video",
        filters: `video==${chunk.join(",")}`,
        maxResults: chunk.length,
      });
      for (const row of res.data.rows || []) {
        const [videoId, impressions, ctr] = row;
        stats.set(videoId, { impressions: Number(impressions) || 0, ctr: Number(ctr) || 0 });
      }
    } catch (e) {
      explainIfScopeError(e);
      console.warn(`Analytics query failed for a batch of ${chunk.length} videos, skipping them:`, e.message);
    }
  }
  return stats;
}

async function main() {
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8"));
  } catch (e) {
    console.warn("No videos-manifest.json found yet, nothing to report on.");
    return;
  }

  const cutoffOld = new Date(daysAgo(MAX_AGE_DAYS));
  const cutoffYoung = new Date(daysAgo(MIN_AGE_DAYS));
  const eligible = (manifest.videos || []).filter((v) => {
    if (!v.thumbnail_variant || !v.video_id || !v.published_at) return false;
    const published = new Date(v.published_at);
    return published >= cutoffOld && published <= cutoffYoung;
  });

  console.log(`${eligible.length} videos eligible for the thumbnail report (variant tagged, ${MIN_AGE_DAYS}-${MAX_AGE_DAYS} days old).`);
  if (eligible.length === 0) {
    console.log("Nothing to analyze yet — leaving thumbnail-winner.json untouched.");
    return;
  }

  const stats = await fetchThumbnailStats(eligible.map((v) => v.video_id));

  const totals = { A: { impressions: 0, weightedCtr: 0 }, B: { impressions: 0, weightedCtr: 0 } };
  let matched = 0;
  for (const v of eligible) {
    const s = stats.get(v.video_id);
    if (!s || s.impressions === 0) continue;
    matched++;
    const bucket = totals[v.thumbnail_variant];
    if (!bucket) continue;
    bucket.impressions += s.impressions;
    bucket.weightedCtr += s.ctr * s.impressions; // weight each video's CTR by its own impressions
  }
  console.log(`Matched analytics data for ${matched}/${eligible.length} eligible videos.`);

  const summary = {};
  for (const variant of ["A", "B"]) {
    const t = totals[variant];
    summary[variant] = {
      impressions: t.impressions,
      ctr: t.impressions > 0 ? +(t.weightedCtr / t.impressions).toFixed(3) : 0,
    };
  }
  console.log("Variant summary:", summary);

  let winner = null;
  const enoughData = summary.A.impressions >= MIN_IMPRESSIONS_PER_VARIANT && summary.B.impressions >= MIN_IMPRESSIONS_PER_VARIANT;
  if (enoughData) {
    const lead = Math.abs(summary.A.ctr - summary.B.ctr);
    if (lead >= MIN_CTR_LEAD_POINTS) {
      winner = summary.A.ctr > summary.B.ctr ? "A" : "B";
    }
  }

  const result = {
    winner, // "A" | "B" | null — generate-video.js reads this directly
    decided_at: new Date().toISOString(),
    enough_data: enoughData,
    summary,
  };

  await fs.writeFile(WINNER_PATH, JSON.stringify(result, null, 2) + "\n");

  if (winner) {
    console.log(`Winner: variant ${winner} (CTR ${summary[winner].ctr}% vs ${summary[winner === "A" ? "B" : "A"].ctr}%). Locking it in.`);
  } else if (enoughData) {
    console.log("Enough data on both sides, but no clear lead — keeping the A/B rotation going.");
  } else {
    console.log("Not enough impressions on one or both variants yet — keeping the A/B rotation going.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
