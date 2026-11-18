import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,privateDecrypt,constants,createDecipheriv} from 'node:crypto';
import {execute} from '../maintenance/metadata-apply-entry.js';
import {hash,TARGETS} from '../maintenance/metadata-repair-core.js';
const keys=generateKeyPairSync('rsa',{modulusLength:3072,publicKeyEncoding:{format:'pem',type:'spki'},privateKeyEncoding:{format:'pem',type:'pkcs8'}});
function fixture({failUpdate=0,drift=false,badReview=false}={}) {
 const videos={},plans=[],calls=[],files=[],logs=[];let clients=0,updates=0,reads=0;
 for(const id of Object.keys(TARGETS).filter(id=>TARGETS[id].channel==='4')) {
  const b={id,etag:'v1',snippet:{channelId:TARGETS[id].owner,title:'English title',description:'English full description',tags:['keep'],categoryId:'27'},status:{privacyStatus:'public'},contentDetails:{caption:'true'},localizations:{en:{title:'English',description:'English'},es:{title:'Bad',description:'Bad hook\n\nhttps://example.test/full?x=1&y=2'},'es-US':{title:'Unchanged regional',description:'Original regional description'},ar:{title:'Original Arabic',description:'Unchanged Arabic'}}};videos[id]=b;
  const c={locale:'es',originalHash:hash(b.localizations.es),originalHook:'Bad hook',tail:'\n\nhttps://example.test/full?x=1&y=2',title:'Corrected',hook:'Corrected hook',review:{status:'source-fidelity-reviewed',evidence:'Synthetic independent review'}};c.tailHash=hash(c.tail);
  plans.push({videoId:id,snapshotHash:hash(b),changes:[c]});
 }
 const reviewRecord={scope:'five-video-faults-only',videos:Object.fromEntries(plans.map(p=>[p.videoId,{status:badReview?'pending':'all-required-changes-cleared',planHash:hash(p)}]))};
 const envelope={version:1,channel:'4',plans,reviewRecord,evidenceRecipientPem:keys.publicKey};
 const env={REPAIR_MODE:'apply',REPAIR_CHANNEL:'4',REVIEWED_INPUT_SHA256:hash(envelope),YT_BOUNDED_METADATA_INPUT:JSON.stringify(envelope)};
 const makeClient=()=>{clients++;assert(!('YT_BOUNDED_METADATA_INPUT' in env));return {channels:{list:async a=>{calls.push(['identity',a]);return {data:{items:[{id:TARGETS.SadjccrotLo.owner}]}}}},videos:{list:async a=>{calls.push(['list',a]);reads++;const b=structuredClone(videos[a.id[0]]);if(drift&&reads===3)b.status.privacyStatus='private';return {data:{items:[b]}}},update:async(a,options)=>{updates++;calls.push(['update',a,options]);assert.deepEqual(a.part,['localizations']);assert.deepEqual(Object.keys(a.requestBody).sort(),['id','localizations']);videos[a.requestBody.id].localizations=structuredClone(a.requestBody.localizations);videos[a.requestBody.id].etag='v2';if(failUpdate===updates)throw new Error('Credential-bearing provider message MUST NOT LEAK');return {data:{}};}}};};
 return {env,makeClient,writeCiphertext:async(n,v)=>files.push([n,v]),log:x=>logs.push(x),calls,files,logs,get clients(){return clients},get updates(){return updates},videos,envelope};
}
function decrypt(s){const e=JSON.parse(s);const k=privateDecrypt({key:keys.privateKey,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},Buffer.from(e.wrappedKey,'base64'));const d=createDecipheriv('aes-256-gcm',k,Buffer.from(e.iv,'base64'));d.setAuthTag(Buffer.from(e.tag,'base64'));return JSON.parse(Buffer.concat([d.update(Buffer.from(e.ciphertext,'base64')),d.final()]).toString('utf8'));}
test('integrated two-video apply preserves all unrelated state, evidence only ciphertext, no private input logs',async()=>{const m=fixture();assert.equal(await execute(m),true);assert.equal(m.clients,1);assert.equal(m.updates,2);assert.equal(m.files.length,6);for(const [n,s]of m.files){assert(n.endsWith('.json.enc'));assert(!s.includes('example.test'));assert(!s.includes('Corrected hook'));decrypt(s);}for(const id of Object.keys(m.videos)){assert.equal(m.videos[id].localizations.en.title,'English');assert.equal(m.videos[id].localizations['es-US'].title,'Unchanged regional');}assert(!JSON.stringify(m.logs).includes('example.test'));});
test('uncleared manifest rejected before client/credentials, no evidence',async()=>{const m=fixture({badReview:true});assert.equal(await execute(m),false);assert.equal(m.clients,0);assert.equal(m.updates,0);assert.equal(m.files.length,0);});
test('private envelope digest mismatch before client',async()=>{const m=fixture();m.env.REVIEWED_INPUT_SHA256='0'.repeat(64);assert.equal(await execute(m),false);assert.equal(m.clients,0);assert(!('YT_BOUNDED_METADATA_INPUT'in m.env));});
test('state drift stops before write',async()=>{const m=fixture({drift:true});assert.equal(await execute(m),false);assert.equal(m.updates,0);assert.equal(m.files.length,2);});
test('ambiguous successful-first-write failure stops without retry or second video, logs no provider text',async()=>{const m=fixture({failUpdate:1});assert.equal(await execute(m),false);assert.equal(m.updates,1);assert.equal(m.files.length,3);assert(!JSON.stringify(m.logs).includes('MUST NOT LEAK'));});
test('evidence persistence failure stops before any update',async()=>{const m=fixture();m.writeCiphertext=async()=>{throw new Error('filesystem');};assert.equal(await execute(m),false);assert.equal(m.updates,0);});
