import test from 'node:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import assert from 'node:assert/strict';

const source=readFileSync(new URL('../../server/QUALITY_REPORT_SERVICE.js',import.meta.url),'utf8');
const vmContext={console,Date,JSON,Math,Number,String,RegExp,Set,Array,Object,encodeURIComponent};
runInNewContext(source,vmContext,{filename:'Code.js',timeout:3000});

function report(beer='לאגר',batch='1532',customer='נחם',type='הקצפת יתר'){
 return {beer,batch,customer,type};
}
function row({ticket,event,customer='נחם',beer='לאגר',batch='1532',type='הקצפת יתר',date='25/10/2026'}){
 const r=new Array(30).fill('');
 r[0]=String(ticket);r[2]=customer;r[3]=beer;r[4]=batch;r[7]=date;r[23]=event||'';r[9]=type;
 return r;
}
test('third distinct complaint in same beer and batch is flagged regardless of packaging',()=>{
 const rows=[row({ticket:1,event:'INC-1'}),row({ticket:2,event:'INC-1'}),
   row({ticket:3,event:'INC-2'})];
 assert.equal(vmContext.qBatchIncidents_(rows,report(),'INC-3'),3);
 assert.equal(vmContext.qBatchIncidents_(rows,report(),'INC-2'),2);
 assert.equal(vmContext.qBatchIncidents_(rows,report('IPA'),'INC-3'),1);
 assert.equal(vmContext.qBatchIncidents_(rows,report('לאגר','1533'),'INC-3'),1);
 assert.equal(vmContext.qBatchIncidents_(rows,report('לאגר',''),'INC-3'),0);
});
test('same customer issue links existing event; another issue creates new event',()=>{
 const rows=[row({ticket:1,event:'INC-1'}),row({ticket:2,event:'INC-2',type:'טעם חריג'})];
 assert.equal(vmContext.qIdentifyEvent_(rows,report()),'INC-1');
 assert.equal(vmContext.qIdentifyEvent_(rows,report('לאגר','1532','נחם','ריח חריג')),'INC-0003');
});
test('legacy rows with no event id are distinct by ticket',()=>{
 const rows=[row({ticket:7}),row({ticket:8})];
 assert.equal(vmContext.qBatchIncidents_(rows,report(),'INC-1'),3);
});
test('idempotency match uses submission ID, not reporter or description',()=>{
 const r=row({ticket:1,event:'INC-1'});r[26]='submission-abc';
 assert.equal(vmContext.qFindExisting_([r],'submission-abc'),r);
 assert.equal(vmContext.qFindExisting_([r],'different'),null);
});
test('Firestore document decoder supports maps and media arrays with signed-only public endpoint',()=>{
 const obj=vmContext.qValue_({mapValue:{fields:{beer:{stringValue:'IPA'},quantity:{integerValue:'3'}}}});
 assert.equal(obj.beer,'IPA');assert.equal(obj.quantity,3);
 assert.equal(vmContext.qTyped_(null).nullValue,null);
 assert.match(source,/currentDocument.updateTime/);
 assert.equal(source.includes('function doPost('),false);
 assert.equal(source.includes('function qualityHandleSignedDispatch_(body)'),true);
 assert.equal(source.includes('function doGet('),false);
});

test('unsigned and stale requests are rejected before Firestore access',()=>{
 const old=vmContext.PropertiesService;
 const secret='a'.repeat(64);
 vmContext.PropertiesService={getScriptProperties:()=>({getProperty:()=>secret})};
 vmContext.ContentService={MimeType:{JSON:'JSON'},createTextOutput:content=>({setMimeType:()=>({text:content})})};
 const call=(data)=>vmContext.qualityHandleSignedDispatch_(data);
 assert.equal(call({id:'5fbff1b0-b31e-4f67-b719-1c86fca8e2cf',timestamp:Date.now(),signature:'a'.repeat(64)}).ok,false);
 assert.equal(call({id:'5fbff1b0-b31e-4f67-b719-1c86fca8e2cf',timestamp:Date.now()-300000,signature:'a'.repeat(64)}).ok,false);
 vmContext.PropertiesService=old;
});
test('signature validation uses a timestamp-bound HMAC and no secret in browser',()=>{
 assert.match(source,/computeHmacSha256Signature/);
 assert.match(source,/Math.abs\(Date.now\(\)-timestamp\)>120000/);
 assert.match(source,/qConstantTimeEqual_/);
 const backend=readFileSync(new URL('../index.mjs',import.meta.url),'utf8');
 assert.match(backend,/createHmac\('sha256',secret\)/);
 assert.match(backend,/dispatchNow\(submissionId,files\)/);
 assert.match(backend,/QUALITY_WEBHOOK_SECRET/);
 assert.match(backend,/AbortSignal.timeout\(75000\)/);
});

test('existing brewery doPost routes ONLY signed quality before normal Firebase authentication',()=>{
 const post=readFileSync(new URL('../../server/post.js',import.meta.url),'utf8');
 const signed=post.indexOf('data.action === "QualitySignedDispatch"');
 const normal=post.indexOf('authenticateFirebaseRequest_(data.idToken)');
 assert.ok(signed>0 && signed<normal);
 assert.match(post,/qualityHandleSignedDispatch_\(data\)/);
 assert.match(post,/const response = runPostActionIdempotently_\(data\)/);
});


test('mail-disabled worker saves the ticket and media metadata without ever sending mail',()=>{
 const previous={qReadSheet_:vmContext.qReadSheet_,qPatch_:vmContext.qPatch_,
   qMedia_:vmContext.qMedia_,qDate_:vmContext.qDate_,
   SpreadsheetApp:vmContext.SpreadsheetApp,qFetch_:vmContext.qFetch_,MailApp:vmContext.MailApp};
 const calls={rows:[],patches:[],flushed:0};
 try{
   vmContext.qReadSheet_=()=>({
     sheet:{getRange:(row,column,count,width)=>({setValues:(items)=>{
       assert.equal(row,6);assert.equal(column,1);assert.equal(count,1);assert.equal(width,30);
       calls.rows.push(...items);
     }})},rows:[],last:5
   });
   vmContext.qPatch_=(name,change)=>{calls.patches.push(change);return {updateTime:'next'}};
   vmContext.qMedia_=()=>['https://drive.google.com/file/d/example/view'];
   vmContext.qDate_=()=> '27/10/2026';
   vmContext.SpreadsheetApp={flush:()=>{calls.flushed++}};
   vmContext.qFetch_=()=>({getContentText:()=>''});
   vmContext.MailApp={sendEmail:()=>{throw new Error('Unexpected email send')}};
   const fields=Object.fromEntries(Object.entries({
     customer:'Test Client',beer:'IPA',batch:'1600',packageType:'בקבוק',
     type:'טעם חריג',quantity:'2',reporter:'Test',description:'Test only'
   }).map(([key,value])=>[key,{stringValue:value}]));
   const doc={name:'projects/test/databases/(default)/documents/qualitySubmissions/test-1',
     updateTime:'v1',fields:{report:{mapValue:{fields}},submittedAt:{stringValue:'2026-10-27T10:00:00Z'}}};
   const result=vmContext.qProcess_(doc);
   assert.equal(result.ticket,'1');
   assert.equal(result.eventId,'INC-0001');
   assert.equal(calls.rows.length,1);
   assert.equal(calls.rows[0][28],'מייל מושבת');
   assert.equal(calls.flushed,1);
   const completion=calls.patches.at(-1);
   assert.equal(completion.status,'completed');
   assert.equal(completion.notificationStatus,'disabled');
   assert.equal(completion.report,null);
   assert.equal(completion.media,null);
 }finally{
   Object.assign(vmContext,previous);
 }
});

test('worker and UI have no active email sending, no mail scope and accurate confirmation text',()=>{
 assert.doesNotMatch(source,/MailApp\.sendEmail|GmailApp\.sendEmail|Q_MAIL_TO/);
 const manifest=readFileSync(new URL('../../server/appsscript.json',import.meta.url),'utf8');
 assert.doesNotMatch(manifest,/script\.send_mail|mail\.google\.com/);
 const ui=readFileSync(new URL('../../src/public-report/ReportPage.tsx',import.meta.url),'utf8');
 assert.match(ui,/לא נשלחת הודעה בדוא״ל/);
 assert.doesNotMatch(ui,/ונשלחה הודעה לצוות/);
});

test('quality intake transfers attachments directly to signed Apps Script without Cloud Storage',()=>{
 const backend=readFileSync(new URL('../index.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(backend,/getStorage\(|QUALITY_UPLOAD_BUCKET|bucket\.file\(/);
 assert.match(backend,/status:files.length\?'transfer':'queued'/);
 assert.match(backend,/mediaHash/);
 assert.match(backend,/body:JSON.stringify\(\{action:'QualitySignedDispatch'/);
 assert.match(backend,/const media=\[\]/);
});
