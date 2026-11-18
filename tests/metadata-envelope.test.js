import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,privateDecrypt,constants,createDecipheriv} from 'node:crypto';
import {seal} from '../maintenance/metadata-envelope.js';
test('authenticated encryption roundtrips exact raw Unicode and URL tails without plaintext',()=>{
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const raw={description:'Exact Arabic العربية\nhttps://example.test/full?x=1&y=2',tail:' unchanged\r\n'};
 const sealed=seal(raw,publicKey);assert(!sealed.includes('example.test'));
 const e=JSON.parse(sealed),key=privateDecrypt({key:privateKey,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},Buffer.from(e.wrappedKey,'base64'));
 const d=createDecipheriv('aes-256-gcm',key,Buffer.from(e.iv,'base64'));d.setAuthTag(Buffer.from(e.tag,'base64'));
 const out=Buffer.concat([d.update(Buffer.from(e.ciphertext,'base64')),d.final()]).toString('utf8');assert.deepEqual(JSON.parse(out),raw);
});
