#!/usr/bin/env node
// Controlled one-time Firestore migration: full backup, oldest-wins merge, transaction guards.
// --snapshot NEVER WRITES. --apply requires the uploaded snapshot and explicit guard.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
const PROJECT='fermenter-dashboard-bada3';
const BATCHES=['1603','1602','1601','1600','1599','1598','1597','1596','1595','1594','1593','1592','1591','1590','1588','1587','1586','1585','1583','1580'];
const value=v=>v!==null&&v!==undefined&&v!=='';
const iso=v=>v?.toDate?.().toISOString()??null;
function day(id){
 const m=String(id).match(/^(\d{4}-\d{2}-\d{2})(?:_(\d{3,4}))?$/);
 if(!m)return null;
 const d=new Date(m[1]+'T12:00:00Z');
 if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==m[1])return null;
 if(m[2]){const t=m[2].padStart(4,'0');if(+t.slice(0,2)>23||+t.slice(2)>59)return null;}
 return m[1];
}
function fieldDay(v){
 const m=String(v??'').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
 if(!m)return null;
 let y=+m[3];if(y<100)y+=2000;
 const s=String(y)+'-'+String(+m[2]).padStart(2,'0')+'-'+String(+m[1]).padStart(2,'0');
 const d=new Date(s+'T12:00:00Z');
 return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===s?s:null;
}
function safe(data){
 return data&&typeof data==='object'&&!Array.isArray(data)&&Object.values(data).every(v=>
  v===null||typeof v==='string'||typeof v==='boolean'||(typeof v==='number'&&Number.isFinite(v)));
}
function notes(rows){
 let parts=[];
 for(const row of rows){
  const current=String(row.data.notes??'').trim();
  if(!current)continue;
  const next=current.split(' | ').map(s=>s.trim()).filter(Boolean);
  if(!parts.length){parts=[...next];continue;}
  let contained=false;
  for(let start=0;start+next.length<=parts.length;start++){
   if(next.every((v,j)=>v===parts[start+j])){contained=true;break;}
  }
  if(contained)continue;
  let overlap=0;
  for(let n=Math.min(parts.length,next.length);n>0;n--){
   if(parts.slice(-n).every((v,j)=>v===next[j])){overlap=n;break;}
  }
  parts.push(...next.slice(overlap));
 }
 return parts.join(' | ');
}
function combine(batch,key,documents){
 const rows=[...documents].sort((a,b)=>Date.parse(a.createTime)-Date.parse(b.createTime)||a.id.localeCompare(b.id));
 for(const row of rows){
  assert.ok(row.createTime&&Number.isFinite(Date.parse(row.createTime)),'Missing createTime '+batch+'/'+row.id);
  assert.ok(row.updateTime&&Number.isFinite(Date.parse(row.updateTime)),'Missing updateTime '+batch+'/'+row.id);
  assert.ok(safe(row.data),'Unsupported field data '+batch+'/'+row.id);
  if(value(row.data.date))assert.equal(fieldDay(row.data.date),key,'Date/ID mismatch '+batch+'/'+row.id);
 }
 for(let i=1;i<rows.length;i++)assert.notEqual(rows[i].createTime,rows[i-1].createTime,
  'Equal creation timestamps; cannot decide oldest '+batch+'/'+key);
 const merged={...rows[0].data},conflicts=[];
 for(const row of rows.slice(1)){
  for(const [field,v] of Object.entries(row.data)){
   if(['date','time','notes','originalMeasurementCreatedAt'].includes(field))continue;
   if(!value(merged[field])&&value(v))merged[field]=v;
   else if(value(merged[field])&&value(v)&&!Object.is(merged[field],v)&&!conflicts.includes(field))conflicts.push(field);
  }
 }
 const [y,m,d]=key.split('-');
 merged.date=d+'/'+m+'/'+y;
 const time=rows.find(row=>value(row.data.time));
 if(time)merged.time=String(time.data.time);
 merged.notes=notes(rows);
 merged.originalMeasurementCreatedAt=rows[0].data.originalMeasurementCreatedAt||rows[0].createTime;
 return {batch,day:key,data:merged,removeIds:rows.map(r=>r.id).filter(id=>id!==key),conflicts};
}
function analyze(batch,documents){
 assert.ok(documents.length<=160,'Bound exceeded on '+batch);
 const groups=new Map();
 for(const doc of documents){
  const key=day(doc.id);
  assert.ok(key,'Unknown measurement ID '+batch+'/'+doc.id);
  assert.ok(safe(doc.data),'Non-scalar field '+batch+'/'+doc.id);
  if(value(doc.data.date))assert.equal(fieldDay(doc.data.date),key,'Date/ID mismatch '+batch+'/'+doc.id);
  assert.ok(doc.createTime&&doc.updateTime,'Missing Firestore timestamps');
  if(!groups.has(key))groups.set(key,[]);
  groups.get(key).push(doc);
 }
 const merged=[...groups].map(([key,docs])=>combine(batch,key,docs));
 return {batch,total:documents.length,days:groups.size,
  changes:merged.filter(p=>p.removeIds.length>0)};
}
function signature(docs){
 return createHash('sha256').update(JSON.stringify(
  docs.map(d=>[d.id,d.createTime,d.updateTime]).sort((a,b)=>a[0].localeCompare(b[0])))).digest('hex');
}
function validate(backup){
 assert.equal(backup.project,PROJECT);
 assert.equal(backup.readonly,true);
 assert.deepEqual(backup.batches,BATCHES);
 assert.equal(backup.results.length,BATCHES.length);
 assert.ok(backup.results.reduce((n,r)=>n+r.documents.length,0)<=1800,'Read cap exceeded');
 return backup.results.map((row,i)=>{
  assert.equal(row.batch,BATCHES[i]);
  assert.equal(signature(row.documents),row.signature,'Snapshot changed after upload');
  return analyze(row.batch,row.documents);
 });
}
async function connect(){
 if(process.env.FIREBASE_PROJECT_ID!==PROJECT)throw Error('Wrong Firebase project');
 const {initializeApp,applicationDefault}=await import('firebase-admin/app');
 const {getFirestore}=await import('firebase-admin/firestore');
 initializeApp({credential:applicationDefault(),projectId:PROJECT});
 return getFirestore();
}
function snapRow(doc){
 const data=doc.data();
 if(!safe(data))throw Error('Unsupported Firestore measurement data at '+doc.ref.path);
 return {id:doc.id,createTime:iso(doc.createTime),updateTime:iso(doc.updateTime),data};
}
async function createBackup(db){
 const results=[];
 for(const batch of BATCHES){
  const docs=(await db.collection('brews').doc(batch).collection('measurements').get()).docs.map(snapRow);
  analyze(batch,docs);
  results.push({batch,signature:signature(docs),documents:docs});
 }
 const backup={project:PROJECT,readonly:true,createdAt:new Date().toISOString(),batches:BATCHES,results};
 validate(backup);
 return backup;
}
async function migrate(db,backup){
 const plans=validate(backup),report=[];
 for(let i=0;i<plans.length;i++){
  const batch=BATCHES[i],col=db.collection('brews').doc(batch).collection('measurements');
  try{
   const applied=await db.runTransaction(async tx=>{
    const live=(await tx.get(col)).docs.map(snapRow);
    if(signature(live)!==backup.results[i].signature)throw Error('STALE: changed since backup');
    const plan=analyze(batch,live);
    for(const group of plan.changes){
     tx.set(col.doc(group.day),group.data);
     for(const id of group.removeIds)tx.delete(col.doc(id));
    }
    return {batch,status:'COMMITTED',days:plan.days,groups:plan.changes.length,
      deleted:plan.changes.reduce((n,p)=>n+p.removeIds.length,0),
      conflictingFields:plan.changes.reduce((n,p)=>n+p.conflicts.length,0)};
   },{maxAttempts:2});
   const after=await col.get();
   const invalid=after.docs.filter(d=>d.id!==day(d.id));
   if(invalid.length)throw Error('VERIFY FAILED: '+invalid.map(d=>d.id).join(','));
   report.push({...applied,status:'VERIFIED',remaining:after.size});
  }catch(e){report.push({batch,status:'BLOCKED',reason:String(e?.message||e)});}
 }
 return {project:PROJECT,performedAt:new Date().toISOString(),results:report,
  verifiedBatches:report.filter(r=>r.status==='VERIFIED').length,
  deleted:report.reduce((n,r)=>n+(r.deleted||0),0)};
}
function selfTest(){
 assert.equal(day('2026-10-06_627'),'2026-10-06');
 assert.equal(day('2026-10-06'),'2026-10-06');
 assert.equal(day('2026-02-30'),null);
 assert.equal(fieldDay('6/10/26'),'2026-10-06');
 const make=(id,created,data)=>({id,createTime:created,updateTime:created,data});
 const r=analyze('1600',[
  make('2026-10-06_0627','2026-10-06T06:00:00Z',{date:'06/10/2026',temp:12,notes:'A | B'}),
  make('2026-10-06_627','2026-10-06T05:00:00Z',{date:'6/10/26',temp:11,plato:5,notes:'A'}),
  make('2026-10-06_0930','2026-10-06T09:00:00Z',{date:'06/10/2026',temp:15,notes:'B | C'}),
  make('2026-10-07','2026-10-07T09:00:00Z',{date:'07/10/2026',temp:6})]);
 assert.equal(r.changes.length,1);
 assert.equal(r.days,2);
 assert.equal(r.changes[0].data.temp,11,'oldest wins');
 assert.equal(r.changes[0].data.plato,5,'missing fields filled');
 assert.equal(r.changes[0].data.notes,'A | B | C','notes preserved');
 assert.equal(r.changes[0].removeIds.length,3);
 assert.throws(()=>analyze('1600',[make('bad','2026-10-06T06:00:00Z',{})]),/Unknown measurement/);
 console.log('Daily consolidation safety tests passed.');
}
const args=process.argv.slice(2);
if(args.length===1&&args[0]==='--self-test')selfTest();
else if(args.length===1&&args[0]==='--snapshot'){
 const db=await connect();process.stdout.write(JSON.stringify(await createBackup(db),null,2));
}else if(args.length===3&&args[0]==='--apply'&&args[1]==='--file'){
 if(process.env.CONFIRM_DAILY_MEASUREMENT_MIGRATION!=='1600-1580-ONE-DOC-PER-DAY')throw Error('Missing explicit migration guard');
 const db=await connect(),backup=JSON.parse(fs.readFileSync(args[2],'utf8'));
 const r=await migrate(db,backup);process.stdout.write(JSON.stringify(r,null,2)+'\n');
 if(r.verifiedBatches!==BATCHES.length)process.exitCode=1;
}else throw Error('Use --self-test, --snapshot or --apply --file PATH');
