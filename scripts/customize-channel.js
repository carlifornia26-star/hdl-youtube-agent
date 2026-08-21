import { translateMeta } from "./cf-ai.js";
import { listSupportedLanguages, getMyChannelBranding, updateChannelLocalizations, getChannelLocalizations } from "./youtube.js";

// One-off / on-demand script (run via the "HDL Channel Localization" workflow_dispatch, not on
// a daily cron — the channel name and description don't change often, so there's no reason to
// re-translate them every day). Run it again any time you change the channel's default (English)
// name or description in Studio, so the translations catch up.
//
// What "channel name" actually means here: the channel's DEFAULT title comes from the Google/
// Brand Account and can't be changed via this API at all (only manually in Studio's Basic info
// page) — but a PER-LANGUAGE override IS settable via channels.update's localizations map, which
// is exactly what shows a translated name+description to a viewer whose YouTube language matches
// that code. That's what this script sets, for every language YouTube's i18nLanguages.list
// reports as supported.

const CHANNEL_DESCRIPTION_MAX = 1000; // YouTube channel "About" description hard cap (videos allow 5000; channels don't)

// m2m100 (Cloudflare's translation model) doesn't recognize YouTube's regional/script subtags
// (pt-BR, zh-Hans, es-419, etc.) — strip to the base language for the TRANSLATION call only.
// The full YouTube code from i18nLanguages.list is still what's used as the localizations key,
// so viewers on that exact locale still match correctly.
function baseLangForTranslation(ytCode) {
  return ytCode.split(/[-_]/)[0];
}

// Read-back verification (fix guide item E). channels.update returning 200 only means YouTube
// ACCEPTED the request — it does NOT prove every locale was actually stored. This re-fetches the
// channel from YouTube and checks each requested locale is really there before anything is
// reported as a success. Returns the list of locale codes that are missing (empty = fully verified).
async function verifySaved(channelId, requestedLocalizations) {
  const saved = await getChannelLocalizations(channelId);
  const requested = Object.keys(requestedLocalizations);
  return requested.filter((code) => !saved[code]);
}

async function main() {
  console.log("Fetching current channel branding...");
  const channel = await getMyChannelBranding();
  const channelId = channel.id;
  const defaultTitle = channel.snippet.title;
  const defaultDescription = (channel.brandingSettings?.channel?.description || "").trim();
  console.log(`Channel: "${defaultTitle}" (${channelId})`);
  console.log(`Current description (${defaultDescription.length} chars): ${defaultDescription.slice(0, 120)}${defaultDescription.length > 120 ? "..." : ""}`);
  if (!defaultDescription) {
    console.warn("No channel description set yet — set one in Studio's Basic info page first, then re-run this.");
  }

  console.log("Fetching YouTube's supported application language list...");
  const languages = (await listSupportedLanguages()).filter((l) => l.code.toLowerCase() !== "en");
  console.log(`YouTube reports ${languages.length} supported languages (besides English, which stays as the default).`);

  // channels.update REPLACES the whole localizations object, so start from what's already
  // there (e.g. a previous run, or entries set by hand in Studio) instead of discarding it.
  const localizations = { ...(channel.localizations || {}) };

  let translated = 0;
  let skipped = 0;
  for (const { code, name } of languages) {
    const mtLang = baseLangForTranslation(code);
    try {
      const t = await translateMeta(defaultTitle, defaultDescription, mtLang);
      localizations[code] = {
        title: t.title,
        description: t.description.slice(0, CHANNEL_DESCRIPTION_MAX),
      };
      translated++;
      console.log(`  done: ${code} (${name})`);
    } catch (e) {
      skipped++;
      console.warn(`  skip: ${code} (${name}) — ${e.message}`);
    }
  }
  console.log(`Translated ${translated} languages, skipped ${skipped}.`);

  console.log("Sending localizations to YouTube (channels.update)...");
  try {
    await updateChannelLocalizations({ channelId, localizations });
    console.log("API accepted the update — verifying by reading the channel back from YouTube...");

    const missing = await verifySaved(channelId, localizations);
    if (missing.length) {
      console.error(
        `VERIFICATION FAILURE: YouTube accepted the update response, but read-back ` +
          `verification found ${missing.length} missing locale(s): ${missing.join(", ")}. ` +
          "Do not trust the update call's own success response — check the API response and " +
          "channel state before assuming these are live."
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      `SUCCESS: Localization update succeeded and was verified on YouTube — ` +
        `${Object.keys(localizations).length} language(s) confirmed present.`
    );
    console.log("Check it: Studio -> Customization -> Basic info -> language dropdown at the top.");
  } catch (e) {
    // Quota exhaustion fails identically no matter which keys are sent — retrying or probing
    // learns nothing from it and just spends more quota you don't have. Stop here.
    if (e.isQuotaExceeded) {
      console.error(
        "QUOTA FAILURE: Localization was not changed because YouTube Data API quotaExceeded. " +
          "None of the language codes are actually invalid — the bulk update simply couldn't go " +
          "through today. Wait for quota reset (midnight Pacific Time) or use the correct Google " +
          "Cloud project/quota, then re-run this workflow."
      );
      process.exitCode = 1;
      return;
    }

    // No locale-by-locale bisection here on purpose: hunting for a single bad key by trial and
    // error costs one full channels.update call (50 quota units) per trial, and recursively
    // bisecting ~75+ languages can run to 100+ trial calls — enough to exhaust a day's quota by
    // itself chasing down one bad key. updateChannelLocalizations() already logs the full API
    // error detail (including, for a genuine invalid-locale rejection, whatever YouTube reports)
    // before this is thrown — check that log output above to see exactly what YouTube objected
    // to, fix it by hand, and re-run once quota allows.
    console.error(
      "UPDATE FAILURE: channels.update was rejected for a non-quota reason. See the API error " +
        "detail logged above (from updateChannelLocalizations) for what YouTube actually " +
        "objected to. No automatic locale-by-locale retry is attempted, since that can burn " +
        "through a day's quota chasing a single bad key."
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("customize-channel failed:", err?.response?.data?.error || err.message);
  process.exit(1);
});
