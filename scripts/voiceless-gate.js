// Pre-publish voiceless gate predicate (extracted 2026-11-05 so the boundary is unit-testable).
// Semantics: a run is blocked when STRICTLY MORE than `threshold` of built scenes have no
// narration - exactly 20% voiceless still publishes (the historical behavior of the
// VOICE_FAILURE_THRESHOLD alert, preserved when the check moved before publishVideo).
export const VOICELESS_BLOCK_THRESHOLD = 0.2;

export function exceedsVoicelessThreshold(voicelessCount, totalScenes, threshold = VOICELESS_BLOCK_THRESHOLD) {
  if (!Number.isFinite(voicelessCount) || !Number.isFinite(totalScenes) || totalScenes < 0 || voicelessCount < 0) {
    throw new Error(`invalid voiceless accounting: ${voicelessCount}/${totalScenes}`);
  }
  if (totalScenes === 0) return false; // nothing built - the duration invariant fails first anyway
  return voicelessCount / totalScenes > threshold;
}
