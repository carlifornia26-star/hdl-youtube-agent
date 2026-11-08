// Real public-page capture, never a fabricated RSS/headline card. No account login.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
export async function captureTrendingNow({term,geo='US',outDir,topicFitReviewed=false}){
 if(!term?.trim()||!['US','GB','CA','AU','IN','ZA','NG','PH','IE','NZ','SG','KE'].includes(geo))throw Error('Explicit term and supported geo required');
 const {chromium}=await import('playwright');const browser=await chromium.launch({headless:true,args:['--no-sandbox']});const dest=path.resolve(outDir);await fs.mkdir(dest,{recursive:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900},locale:'en-US'});await page.goto(`https://trends.google.com/trending?geo=${geo}`,{waitUntil:'domcontentloaded',timeout:60000});
  await page.getByRole('grid',{name:'Trending Now'}).waitFor({timeout:30000});
  await page.waitForFunction(()=>!document.querySelector('[role=progressbar]')&&(document.querySelector('input[type=checkbox],[role=checkbox]')||document.body.innerText.includes('No results found')),{timeout:30000});
  await page.getByRole('button',{name:'Search trends',exact:true}).click();await page.getByRole('textbox',{name:'Search trends',exact:true}).fill(term);
  // Wait for client-side filtering to settle, then require an actual matching row.
  await page.waitForFunction(t=>!document.querySelector('[role=progressbar]')&&(document.body.innerText.includes('No results found')||Array.from(document.querySelectorAll('tr,[role=row]')).some(r=>r.querySelector('input[type=checkbox],[role=checkbox]')&&r.innerText.toLowerCase().includes(t.toLowerCase()))),term,{timeout:30000});const rows=await page.getByRole('grid',{name:'Trending Now'}).getByRole('row').allInnerTexts();
  const matches=rows.filter(s=>s.toLowerCase().includes(term.toLowerCase())&&/\bActive\b|\bago\b|\bEnded\b/.test(s));
  const capturedAt=new Date().toISOString();const sourceUrl=page.url();const screenshot=path.join(dest,'trending-now.png');await page.screenshot({path:screenshot,fullPage:true});const sha256=crypto.createHash('sha256').update(await fs.readFile(screenshot)).digest('hex');
  const report={status:matches.length?'MATCH_FOUND_REVIEW_REQUIRED':'NO_MATCH',sourceUrl,term,geo,timeWindow:'Past 24 hours',capturedAt,screenshot,sha256,matchingRows:matches,topicFitReviewed,pixelsReviewed:false,eligibleForVideo:false};await fs.writeFile(path.join(dest,'trending-now-capture.json'),JSON.stringify(report,null,2));return report;
 }finally{await browser.close()}
}
if(process.argv[1]===new URL(import.meta.url).pathname){console.log(JSON.stringify(await captureTrendingNow({term:process.argv[2],geo:process.argv[3]||'US',outDir:process.argv[4]||'build/trends-capture'}),null,2));}
