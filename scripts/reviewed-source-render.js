// Private reviewed-source branch. This module has no YouTube or account integrations.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
async function probe(p){return JSON.parse((await exec('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type,nb_frames,r_frame_rate','-of','json',p])).stdout);}
async function verified(p,sha){const b=await fs.readFile(p);if(crypto.createHash('sha256').update(b).digest('hex')!==sha)throw Error(`Reviewed bytes changed: ${p}`);}
export async function renderReviewedPrivate({manifestPath,outDir}){
 const m=JSON.parse(await fs.readFile(manifestPath,'utf8'));const base=path.dirname(path.resolve(manifestPath));const dest=path.resolve(outDir);await fs.mkdir(dest,{recursive:true});
 if(m.mode!=='private-review'||m.publishEligible!==false)throw Error('This source lane only supports private local review; publication forbidden');
 if(!m.topic||!Array.isArray(m.scenes)||!m.scenes.length)throw Error('Missing topic/source scenes');
 const reviews=['rightsReviewed','relevanceReviewed','pixelsReviewed','audioReviewed'];let frames=0,pexelsFrames=0;const ledger=[];const files=[];
 for(const [i,s] of m.scenes.entries()){
  for(const key of ['path','sha256','sourceUrl','licenseUrl','attribution','context','kind'])if(typeof s[key]!=='string'||!s[key].trim())throw Error(`Scene${i} missing${key}`);
  if(reviews.some(k=>s[k]!==true)||typeof s.pexelsVisible!=='boolean')throw Error(`Scene${i} incomplete review`);
  if(!Number.isInteger(s.frames)||s.frames<=0)throw Error('Measured frame count required');
  if(s.kind==='licensed-speaker'&&s.audioMode!=='original-speaker')throw Error('No speaker dubbing');
  if(!['pexels','licensed-speaker','original-animation','source-transition','trends-screenshot'].includes(s.kind))throw Error('Unknown source kind');
  if(s.kind==='trends-screenshot'&&(!s.capturedAt||!s.geo||!s.timeWindow||s.topic!==m.topic||s.topicFitReviewed!==true))throw Error('Unverified topic-fit screenshot');
  const input=path.resolve(base,s.path);await verified(input,s.sha256);const p=await probe(input);const video=p.streams.find(x=>x.codec_type==='video');if(!video||Number(video.nb_frames)!==s.frames)throw Error(`Scene${i} frame measurement mismatch`);
  if(video.r_frame_rate!=='25/1')throw Error('Sources must be reviewed25fps');frames+=s.frames;if(s.pexelsVisible)pexelsFrames+=s.frames;files.push(input);ledger.push({...s,measuredFrames:Number(video.nb_frames)});
 }
 if(frames<12750)throw Error('Minimum510s not met');if(Math.abs(pexelsFrames-frames*.2)>1)throw Error('Measured20% Pexels target not met');
 const audio=path.resolve(base,m.audio.path);await verified(audio,m.audio.sha256);if(m.audio.targetLufs!==-14||m.audio.truePeakCeiling!==-1.5||m.audio.loudnessReviewed!==true)throw Error('Unchanged loudness review missing');
 const captionLanguages=['en','es','fr','pt','de','hi','ar','id','sw','ja','ru','ko','zh','it','tr','vi'];const captions=[];
 for(const lang of captionLanguages){const c=m.captions?.[lang];if(!c)throw Error(`Missing ${lang} caption file`);const p=path.resolve(base,c.path);await verified(p,c.sha256);const s=await fs.readFile(p,'utf8');if(!s.includes('-->'))throw Error(`Invalid ${lang} track`);captions.push({lang,path:p,fidelityReviewed:c.fidelityReviewed===true});}
 const concat=path.join(dest,'reviewed-concat.txt');if(files.some(p=>p.includes("'")))throw Error('Unsupported quote in path');await fs.writeFile(concat,files.map(p=>`file '${p}'\n`).join(''));
 const output=path.join(dest,'private-reviewed-source.mp4');const args=['-y','-hide_banner','-loglevel','error','-f','concat','-safe','0','-i',concat,'-i',audio];for(const c of captions)args.push('-i',c.path);
 args.push('-map','0:v','-map','1:a');for(let i=0;i<captions.length;i++)args.push('-map',`${i+2}:0`);
 let vf='scale=1120:630,pad=1280:720:80:0:black';if(m.englishBurnIn){const a=path.resolve(base,m.englishBurnIn.path);await verified(a,m.englishBurnIn.sha256);if(a.includes("'")||a.includes(':'))throw Error('Unsupported ASS path');vf+=`,ass=${a}`;}
 args.push('-vf',vf,'-frames:v',String(frames),'-t',String(frames/25),'-c:v','libx264','-preset','fast','-crf','32','-c:a','copy','-c:s','mov_text');
 const iso=['eng','spa','fra','por','deu','hin','ara','ind','swa','jpn','rus','kor','zho','ita','tur','vie'];captions.forEach((c,i)=>args.push(`-metadata:s:s:${i}`,`language=${iso[i]}`,`-metadata:s:s:${i}`,`title=${c.lang} - private review`));args.push('-movflags','+faststart',output);
 await exec('ffmpeg',args,{maxBuffer:4*1024*1024});const actual=await probe(output);const actualFrames=Number(actual.streams.find(s=>s.codec_type==='video')?.nb_frames);if(actualFrames!==frames||actual.streams.filter(s=>s.codec_type==='subtitle').length!==16)throw Error('Final output failed frame/caption stream verification');
 let trendCapture=null;if(m.trendCapture){const {captureTrendingNow}=await import('./capture-trending-now.mjs');trendCapture=await captureTrendingNow({...m.trendCapture,outDir:path.join(dest,'trending-now')});}
 const report={output,trendCapture,topic:m.topic,privateOnly:true,publishEligible:false,measuredSeconds:frames/25,pexelsFrames,pexelsShare:pexelsFrames/frames,captions:captions.map(c=>({lang:c.lang,fidelityReviewed:c.fidelityReviewed})),remainingGates:['Caption fidelity and timing/display review','Final combined AV/factual review','Production narration/settings confirmation','Separate publishing approval/state gates'],scenes:ledger};await fs.writeFile(path.join(dest,'reviewed-source-ledger.json'),JSON.stringify(report,null,2));return report;
}
