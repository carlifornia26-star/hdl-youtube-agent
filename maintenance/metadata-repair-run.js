import {TARGETS,scope} from './metadata-repair-core.js';
const parts=['snippet','status','localizations','contentDetails'];
export async function run({yt,mode,channel,write}) {
  if (mode!=='export' || !['1','4'].includes(channel)) throw new Error('Export only; apply is disabled');
  const identity=await yt.channels.list({part:['id'],mine:true});
  const ids=(identity.data.items||[]).map(c=>c.id);
  const targets=Object.keys(TARGETS).filter(id=>TARGETS[id].channel===channel);
  for (const id of targets) {
    const result=await yt.videos.list({id:[id],part:parts});
    if (result.data.items?.length!==1) throw new Error('Missing or ambiguous video');
    const item=result.data.items[0];scope(item,channel,ids);
    await write(`${id}-before.json.enc`,item);
  }
  console.log('Verified raw metadata encrypted for private offline review. No API writes.');
}
