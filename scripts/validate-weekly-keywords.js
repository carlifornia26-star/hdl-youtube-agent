import fs from "node:fs/promises";

const FILE = "keywords-weekly.json";
const MAX_TAG_LENGTH = 100;
const MAX_TAG_BUDGET = 460;
const MAX_REASONABLE_AGE_DAYS = 9; // this file only changes once a week, on Monday

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
  if (!Array.isArray(data.weeklyTop2)) fail("weeklyTop2 is missing or not an array.");

  const ageDays = (Date.now() - Date.parse(data.updatedAt)) / 86400000;
  if (ageDays < -1) fail("updatedAt is in the future.");
  if (ageDays > MAX_REASONABLE_AGE_DAYS) {
    console.warn(
      `WARNING: active weekly keyword file is ${ageDays.toFixed(1)} days old (expected to refresh every Monday). ` +
      "The daily uploader will continue using this last-known-good dataset."
    );
  }

  for (const term of [...data.fixed, ...data.weeklyTop2]) {
    if (typeof term !== "string") fail("a keyword term is not a string.");
    const clean = term.trim();
    if (!clean) fail("an empty keyword term was found.");
    if (clean.length > MAX_TAG_LENGTH) {
      console.warn(`Ignoring validation warning: a term is longer than the per-tag limit: ${clean.slice(0, 80)}...`);
    }
  }

  const estimatedFixed = [...data.fixed, ...data.weeklyTop2].map(String).join(",").length;
  if (estimatedFixed > MAX_TAG_BUDGET) {
    fail("fixed + weekly-2 keyword pool alone exceeds the safe video-tag budget.");
  }

  console.log("WEEKLY KEYWORDS VALIDATION: SUCCESS");
  console.log(`File: ${FILE}`);
  console.log(`Updated at: ${data.updatedAt}`);
  console.log(`Age: ${Math.max(0, ageDays).toFixed(2)} days`);
  console.log(`Fixed keywords: ${data.fixed.join(", ")}`);
  console.log(`This week's top 2: ${data.weeklyTop2.join(", ") || "(none)"}`);
} catch (error) {
  if (error.code === "ENOENT") fail(`${FILE} does not exist. Run the weekly keyword workflow first.`);
  fail(error.message);
         }
