import { google } from "googleapis";
import fs from "node:fs";

function client() {
  const oauth2 = new google.auth.OAuth2(process.env.YT_CLIENT_ID, process.env.YT_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: process.env.YT_REFRESH_TOKEN });
  return google.youtube({ version: "v3", auth: oauth2 });
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
    console.error("uploadVideo failed. requestBody was:\n", JSON.stringify(requestBody, null, 2));
    throw err;
  }
}

export async function uploadThumbnail({ videoId, imagePath }) {
  const youtube = client();
  await youtube.thumbnails.set({
    videoId,
    media: { body: fs.createReadStream(imagePath) },
  });
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
      const isLast = attempt === 4;
      console.warn(
        `captions.insert (${language}): attempt ${attempt}/4 failed${isLast ? "" : ", retrying"}: ${err.message}`
      );
      if (!isLast) await new Promise((r) => setTimeout(r, 4000 * attempt)); // 4s, 8s, 12s
    }
  }
  throw lastErr;
}
