import assert from 'node:assert/strict';
import {createPublicKey} from 'node:crypto';
import {hash} from './metadata-repair-core.js';
import {seal} from './metadata-envelope.js';
export function loadPrivateInput(raw,expectedDigest,channel) {
  assert(typeof expectedDigest==='string' && /^[a-f0-9]{64}$/.test(expectedDigest),'Missing pinned independently reviewed digest');
  assert(typeof raw==='string' && Buffer.byteLength(raw,'utf8')<=47000,'Private input missing or too large for one secret');
  const value=JSON.parse(raw);
  assert(value && !Array.isArray(value),'Invalid private input');
  assert.deepEqual(Object.keys(value).sort(),['channel','evidenceRecipientPem','plans','reviewRecord','version']);
  assert.equal(value.version,1);assert.equal(value.channel,channel);
  assert.equal(hash(value),expectedDigest,'Private input differs from reviewed approval');
  const key=createPublicKey(value.evidenceRecipientPem);
  assert.equal(key.asymmetricKeyType,'rsa');
  // Prove sealing works BEFORE any client construction or network: a recipient
  // that cannot encrypt (e.g. OAEP-unusable) fails here with zero network use.
  try { seal({canary:true},value.evidenceRecipientPem); } catch { throw new Error('Evidence recipient cannot encrypt'); }
  assert(key.asymmetricKeyDetails.modulusLength>=3072,'Weak evidence encryption recipient');
  assert(!value.evidenceRecipientPem.includes('PRIVATE KEY'),'Private key must not enter Actions');
  return value;
}
