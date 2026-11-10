// Maintenance script: put specific private videos back on the fixed daily schedule.
// Owner rule (2026-11-10): every video stays scheduled for the fixed daily slot - this
// script NEVER publishes immediately. It only touches the exact IDs passed in VIDEO_IDS;
// anything already public or already scheduled for the target is skipped. Safe to re-run.
//
// Env:
//   VIDEO_IDS            required, comma-separated YouTube video IDs to schedule
//   PUBLISH_AT           optional ISO timestamp (must be in the future); default = the next
//                        daily slot from PUBLISH_HOUR_UTC/PUBLISH_MINUTE_UTC
//   PUBLISH_HOUR_UTC     default 16 - fixed daily publish moment (matches daily-video.yml)
//   PUBLISH_MINUTE_UTC   default 0
import { getYoutubeClient, publishVideo } from "./youtube.js";

function nextDailySlot() {
  const hour = Number(process.env.PUBLISH_HOUR_UTC ?? 16);
  const minute = Number(process.env.PUBLISH_MINUTE_UTC ?? 0);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error("Invalid PUBLISH_HOUR_UTC/PUBLISH_MINUTE_UTC");
  }
  const now = new Date();
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0));
  if (target.getTime() <= now.getTime()) target.setUTCDate(target.getUTCDate() + 1);
  return target;
}

async function main() {
  const youtube = getYoutubeClient();
  const ids = String(process.env.VIDEO_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids.length) throw new Error("VIDEO_IDS is required - refusing to touch unspecified videos.");

  const publishAt = process.env.PUBLISH_AT ? new Date(process.env.PUBLISH_AT) : nextDailySlot();
  if (!Number.isFinite(publishAt.getTime())) throw new Error(`Invalid PUBLISH_AT: ${process.env.PUBLISH_AT}`);
  if (publishAt.getTime() <= Date.now()) {
    throw new Error(`PUBLISH_AT ${publishAt.toISOString()} is in the past - videos stay scheduled ahead, never late/immediate.`);
  }
  const publishAtIso = publishAt.toISOString();
  console.log(`Target schedule: ${publishAtIso} for ${ids.length} video(s): ${ids.join(", ")}`);

  const statusRes = await youtube.videos.list({ part: ["status"], id: ids });
  const found = new Map((statusRes.data.items || []).map((v) => [v.id, v.status || {}]));

  let scheduled = 0;
  let skipped = 0;
  let failed = 0;
  for (const id of ids) {
    const st = found.get(id);
    if (!st) {
      console.error(`${id}: not found on this account - skipping (wrong channel secrets?)`);
      failed++;
      continue;
    }
    if (st.privacyStatus !== "private") {
      console.log(`${id}: already ${st.privacyStatus} - skipping`);
      skipped++;
      continue;
    }
    if (st.publishAt && new Date(st.publishAt).getTime() === publishAt.getTime()) {
      console.log(`${id}: already scheduled for ${st.publishAt} - skipping`);
      skipped++;
      continue;
    }
    if (st.publishAt) {
      console.warn(`${id}: has existing publishAt ${st.publishAt}; resetting to ${publishAtIso} per explicit request`);
    }
    try {
      await publishVideo({ videoId: id, publishAt: publishAtIso });
      scheduled++;
    } catch (e) {
      failed++;
      console.error(`Failed to schedule ${id}: ${e.message}`);
    }
  }
  console.log(`Done. ${scheduled} scheduled for ${publishAtIso}, ${skipped} skipped, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1; // red X in Actions if anything is still stuck
}

main().catch((err) => {
  console.error("fix-private-videos.js crashed:", err);
  process.exitCode = 1;
});
