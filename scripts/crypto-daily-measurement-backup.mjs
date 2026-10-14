#!/usr/bin/env node
// Encrypt sensitive Firestore backups before uploading GitHub Actions artifacts.
// The existing Firebase service-account private key is the decryption secret.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomBytes,createHash,createCipheriv,createDecipheriv} from 'node:crypto';
const PREFIX=Buffer.from('FERMDAY1');
function key(){
 const credentials=JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS,'utf8'));
 if(!credentials.private_key)throw Error('Missing service account key');
 return createHash('sha256').update('fermentors-daily-backup-v1\0').update(credentials.private_key).digest();
}
function encrypt(data,secret){
 const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',secret,nonce);
 const ciphertext=Buffer.concat([cipher.update(data),cipher.final()]);
 return Buffer.concat([PREFIX,nonce,cipher.getAuthTag(),ciphertext]);
}
function decrypt(data,secret){
 assert.ok(data.subarray(0,8).equals(PREFIX),'Backup format invalid');
 const nonce=data.subarray(8,20),tag=data.subarray(20,36),payload=data.subarray(36);
 const cipher=createDecipheriv('aes-256-gcm',secret,nonce);
 cipher.setAuthTag(tag);
 return Buffer.concat([cipher.update(payload),cipher.final()]);
}
const args=process.argv.slice(2);
if(args.length===1&&args[0]==='--self-test'){
 const secret=randomBytes(32),bytes=Buffer.from('private measurement backup','utf8');
 const encoded=encrypt(bytes,secret);
 assert.deepEqual(decrypt(encoded,secret),bytes);
 assert.throws(()=>decrypt(encoded,randomBytes(32)));
 console.log('Encrypted backup round-trip and tamper guard passed.');
}else if(args.length===3&&(args[0]==='--encrypt'||args[0]==='--decrypt')){
 const input=fs.readFileSync(args[1]),secret=key();
 fs.writeFileSync(args[2],args[0]==='--encrypt'?encrypt(input,secret):decrypt(input,secret),{mode:0o600});
}else throw Error('Use --self-test, --encrypt INPUT OUTPUT, or --decrypt INPUT OUTPUT');
