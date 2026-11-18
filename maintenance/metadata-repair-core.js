import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { validateUploadMetadata } from '../scripts/upload-metadata.js';
export const TARGETS = Object.freeze({
  G_H_scsEaos: {channel: '1', owner: 'UC60P1GSNEVPgtIentvSc45A'},
  GtSBugKsYVI: {channel: '1', owner: 'UC60P1GSNEVPgtIentvSc45A'},
  mp5wp6GTpAE: {channel: '1', owner: 'UC60P1GSNEVPgtIentvSc45A'},
  SadjccrotLo: {channel: '4', owner: 'UCZv9QcBMtyi4n2PkuxTCiPg'},
  '5WQRQqM8E2E': {channel: '4', owner: 'UCZv9QcBMtyi4n2PkuxTCiPg'},
});
export function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k)+':'+stable(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export const hash = value => crypto.createHash('sha256').update(stable(value)).digest('hex');
export function scope(video, channel, authenticatedIds) {
  const target = TARGETS[video?.id];
  assert(target && target.channel === channel, 'Video/channel not allowlisted');
  assert(target.owner, 'Expected owning channel not yet independently verified');
  assert.equal(video.snippet?.channelId, target.owner, 'Unexpected owning channel');
  assert(authenticatedIds.includes(target.owner), 'Credential does not own expected channel');
  assert(video.localizations && typeof video.localizations === 'object' && !Array.isArray(video.localizations), 'Missing raw localizations');
}
export function buildUpdate(before, plan) {
  assert.equal(plan.videoId, before.id, 'Plan video mismatch');
  assert.equal(plan.snapshotHash, hash(before), 'Snapshot hash mismatch');
  assert(Array.isArray(plan.changes) && plan.changes.length > 0, 'Empty changes');
  const localizations = structuredClone(before.localizations);
  const seen = new Set();
  for (const c of plan.changes) {
    assert(typeof c.locale === 'string' && Object.hasOwn(localizations,c.locale), 'Locale absent from raw provider map');
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
export function verifyAfter(before, after, request) {
  assert.equal(after.id,before.id,'Readback video mismatch');
  assert.deepEqual(after.localizations,request.localizations,'Full locale-map readback mismatch');
  for (const key of ['snippet','status','contentDetails']) assert.deepEqual(after[key],before[key],`Unrelated ${key} changed`);
}
