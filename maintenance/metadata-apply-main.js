import fs from 'node:fs/promises';
import {google} from 'googleapis';
import {execute} from './metadata-apply-entry.js';
const dir='metadata-apply-output';
try {
  await fs.mkdir(dir,{recursive:true});
  const ok=await execute({env:process.env,
    makeClient:()=>{
      const {YT_CLIENT_ID,YT_CLIENT_SECRET,YT_REFRESH_TOKEN}=process.env;
      delete process.env.YT_CLIENT_ID;delete process.env.YT_CLIENT_SECRET;delete process.env.YT_REFRESH_TOKEN;
      if(!YT_CLIENT_ID||!YT_CLIENT_SECRET||!YT_REFRESH_TOKEN)throw new Error('Credential unavailable');
      const auth=new google.auth.OAuth2(YT_CLIENT_ID,YT_CLIENT_SECRET);
      auth.setCredentials({refresh_token:YT_REFRESH_TOKEN});
      return google.youtube({version:'v3',auth});
    },
    writeCiphertext:async(name,value)=>{
      if(!/^[A-Za-z0-9_-]+-(before|request|after)\.json\.enc$/.test(name))throw new Error('Invalid evidence filename');
      await fs.writeFile(`${dir}/${name}`,value,{mode:0o600});
    },log:message=>console.log(message)});
  if(!ok)process.exitCode=1;
} catch {
  delete process.env.YT_BOUNDED_METADATA_INPUT;
  console.error('Bounded metadata apply stopped before completion. No automatic retry.');process.exitCode=1;
}
