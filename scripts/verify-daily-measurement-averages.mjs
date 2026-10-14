#!/usr/bin/env node
// Read-only post-migration confirmation from Apps Script's durable status marker.
import assert from 'node:assert/strict';
const PROJECT='fermenter-dashboard-bada3';
function valid(x){
 return x&&x.status==='averages_rebuilt'&&Number(x.stylesUpdated)>0&&
   Number.isFinite(Date.parse(x.migrationCompletedAt))&&
   Number.isFinite(Date.parse(x.rebuildCompletedAt))&&
   Date.parse(x.rebuildCompletedAt)>=Date.parse(x.migrationCompletedAt);
}
if(process.argv[2]==='--self-test'){
 assert.ok(valid({status:'averages_rebuilt',stylesUpdated:6,
  migrationCompletedAt:'2026-10-14T12:00:00Z',rebuildCompletedAt:'2026-10-14T12:10:00Z'}));
 assert.ok(!valid({status:'completed',stylesUpdated:6}));
 console.log('Average rebuild verification tests passed.');
}else if(process.argv.length===2){
 if(process.env.FIREBASE_PROJECT_ID!==PROJECT)throw Error('Wrong Firebase project');
 const {initializeApp,applicationDefault}=await import('firebase-admin/app');
 const {getFirestore}=await import('firebase-admin/firestore');
 initializeApp({credential:applicationDefault(),projectId:PROJECT});
 const db=getFirestore();
 const marker=db.collection('maintenanceRequests').doc('daily-measurements-2026-10-14');
 const start=Date.now(),delay=30000,timeout=14*60*1000;
 let last='not found';
 while(Date.now()-start<=timeout){
  const doc=await marker.get();
  const data=doc.exists?doc.data():null;
  if(valid(data)){
   console.log('Verified completed style-average rebuild; styles updated: '+data.stylesUpdated);
   process.exit(0);
  }
  last=data?.status||'not found';
  await new Promise(resolve=>setTimeout(resolve,delay));
 }
 throw Error('Style averages rebuild not confirmed within 14 minutes; last marker status: '+last);
}else throw Error('Use without args or --self-test');
