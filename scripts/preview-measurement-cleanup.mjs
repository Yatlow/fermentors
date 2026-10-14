#!/usr/bin/env node
/**
 * READ ONLY. Exports complete measurement snapshots and a conservative cleanup preview.
 * Never writes or deletes Firestore documents. Use only on explicitly selected batches.
 * Sensitive full document values are stored in a short-lived Actions artifact.
 */
import assert from "node:assert/strict";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const normalize = id => {
  const m = String(id).match(/^(\d{4}-\d{2}-\d{2})_(\d{3,4})$/);
  if (!m) return null;
  const hhmm = m[2].padStart(4,"0");
  if (+hhmm.slice(0,2)>23 || +hhmm.slice(2)>59) return null;
  return m[1]+"_"+hhmm;
};
const canonical = v => {
  if (v === undefined) return null;
  if (v && typeof v.toDate === "function") return {__timestamp:v.toDate().toISOString()};
  if (v instanceof Date) return {__date:v.toISOString()};
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));
  return v;
};
const comparable = v => JSON.stringify(canonical(v));
const fieldChanges = (a,b) => [...new Set([...Object.keys(a),...Object.keys(b)])].filter(k=>comparable(a[k])!==comparable(b[k]));
const classify = rows => {
  const canonicalId=rows[0].instant;
  const preferred=rows.find(r=>r.id===canonicalId);
  const changes=[...new Set(rows.flatMap(r=>fieldChanges(rows[0].data,r.data)))];
  const status=!preferred?"MANUAL_REVIEW_NO_CANONICAL_ID":changes.length===0?"IDENTICAL_CONTENT":"MANUAL_REVIEW_DIFFERENT_CONTENT";
  return {instant:canonicalId,status,preferredId:preferred?.id??null,ids:rows.map(r=>r.id),differingFields:changes,
    // Snapshot all original values; never silently choose or discard a measurement.
    documents:rows.map(r=>({id:r.id,createTime:r.createTime,updateTime:r.updateTime,data:r.data})),
    proposedDeletes:[],requiresApproval:true};
};
function plan(batch,docs) {
  const groups=new Map(),unrecognized=[];
  for(const doc of docs){
    const instant=normalize(doc.id);
    if(!instant){unrecognized.push(doc.id);continue;}
    const row={id:doc.id,instant,createTime:doc.createTime??null,updateTime:doc.updateTime??null,data:canonical(doc.data)};
    if(!groups.has(instant))groups.set(instant,[]);
    groups.get(instant).push(row);
  }
  return {batch,documentsRead:docs.length,unrecognizedIds:unrecognized,
    duplicateGroups:[...groups.values()].filter(x=>x.length>1).map(classify)};
}
function test(){
  const p=plan("1",[
    {id:"2026-10-06_627",data:{time:"6:27",temp:10}},
    {id:"2026-10-06_0627",data:{time:"06:27",temp:10}},
    {id:"2026-10-06_0830",data:{temp:11}}
  ]);
  assert.equal(p.duplicateGroups.length,1);
  assert.equal(p.duplicateGroups[0].status,"MANUAL_REVIEW_DIFFERENT_CONTENT");
  assert.deepEqual(p.duplicateGroups[0].proposedDeletes,[]);
  assert.equal(normalize("2026-10-06_2460"),null);
  assert.equal(plan("2",[{id:"2026-10-06_627",data:{temp:10}},{id:"2026-10-06_0627",data:{temp:10}}]).duplicateGroups[0].status,"IDENTICAL_CONTENT");
  console.log("Cleanup preview self-test passed");
}
const args=process.argv.slice(2);
if(args.length===1&&args[0]==="--self-test"){test();}
else{
  if(args.length!==2||args[0]!=="--batches")throw Error("Usage: --batches comma-separated-IDs (max 10) | --self-test");
  const batches=args[1].split(",").map(s=>s.trim());
  if(batches.length<1||batches.length>10||batches.some(s=>!/^[0-9]{1,12}$/.test(s))||new Set(batches).size!==batches.length)throw Error("Invalid batch list");
  if(process.env.FIREBASE_PROJECT_ID!=="fermenter-dashboard-bada3")throw Error("Explicit project mismatch");
  initializeApp({credential:applicationDefault(),projectId:process.env.FIREBASE_PROJECT_ID});
  const db=getFirestore();
  const results=[];
  for(const batch of batches){
    const snap=await db.collection("brews").doc(batch).collection("measurements").get();
    results.push(plan(batch,snap.docs.map(d=>({id:d.id,data:d.data(),createTime:d.createTime?.toDate().toISOString(),updateTime:d.updateTime?.toDate().toISOString()}))));
  }
  console.log(JSON.stringify({readonly:true,generatedAt:new Date().toISOString(),projectId:process.env.FIREBASE_PROJECT_ID,
    scannedBatches:batches,documentsRead:results.reduce((n,r)=>n+r.documentsRead,0),
    duplicateGroups:results.reduce((n,r)=>n+r.duplicateGroups.length,0),
    warning:"This is a preview and backup of DUPLICATE GROUPS, not a full backup of every measurement in these batches. No deletions proposed.",
    results},null,2));
}
