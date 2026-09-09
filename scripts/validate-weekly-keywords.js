import fs from "node:fs/promises";

const FILE = "keywords-weekly.json";
const MAX_CHANNEL_KEYWORDS = 500;
const MAX_TAG_LENGTH = 100;
const MAX_TAG_BUDGET = 460;
const MAX_REASONABLE_AGE_DAYS = 14;

function fail(message) {
  console.error(`WEEKLY KEYWORDS VALIDATION FAILED: ${message}`);
  process.exit(1);
}

try {
  const raw = await fs.readFile(FILE, "utf8");
  const data = JSON.parse(raw);

  if (!data || typeof data !== "object") fail("file is not a JSON object.");
  if (!data.updatedAt || Number.isNaN(Date.parse(data.updatedAt))) {
    fail("updatedAt is missing or invalid.");
  }

  if (!Array.isArray(data.fixed)) fail("fixed is missing or not an array.");
  if (!Array.isArray(data.googleTrendsApprox)) fail("googleTrendsApprox is missing or not an array.");
  if (!Array.isArray(data.youtubeTopTermsFlat)) fail("youtubeTopTermsFlat is missing or not an array.");
  if (!data.youtubeTopTermsByCountry || typeof data.youtubeTopTermsByCountry !== "object") {
    fail("youtubeTopTermsByCountry is missing or invalid.");
  }

  if (typeof data.channelKeywordsString !== "string" || !data.channelKeywordsString.trim()) {
    fail("channelKeywordsString is missing or empty.");
  }

  if (data.channelKeywordsString.length > MAX_CHANNEL_KEYWORDS) {
    fail(`channelKeywordsString is ${data.channelKeywordsString.length} characters; maximum is ${MAX_CHANNEL_KEYWORDS}.`);
  }

  const ageDays = (Date.now() - Date.parse(data.updatedAt)) / 86400000;
  if (ageDays < -1) fail("updatedAt is in the future.");
  if (ageDays > MAX_REASONABLE_AGE_DAYS) {
    console.warn(
      `WARNING: active keyword file is ${ageDays.toFixed(1)} days old. ` +
      "The daily uploader will continue using this last-known-good dataset."
    );
  }

  const allTrending = [
    ...data.googleTrendsApprox,
    ...data.youtubeTopTermsFlat,
    ...Object.values(data.youtubeTopTermsByCountry).flat(),
  ];

  for (const term of allTrending) {
    if (typeof term !== "string") fail("a trending term is not a string.");
    const clean = term.trim();
    if (!clean) fail("an empty trending term was found.");
    if (clean.length > MAX_TAG_LENGTH) {
      console.warn(`Ignoring validation warning: a source term is longer than the per-tag limit: ${clean.slice(0, 80)}...`);
    }
  }

  const estimatedFixed = data.fixed.map(String).join(",").length;
  if (estimatedFixed > MAX_TAG_BUDGET) {
    fail("fixed keyword pool alone exceeds the safe video-tag budget.");
  }

  console.log("WEEKLY KEYWORDS VALIDATION: SUCCESS");
  console.log(`File: ${FILE}`);
  console.log(`Updated at: ${data.updatedAt}`);
  console.log(`Age: ${Math.max(0, ageDays).toFixed(2)} days`);
  console.log(`Channel keyword characters: ${data.channelKeywordsString.length}/${MAX_CHANNEL_KEYWORDS}`);
  console.log(`Google trend terms: ${data.googleTrendsApprox.length}`);
  console.log(`YouTube flattened terms: ${data.youtubeTopTermsFlat.length}`);
  console.log(`YouTube markets with data: ${
    Object.values(data.youtubeTopTermsByCountry).filter((v) => Array.isArray(v) && v.length > 0).length
  }`);
} catch (error) {
  if (error.code === "ENOENT") fail(`${FILE} does not exist. Run the weekly keyword workflow first.`);
  fail(error.message);
}
