import {onRequest} from 'firebase-functions/v2/https';
import {defineSecret,defineString} from 'firebase-functions/params';
import {initializeApp} from 'firebase-admin/app';
import {getFirestore,FieldValue} from 'firebase-admin/firestore';
import {getStorage} from 'firebase-admin/storage';
import Busboy from 'busboy';
import {createHmac,createHash} from 'node:crypto';
import {validateReport,knownSku,skuCatalogKey} from './qualityLogic.mjs';

initializeApp();
const database=getFirestore();
const turnstileSecret=defineSecret('QUALITY_TURNSTILE_SECRET');
const uploadBucket=defineString('QUALITY_UPLOAD_BUCKET',{default:'fermenter-dashboard-bada3.firebasestorage.app'});
const allowedHosts=defineString('QUALITY_ALLOWED_HOSTS',{default:'fermenter-dashboard-bada3.web.app,fermenter-dashboard-bada3.firebaseapp.com'});
const MAX_MEDIA_COUNT=4;
const MAX_MEDIA_BYTES=22*1024*1024;
const FILE_BYTES=14*1024*1024;
const MEDIA_TYPES=new Set(['image/jpeg','image/png','image/webp','image/heic','image/heif','video/mp4','video/quicktime','video/webm']);
const API_OPTIONS={region:'europe-west1',memory:'512MiB',timeoutSeconds:120,maxInstances:5,invoker:'public',secrets:[turnstileSecret]};

function isAllowedHost(host) {
  return allowedHosts.value().split(',').map(s=>s.trim()).filter(Boolean).includes(host);
}
async function checkTurnstile(token,ip) {
  if (!token) throw new Error('יש לאמת את הבדיקה נגד ספאם.');
  const body=new URLSearchParams({secret:turnstileSecret.value(),response:token,remoteip:ip||''});
  const res=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{
    method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body,signal:AbortSignal.timeout(12000)
  });
  if (!res.ok) throw new Error('שירות אימות הספאם אינו זמין.');
  const check=await res.json();
  if (!check.success || check.action!=='quality-report' || !isAllowedHost(check.hostname)) {
    throw new Error('בדיקת האבטחה לא הצליחה. יש לנסות שוב.');
  }
}
function validFileSignature({mimeType,buffer}) {
  if (buffer.length<12) return false;
  if (mimeType==='image/jpeg') return buffer[0]===255 && buffer[1]===216 && buffer[2]===255;
  if (mimeType==='image/png') return buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (mimeType==='image/webp') return buffer.toString('ascii',0,4)==='RIFF' && buffer.toString('ascii',8,12)==='WEBP';
  if (mimeType==='image/heic' || mimeType==='image/heif') return buffer.toString('ascii',4,8)==='ftyp';
  if (mimeType==='video/mp4' || mimeType==='video/quicktime') return buffer.toString('ascii',4,8)==='ftyp';
  if (mimeType==='video/webm') return buffer.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
  return false;
}
function parseSubmission(req) {
  return new Promise((resolve,reject)=>{
    let total=0;const files=[];const fields={};let failed=false;
    const fail=e=>{failed=true;reject(e instanceof Error?e:new Error(String(e)));};
    try {
      const bb=Busboy({headers:req.headers,limits:{files:MAX_MEDIA_COUNT,fieldSize:5000,fields:22,fileSize:FILE_BYTES,parts:30}});
      bb.on('field',(name,value)=>{if(name.length<80)fields[name]=value;});
      bb.on('file',(field,stream,info)=>{
        if(field!=='files'){stream.resume();fail(new Error('שדה מדיה לא מוכר.'));return;}
        const chunks=[];let length=0;
        stream.on('data',chunk=>{length+=chunk.length;total+=chunk.length;if(total>MAX_MEDIA_BYTES)fail(new Error('הקבצים גדולים מדי (עד 22MB יחד).'));else chunks.push(chunk);});
        stream.on('limit',()=>fail(new Error('קובץ גדול מדי (מקסימום 14MB).')));
        stream.on('error',fail);
        stream.on('end',()=>{
          if(failed)return;
          const file={name:String(info.filename||'attachment').slice(0,120),mimeType:String(info.mimeType).toLowerCase(),buffer:Buffer.concat(chunks)};
          if(!MEDIA_TYPES.has(file.mimeType)||!validFileSignature(file))fail(new Error('סוג קובץ לא נתמך.'));
          else files.push(file);
        });
      });
      bb.on('filesLimit',()=>fail(new Error('אפשר להעלות עד ארבעה קבצים.')));
      bb.on('fieldsLimit',()=>fail(new Error('יותר מדי שדות בטופס.')));
      bb.on('partsLimit',()=>fail(new Error('יותר מדי נתונים בטופס.')));
      bb.on('error',fail);
      bb.on('close',()=>{if(!failed)resolve({fields,files});});
      bb.end(req.rawBody);
    } catch(e){fail(e);}
  });
}
async function chargeLimit(ip) {
  const now=new Date();const bucket=now.toISOString().slice(0,13);
  const hash=createHmac('sha256',turnstileSecret.value()).update(ip||'unknown').digest('hex');
  const ref=database.doc('qualityRateLimits/'+hash+'-'+bucket);
  await database.runTransaction(async tx=>{
    const doc=await tx.get(ref);const count=Number(doc.data()?.count||0);
    if(count>=10)throw new Error('יותר מדי דיווחים בזמן קצר. אפשר לנסות שוב מאוחר יותר.');
    tx.set(ref,{count:count+1,expiresAt:new Date(Date.now()+3*86400000)});
  });
}

function cleanName(value){
  return String(value||'attachment').replace(/[^\p{L}\p{N}. _-]/gu,'_').slice(0,70)||'attachment';
}
export const qualityReport=onRequest(API_OPTIONS,async(req,res)=>{
  res.set('Cache-Control','no-store');
  const origin=req.get('origin');
  if(origin){
    let url;
    try{url=new URL(origin)}catch{res.status(403).json({error:'Origin rejected'});return}
    if(!isAllowedHost(url.hostname)||(url.protocol!=='https:'&&!(url.hostname==='localhost'&&url.protocol==='http:'))){
      res.status(403).json({error:'Origin rejected'});return
    }
    res.set('Access-Control-Allow-Origin',origin);
    res.set('Vary','Origin');
    res.set('Access-Control-Allow-Methods','POST, OPTIONS');
    res.set('Access-Control-Allow-Headers','Content-Type');
  }
  if(req.method==='OPTIONS'){res.status(204).end();return}
  if(req.method!=='POST'){res.set('Allow','POST, OPTIONS');res.status(405).json({error:'Method not allowed'});return}
  try{
    const {fields,files}=await parseSubmission(req);
    const submissionId=String(fields.submissionId||'');
    if(!/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(submissionId))throw new Error('מזהה שליחה חסר.');
    const report=validateReport(fields);
    await checkTurnstile(fields.turnstileToken,req.ip);
    const idRef=database.doc('qualitySubmissions/'+submissionId);
    const payloadHash=createHash('sha256').update(JSON.stringify(report)+'|'+files.map(f=>f.name+':'+createHash('sha256').update(f.buffer).digest('hex')).join('|')).digest('hex');
    const prior=await idRef.get();
    if(prior.exists){
      if(prior.data()?.payloadHash!==payloadHash)throw new Error('מזהה שליחה כבר שימש לדיווח אחר.');
      res.status(202).json({reference:submissionId.slice(0,8).toUpperCase(),queued:true,duplicate:true});return;
    }
    await chargeLimit(req.ip);
    if(report.packageType==='חבית'||report.packageType==='בקבוק'){
      const key=skuCatalogKey(report.beer,report.packageType);
      try{
        const doc=await database.doc('productCatalog/'+key).get();
        if(doc.exists){const override=doc.data();report.sku=override.enabled===false?'':String(override.sku||'')}
        else report.sku=knownSku(report.beer,report.packageType);
      }catch(e){console.warn('Quality catalog read unavailable',e?.message)}
    }
    // Uploaded bytes are private; no signed/public download links.
    // An authorized Apps Script poller moves attachments into the brewery Drive.
    const bucket=getStorage().bucket(uploadBucket.value());
    const media=[];
    for(let i=0;i<files.length;i++){
      const file=files[i];
      const path='quality-inbox/'+submissionId+'/'+String(i+1).padStart(2,'0')+'-'+cleanName(file.name);
      await bucket.file(path).save(file.buffer,{
        resumable:false,validation:'crc32c',contentType:file.mimeType,
        metadata:{cacheControl:'private,no-store'}
      });
      media.push({path,name:file.name,mimeType:file.mimeType});
    }
    await database.runTransaction(async tx=>{
      const current=await tx.get(idRef);
      if(current.exists){
        if(current.data()?.payloadHash!==payloadHash)throw new Error('מזהה שליחה כבר שימש לדיווח אחר.');
        return;
      }
      tx.create(idRef,{
        status:'queued',report,media,bucket:bucket.name,payloadHash,attempts:0,
        createdAt:FieldValue.serverTimestamp(),submittedAt:new Date().toISOString()
      });
    });
    res.status(202).json({reference:submissionId.slice(0,8).toUpperCase(),queued:true});
  }catch(error){
    console.error('Quality intake failed',error?.message);
    const safe=error instanceof Error&&/^(יש |סוג |קובץ |הקבצים |אפשר |ערך |מספר |תאריך |שדה |מזהה |יותר מדי |הדיווח |בדיקת)/.test(error.message);
    res.status(safe?400:500).json({error:safe?error.message:'לא ניתן לקלוט את הדיווח כרגע. נסו שוב מאוחר יותר.'});
  }
});
