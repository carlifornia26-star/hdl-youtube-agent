import {TARGETS,scope,hash,buildUpdate,verifyAfter} from './metadata-repair-core.js';
const parts=['snippet','status','localizations','contentDetails'];
export async function runApply({yt,mode,channel,plans,write,reviewRecord}) {
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
  const before={}; const requests={};
  // Export all originals and preflight all channel plans before any update.
  for (const id of targets) {
    before[id]=await read(id);
    await write(`${id}-before.json`,before[id]);
    if (mode==='apply') requests[id]=buildUpdate(before[id],plans.find(p=>p.videoId===id));
  }
  for (const id of targets) {
    const current=await read(id);
    if (hash(current)!==hash(before[id])) throw new Error('Provider state drift before update');
    await write(`${id}-request.json`,requests[id]);
    // Never add snippet/status or reuse the upload/generation pipeline here.
    await yt.videos.update({part:['localizations'],requestBody:requests[id]}, {headers:{'If-Match':current.etag}});
    const after=await read(id);
    await write(`${id}-after.json`,after);
    verifyAfter(before[id],after,requests[id]);
    console.log(`Verified metadata-only update: ${id}`);
  }
}
