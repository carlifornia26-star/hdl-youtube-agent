// Private reviewed-source branch. This module has no YouTube or account integrations.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
async function probe(p){return JSON.parse((await exec('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type,nb_frames,r_frame_rate,duration,width,height','-of','json',p])).stdout);}
async function verified(p,sha){const b=await fs.readFile(p);if(crypto.createHash('sha256').update(b).digest('hex')!==sha)throw Error(`Reviewed bytes changed: ${p}`);}
export async function renderReviewedPrivate({manifestPath,outDir}){
 const m=JSON.parse(await fs.readFile(manifestPath,'utf8'));if(m.mode==='private-source-plan')return preparePreservedSourcePlan({planPath:manifestPath,outDir});const base=path.dirname(path.resolve(manifestPath));const dest=path.resolve(outDir);await fs.mkdir(dest,{recursive:true});
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
 const audio=path.resolve(base,m.audio.path);await verified(audio,m.audio.sha256);const sourceAudio=(await probe(audio)).streams.find(s=>s.codec_type==='audio');if(!sourceAudio||!Number.isFinite(Number(sourceAudio.duration)))throw Error('Measured source audio duration required');if(m.audio.targetLufs!==-14||m.audio.truePeakCeiling!==-1.5||m.audio.loudnessReviewed!==true)throw Error('Unchanged loudness review missing');
 const captionLanguages=['en','es','fr','pt','de','hi','ar','id','sw','ja','ru','ko','zh','it','tr','vi'];const captions=[];
 for(const lang of captionLanguages){const c=m.captions?.[lang];if(!c)throw Error(`Missing ${lang} caption file`);const p=path.resolve(base,c.path);await verified(p,c.sha256);const s=await fs.readFile(p,'utf8');if(!s.includes('-->'))throw Error(`Invalid ${lang} track`);captions.push({lang,path:p,fidelityReviewed:c.fidelityReviewed===true});}
 const concat=path.join(dest,'reviewed-concat.txt');if(files.some(p=>p.includes("'")))throw Error('Unsupported quote in path');await fs.writeFile(concat,files.map(p=>`file '${p}'\n`).join(''));
 const output=path.join(dest,'private-reviewed-source.mp4');const args=['-y','-hide_banner','-loglevel','error','-f','concat','-safe','0','-i',concat,'-i',audio];for(const c of captions)args.push('-i',c.path);
 args.push('-map','0:v','-map','1:a');for(let i=0;i<captions.length;i++)args.push('-map',`${i+2}:0`);
 let vf='scale=1120:630,pad=1280:720:80:0:black';if(m.englishBurnIn){const a=path.resolve(base,m.englishBurnIn.path);await verified(a,m.englishBurnIn.sha256);if(a.includes("'")||a.includes(':'))throw Error('Unsupported ASS path');vf+=`,ass=${a}`;}
 args.push('-vf',vf,'-t',String(frames/25),'-c:v','libx264','-preset','fast','-crf','32','-c:a','copy','-c:s','mov_text');
 const iso=['eng','spa','fra','por','deu','hin','ara','ind','swa','jpn','rus','kor','zho','ita','tur','vie'];captions.forEach((c,i)=>args.push(`-metadata:s:s:${i}`,`language=${iso[i]}`,`-metadata:s:s:${i}`,`title=${c.lang} - private review`));args.push('-movflags','+faststart',output);
 await exec('ffmpeg',args,{maxBuffer:4*1024*1024});const actual=await probe(output);const actualFrames=Number(actual.streams.find(s=>s.codec_type==='video')?.nb_frames);if(actualFrames!==frames||actual.streams.filter(s=>s.codec_type==='subtitle').length!==16)throw Error('Final output failed frame/caption stream verification');
 const outputAudio=actual.streams.find(s=>s.codec_type==='audio');const requiredAudioSeconds=Math.min(Number(sourceAudio.duration),frames/25);if(!outputAudio||!Number.isFinite(Number(outputAudio.duration))||Number(outputAudio.duration)<requiredAudioSeconds-0.05)throw Error('Final audio tail was truncated');
 let trendCapture=null;if(m.trendCapture){const {captureTrendingNow}=await import('./capture-trending-now.mjs');trendCapture=await captureTrendingNow({...m.trendCapture,outDir:path.join(dest,'trending-now')});}
 const report={output,trendCapture,topic:m.topic,privateOnly:true,publishEligible:false,measuredSeconds:frames/25,pexelsFrames,pexelsShare:pexelsFrames/frames,captions:captions.map(c=>({lang:c.lang,fidelityReviewed:c.fidelityReviewed})),remainingGates:['Caption fidelity and timing/display review','Final combined AV/factual review','Production narration/settings confirmation','Separate publishing approval/state gates'],scenes:ledger};await fs.writeFile(path.join(dest,'reviewed-source-ledger.json'),JSON.stringify(report,null,2));return report;
}

export async function buildPreservedSourceScene({source,bookSlug,outPath,orientation='landscape',privateReview,voicePath,loop}){
 if(privateReview!==true)throw Error('Staged source adapter only supports private review');
 if(voicePath||loop)throw Error('No narration overlay or looping on original-source AV');
 if(!['landscape','vertical'].includes(orientation))throw Error('Unknown orientation');
 if(!source.books?.includes(bookSlug))throw Error('Source is not mapped to this book');
 for(const k of ['rightsReviewed','relevanceReviewed','pixelsReviewed','audioReviewed'])if(source[k]!==true)throw Error(`Missing ${k}`);
 for(const k of ['path','sha256','sourceUrl','licenseUrl','attribution','context','sourceTranscript'])if(!source[k])throw Error(`Missing ${k}`);
 if(source.sourceTranscriptReviewed!==true)throw Error('Reviewed original-speech transcript required');
 if(source.audioMode!=='original-source'||source.framedCreditsReviewed!==true)throw Error('Preserved original audio and framed credits required');
 let input=source;if(orientation==='vertical'){const candidate=source.orientationSources?.vertical;if(!candidate||candidate.pixelsReviewed!==true||candidate.framedCreditsReviewed!==true)throw Error('Independently reviewed vertical source framing required');input=candidate;}
 const bytes=await fs.readFile(input.path);if(crypto.createHash('sha256').update(bytes).digest('hex')!==input.sha256)throw Error('Reviewed source bytes changed');
 const p=await probe(input.path),v=p.streams.find(s=>s.codec_type==='video'),a=p.streams.find(s=>s.codec_type==='audio');
 if(!v||!a||!Number.isFinite(Number(a.duration)))throw Error('Original audiovisual source required');
 const d=Number(v.duration);if(!Number.isFinite(d)||Math.abs(d-source.frames/25)>.04)throw Error('Source duration/frame mismatch');
 const [w,h]=orientation==='landscape'?[1920,1080]:[1080,1920];
 // Fit the COMPLETE reviewed image. Never crop source credits, recolor scientific images,
 // repeat footage, duck speech, synthesize a replacement voice, or cap video frames early.
 await exec('ffmpeg',['-y','-hide_banner','-loglevel','error','-i',input.path,'-map','0:v:0','-map','0:a:0','-vf',`scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`,'-t',String(d),'-r','25','-c:v','libx264','-preset','fast','-crf','24','-c:a','copy','-movflags','+faststart',outPath],{maxBuffer:1024*1024});
 // Compare complete compressed audio, not just stream durations or an intermediate.
 const audioHash=async p=>crypto.createHash('sha256').update((await exec('ffmpeg',['-v','error','-i',p,'-map','0:a:0','-c:a','copy','-f','adts','-'],{encoding:'buffer',maxBuffer:32*1024*1024})).stdout).digest('hex');
 if(await audioHash(input.path)!==await audioHash(outPath))throw Error('Original-source audio bytes changed or tail truncated');
 const actual=await probe(outPath);const ov=actual.streams.find(s=>s.codec_type==='video'),oa=actual.streams.find(s=>s.codec_type==='audio');
 if(Number(ov?.nb_frames)!==source.frames||Number(oa?.duration)<Math.min(Number(a.duration),d)-.05)throw Error('Output frame/audio-tail verification failed');
 return {privateOnly:true,publishEligible:false,outPath,duration:d,sourceId:source.id,audioMode:'original-source',captionCues:source.captionCues||null,sourceTranscript:source.sourceTranscript,pexelsVisible:false,remainingGates:['Source-specific captions in all required languages','Final assembled context and audio-master review','Independent vertical readability review before any Short release']};
}

export const LANGUAGES=['en','es','fr','pt','de','hi','ar','id','sw','ja','ru','ko','zh','it','tr','vi'];
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const words=s=>s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
function stamp(t){const ms=Math.round(t*1000);return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`;}
export function inspectSourceCaptions(source,pack){
 const errors=[];
 if(!source.sourceTranscriptReviewed)errors.push('Original transcript not reviewed');
 if(pack?.sourceSha256!==source.sha256)errors.push('Captions not bound to reviewed source bytes');
 if(pack?.transcriptSha256!==hash(source.sourceTranscript||''))errors.push('Captions not bound to reviewed transcript');
 const duration=source.frames/25;
 for(const lang of LANGUAGES){
  const t=pack?.tracks?.[lang];
  if(!t?.cues?.length){errors.push(`${lang}: missing source-specific track`);continue;}
  if(t.fidelityReviewed!==true||t.timingReviewed!==true||t.displayReviewed!==true)errors.push(`${lang}: fidelity/timing/display review incomplete`);
  let last=0;
  for(const [i,c] of t.cues.entries()){
   if(!Number.isFinite(c.start)||!Number.isFinite(c.end)||c.start<last||c.end<=c.start||c.end>duration+.001)errors.push(`${lang}/${i}: overlap or source-range error`);
   if(typeof c.text!=='string'||!c.text.trim()){errors.push(`${lang}/${i}: empty text`);continue;}
   const lines=c.text.split('\n');const cps=[...c.text.replace(/\s/gu,'')].length/(c.end-c.start);
   if(lines.length>2||cps>24)errors.push(`${lang}/${i}: caption layout/speed review failed`);
   last=c.end;
  }
  if(lang==='en'&&words(t.cues.map(c=>c.text).join(' '))!==words(source.sourceTranscript))errors.push('en: transcript words changed or lost');
 }
 return {sourceId:source.id,duration,complete:errors.length===0,errors};
}
export async function preparePreservedSourcePlan({planPath,outDir}){
 const p=JSON.parse(await fs.readFile(planPath,'utf8'));
 if(p.mode!=='private-source-plan'||p.publishEligible!==false||!p.bookSlug||!p.sources?.length)throw Error('Explicit private source plan required');
 const base=path.dirname(path.resolve(planPath)),dest=path.resolve(outDir);await fs.mkdir(dest,{recursive:true});
 const selected=[],seen=new Set(),issues=[];let frames=0;
 for(const item of p.sources){
  const inv=JSON.parse(await fs.readFile(path.resolve(base,item.inventoryPath),'utf8'));
  const source=inv.sources?.find(s=>s.id===item.sourceId);
  if(!source||!source.books?.includes(p.bookSlug))throw Error('Source/book mapping missing');
  if(!Number.isInteger(source.frames)||source.frames<=0)throw Error('Measured source frames required');
  for(const k of ['rightsReviewed','relevanceReviewed','pixelsReviewed','audioReviewed','framedCreditsReviewed','sourceTranscriptReviewed'])if(source[k]!==true)throw Error(`Missing source review: ${k}`);
  for(const k of ['sourceUrl','licenseUrl','attribution','context','sourceTranscript'])if(!source[k])throw Error(`Missing source provenance: ${k}`);
  if(source.audioMode!=='original-source')throw Error('Original-source audio required');
  if(seen.has(source.id))throw Error('No source repetition to pad runtime');seen.add(source.id);
  const actual=await fs.readFile(source.path);if(hash(actual)!==source.sha256)throw Error('Reviewed source bytes changed');
  const pack=item.captionPackPath?JSON.parse(await fs.readFile(path.resolve(base,item.captionPackPath),'utf8')):null;
  const check=inspectSourceCaptions(source,pack);issues.push(...check.errors.map(e=>`${source.id}: ${e}`));
  selected.push({source,pack,startFrame:frames});frames+=source.frames;
 }
 const report={privateOnly:true,publishEligible:false,bookSlug:p.bookSlug,sourceIds:selected.map(s=>s.source.id),measuredNonPexelsSeconds:frames/25,requiredNonPexelsAt510Seconds:408,remainingSecondsAt510Seconds:Math.max(0,408-frames/25),captionIssues:issues,sourceAssetsBuilt:false,defaultDailyActivation:false,remainingGates:['A complete topic-matched timeline with measured 20% Pexels','Final assembled narration, context, 16-language caption and loudness review','Separate release and current account gates']};
 // Missing source captions are an explicit outcome, never a captions-only or stock fallback.
 if(issues.length){report.status='blocked-source-captions';await fs.writeFile(path.join(dest,'source-plan-report.json'),JSON.stringify(report,null,2));return report;}
 const tracks=Object.fromEntries(LANGUAGES.map(l=>[l,[]]));
 for(const [i,{source,pack,startFrame}] of selected.entries()){
  const rendered=await buildPreservedSourceScene({source,bookSlug:p.bookSlug,outPath:path.join(dest,`source-${i}.mp4`),orientation:p.orientation||'landscape',privateReview:true});
  for(const l of LANGUAGES)for(const c of pack.tracks[l].cues)tracks[l].push({...c,start:c.start+startFrame/25,end:c.end+startFrame/25});
  report.sourceAssetsBuilt=true;report.sources??=[];report.sources.push({...rendered,startFrame});
 }
 report.captionPaths={};for(const l of LANGUAGES){const target=path.join(dest,`${l}.srt`);await fs.writeFile(target,tracks[l].map((c,i)=>`${i+1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join('\n'));report.captionPaths[l]=target;}
 report.status='private-source-assets-only';await fs.writeFile(path.join(dest,'source-plan-report.json'),JSON.stringify(report,null,2));return report;
}
