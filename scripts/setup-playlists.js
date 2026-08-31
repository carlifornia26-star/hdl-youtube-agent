import fs from "node:fs/promises";
import path from "node:path";
import { CATALOG } from "./catalog.js";
import { translateMeta, VIDEO_LANGS } from "./cf-ai.js";
import { createPlaylist } from "./youtube.js";

// CHANNEL_ID is passed in by the workflow (see hdl-setup-playlists.yml's workflow_dispatch
// input). Channel 1 keeps the original unsuffixed filename so its existing playlist history
// isn't disturbed; channels 2/3 get their own file so playlists don't overwrite each other.
const CHANNEL_ID = process.env.CHANNEL_ID || "1";
const PLAYLISTS_PATH = path.resolve(CHANNEL_ID === "1" ? "playlists.json" : `playlists-${CHANNEL_ID}.json`);

// Same fix as generate-video.js: Cloudflare's m2m100 model uses short codes (zh, es, fr...),
// but YouTube's localizations map requires proper BCP-47 tags and rejects some of them outright
// (plain "zh" in particular) — an unrecognized code fails the ENTIRE request with a generic
// error. This maps Cloudflare's code -> the YouTube-safe equivalent only where they differ.
const YT_LOCALE_MAP = {
  zh: "zh-Hans",
};

async function loadPlaylists() {
  try {
    return JSON.parse(await fs.readFile(PLAYLISTS_PATH, "utf8"));
  } catch {
    return {}; // first run — file doesn't exist yet
  }
}

// One-off / on-demand script (run via the "HDL Setup Playlists" workflow_dispatch, not on a
// daily cron — playlists only need creating once per book, not once per day). Creates one
// playlist per CATALOG entry, translated into the same 15 languages as the videos, and writes
// their IDs to playlists.json so generate-video.js can add each day's video to the right one.
// Safe to re-run any time you add a new book to CATALOG — existing playlists are skipped, not
// recreated, so this never spends quota or makes duplicates for books already set up.
async function main() {
  console.log(`Channel ${CHANNEL_ID} — using ${PLAYLISTS_PATH}`);
  const playlists = await loadPlaylists();
  let created = 0;
  let skipped = 0;
  let failed = 0; // non-quota failures — see the exit-code check below

  for (const book of CATALOG) {
    if (playlists[book.slug]) {
      console.log(`Skipping ${book.slug} — playlist already exists (${playlists[book.slug]}).`);
      skipped++;
      continue;
    }

    const title = `${book.title} — Teaser Videos | HDL Group`;
    const description = `Daily short teasers exploring ${book.angle}, based on the book "${book.title}" from HDL Group. Available exclusively on Google Play Books.`;

    const localizations = {};
    for (const lang of VIDEO_LANGS) {
      const ytLang = YT_LOCALE_MAP[lang] ?? lang;
      try {
        localizations[ytLang] = await translateMeta(title, description, lang);
      } catch (e) {
        console.warn(`Translation failed for ${book.slug}/${lang}, skipping:`, e.message);
      }
    }

    try {
      const playlist = await createPlaylist({ title, description, localizations });
      playlists[book.slug] = playlist.id;
      created++;
      console.log(`Created playlist for ${book.slug}: https://youtube.com/playlist?list=${playlist.id}`);
    } catch (e) {
      console.error(`Failed to create playlist for ${book.slug}:`, e.message);
      if (e.isQuotaExceeded) {
        console.error(
          "QUOTA FAILURE: YouTube Data API quota ran out — stopping here. Re-run this workflow " +
            "after quota resets (midnight Pacific Time) to pick up the remaining books."
        );
        break;
      }
      // Any other failure (auth, missing scope, bad request, etc.) is NOT expected/recoverable
      // the way a quota limit is — it means something is actually broken, and every remaining
      // book will almost certainly fail the same way. Track it so the run fails loudly instead
      // of silently reporting green with zero playlists created.
      failed++;
    }
  }

  await fs.writeFile(PLAYLISTS_PATH, JSON.stringify(playlists, null, 2) + "\n");
  console.log(`Done. ${created} created, ${skipped} skipped, ${failed} failed. Wrote ${PLAYLISTS_PATH}.`);

  // Previously this script always exited 0 as long as main() itself didn't throw — meaning a
  // systemic problem (e.g. a refresh token minted with the wrong OAuth scope) that made EVERY
  // createPlaylist() call fail still produced a green GitHub Actions check, because the
  // per-book try/catch above swallows the error and just moves to the next book. If nothing
  // got created and at least one attempt genuinely failed, fail the run so it shows red instead
  // of silently doing nothing.
  if (created === 0 && failed > 0) {
    console.error(
      `\n*** ALL ${failed} PLAYLIST CREATION ATTEMPT(S) FAILED — likely an auth/permission ` +
        "issue (e.g. the refresh token for this channel was minted without the full YouTube " +
        "write scope, not just the upload scope), not a fluke. See the per-book error(s) above " +
        "for the actual API error detail. ***\n"
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("setup-playlists failed:", err?.response?.data?.error || err.message);
  process.exit(1);
});
