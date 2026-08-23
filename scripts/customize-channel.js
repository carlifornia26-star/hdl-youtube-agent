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
    await updateChannelLocalizations({ channelId, localizations, title: defaultTitle, description: defaultDescription });
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
    // Quota exhaustion fails identically no matter which keys are sent — bisecting can't learn
    // anything from it, and every bisection call spends more quota you don't have, which is how
    // a single quota error turns into dozens of languages wrongly logged as "rejected." Stop here.
    if (e.isQuotaExceeded) {
      console.error(
        "QUOTA FAILURE: Localization was not changed because YouTube Data API quotaExceeded. " +
          "None of the language codes are actually invalid — the bulk update simply couldn't go " +
          "through today. Wait for quota reset (midnight Pacific Time) or use the correct Google " +
          "Cloud project/quota, then re-run this workflow. Do not bisect or test individual " +
          "locales off the back of this error."
      );
      process.exitCode = 1;
      return;
    }

    console.warn("Bulk update rejected. Bisecting to find which locale key(s) YouTube won't accept...");
    const base = { ...(channel.localizations || {}) }; // last known-good state, applied incrementally below
    const newKeys = Object.keys(localizations).filter((k) => !(k in base));
    const bad = [];
    let quotaHitMidBisect = false;

    async function bisect(keys) {
      if (keys.length === 0 || quotaHitMidBisect) return;
      const trial = { ...base };
      for (const k of keys) trial[k] = localizations[k];
      try {
        await updateChannelLocalizations({ channelId, localizations: trial, title: defaultTitle, description: defaultDescription });
        Object.assign(base, trial); // this subset is clean — keep it applied and move on
      } catch (trialErr) {
        // Quota can run out mid-bisection too (each trial call still costs units). Stop instead
        // of continuing to misattribute quota failures to whatever keys happen to be left.
        if (trialErr.isQuotaExceeded) {
          quotaHitMidBisect = true;
          return;
        }
        if (keys.length === 1) {
          bad.push(keys[0]);
          return;
        }
        const mid = Math.ceil(keys.length / 2);
        await bisect(keys.slice(0, mid));
        await bisect(keys.slice(mid));
      }
    }

    await bisect(newKeys);

    // Verify whatever `base` claims succeeded against what YouTube actually has, rather than
    // trusting the bisection trial calls' own success responses.
    const appliedCount = Object.keys(base).length - Object.keys(channel.localizations || {}).length;
    const stillMissing = appliedCount > 0 ? await verifySaved(channelId, base) : [];

    if (quotaHitMidBisect) {
      console.error(
        "QUOTA FAILURE: YouTube Data API quota ran out partway through bisection — stopping here. " +
          `${appliedCount} language(s) were accepted before that; the rest are still untested, not ` +
          "confirmed bad. Re-run after quota resets (midnight Pacific Time)."
      );
    } else if (bad.length) {
      console.error(`Rejected locale key(s): ${bad.join(", ")} — YouTube's channels.update won't accept these as localization keys.`);
      console.log(`${appliedCount} other new language(s) were accepted by the bisection trial calls.`);
    } else {
      console.error("VERIFICATION FAILURE: Bisection found no single bad key — likely a transient error. Re-run the workflow.");
    }

    if (stillMissing.length) {
      console.error(
        `VERIFICATION FAILURE: Of the ${appliedCount} language(s) the bisection calls reported as ` +
          `accepted, ${stillMissing.length} are NOT present on read-back: ${stillMissing.join(", ")}. ` +
          "Do not trust an accepted response alone."
      );
    } else if (appliedCount > 0) {
      console.log(`Verified: ${appliedCount} language(s) from the bisection recovery are confirmed present on YouTube.`);
    }

    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("customize-channel failed:", err?.response?.data?.error || err.message);
  process.exit(1);
});
