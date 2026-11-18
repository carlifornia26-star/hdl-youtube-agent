import fs from 'node:fs/promises';
import {createPublicKey,createHash,timingSafeEqual} from 'node:crypto';
import {seal} from './metadata-envelope.js';
// Single read-only videos.list(part=localizations) for one allowlisted video.
// Exactly one OAuth refresh POST and one videos GET against fixed official
// HTTPS endpoints. No retries, no redirects, no SDK, no env endpoint overrides.
// Recipient is pinned (canonical SPKI SHA-256, RSA >= 3072) and validated before
// any OAuth. Full map + readAt + video etag are sealed in memory with the
// reviewed envelope helper; only the .enc file is written. Unexpected-but-valid
// observed states are preserved as ciphertext diagnostics, never silently
// discarded and never cause rejection; malformed (wrong-typed) data fails
// closed with no output. Generic failure marker only.
const dir='metadata-read-output';
const ALLOWED=new Set(['G_H_scsEaos']);
const TOKEN_URL='https://oauth2.googleapis.com/token';
const API_URL='https://www.googleapis.com/youtube/v3/videos?part=localizations&id=';
const TIMEOUT_MS=15000;
const LOCALE_RE=/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
// Observed baseline locale key set for this video at plan time (29 keys).
// Used for deviation diagnostics only, never for rejection.
const BASELINE_LOCALES=['de-DE','ja','pt','hi','es-US','ml','iw','sw','de','ko','te','fr','en','pa','ar','fr-FR','ru','ta','id','zh-Hans','tr','uk','es','pt-BR','bn','it','nl-NL','pl','vi'];
async function cleanup(){for (const k of ['YT_CLIENT_ID','YT_CLIENT_SECRET','YT_REFRESH_TOKEN','READ_PUBLIC_KEY_PEM','READ_EXPECTED_SPKI_SHA256']) delete process.env[k];}
function validateEntry(k,v){
  if (!LOCALE_RE.test(k)) return null;
  if (typeof v!=='object'||v===null||Array.isArray(v)) return null;
  const out={};
  for (const f of ['title','description']) {
    if (v[f]===undefined) continue;
    if (typeof v[f]!=='string') return null;
    out[f]=v[f];
  }
  return out;
}
try {
  await fs.mkdir(dir,{recursive:true});
  const videoId=process.env.READ_VIDEO_ID;
  if (!ALLOWED.has(videoId)) throw new Error('not allowlisted');
  const pem=process.env.READ_PUBLIC_KEY_PEM??'';
  const expectedPin=(process.env.READ_EXPECTED_SPKI_SHA256??'').trim().toLowerCase();
  let recipient;
  try {
    recipient=createPublicKey(pem);
  } catch { throw new Error('recipient invalid'); }
  if (recipient.asymmetricKeyType!=='rsa') throw new Error('recipient type');
  if ((recipient.asymmetricKeyDetails?.modulusLength??0)<3072) throw new Error('recipient strength');
  const pin=createHash('sha256').update(recipient.export({format:'der',type:'spki'})).digest('hex');
  if (!/^[0-9a-f]{64}$/.test(expectedPin)||!timingSafeEqual(Buffer.from(pin,'hex'),Buffer.from(expectedPin,'hex'))) throw new Error('recipient pin');
  seal({canary:true},pem); // prove recipient usable for sealing before any OAuth
  const {YT_CLIENT_ID,YT_CLIENT_SECRET,YT_REFRESH_TOKEN}=process.env;
  await cleanup();
  if (!YT_CLIENT_ID||!YT_CLIENT_SECRET||!YT_REFRESH_TOKEN) throw new Error('credential unavailable');
  const tokenRes=await fetch(TOKEN_URL,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:YT_CLIENT_ID,client_secret:YT_CLIENT_SECRET,refresh_token:YT_REFRESH_TOKEN,grant_type:'refresh_token'}),redirect:'error',signal:AbortSignal.timeout(TIMEOUT_MS)});
  if (!tokenRes.ok) throw new Error('refresh failed');
  const tokenBody=await tokenRes.json();
  const accessToken=typeof tokenBody.access_token==='string'&&tokenBody.access_token?tokenBody.access_token:null;
  if (!accessToken) throw new Error('refresh failed');
  try {
    const apiRes=await fetch(`${API_URL}${encodeURIComponent(videoId)}`,{headers:{authorization:`Bearer ${accessToken}`},redirect:'error',signal:AbortSignal.timeout(TIMEOUT_MS)});
    if (!apiRes.ok) throw new Error('read failed');
    const data=await apiRes.json();
    const items=Array.isArray(data.items)?data.items:[];
    if (items.length!==1||items[0].id!==videoId) throw new Error('ambiguous result');
    const item=items[0];
    const diagnostics=[];
    let etag=null;
    if (typeof item.etag==='string'&&item.etag) etag=item.etag; else diagnostics.push('etag-missing');
    let localizations=null;
    if (item.localizations===null||item.localizations===undefined) {
      diagnostics.push('localizations-absent');
    } else {
      if (typeof item.localizations!=='object'||Array.isArray(item.localizations)) throw new Error('malformed map');
      localizations={};
      for (const [k,v] of Object.entries(item.localizations)) {
        const entry=validateEntry(k,v);
        if (entry===null) throw new Error('malformed entry');
        localizations[k]=entry;
      }
      const keys=Object.keys(localizations);
      const missing=BASELINE_LOCALES.filter(b=>!keys.includes(b));
      const extra=keys.filter(k=>!BASELINE_LOCALES.includes(k));
      if (missing.length) diagnostics.push(`baseline-missing:${missing.join(',')}`);
      if (extra.length) diagnostics.push(`baseline-extra:${extra.join(',')}`);
    }
    const sealed=seal({videoId,readAt:new Date().toISOString(),etag,localizations,localeCount:localizations?Object.keys(localizations).length:0,diagnostics},pem);
    await fs.writeFile(`${dir}/${videoId}-localizations.enc`,sealed,{mode:0o600});
    console.log('Bounded metadata read completed; inspect retained ciphertext.');
  } finally {
    tokenBody.access_token=null;
  }
} catch {
  await cleanup();
  console.error('Bounded metadata read stopped before completion.');
  process.exitCode=1;
}
