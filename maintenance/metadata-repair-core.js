import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { validateUploadMetadata } from '../scripts/upload-metadata.js';
export const TARGETS = Object.freeze({
  // All four completed repairs excluded. Only the untouched channel4 target remains.
  '5WQRQqM8E2E': {channel: '4', owner: 'UCZv9QcBMtyi4n2PkuxTCiPg'},
});
export function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k)+':'+stable(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export const hash = value => crypto.createHash('sha256').update(stable(value)).digest('hex');
export function snapshotHash(resource) {
  const projected=structuredClone(resource);
  delete projected.etag; // Only top-level provider response token, never nested fields.
  return hash(projected);
}
export function scope(video, channel, authenticatedIds) {
  const target = TARGETS[video?.id];
  assert(target && target.channel === channel, 'Video/channel not allowlisted');
  assert(target.owner, 'Expected owning channel not yet independently verified');
  assert.equal(video.snippet?.channelId, target.owner, 'Unexpected owning channel');
  assert(authenticatedIds.includes(target.owner), 'Credential does not own expected channel');
  assert(video.localizations && typeof video.localizations === 'object' && !Array.isArray(video.localizations), 'Missing raw localizations');
}
// Binds a plan entry to its approved intended end-state, computed offline from
// the retained approved before-resource plus exactly the reviewed changes.
// Used to recognize an already-correct current map WITHOUT weakening any gate.
export function assertIntendedBinding(plan) {
  assert(typeof plan.intendedSnapshotHash==='string' && /^[0-9a-f]{64}$/.test(plan.intendedSnapshotHash),'Missing approved intended snapshot binding');
  assert.notEqual(plan.intendedSnapshotHash,plan.snapshotHash,'No-op repair plan');
}
export function buildUpdate(before, plan) {
  assert.equal(plan.videoId, before.id, 'Plan video mismatch');
  assertIntendedBinding(plan);
  assert.equal(plan.snapshotHash, snapshotHash(before), 'Snapshot hash mismatch');
  assert(Array.isArray(plan.changes) && plan.changes.length > 0, 'Empty changes');
  const localizations = structuredClone(before.localizations);
  const seen = new Set();
  for (const c of plan.changes) {
    assert(typeof c.locale === 'string' && Object.hasOwn(localizations,c.locale), 'Locale absent from raw provider map');
    assert(!/^en(?:-|$)/i.test(c.locale), 'English localizations are outside repair scope');
    assert(!seen.has(c.locale), 'Repeated locale'); seen.add(c.locale);
    assert(!(before.id === 'GtSBugKsYVI' && c.locale === 'fr'), 'Borderline French improvement explicitly excluded');
    assert.equal(c.review?.status,'source-fidelity-reviewed','Translation review missing');
    assert(typeof c.review?.evidence === 'string' && c.review.evidence.length > 0,'Review evidence missing');
    const old = localizations[c.locale];
    assert.equal(hash(old), c.originalHash, 'Original localized pair changed');
    assert(typeof c.tail === 'string' && c.tail.length > 0 && old.description.endsWith(c.tail), 'Exact raw tail not identified');
    assert.equal(hash(c.tail),c.tailHash,'Tail hash mismatch');
    assert(typeof c.originalHook === 'string' && old.description === c.originalHook + c.tail,'Ambiguous hook boundary');
    assert(typeof c.title === 'string' && typeof c.hook === 'string','Invalid proposed fields');
    const next = {...old, title:c.title, description:c.hook + c.tail};
    assert(next.title !== old.title || next.description !== old.description,'No-op repair');
    localizations[c.locale] = next;
  }
  // This boundary validates shape, not translation meaning.
  validateUploadMetadata({title: before.snippet.title, description: before.snippet.description, localizations});
  return {id:before.id,localizations};
}
// Classifies the post-write readback without throwing: only 'confirmed' may
// proceed to another write. Any divergence or an unavailable readback is an
// UNCONFIRMED outcome: the runner stops, retains evidence and never retries.
export function classifyAfter(before, after, request) {
  const divergences=[];
  if (after.id!==before.id) divergences.push('video-id');
  if (JSON.stringify(stable(after.localizations))!==JSON.stringify(stable(request.localizations))) divergences.push('localizations');
  for (const key of ['snippet','status','contentDetails']) {
    if (JSON.stringify(stable(after[key]))!==JSON.stringify(stable(before[key]))) divergences.push(key);
  }
  return {confirmed:divergences.length===0,divergences};
}
export function verifyAfter(before, after, request) {
  const v=classifyAfter(before,after,request);
  assert(v.confirmed,`Readback mismatch: ${v.divergences.join(',')}`);
}
