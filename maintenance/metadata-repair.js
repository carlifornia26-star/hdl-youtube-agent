import fs from 'node:fs/promises';
import {google} from 'googleapis';
import {run} from './metadata-repair-run.js';
import {seal} from './metadata-envelope.js';
const mode=process.env.REPAIR_MODE;
const channel=process.env.REPAIR_CHANNEL;
const dir='metadata-repair-output';
async function main() {
  if (mode!=='export' || !['1','4'].includes(channel)) throw new Error('Invalid mode or channel');
  await fs.mkdir(dir,{recursive:true});
  const auth=new google.auth.OAuth2(process.env.YT_CLIENT_ID,process.env.YT_CLIENT_SECRET);
  auth.setCredentials({refresh_token:process.env.YT_REFRESH_TOKEN});
  const yt=google.youtube({version:'v3',auth});
  const recipient=await fs.readFile('maintenance/metadata-export-recipient.pem','utf8');
  await run({yt,mode,channel,write:async(name,value)=>fs.writeFile(`${dir}/${name}`,seal(value,recipient))});
}
main().catch(async()=>{
  // Never dump OAuth/client request/response objects, tokens or raw exception text.
  await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(`${dir}/FAILED.txt`,'Stopped. Review available before/request/after artifacts. No automatic rollback or retry. A write may have succeeded before failure.');
  console.error('Metadata repair stopped; inspect non-secret artifacts. No automatic retry.');process.exitCode=1;
});
