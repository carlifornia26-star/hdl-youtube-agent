import { google } from "googleapis";
import fs from "node:fs";

function oauth2Client() {
  const oauth2 = new google.auth.OAuth2(process.env.YT_CLIENT_ID, process.env.YT_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: process.env.YT_REFRESH_TOKEN });
  return oauth2;
}

function client() {
  return google.youtube({ version: "v3", auth: oauth2Client() });
}

// Separate client for the YouTube Analytics API (thumbnail-report.js) — same refresh token,
// but only works if it was minted with the yt-analytics.readonly scope added (see SETUP.md).
// A missing-scope call fails with a 403 "insufficient authentication scopes" error, which
// thumbnail-report.js catches and explains on its own.
export function analyticsClient() {
  return google.youtubeAnalytics({ version: "v2", auth: oauth2Client() });
}

// google-auth-library's own error for a dead refresh token is `GaxiosError: invalid_grant` with
// no video/upload-specific wording anywhere in it, buried under a huge dumped request/response
// object — easy to mistake for a one-off upload glitch instead of what it actually is: the
// YT_REFRESH_TOKEN secret is dead and EVERY call in this run (upload, thumbnail, captions) will
// fail the same way until it's replaced. This turns that into one unmissable line, logged before
// the original error is rethrown (so the full details are still there for debugging below it).
// Printed once per run (not once per caption language) via authErrorExplained.
let authErrorExplained = false;
function explainIfAuthError(err) {
  const reason = err?.response?.data?.error || err?.message || "";
  if (String(reason).includes("invalid_grant") && !authErrorExplained) {
    authErrorExplained = true;
    console.error(
      "\n*** YOUTUBE AUTH IS DEAD, NOT A ONE-OFF FAILURE ***\n" +
        "YT_REFRESH_TOKEN has expired or been revoked (Google shows this if the OAuth consent " +
        "screen is still in 'Testing' mode — those tokens expire after 7 days — or if access was " +
        "manually revoked). Every upload call this run will fail the same way. Fix: redo the " +
        "OAuth Playground flow in SETUP.md step 2.4 to mint a fresh refresh token, then update " +
        "the YT_REFRESH_TOKEN repo secret. If your OAuth consent screen is in Testing mode, " +
        "publish it (or add yourself as a permanent test user) so this stops recurring.\n"
    );
  }
}

export async function uploadVideo({ videoPath, title, description, tags, localizations, categoryId }) {
  const youtube = client();
  const isPrivate = process.env.DRY_RUN_PRIVATE === "true";

  // Drop any localization entries with an empty/blank title — an empty or malformed
  // localization entry is enough to make YouTube reject the whole request with the
  // generic "invalidVideoMetadata" error (no indication of which field caused it).
  const cleanLocalizations = Object.fromEntries(
    Object.entries(localizations || {}).filter(([, v]) => v?.title?.trim())
  );

  const requestBody = {
    snippet: {
      title,
      description,
      tags,
      categoryId: categoryId || "28", // Falls back to Science & Technology if a caller doesn't
      // pass one. Per-channel category now comes from generate-video.js (CATEGORY_ID, set from
      // CHANNEL_ID) — this hardcoded default only matters if this function is ever called
      // without that argument.
      defaultLanguage: "en", // matches Studio's "Title and description language: English"
      defaultAudioLanguage: "en", // matches Studio's "Video language: English". Without this,
      // uploads via the API show "0 languages" — defaultLanguage alone only tells YouTube the
      // text (title/description) is English; this is the field for the spoken audio track.
    },
    status: {
      privacyStatus: isPrivate ? "private" : "public",
      selfDeclaredMadeForKids: false,
      license: "youtube", // matches Studio's "Licence: Standard YouTube licence" (the other
      // option, "creativeCommon", is a separate CC BY licence you'd opt into explicitly)
    },
    localizations: cleanLocalizations,
  };

  try {
    const res = await youtube.videos.insert({
      part: ["snippet", "status", "localizations"],
      requestBody,
      media: { body: fs.createReadStream(videoPath) },
    });

    return res.data; // includes .id
  } catch (err) {
    explainIfAuthError(err);
    // err.message alone is just the generic top-level reason ("The request metadata is
    // invalid.") — Google's actual per-field detail lives in err.response.data.error (or
    // err.errors on older client versions). Logging that too is the difference between
    // guessing which field broke it and actually knowing.
    const apiError = err?.response?.data?.error || err?.errors || null;
    if (apiError) {
      console.error("uploadVideo failed. API error detail:\n", JSON.stringify(apiError, null, 2));
    }
    console.error("uploadVideo failed. requestBody was:\n", JSON.stringify(requestBody, null, 2));
    throw err;
  }
}

// Returns every application language YouTube itself supports (used by customize-channel.js to
// know what "all available languages" actually means — this is Google's own list, not a guess).
export async function listSupportedLanguages() {
  const youtube = client();
  const res = await youtube.i18nLanguages.list({ part: ["snippet"], hl: "en" });
  return (res.data.items || [])
    .map((l) => ({ code: l.id, name: l.snippet?.name }))
    .filter((l) => l.code);
}

export async function getMyChannelBranding() {
  const youtube = client();
  const res = await youtube.channels.list({
    part: ["snippet", "brandingSettings", "localizations"],
    mine: true,
  });
  const channel = res.data.items?.[0];
  if (!channel) throw new Error("No channel found for this account/token.");
  return channel;
}

// channels.update REPLACES the entire localizations object with whatever is sent — it does not
// merge — so callers must include every localization they want kept, not just the new/changed
// ones. Costs 50 quota units total regardless of how many languages are in the map (one call).
// A 403 with reason "quotaExceeded" means the day's YouTube Data API quota is used up. It has
// nothing to do with which locale keys were sent, it will fail identically no matter what's in
// the request, and retrying (or bisecting) just burns more of an already-empty quota. Tag it so
// callers can tell "the whole account is out of quota" apart from "one specific key is invalid."
//
// Checks BOTH the HTTP status and the reason string, and looks in every shape googleapis is
// known to put them in across versions (err.response.data.error.errors[0].reason is the modern
// gaxios shape; err.errors[0].reason is the older/alternate shape) — a mismatch in either would
// silently fall through to the "treat it like a bad locale" bisection path, which is exactly the
// bug this exists to prevent.
export function isQuotaExceeded(err) {
  const status = err?.response?.status ?? err?.code ?? err?.status;
  const errors = err?.response?.data?.error?.errors ?? err?.errors ?? [];
  const reason = errors?.[0]?.reason ?? "";
  return Number(status) === 403 && String(reason).toLowerCase() === "quotaexceeded";
}

export async function updateChannelLocalizations({ channelId, localizations }) {
  const youtube = client();
  try {
    const res = await youtube.channels.update({
      part: ["localizations"],
      requestBody: { id: channelId, localizations },
    });
    return res.data;
  } catch (err) {
    explainIfAuthError(err);
    const apiError = err?.response?.data?.error || err?.errors || null;
    if (apiError) {
      console.error("updateChannelLocalizations failed. API error detail:\n", JSON.stringify(apiError, null, 2));
    }
    err.isQuotaExceeded = isQuotaExceeded(err);
    throw err;
  }
}

// Post-update read-back verification (guide item E). A 200 OK from channels.update only means
// YouTube ACCEPTED the request — it does not guarantee every locale in it was actually stored.
// This re-fetches the channel directly from YouTube so callers can confirm what's really live,
// rather than trusting the update call's own success response.
export async function getChannelLocalizations(channelId) {
  const youtube = client();
  const res = await youtube.channels.list({
    part: ["snippet", "localizations"],
    id: [channelId],
  });
  const channel = res.data.items?.[0];
  if (!channel) {
    throw new Error(`Verification failed: channels.list returned no channel for id ${channelId}.`);
  }
  return channel.localizations || {};
}

// Sets the channel trailer shown to non-subscribers (Studio calls this "Channel trailer for
// new visitors"). This is a REAL, long-standing API field — unlike the Studio homepage
// "Featured video for returning subscribers" / Spotlight section, which has no Data API
// exposure at all and has to be set by hand in Studio, once, per channel.
//
// channels.update with part=brandingSettings replaces the whole brandingSettings.channel
// object, same overwrite trap as localizations (see updateChannelLocalizations above) — so
// this merges into whatever branding is already there instead of sending only unsubscribedTrailer.
export async function setChannelTrailer({ channelId, videoId, currentBranding }) {
  const youtube = client();
  const mergedChannelBranding = { ...(currentBranding?.channel || {}), unsubscribedTrailer: videoId };
  try {
    const res = await youtube.channels.update({
      part: ["brandingSettings"],
      requestBody: {
        id: channelId,
        brandingSettings: { channel: mergedChannelBranding },
      },
    });
    return res.data;
  } catch (err) {
    explainIfAuthError(err);
    const apiError = err?.response?.data?.error || err?.errors || null;
    if (apiError) {
      console.error("setChannelTrailer failed. API error detail:\n", JSON.stringify(apiError, null, 2));
    }
    err.isQuotaExceeded = isQuotaExceeded(err);
    throw err;
  }
}

export async function uploadThumbnail({ videoId, imagePath }) {
  const youtube = client();
  try {
    await youtube.thumbnails.set({
      videoId,
      media: { body: fs.createReadStream(imagePath) },
    });
  } catch (err) {
    explainIfAuthError(err);
    throw err;
  }
}

export async function uploadCaptionTrack({ videoId, language, srtPath, name }) {
  const youtube = client();
  // Retry: calling captions.insert immediately after videos.insert can fail with a
  // "video not found" style error because YouTube hasn't finished registering the upload yet.
  // This is a known timing race, not a real error — a short backoff clears it almost always.
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await youtube.captions.insert({
        part: ["snippet"],
        requestBody: {
          snippet: { videoId, language, name, isDraft: false },
        },
        media: { body: fs.createReadStream(srtPath) },
      });
      return;
    } catch (err) {
      lastErr = err;
      const isAuthDead = String(err?.response?.data?.error || err?.message || "").includes("invalid_grant");
      const isLast = attempt === 4 || isAuthDead; // no point retrying a dead token 4x per language
      console.warn(
        `captions.insert (${language}): attempt ${attempt}/4 failed${isLast ? "" : ", retrying"}: ${err.message}`
      );
      if (isLast) explainIfAuthError(err);
      if (!isLast) await new Promise((r) => setTimeout(r, 4000 * attempt)); // 4s, 8s, 12s
      if (isAuthDead) break;
    }
  }
  throw lastErr;
}

export async function createPlaylist({ title, description, localizations }) {
  const youtube = client();
  const cleanLocalizations = Object.fromEntries(
    Object.entries(localizations || {}).filter(([, v]) => v?.title?.trim())
  );
  try {
    const res = await youtube.playlists.insert({
      part: ["snippet", "status", "localizations"],
      requestBody: {
        snippet: { title, description, defaultLanguage: "en" },
        status: { privacyStatus: "public" },
        localizations: cleanLocalizations,
      },
    });
    return res.data; // includes .id
  } catch (err) {
    explainIfAuthError(err);
    const apiError = err?.response?.data?.error || err?.errors || null;
    if (apiError) {
      console.error("createPlaylist failed. API error detail:\n", JSON.stringify(apiError, null, 2));
    }
    err.isQuotaExceeded = isQuotaExceeded(err);
    throw err;
  }
}

export async function addVideoToPlaylist({ playlistId, videoId }) {
  const youtube = client();
  try {
    await youtube.playlistItems.insert({
      part: ["snippet"],
      requestBody: {
        snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } },
      },
    });
  } catch (err) {
    explainIfAuthError(err);
    err.isQuotaExceeded = isQuotaExceeded(err);
    throw err;
  }
}
