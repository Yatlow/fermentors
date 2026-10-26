import test from 'node:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import assert from 'node:assert/strict';

const source=readFileSync(new URL('../../quality-appsscript/Code.js',import.meta.url),'utf8');
const vmContext={console,Date,JSON,Math,Number,String,RegExp,Set,Array,Object,encodeURIComponent};
runInNewContext(source,vmContext,{filename:'Code.js',timeout:3000});

function report(beer='לאגר',batch='1532',customer='נחם',type='הקצפת יתר'){
 return {beer,batch,customer,type};
}
function row({ticket,event,customer='נחם',beer='לאגר',batch='1532',type='הקצפת יתר',date='25/10/2026'}){
 const r=new Array(30).fill('');
 r[0]=String(ticket);r[2]=customer;r[3]=beer;r[4]=batch;r[7]=date;r[20]=event||'';r[21]=type;
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
 assert.equal(source.includes('function doPost('),true);
 assert.equal(source.includes('function doGet('),false);
});

test('unsigned and stale requests are rejected before Firestore access',()=>{
 const old=vmContext.PropertiesService;
 const secret='a'.repeat(64);
 vmContext.PropertiesService={getScriptProperties:()=>({getProperty:()=>secret})};
 vmContext.ContentService={MimeType:{JSON:'JSON'},createTextOutput:content=>({setMimeType:()=>({text:content})})};
 const call=(data)=>JSON.parse(vmContext.doPost({postData:{contents:JSON.stringify(data)}}).text);
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
 assert.match(backend,/dispatchNow\(submissionId\)/);
 assert.match(backend,/QUALITY_WEBHOOK_SECRET/);
 assert.match(backend,/AbortSignal.timeout\(75000\)/);
});
