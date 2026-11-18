import test from 'node:test';
import assert from 'node:assert/strict';
import {run} from '../maintenance/metadata-repair-run.js';
import {TARGETS} from '../maintenance/metadata-repair-core.js';
function mock(){
 const calls=[];const files=[];
 const yt={channels:{list:async()=>({data:{items:[{id:TARGETS.G_H_scsEaos.owner}]}})},videos:{list:async arg=>{calls.push(['list',arg]);return {data:{items:[{id:arg.id[0],etag:'e',snippet:{channelId:TARGETS.G_H_scsEaos.owner,title:'EN',description:'EN'},status:{privacyStatus:'public'},localizations:{es:{title:'ES',description:'ES'}}}]}}},update:async arg=>{calls.push(['update',arg]);return {data:{}}}}};
 return {yt,calls,files,write:async(n,v)=>files.push([n,v])};
}
test('export reads all three exact ch1 targets, writes backups, zero API mutations',async()=>{const m=mock();await run({...m,mode:'export',channel:'1'});assert.equal(m.files.length,3);assert.equal(m.calls.filter(c=>c[0]==='update').length,0);assert.deepEqual(m.calls.map(c=>c[1].id[0]),['G_H_scsEaos','GtSBugKsYVI','mp5wp6GTpAE']);});
test('apply missing complete plan fails before write',async()=>{const m=mock();await assert.rejects(run({...m,mode:'apply',channel:'1',plans:[]}));assert.equal(m.calls.length,0);});
test('invalid mode fails before any source/API call',async()=>{const m=mock();await assert.rejects(run({...m,mode:'publish',channel:'1'}));assert.equal(m.calls.length,0);});
test('wrong credential owns no eligible channel, no update',async()=>{const m=mock();m.yt.channels.list=async()=>({data:{items:[{id:'other'}]}});await assert.rejects(run({...m,mode:'export',channel:'1'}));assert.equal(m.calls.filter(c=>c[0]==='update').length,0);assert.equal(m.files.length,0);});
