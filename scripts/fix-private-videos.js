// One-off maintenance script: finds every video in this channel's uploads that is currently
// private and publishes it, using the same (now retrying + verifying) publishVideo() from
// youtube.js. Run via the "Fix Private Videos" GitHub Actions workflow — safe to re-run any
// time; videos that are already public are skipped automatically.
import { getYoutubeClient, publishVideo } from "./youtube.js";

async function main() {
  const youtube = getYoutubeClient();

  const channelRes = await youtube.channels.list({ part: ["contentDetails"], mine: true });
  const uploadsPlaylistId = channelRes.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) {
    throw new Error("Could not find this channel's uploads playlist — check YT_REFRESH_TOKEN is for the right channel.");
  }

  let nextPageToken;
  const privateVideoIds = [];

  do {
    const playlistRes = await youtube.playlistItems.list({
      part: ["contentDetails"],
      playlistId: uploadsPlaylistId,
      maxResults: 50,
      pageToken: nextPageToken,
    });
    const ids = (playlistRes.data.items || []).map((i) => i.contentDetails.videoId);
    if (ids.length) {
      const statusRes = await youtube.videos.list({ part: ["status"], id: ids });
      for (const v of statusRes.data.items || []) {
        if (v.status?.privacyStatus === "private") privateVideoIds.push(v.id);
      }
    }
    nextPageToken = playlistRes.data.nextPageToken;
  } while (nextPageToken);

  console.log(`Found ${privateVideoIds.length} private video(s) on this channel.`);

  let succeeded = 0;
  let failed = 0;
  for (const id of privateVideoIds) {
    try {
      await publishVideo({ videoId: id });
      succeeded++;
    } catch (e) {
      failed++;
      console.error(`Failed to publish ${id}: ${e.message}`);
    }
  }

  console.log(`Done. ${succeeded} published, ${failed} still failing.`);
  if (failed > 0) process.exitCode = 1; // red X in Actions if anything is still stuck
}

main().catch((err) => {
  console.error("fix-private-videos.js crashed:", err);
  process.exitCode = 1;
});
