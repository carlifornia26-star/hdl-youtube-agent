import {TARGETS,scope,hash,snapshotHash,buildUpdate,classifyAfter,stable,assertIntendedBinding} from './metadata-repair-core.js';
const parts=['snippet','status','localizations','contentDetails'];

export async function runApply({yt,mode,channel,plans,write,reviewRecord,log=()=>{}}) {
  if (mode!=='apply' || !['1','4'].includes(channel)) throw new Error('Invalid mode or channel');
  if (!reviewRecord || reviewRecord.scope !== 'five-video-faults-only') throw new Error('Missing independently reviewed manifest');
  if (!Array.isArray(plans)) throw new Error('Private plan missing');
  for (const id of Object.keys(TARGETS).filter(id=>TARGETS[id].channel===channel)) {
    const entry=plans.find(p=>p.videoId===id);
    if (!entry || !Array.isArray(entry.changes) || entry.changes.length===0) throw new Error('Complete channel repair plan required');
    const expected=reviewRecord.videos?.[id];
    if (!expected || expected.status!=='all-required-changes-cleared') throw new Error('Channel has pending source-fidelity review');
    if (hash(entry)!==expected.planHash) throw new Error('Private plan does not match independent clearance');
  }
  const identity=await yt.channels.list({part:['id'],mine:true});
  const ids=(identity.data.items||[]).map(c=>c.id);
  const targets=Object.keys(TARGETS).filter(id=>TARGETS[id].channel===channel);

  if (mode==='apply' && (!Array.isArray(plans) || plans.length!==targets.length || new Set(plans.map(p=>p.videoId)).size!==targets.length || plans.some(p=>!targets.includes(p.videoId)))) throw new Error('Plan must exactly cover allowlisted channel targets');
  const read=async id=>{
    const result=await yt.videos.list({id:[id],part:parts});
    if (result.data.items?.length!==1) throw new Error('Missing or ambiguous video result');
    const item=result.data.items[0];scope(item,channel,ids);return item;
  };
  const before={}; const requests={}; const alreadyCorrect={};
  // Export all originals and preflight all channel plans before any update.
  for (const id of targets) {
    before[id]=await read(id);
    await write(`${id}-before.json`,before[id]);
    const plan=plans.find(p=>p.videoId===id);
    // Skip only on the APPROVED intended end-state, bound at plan time from the
    // retained approved before-resource plus exactly the reviewed changes: any
    // unrelated-locale, snippet, status, contentDetails or locale-set drift is
    // caught by this full snapshot comparison, never bypassed.
    assertIntendedBinding(plan);
    alreadyCorrect[id]=snapshotHash(before[id])===plan.intendedSnapshotHash;
    if (mode==='apply' && !alreadyCorrect[id]) requests[id]=buildUpdate(before[id],plan);
  }
  for (const id of targets) {
    const plan=plans.find(p=>p.videoId===id);
    const current=await read(id);
    if (snapshotHash(current)!==snapshotHash(before[id])) throw new Error('Provider state drift before update');
    if (alreadyCorrect[id]) {
      // Lag-safe skip: never rewrite values already in effect. Drift after the
      // preflight read is caught by the snapshot gate above; re-check against
      // the approved intended end-state across ALL preserved fields.
      if (snapshotHash(current)!==plan.intendedSnapshotHash) throw new Error('Provider state drift before update');
      await write(`${id}-request.json`,{videoId:id,skipped:'already-correct'});
      log(`No write needed, current map already matches reviewed plan: ${id}`);
      continue;
    }
    await write(`${id}-request.json`,requests[id]);
    // Conditional write requires a genuine fresh etag from THIS read; the
    // snapshot projection deliberately strips it, so guard it explicitly.
    if (typeof current.etag!=='string'||!current.etag) throw new Error('Missing fresh etag for conditional write');
    // Never add snippet/status or reuse the upload/generation pipeline here.
    let updateRes;
    try {
      updateRes=await yt.videos.update({part:['localizations'],requestBody:requests[id]}, {headers:{'If-Match':current.etag}});
    } catch (e) {
      // Every attempted PUT whose outcome is not positively confirmed stays
      // UNCONFIRMED: a non-success response, transport, body-read or parse
      // failure proves NOTHING about provider effect. Full raw body is sealed
      // where one was received; a body-read failure keeps status + a truthful
      // unavailable marker. Stops the run; no retry, no invented acceptance.
      await write(`${id}-update-response.json`,{videoId:id,outcome:'update-error',receivedAt:e.receivedAt??new Date().toISOString(),status:e.apiStatus??null,reason:e.apiReason??null,body:e.apiBody??null,bodyUnavailable:e.bodyReadFailed===true,phase:e.phase??'unknown',uncertain:true});
      log(`Update outcome UNCONFIRMED for ${id} (non-success or unreadable response; provider effect not confirmed); stopped, no further writes, no retry.`);
      throw e;
    }
    await write(`${id}-update-response.json`,{videoId:id,receivedAt:updateRes.receivedAt??new Date().toISOString(),status:updateRes.status??null,body:updateRes.data??null,rawBody:updateRes.rawBody??null});
    let after;
    try {
      after=await read(id);
    } catch (e) {
      await write(`${id}-after.json`,{videoId:id,outcome:'readback-error',receivedAt:e.receivedAt??new Date().toISOString(),status:e.apiStatus??null,reason:e.apiReason??null,body:e.apiBody??null,bodyUnavailable:e.bodyReadFailed===true,phase:e.phase??'unknown'});
      log(`UNCONFIRMED (readback unknown) for ${id}; stopped, no further writes, no retry.`);
      throw new Error('Unconfirmed update outcome: readback unavailable');
    }
    await write(`${id}-after.json`,after);
    const verdict=classifyAfter(current,after,requests[id]);
    if (!verdict.confirmed) {
      log(`UNCONFIRMED (readback diverged: ${verdict.divergences.join('/')}) for ${id}; stopped, no further writes, no retry.`);
      throw new Error('Unconfirmed update outcome: readback diverged');
    }
    log(`Verified metadata-only update: ${id}`);
  }
}
