import fs from "node:fs/promises";

const FILE = "keywords-daily.json";
const MAX_TAG_LENGTH = 100;
const MAX_REASONABLE_AGE_HOURS = 30; // this file is expected to refresh every day at 5pm SAST

function fail(message) {
  console.error(`DAILY KEYWORDS VALIDATION FAILED: ${message}`);
  process.exit(1);
}

try {
  const raw = await fs.readFile(FILE, "utf8");
  const data = JSON.parse(raw);

  if (!data || typeof data !== "object") fail("file is not a JSON object.");
  if (!data.updatedAt || Number.isNaN(Date.parse(data.updatedAt))) {
    fail("updatedAt is missing or invalid.");
  }

  if (!Array.isArray(data.dailyRest)) fail("dailyRest is missing or not an array.");
  if (!Array.isArray(data.googleTrendsApprox)) fail("googleTrendsApprox is missing or not an array.");
  if (!Array.isArray(data.youtubeTopTermsFlat)) fail("youtubeTopTermsFlat is missing or not an array.");
  if (!data.youtubeTopTermsByCountry || typeof data.youtubeTopTermsByCountry !== "object") {
    fail("youtubeTopTermsByCountry is missing or invalid.");
  }

  const ageHours = (Date.now() - Date.parse(data.updatedAt)) / 3600000;
  if (ageHours < -2) fail("updatedAt is in the future.");
  if (ageHours > MAX_REASONABLE_AGE_HOURS) {
    console.warn(
      `WARNING: active daily keyword file is ${ageHours.toFixed(1)} hours old (expected to refresh every day at ` +
      "5pm SAST). The uploader will continue using this last-known-good dataset."
    );
  }

  for (const term of data.dailyRest) {
    if (typeof term !== "string") fail("a dailyRest term is not a string.");
    const clean = term.trim();
    if (!clean) fail("an empty dailyRest term was found.");
    if (clean.length > MAX_TAG_LENGTH) {
      console.warn(`Ignoring validation warning: a source term is longer than the per-tag limit: ${clean.slice(0, 80)}...`);
    }
  }

  console.log("DAILY KEYWORDS VALIDATION: SUCCESS");
  console.log(`File: ${FILE}`);
  console.log(`Updated at: ${data.updatedAt}`);
  console.log(`Age: ${Math.max(0, ageHours).toFixed(2)} hours`);
  console.log(`dailyRest terms: ${data.dailyRest.length}`);
  console.log(`YouTube markets with data: ${
    Object.values(data.youtubeTopTermsByCountry).filter((v) => Array.isArray(v) && v.length > 0).length
  }`);
} catch (error) {
  // No daily file yet is tolerated (e.g. very first run before the daily workflow has ever
  // fired) — generate-video.js already treats a missing keywords-daily.json as "no daily terms
  // yet", not a failure, so this preflight warns instead of blocking the day's upload.
  if (error.code === "ENOENT") {
    console.warn(`WARNING: ${FILE} does not exist yet — proceeding without today's daily trending terms.`);
    process.exit(0);
  }
  fail(error.message);
}
