import { translateMeta } from "./cf-ai.js";
import { listSupportedLanguages, getMyChannelBranding, updateChannelLocalizations } from "./youtube.js";

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
  await updateChannelLocalizations({ channelId, localizations });
  console.log(`Done — channel name + description now localized into ${Object.keys(localizations).length} languages.`);
  console.log("Check it: Studio -> Customization -> Basic info -> language dropdown at the top.");
}

main().catch((err) => {
  console.error("customize-channel failed:", err?.response?.data?.error || err.message);
  process.exit(1);
});
