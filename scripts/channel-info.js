// Read-only bounded audit. No insert/update/delete/generation calls.
import { getYoutubeClient } from './youtube.js';
const yt=getYoutubeClient();
const channel=String(process.env.CHANNEL_ID||'');
if(!['1','2','3','4'].includes(channel)) throw new Error('Invalid channel');
try {
 const c=(await yt.channels.list({part:['snippet','contentDetails'],mine:true})).data.items||[];
 if(c.length!==1) throw new Error('Expected one owner');
 const owner=c[0];
 const recent=(await yt.playlistItems.list({part:['contentDetails'],playlistId:owner.contentDetails.relatedPlaylists.uploads,maxResults:10})).data.items||[];
 const fixed={'1':['CoGTxUsn7MA','ofekIx2FINk'],'2':['jz0KWbvL2oQ','jQT0VwwkuUQ'],'3':[],'4':['gL5TS0mk6Mo','aT1TwuQ4V3E']}[channel];
 const ids=[...new Set([...fixed,...recent.map(x=>x.contentDetails.videoId)])];
 const videos=(await yt.videos.list({part:['snippet','status','contentDetails'],id:ids})).data.items||[];
 if(videos.some(v=>v.snippet.channelId!==owner.id)) throw new Error('Ownership mismatch');
 videos.sort((a,b)=>Number(fixed.includes(b.id))-Number(fixed.includes(a.id)));
 const rows=[];let reads=0;
 for(const v of videos){
  const row={id:v.id,title:v.snippet.title,channelId:v.snippet.channelId,status:v.status,duration:v.contentDetails.duration,heldId:fixed.includes(v.id)};
  if(v.status.privacyStatus==='private'&&reads<6){
   reads++;
   row.captions=((await yt.captions.list({part:['snippet'],videoId:v.id})).data.items||[]).map(x=>({id:x.id,language:x.snippet.language,status:x.snippet.status,isDraft:x.snippet.isDraft,trackKind:x.snippet.trackKind,failureReason:x.snippet.failureReason||null}));
  }
  rows.push(row);
 }
 console.log(JSON.stringify({mode:'read-only',at:new Date().toISOString(),channel,owner:{id:owner.id,title:owner.snippet.title,handle:owner.snippet.customUrl},videos:rows,captionReads:reads,missingIds:ids.filter(id=>!videos.some(v=>v.id===id))},null,2));
}catch(e){console.error(JSON.stringify({channel,error:String(e?.message||'audit failed').slice(0,240)}));process.exitCode=1;}
