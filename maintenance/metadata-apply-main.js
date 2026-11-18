import fs from 'node:fs/promises';
import {execute} from './metadata-apply-entry.js';
import {makeNativeClient} from './metadata-native-client.js';
const dir='metadata-apply-output';
try {
  await fs.mkdir(dir,{recursive:true});
  const ok=await execute({env:process.env,
    makeClient:()=>{
      const {YT_CLIENT_ID,YT_CLIENT_SECRET,YT_REFRESH_TOKEN}=process.env;
      delete process.env.YT_CLIENT_ID;delete process.env.YT_CLIENT_SECRET;delete process.env.YT_REFRESH_TOKEN;
      if(!YT_CLIENT_ID||!YT_CLIENT_SECRET||!YT_REFRESH_TOKEN)throw new Error('Credential unavailable');
      return makeNativeClient(YT_CLIENT_ID,YT_CLIENT_SECRET,YT_REFRESH_TOKEN);
    },
    writeCiphertext:async(name,value)=>{
      if(!/^[A-Za-z0-9_-]+-(before|request|after|update-response)\.json\.enc$/.test(name))throw new Error('Invalid evidence filename');
      await fs.writeFile(`${dir}/${name}`,value,{mode:0o600});
    },log:message=>console.log(message)});
  if(!ok)process.exitCode=1;
} catch {
  delete process.env.YT_BOUNDED_METADATA_INPUT;
  console.error('Bounded metadata apply stopped before completion. No automatic retry.');process.exitCode=1;
}
