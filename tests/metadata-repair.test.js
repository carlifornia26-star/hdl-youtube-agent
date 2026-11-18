import test from 'node:test';
import assert from 'node:assert/strict';
import {TARGETS,scope,hash,buildUpdate,verifyAfter} from '../maintenance/metadata-repair-core.js';
function fixture(){
 const b={id:'G_H_scsEaos',etag:'version1',snippet:{channelId:TARGETS.G_H_scsEaos.owner,title:'English',description:'English tail',tags:['keep'],categoryId:'27'},status:{privacyStatus:'public',madeForKids:false},contentDetails:{caption:'true'},localizations:{es:{title:'Bad',description:'Bad hook\nhttps://example.test/full?x=1&y=2'},ar:{title:'Remain',description:'unchanged'}}};
 const c={locale:'es',title:'Good',hook:'Correct hook',originalHook:'Bad hook',tail:'\nhttps://example.test/full?x=1&y=2',originalHash:hash(b.localizations.es),review:{status:'source-fidelity-reviewed',evidence:'offline fixture, not real review'}};
 c.tailHash=hash(c.tail);return [b,{videoId:b.id,snapshotHash:hash(b),changes:[c]}];
}
test('exact allowlist identity',()=>{const [b]=fixture();scope(b,'1',[b.snippet.channelId]);});
for (const [name,mutate] of [
 ['wrong channel',(b)=>scope(b,'4',[b.snippet.channelId])],
 ['wrong owner',(b)=>scope(b,'1',['other'])],
 ['unknown video',(b)=>{b.id='other';scope(b,'1',[])}],
 ['wrong ch4 owner',(b)=>{b.id='SadjccrotLo';scope(b,'4',[])}],
]) test(name,()=>{const [b]=fixture();assert.throws(()=>mutate(b));});
test('full map preserved and only localized pair changed',()=>{const[b,p]=fixture();const r=buildUpdate(b,p);assert.deepEqual(Object.keys(r).sort(),['id','localizations']);assert.deepEqual(r.localizations.ar,b.localizations.ar);assert(r.localizations.es.description.endsWith(p.changes[0].tail));assert.equal(b.localizations.es.title,'Bad');verifyAfter(b,{...b,etag:'version2',localizations:r.localizations},r);});
for (const [name,mutate] of [
 ['source drift',(b,p)=>b.status.privacyStatus='private'],
 ['missing review',(b,p)=>delete p.changes[0].review],
 ['uncertain review',(b,p)=>p.changes[0].review.status='uncertain'],
 ['unknown locale',(b,p)=>p.changes[0].locale='xx'],
 ['truncated tail',(b,p)=>p.changes[0].tail='https://example...'],
 ['wrong boundary',(b,p)=>p.changes[0].originalHook='Bad'],
 ['wrong tail hash',(b,p)=>p.changes[0].tailHash='x'],
 ['blank title',(b,p)=>p.changes[0].title=''],
 ['oversized title',(b,p)=>p.changes[0].title='x'.repeat(101)],
 ['duplicate locale',(b,p)=>p.changes.push(p.changes[0])],
]) test(name,()=>{const[b,p]=fixture();mutate(b,p);assert.throws(()=>buildUpdate(b,p));});
test('unrelated status readback change fails',()=>{const[b,p]=fixture();const r=buildUpdate(b,p);assert.throws(()=>verifyAfter(b,{...b,status:{privacyStatus:'private'},localizations:r.localizations},r));});
test('lost untouched locale fails readback',()=>{const[b,p]=fixture();const r=buildUpdate(b,p);const a=structuredClone(r.localizations);delete a.ar;assert.throws(()=>verifyAfter(b,{...b,localizations:a},r));});
test('excluded French improvement fails',()=>{const[b,p]=fixture();b.id='GtSBugKsYVI';b.localizations.fr=b.localizations.es;p.videoId=b.id;p.snapshotHash=hash(b);p.changes[0].locale='fr';assert.throws(()=>buildUpdate(b,p));});
test('English locale edit explicitly rejects even with valid review and raw hashes',()=>{
 const[b,p]=fixture();b.localizations.en=structuredClone(b.localizations.es);p.snapshotHash=hash(b);p.changes[0].locale='en';p.changes[0].originalHash=hash(b.localizations.en);
 assert.throws(()=>buildUpdate(b,p),/English localizations are outside repair scope/);
});
