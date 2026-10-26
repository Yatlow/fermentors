import {onRequest} from 'firebase-functions/v2/https';
import {onSchedule} from 'firebase-functions/v2/scheduler';
import {defineSecret,defineString} from 'firebase-functions/params';
import {initializeApp} from 'firebase-admin/app';
import {getFirestore,FieldValue} from 'firebase-admin/firestore';
import {google} from 'googleapis';
import Busboy from 'busboy';
import {Readable} from 'node:stream';
import {createHmac,createHash} from 'node:crypto';
import {
  validateReport,HEADERS,rowsToReports,relatedEvent,
  createSheetRow,normalize,knownSku,skuCatalogKey,mergeSkuHistory
} from './qualityLogic.mjs';

initializeApp();
const database=getFirestore();
const clientId=defineSecret('QUALITY_GOOGLE_CLIENT_ID');
const clientSecret=defineSecret('QUALITY_GOOGLE_CLIENT_SECRET');
const refreshToken=defineSecret('QUALITY_GOOGLE_REFRESH_TOKEN');
const turnstileSecret=defineSecret('QUALITY_TURNSTILE_SECRET');
const sheetId=defineString('QUALITY_SHEET_ID');
const mediaRootId=defineString('QUALITY_MEDIA_FOLDER_ID');
const allowedHosts=defineString('QUALITY_ALLOWED_HOSTS',{default:'fermenter-dashboard-bada3.web.app,fermenter-dashboard-bada3.firebaseapp.com'});
const senderEmail=defineString('QUALITY_SENDER_EMAIL',{default:'brewcrew@shapirobeer.co.il'});
const recipient='yochai@shapirobeer.co.il';
const MAX_MEDIA_COUNT=4;
const MAX_MEDIA_BYTES=22*1024*1024;
const FILE_BYTES=14*1024*1024;
const MEDIA_TYPES=new Set(['image/jpeg','image/png','image/webp','image/heic','image/heif','video/mp4','video/quicktime','video/webm']);
const API_OPTIONS={
  region:'europe-west1',memory:'512MiB',timeoutSeconds:120,maxInstances:5,invoker:'public',
  secrets:[clientId,clientSecret,refreshToken,turnstileSecret]
};
function clients() {
  const oauth=new google.auth.OAuth2(clientId.value(),clientSecret.value());
  oauth.setCredentials({refresh_token:refreshToken.value()});
  return {sheets:google.sheets({version:'v4',auth:oauth}),drive:google.drive({version:'v3',auth:oauth}),gmail:google.gmail({version:'v1',auth:oauth})};
}
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
async function sheetRows(sheets) {
  const response=await sheets.spreadsheets.values.get({spreadsheetId:sheetId.value(),range:"'גיליון1'!A6:AD",valueRenderOption:'FORMATTED_VALUE'});
  return response.data.values||[];
}
async function ensureHeaders(sheets) {
  const response=await sheets.spreadsheets.values.get({spreadsheetId:sheetId.value(),range:"'גיליון1'!U4:AD4"});
  const current=response.data.values?.[0]||[];
  if(current.some((v,i)=>v && v!==HEADERS[i])) throw new Error('עמודות התוספת בגיליון כבר בשימוש. לא בוצעה כתיבה.');
  if(HEADERS.every((v,i)=>current[i]===v))return;
  await sheets.spreadsheets.values.update({
    spreadsheetId:sheetId.value(),range:"'גיליון1'!U4:AD4",valueInputOption:'RAW',
    requestBody:{values:[HEADERS]}
  });
}
async function existingSubmission(sheets,id) {
  const rows=await sheetRows(sheets);
  return rows.some(r=>r[26]===id);
}
function safeName(value) {return value.replace(/[^\p{L}\p{N}. _-]/gu,'_').slice(0,85) || 'media';}
async function saveMedia(drive,ticket,files,previousFolderId='') {
  if(!files.length)return {links:[],folderId:previousFolderId};
  let folderId=previousFolderId;
  if(!folderId){
    const created=await drive.files.create({requestBody:{name:'פנייה '+String(ticket).padStart(4,'0'),mimeType:'application/vnd.google-apps.folder',parents:[mediaRootId.value()]},fields:'id'});
    folderId=created.data.id;
  }
  const links=[];
  for(let i=0;i<files.length;i++){
    const file=files[i];const filename=String(i+1).padStart(2,'0')+'-'+safeName(file.name);
    // Resuming a submission reuses uploaded files rather than duplicating them.
    const quoted=filename.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
    const old=await drive.files.list({q:"'"+folderId+"' in parents and trashed=false and name='"+quoted+"'",fields:'files(id,name,webViewLink)',pageSize:1});
    let fileId=old.data.files?.[0]?.id;
    if(!fileId){
      const uploaded=await drive.files.create({
        requestBody:{name:filename,mimeType:file.mimeType,parents:[folderId]},
        media:{mimeType:file.mimeType,body:Readable.from(file.buffer)},
        fields:'id,webViewLink'
      });
      fileId=uploaded.data.id;
    }
    links.push('https://drive.google.com/file/d/'+fileId+'/view');
  }
  return {links,folderId};
}
async function sendMail(gmail,subject,textBody) {
  const from=senderEmail.value();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from))throw new Error('QUALITY_SENDER_EMAIL not configured.');
  const encodedSubject='=?UTF-8?B?'+Buffer.from(subject).toString('base64')+'?=';
  const mime=[
    'From: '+from,'To: '+recipient,'Subject: '+encodedSubject,
    'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64','',
    Buffer.from(textBody).toString('base64')
  ].join('\r\n');
  await gmail.users.messages.send({userId:'me',requestBody:{raw:Buffer.from(mime).toString('base64url')}});
}
function sheetLink(){return 'https://docs.google.com/spreadsheets/d/'+sheetId.value()+'/edit';}
export const qualityReport=onRequest(API_OPTIONS,async(req,res)=>{
  res.set('Cache-Control','no-store');
  // Public form calls the HTTPS Cloud Function directly to bypass Firebase
  // Hosting's 60-second rewrite timeout on slower media uploads.
  const origin=req.get('origin');
  if(origin) {
    let parsed;
    try { parsed=new URL(origin); } catch { res.status(403).json({error:'Origin rejected'});return; }
    if(!isAllowedHost(parsed.hostname) ||
      (parsed.protocol!=='https:' && !(parsed.hostname==='localhost' && parsed.protocol==='http:'))) {
      res.status(403).json({error:'Origin rejected'});return;
    }
    res.set('Access-Control-Allow-Origin',origin);
    res.set('Vary','Origin');
    res.set('Access-Control-Allow-Methods','POST, OPTIONS');
    res.set('Access-Control-Allow-Headers','Content-Type');
  }
  if(req.method==='OPTIONS'){res.status(204).end();return;}
  if(req.method!=='POST'){res.set('Allow','POST, OPTIONS');res.status(405).json({error:'Method not allowed'});return;}
  let reportId;
  let ownsClaim=false;
  try{
    const {fields,files}=await parseSubmission(req);
    if(!/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(fields.submissionId||''))throw new Error('מזהה שליחה חסר.');
    reportId=fields.submissionId;
    const report=validateReport(fields);
    await checkTurnstile(fields.turnstileToken,req.ip);
    await chargeLimit(req.ip);
    // Resolve the real product SKU using the same editable product catalog as
    // the brewery app, with its default catalog as a fallback.
    if(report.packageType==='חבית'||report.packageType==='בקבוק'){
      const key=skuCatalogKey(report.beer,report.packageType);
      try {
        const entry=await database.doc('productCatalog/'+key).get();
        if(entry.exists){
          const override=entry.data();
          report.sku=override.enabled===false?'':String(override.sku||'');
        } else report.sku=knownSku(report.beer,report.packageType);
      }catch(error){console.warn('Product catalog lookup unavailable',error?.message);}
    }
    const {sheets,drive,gmail}=clients();
    const rows=await sheetRows(sheets);
    const existing=rowsToReports(rows);
    const now=new Date();
    const related=relatedEvent(existing,report,now);
    const highestTicket=existing.reduce((m,x)=>Math.max(m,Number(x.ticket)||0),0);
    const highestEvent=existing.reduce((m,x)=>Math.max(m,Number(x.eventId.match(/\d+$/)?.[0]||0)),highestTicket);

    const idRef=database.doc('qualitySubmissions/'+reportId);
    const counterRef=database.doc('qualityReportMeta/counters');
    const groupSignature=report.batch ? [report.customer,report.beer,report.batch,report.type].map(normalize).join('|') : '';
    const groupRef=groupSignature
      ? database.doc('qualityEventGroups/'+createHash('sha256').update(groupSignature).digest('hex'))
      : null;
    // Count distinct quality incidents per beer+batch, regardless of SKU, packaging or date.
    // A batch can have both kegs and bottles, and older history remains relevant.
    const batchSignature=report.batch ? [report.beer,report.batch].map(normalize).join('|') : '';
    const batchRef=batchSignature
      ? database.doc('qualityBatchHistory/'+createHash('sha256').update(batchSignature).digest('hex'))
      : null;
    const cutoff=now.valueOf()-90*86400_000; // Only same customer/issue event grouping uses 90 days.
    const fromSheet=(batchRef?existing:[])
      .filter(r=>normalize(r.beer)===normalize(report.beer) && normalize(r.batch)===normalize(report.batch))
      .map(r=>({id:r.eventId,at:(r.date||now).toISOString()}));
    const key=createHash('sha256').update(JSON.stringify(report)).digest('hex');
    const claimed=await database.runTransaction(async tx=>{
      const [prior,counter,groupSnapshot,batchSnapshot]=await Promise.all([
        tx.get(idRef),tx.get(counterRef),
        groupRef?tx.get(groupRef):Promise.resolve(null),
        batchRef?tx.get(batchRef):Promise.resolve(null)
      ]);
      if(prior.exists){
        if(prior.data()?.payload!==key)throw new Error('מזהה שליחה כבר שימש לדיווח אחר.');
        if(prior.data()?.status==='completed')return {...prior.data(),completed:true};
        const last=prior.data()?.processingAt?.toMillis?.()||0;
        if(prior.data()?.status==='processing' && Date.now()-last<180000)
          throw new Error('הדיווח כבר נמצא בטיפול. יש לנסות שוב בעוד מספר דקות.');
        tx.update(idRef,{status:'processing',processingAt:new Date()});
        return {...prior.data(),completed:false};
      }
      const recentGroup=groupSnapshot?.exists && (
        Number(groupSnapshot.data()?.lastEventAt?.toMillis?.()||0)>=cutoff
      );
      const relatedEventId=(recentGroup && groupSnapshot.data()?.eventId) || related?.eventId;
      const nextTicket=Math.max(Number(counter.data()?.nextTicket||0),highestTicket)+1;
      const newEvent=!relatedEventId;
      const nextEvent=Math.max(Number(counter.data()?.nextEvent||0),highestEvent)+(newEvent?1:0);
      const eventId=relatedEventId||'INC-'+String(nextEvent).padStart(4,'0');

      // The current report is included in the batch count. Distinct event IDs
      // prevent two reports of the same customer+issue from inflating the count.
      // The transaction serializes concurrent submissions for the same batch.
      const history=batchRef?mergeSkuHistory(fromSheet,batchSnapshot?.data()?.events||[],
        Number.NEGATIVE_INFINITY,eventId,now):null;
      const batchIncidentCount=history?.events.length||0;
      const escalation=Boolean(batchRef && batchIncidentCount>=3);
      const claim={
        ticket:nextTicket,eventId,payload:key,status:'processing',processingAt:new Date(),
        createdAt:now,sku:report.sku,client:report.customer,escalation,batchIncidentCount
      };
      tx.set(idRef,claim);
      tx.set(counterRef,{nextTicket,nextEvent},{merge:true});
      if(groupRef)tx.set(groupRef,{
        eventId,lastEventAt:now,customer:report.customer,beer:report.beer,
        batch:report.batch,type:report.type
      });
      if(batchRef)tx.set(batchRef,{events:history.events,updatedAt:now,beer:report.beer,batch:report.batch});
      return {...claim,completed:false};
    });
    if(claimed.completed){res.status(200).json({ticket:claimed.ticket,eventId:claimed.eventId,duplicate:true});return;}
    ownsClaim=true;
    const ticket=claimed.ticket;
    // Persist folder ID first so an interrupted retry can reuse the same folder.
    let folderId=claimed.folderId||'';
    if(files.length && !folderId){
      const f=await drive.files.create({requestBody:{name:'פנייה '+String(ticket).padStart(4,'0'),mimeType:'application/vnd.google-apps.folder',parents:[mediaRootId.value()]},fields:'id'});
      folderId=f.data.id;
      await idRef.update({folderId});
    }
    const media=await saveMedia(drive,ticket,files,folderId);
    await ensureHeaders(sheets);
    if(!await existingSubmission(sheets,reportId)){
      const row=createSheetRow(String(ticket),claimed.eventId,report,media.links,now,reportId,
        claimed.escalation?'3+ תקלות באצווה ('+claimed.batchIncidentCount+')':'');
      await sheets.spreadsheets.values.append({
        spreadsheetId:sheetId.value(),range:"'גיליון1'!A:AD",
        valueInputOption:'RAW',insertDataOption:'INSERT_ROWS',requestBody:{values:[row]}
      });
    }
    // Successful Sheets persistence is the completion boundary. Email is retried independently on failure.

    const escalation=Boolean(claimed.escalation);
    const subject='דיווח תקלה חדש · '+report.beer+' · פנייה #'+ticket;
    const body=['פנייה #'+ticket,'אירוע: '+claimed.eventId,
      'לקוח: '+report.customer,'בירה: '+report.beer,'אצווה: '+(report.batch||'לא ידוע'),
      'סוג אריזה: '+report.packageType,'קטגוריה: '+report.type,'כמות: '+(report.quantity ? report.quantity+' '+(report.packageType==='חבית'?'חביות':'בקבוקים') : 'לא צוין'),
      'מדווח: '+report.reporter,'טלפון: '+(report.phone||'לא סופק'),
      'תיאור: '+report.description,
      ...(escalation?['','⚠️ תשומת לב: '+claimed.batchIncidentCount+' אירועי תקלה נפרדים כבר דווחו על אצווה '+report.batch+' ('+report.beer+'), כולל הפנייה הנוכחית.']:[]),
      ...media.links.map(x=>'מדיה: '+x),'','גיליון: '+sheetLink()].join('\n');
    await idRef.update({
      status:'completed',completedAt:new Date(),folderId:media.folderId,
      mailStatus:'pending',mailSubject:subject,mailBody:body,mailAttempts:0
    });
    try {
      await sendMail(gmail,subject,body);
      await idRef.update({mailStatus:'sent',mailSentAt:new Date(),mailAttempts:1,mailSubject:FieldValue.delete(),mailBody:FieldValue.delete()});
    } catch(error) {
      console.error('quality report email failed; will retry',error?.message);
      try{await idRef.update({mailStatus:'failed',mailAttempts:1});}catch(inner){console.error('Email retry state failed',inner?.message);}
    }
    res.status(201).json({ticket,eventId:claimed.eventId});
  }catch(error){
    console.error('quality report processing error',error?.message);
    if(reportId && ownsClaim){
      const ref=database.doc('qualitySubmissions/'+reportId);
      try{const snap=await ref.get();if(snap.exists&&snap.data().status==='processing')await ref.update({status:'failed'});}catch{/* Preserve primary failure */ }
    }
    const safe=error instanceof Error && /^(יש |סוג |קובץ |הקבצים |אפשר |ערך |מספר |תאריך |שדה |מזהה |יותר מדי |הדיווח |עמודות |בדיקת)/.test(error.message);
    res.status(safe?400:500).json({error:safe?error.message:'אירעה שגיאה בשמירת הפנייה. נסו שוב מאוחר יותר.'});
  }
});
export const qualityReportMailRetry=onSchedule({
  schedule:'10 * * * *',timeZone:'Asia/Jerusalem',region:'europe-west1',
  secrets:[clientId,clientSecret,refreshToken]
},async()=>{
  const {gmail}=clients();
  const snapshot=await database.collection('qualitySubmissions').where('mailStatus','in',['failed','pending']).limit(20).get();
  for(const item of snapshot.docs){
    const row=item.data();
    if(Number(row.mailAttempts||0)>=12)continue;
    if(!row.mailSubject||!row.mailBody)continue;
    try{
      await sendMail(gmail,row.mailSubject,row.mailBody);
      await item.ref.update({mailStatus:'sent',mailSentAt:new Date(),mailAttempts:Number(row.mailAttempts||0)+1,mailSubject:FieldValue.delete(),mailBody:FieldValue.delete()});
    }catch(error){
      console.error('quality email retry failed',item.id,error?.message);
      await item.ref.update({mailAttempts:Number(row.mailAttempts||0)+1});
    }
  }
});
