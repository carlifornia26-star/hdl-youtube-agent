import {randomBytes,createCipheriv,publicEncrypt,constants} from 'node:crypto';
export function seal(value,recipientPem) {
  const key=randomBytes(32), iv=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',key,iv);
  const encrypted=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
  const wrapped=publicEncrypt({key:recipientPem,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},key);
  return JSON.stringify({version:1,algorithm:'RSA-OAEP-SHA256+AES-256-GCM',wrappedKey:wrapped.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:encrypted.toString('base64')});
}
