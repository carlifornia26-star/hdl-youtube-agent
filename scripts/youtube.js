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

  const res = await youtube.videos.insert({
    part: ["snippet", "status", "localizations"],
    requestBody: {
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
      localizations,
    },
    media: { body: fs.createReadStream(videoPath) },
  });

  return res.data; // includes .id
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
  await youtube.captions.insert({
    part: ["snippet"],
    requestBody: {
      snippet: { videoId, language, name, isDraft: false },
    },
    media: { body: fs.createReadStream(srtPath) },
  });
                         }
