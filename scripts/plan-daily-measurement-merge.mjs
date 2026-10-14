#!/usr/bin/env node
/**
 * Read-only FULL-SNAPSHOT and daily merge plan for explicitly selected brews.
 * Never writes or deletes Firestore documents.
 * A plan is NOT authorization to execute deletion.
 */
import assert from "node:assert/strict";
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const own = (obj,key)=>Object.prototype.hasOwnProperty.call(obj,key);
const valid=v=>v!==null&&v!==undefined&&v!=="";
function normalize(v) {
  if(v&&typeof v.toDate==="function")return {__firestoreTimestamp:v.toDate().toISOString()};
  if(v instanceof Date)return {__date:v.toISOString()};
  if(Array.isArray(v))return v.map(normalize);
  if(v&&typeof v==="object")return Object.fromEntries(Object.keys(v).sort().map(k=>[k,normalize(v[k])]));
  return v;
}
const equal=(a,b)=>JSON.stringify(normalize(a))===JSON.stringify(normalize(b));
function keyFor(row) {
  const id=String(row.id);
  const m=id.match(/^(\d{4}-\d{2}-\d{2})_(\d{3,4})$/);
  if(!m)return null;
  const clock=m[2].padStart(4,"0");
  if(+clock.slice(0,2)>23||+clock.slice(2)>59)return null;
  const date=new Date(m[1]+"T12:00:00Z");
  if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==m[1])return null;
  return m[1];
}
function mergeDay(batch,day,rows) {
  // Timestamp order is the source of truth. Missing/equal timestamps block cleanup.
  const sorted=[...rows].sort((a,b)=>
    String(a.createTime||"").localeCompare(String(b.createTime||""))||
    a.id.localeCompare(b.id));
  const timestampOk=sorted.every(r=>r.createTime&&Number.isFinite(Date.parse(r.createTime)))&&
    new Set(sorted.map(r=>r.createTime)).size===sorted.length;
  const first=sorted[0], merged=structuredClone(first.data);
  const conflicts=[],notes=[];
  const seenNotes=new Set();
  for(const row of sorted) {
    const note=String(row.data.notes??"").trim();
    if(note&&!seenNotes.has(note)){seenNotes.add(note);notes.push(note);}
    for(const [field,value] of Object.entries(row.data)){
      if(["notes","date","time"].includes(field))continue;
      if(!valid(merged[field])&&valid(value))merged[field]=structuredClone(value);
      else if(valid(merged[field])&&valid(value)&&!equal(merged[field],value)&&
        !conflicts.some(c=>c.field===field)){
        conflicts.push({field,oldestValue:merged[field],otherValue:value,sourceId:row.id});
      }
    }
  }
  if(notes.length)merged.notes=notes.join(" | ");
  // Every change is preview-only. No automatic execution, even for identical docs.
  return {batch,day,sourceIds:sorted.map(r=>r.id),oldestId:first.id,
    oldestCreateTime:first.createTime,allCreationTimesValidAndDistinct:timestampOk,
    differingFields:conflicts,
    combinedData:merged,
    proposedKeepId:first.id,
    proposedRemoveIds:sorted.slice(1).map(r=>r.id),
    executionAllowed:false,
    requiresHumanApproval:true,
    warnings:[
      ...(!timestampOk?["Missing or equal creation timestamps: do not choose a winner"]:[]),
      ...(conflicts.length?["Oldest values retained for conflicting fields; review before any write"]:[])
    ]};
}
function planBatch(batch,docs){
  const groups=new Map(),unrecognized=[];
  for(const d of docs) {
    const day=keyFor(d);
    if(!day){unrecognized.push(d.id);continue;}
    if(!groups.has(day))groups.set(day,[]);
    groups.get(day).push(d);
  }
  return {batch,documentsRead:docs.length,
    // Full backup includes singletons, unknown-ID docs, all fields and metadata.
    fullSnapshot:docs,
    unrecognizedIds:unrecognized,
    dailyPlans:[...groups].filter(([,rows])=>rows.length>1).map(([day,rows])=>mergeDay(batch,day,rows))};
}
function test(){
  const p=planBatch("1600",[
    {id:"2026-10-06_0627",createTime:"2026-10-06T06:30:00Z",data:{date:"06/10/2026",time:"06:27",plato:5,notes:"Pressure"}},
    {id:"2026-10-06_627",createTime:"2026-10-06T06:20:00Z",data:{date:"06/10/2026",time:"6:27",plato:6,notes:"Yeast"}},
    {id:"2026-10-06_0930",createTime:"2026-10-06T09:30:00Z",data:{date:"06/10/2026",time:"09:30",temp:11}},
    {id:"2026-10-07_0840",createTime:"2026-10-07T08:40:00Z",data:{plato:4}}
  ]);
  assert.equal(p.dailyPlans.length,1);
  assert.equal(p.dailyPlans[0].sourceIds.length,3);
  assert.equal(p.dailyPlans[0].oldestId,"2026-10-06_627");
  assert.equal(p.dailyPlans[0].combinedData.plato,6);
  assert.equal(p.dailyPlans[0].combinedData.temp,11);
  assert.equal(p.dailyPlans[0].combinedData.notes,"Yeast | Pressure");
  assert.equal(p.dailyPlans[0].executionAllowed,false);
  assert.equal(p.fullSnapshot.length,4);
  assert.equal(planBatch("1",[{id:"bad",data:{},createTime:"2026-01-01T00:00:00Z"}]).unrecognizedIds.length,1);
  console.log("Daily merge planner self-test passed");
}
const args=process.argv.slice(2);
if(args.length===1&&args[0]==="--self-test")test();
else{
  if(args.length!==2||args[0]!=="--batches")throw Error("Use --batches comma-separated IDs (max 10)");
  const batches=args[1].split(",").map(x=>x.trim());
  if(batches.length<1||batches.length>10||new Set(batches).size!==batches.length||
     batches.some(x=>!/^[0-9]{1,12}$/.test(x)))throw Error("Invalid batch selection");
  if(process.env.FIREBASE_PROJECT_ID!=="fermenter-dashboard-bada3")throw Error("Project mismatch");
  initializeApp({credential:applicationDefault(),projectId:process.env.FIREBASE_PROJECT_ID});
  const db=getFirestore(),results=[];
  for(const batch of batches){
    const snap=await db.collection("brews").doc(batch).collection("measurements").get();
    results.push(planBatch(batch,snap.docs.map(d=>({
      id:d.id,createTime:d.createTime?.toDate().toISOString()??null,
      updateTime:d.updateTime?.toDate().toISOString()??null,data:normalize(d.data())
    }))));
  }
  console.log(JSON.stringify({readonly:true,createdAt:new Date().toISOString(),
    projectId:process.env.FIREBASE_PROJECT_ID,
    warning:"Contains FULL sensitive measurements backup; no Firestore writes or deletions; manual approval required.",
    batches,documentsRead:results.reduce((n,r)=>n+r.documentsRead,0),
    dailyGroups:results.reduce((n,r)=>n+r.dailyPlans.length,0),
    results},null,2));
}
