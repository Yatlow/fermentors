#!/usr/bin/env node
// One-time correction after the oldest-wins migration ran. Original encrypted
// pre-migration snapshot is REQUIRED. Never re-create deleted timestamped docs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
const PROJECT='fermenter-dashboard-bada3';
const BATCHES=['1603','1602','1601','1600','1599','1598','1597','1596','1595','1594','1593','1592','1591','1590','1588','1587','1586','1585','1583','1580'];
const DATA_FIELDS=['temp','plato','pH','pressure','carbonation','volume'];
const val=x=>x!==undefined&&x!==null&&x!=='';
const identity=x=>JSON.stringify(x);
const iso=x=>x?.toDate?.().toISOString()??null;
const dateOf=id=>String(id).match(/^(\d{4}-\d{2}-\d{2})(?:_\d{3,4})?$/)?.[1]||null;
function digest(rows){return createHash('sha256').update(JSON.stringify(rows.map(r=>[r.id,r.createTime,r.updateTime]).sort((a,b)=>a[0].localeCompare(b[0])))).digest('hex');}
function decide(rows,latest){
 const sorted=[...rows].sort((a,b)=>Date.parse(a.createTime)-Date.parse(b.createTime)||a.id.localeCompare(b.id));
 assert.ok(sorted.every(r=>Number.isFinite(Date.parse(r.createTime))));
 for(let i=1;i<sorted.length;i++)assert.notEqual(sorted[i].createTime,sorted[i-1].createTime,'ambiguous createTime');
 const chosen={};
 for(const field of DATA_FIELDS){
  const ordered=latest?[...sorted].reverse():sorted;
  const row=ordered.find(r=>val(r.data[field]));
  if(row)chosen[field]=row.data[field];
 }
 return chosen;
}
function plan(backup){
 assert.equal(backup.project,PROJECT);
 assert.equal(backup.readonly,true);
 assert.deepEqual(backup.batches,BATCHES);
 assert.equal(backup.results.length,BATCHES.length);
 const batches=[];
 for(let i=0;i<BATCHES.length;i++){
  const source=backup.results[i],batch=BATCHES[i];
  assert.equal(source.batch,batch);
  assert.equal(digest(source.documents),source.signature,'Invalid original backup signature');
  const groups=new Map();
  for(const row of source.documents){
   const day=dateOf(row.id);
   assert.ok(day,'Invalid historic ID '+batch);
   if(!groups.has(day))groups.set(day,[]);
   groups.get(day).push(row);
  }
  const corrections=[];
  for(const [day,rows] of groups){
   if(rows.length<2)continue;
   const oldValues=decide(rows,false),newValues=decide(rows,true),changes={};
   for(const field of DATA_FIELDS){
    if(!Object.is(oldValues[field],newValues[field])&&val(newValues[field])){
     changes[field]={before:oldValues[field]??null,after:newValues[field]};
    }
   }
   if(Object.keys(changes).length)corrections.push({day,changes});
  }
  batches.push({batch,corrections});
 }
 return batches;
}
function selfTest(){
 const make=(id,time,values)=>({id,createTime:time,updateTime:time,data:values});
 const r=[make('2026-10-06_0800','2026-10-06T08:00:00Z',{temp:12,plato:5}),
  make('2026-10-06_0900','2026-10-06T09:00:00Z',{temp:14})];
 assert.deepEqual(decide(r,false),{temp:12,plato:5});
 assert.deepEqual(decide(r,true),{temp:14,plato:5});
 assert.ok(Object.is(undefined,undefined));
 console.log('Historical latest-wins recovery tests passed');
}
async function run(backup,mode){
 const batches=plan(backup);
 if(process.env.FIREBASE_PROJECT_ID!==PROJECT)throw Error('Wrong Firebase project');
 const {initializeApp,applicationDefault}=await import('firebase-admin/app');
 const {getFirestore}=await import('firebase-admin/firestore');
 initializeApp({credential:applicationDefault(),projectId:PROJECT});
 const db=getFirestore();let totals={batches:20,groupsPlanned:0,groupsFixed:0,fieldsFixed:0,fieldsPreservedSinceMigration:0,missingCanonical:0,errors:[]};
 for(const {batch,corrections} of batches){
  totals.groupsPlanned+=corrections.length;
  for(const {day,changes} of corrections){
   const ref=db.collection('brews').doc(batch).collection('measurements').doc(day);
   try{
    // A transaction reads current values and applies ONLY changes whose current
    // value still equals the oldest-wins value we are reversing. Any newer
    // measurement written since migration takes precedence and is left intact.
    const result=await db.runTransaction(async tx=>{
     const current=await tx.get(ref);
     if(!current.exists)return {missing:1};
     const data=current.data(),patch={};let preserved=0;
     for(const [field,{before,after}] of Object.entries(changes)){
      if(Object.is(data[field]??null,before))patch[field]=after;
      else if(Object.is(data[field],after)){} // already corrected
      else preserved++; // newer live update; don't erase it
     }
     if(mode==='apply'&&Object.keys(patch).length)tx.update(ref,patch);
     return {fixed:Object.keys(patch).length,preserved};
    },{maxAttempts:3});
    if(result.missing){totals.missingCanonical++;totals.errors.push(batch+'/'+day+': canonical missing');continue;}
    if(result.fixed)totals.groupsFixed++;
    totals.fieldsFixed+=result.fixed;
    totals.fieldsPreservedSinceMigration+=result.preserved;
   }catch(e){totals.errors.push(batch+'/'+day+': '+String(e.message||e).slice(0,180));}
  }
 }
 return {project:PROJECT,mode,completedAt:new Date().toISOString(),...totals};
}
const args=process.argv.slice(2);
if(args.length===1&&args[0]==='--self-test')selfTest();
else if(args.length===3&&['--preview','--apply'].includes(args[0])&&args[1]==='--file'){
 if(args[0]==='--apply'&&process.env.CONFIRM_HISTORICAL_LATEST_WINS!=='ONE_TIME_20261014')throw Error('Explicit correction guard missing');
 const backup=JSON.parse(fs.readFileSync(args[2],'utf8'));
 const result=await run(backup,args[0]==='--apply'?'apply':'preview');
 process.stdout.write(JSON.stringify(result,null,2)+'\n');
 if(result.errors.length)process.exitCode=1;
}else throw Error('Usage: --self-test or --preview/--apply --file BACKUP');
