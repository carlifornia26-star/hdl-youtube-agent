import { getMyChannelBranding, setChannelTrailer } from "./youtube.js";

// One-off / on-demand script (run via the "HDL Channel Trailer" workflow_dispatch — see
// .github/workflows/set-channel-trailer.yml). Sets the video shown to visitors who land on the
// channel and are NOT yet subscribed ("Channel trailer for new visitors" in Studio's
// Customization -> Basic info page).
//
// This does NOT touch the separate "Featured video for returning subscribers" (Spotlight)
// section on the Studio homepage — that one has no Data API field at all and can only be set
// by hand in Studio, once, per channel: Customization -> Home -> toggle on "Spotlight for
// returning subscribers" -> pick a video -> Save.
//
// Requires VIDEO_ID (the id from a youtube.com/watch?v=... URL) passed via env — see the
// workflow's workflow_dispatch input.

async function main() {
  const videoId = process.env.VIDEO_ID;
  if (!videoId) {
    console.error("VIDEO_ID env var is required (the video id from youtube.com/watch?v=<this part>).");
    process.exitCode = 1;
    return;
  }

  console.log("Fetching current channel branding...");
  const channel = await getMyChannelBranding();
  const channelId = channel.id;
  console.log(`Channel: "${channel.snippet.title}" (${channelId})`);

  const currentTrailer = channel.brandingSettings?.channel?.unsubscribedTrailer;
  if (currentTrailer) {
    console.log(`Current trailer: https://youtube.com/watch?v=${currentTrailer}`);
  } else {
    console.log("No trailer currently set.");
  }

  console.log(`Setting trailer to: https://youtube.com/watch?v=${videoId}`);
  try {
    await setChannelTrailer({ channelId, videoId, currentBranding: channel.brandingSettings });
    console.log("SUCCESS: Channel trailer updated.");
    console.log("Check it (logged out, or in an incognito tab) at: https://youtube.com/channel/" + channelId);
  } catch (e) {
    if (e.isQuotaExceeded) {
      console.error(
        "QUOTA FAILURE: YouTube Data API quotaExceeded. Wait for quota reset (midnight Pacific " +
          "Time) or use the correct project/quota, then re-run this workflow."
      );
      process.exitCode = 1;
      return;
    }
    throw e;
  }
}

main().catch((err) => {
  console.error("set-channel-trailer failed:", err?.response?.data?.error || err.message);
  process.exit(1);
});
