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

export async function uploadVideo({ videoPath, title, description, tags, localizations }) {
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
      categoryId: "27", // Education
      defaultLanguage: "en",
    },
    status: {
      privacyStatus: isPrivate ? "private" : "public",
      selfDeclaredMadeForKids: false,
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
