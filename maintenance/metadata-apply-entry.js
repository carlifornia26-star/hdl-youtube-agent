import {loadPrivateInput} from './metadata-private-input.js';
import {runApply} from './metadata-apply-run.js';
import {seal} from './metadata-envelope.js';
// Dependencies are injected for offline verification. Never logs input or error objects.
export async function execute({env,makeClient,writeCiphertext,log}) {
  const raw=env.YT_BOUNDED_METADATA_INPUT;
  delete env.YT_BOUNDED_METADATA_INPUT;
  try {
    if (env.REPAIR_MODE!=='apply') throw new Error('Apply only');
    const input=loadPrivateInput(raw,env.REVIEWED_INPUT_SHA256,env.REPAIR_CHANNEL);
    // Client is lazy, so runApply's complete manifest preflight happens before auth.
    let client;
    const get=()=>client??=makeClient();
    const yt={channels:{list:(...a)=>get().channels.list(...a)},videos:{list:(...a)=>get().videos.list(...a),update:(...a)=>get().videos.update(...a)}};
    await runApply({yt,mode:'apply',channel:input.channel,plans:input.plans,reviewRecord:input.reviewRecord,
      write:async(name,value)=>writeCiphertext(name+'.enc',seal(value,input.evidenceRecipientPem))});
    log('Bounded metadata apply completed; verify encrypted evidence and public state.');
    return true;
  } catch {
    // May follow an accepted write. Never expose request headers, secrets, body or provider text.
    log('Bounded metadata apply stopped. No automatic retry or rollback. Inspect private evidence before continuing.');
    return false;
  }
}
