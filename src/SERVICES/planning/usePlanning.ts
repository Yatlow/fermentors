import { useEffect, useState } from 'react';
import { collection, doc, onSnapshot, query, where, runTransaction, serverTimestamp } from 'firebase/firestore';
import type { ShipmentEvent } from './dailyPlanner';
import { Timestamp } from 'firebase/firestore';
import type { PlanningSnapshot } from './planningReports';
import { auth, db } from '../../firebase';
import type { Pallet } from '../cooler/Pallettypes ';
import { addDays, dateKey, defaultSettings, weekStart, parseDate, type TankInput, type Actual, type Holiday, type Settings, type WeekPlan } from './planningEngine';

export function usePlanning(today: string, tanks: TankInput[]) {
  const [actualShipments,setActualShipments]=useState<ShipmentEvent[]>([]);
  const [snapshots,setSnapshots]=useState<PlanningSnapshot[]>([]);
  const [snapshotError,setSnapshotError]=useState('');
  const [settings,setSettings]=useState<Settings>(defaultSettings);
  const [plans,setPlans]=useState<WeekPlan[]>([]);
  const [pallets,setPallets]=useState<Pallet[]>([]);
  const [actuals,setActuals]=useState<Actual[]>([]);
  const [ready,setReady]=useState<Record<string,boolean>>({});
  const [errors,setErrors]=useState<Record<string,string>>({});
  const [offline,setOffline]=useState<Record<string,boolean>>({});
  const start=weekStart(today),end=addDays(start,84);
  const logStart=[addDays(start,-84),...tanks.filter(t=>t.tankStatus!==true&&t.batchNumber).map(t=>parseDate(t.brewDate)).filter((d):d is string=>!!d&&d<today)].sort()[0];
  useEffect(()=> {
    setReady({}); setErrors({});
    const ok=(key:string,cache:boolean)=> {setReady(x=>({...x,[key]:true}));setOffline(x=>({...x,[key]:cache}));setErrors(x=>({...x,[key]:''}));};
    const fail=(key:string)=>(e:Error)=>setErrors(x=>({...x,[key]:`${key}: ${e.message}`}));
    const unsub=[
      onSnapshot(query(collection(db,'planningSnapshots'),where('targetWeek','>=',addDays(start,-84)),where('targetWeek','<',end)),snap=>{setSnapshots(snap.docs.map(d=>({...d.data(),id:d.id}) as PlanningSnapshot));setSnapshotError('');},e=>setSnapshotError(e.message)),
      onSnapshot(doc(db,'planningSettings','main'),{includeMetadataChanges:true},snap=> {setSettings(snap.exists()?{...defaultSettings(),...snap.data(),lossPercent:10} as Settings:defaultSettings());ok('הגדרות',snap.metadata.fromCache);},fail('הגדרות')),
      onSnapshot(query(collection(db,'planningWeeks'),where('id','>=',addDays(start,-84)),where('id','<',end)),{includeMetadataChanges:true},snap=> {setPlans(snap.docs.map(d=>d.data() as WeekPlan));ok('תוכניות',snap.metadata.fromCache);},fail('תוכניות')),
      onSnapshot(query(collection(db,'shipments'),where('createdAt','>=',Timestamp.fromDate(new Date(`${start}T00:00:00+03:00`)))),{includeMetadataChanges:true},snap=>{setActualShipments(snap.docs.flatMap(d=>{const date=d.data().createdAt?.toDate?.();return date?[{id:d.id,date:dateKey(date)}]:[];}));ok('משלוחים',snap.metadata.fromCache);},fail('משלוחים')),
      onSnapshot(query(collection(db,'pallets'),where('zone','in',['cooler','pending','bottleRoom','loadingDock'])),{includeMetadataChanges:true},snap=> {setPallets(snap.docs.map(d=>({...d.data(),id:d.id}) as Pallet));ok('מלאי',snap.metadata.fromCache);},fail('מלאי')),
      onSnapshot(query(collection(db,'packagingLog'),where('timestamp','>=',Date.parse(`${logStart}T00:00:00+03:00`)),where('timestamp','<',Date.parse(`${end}T00:00:00+02:00`))),{includeMetadataChanges:true},snap=> {setActuals(snap.docs.map(d=>({...d.data(),id:d.id}) as Actual));ok('אריזות',snap.metadata.fromCache);},fail('אריזות')),
    ]; return ()=>unsub.forEach(fn=>fn());
  },[start,end,logStart]);
  async function save(collectionName:string,id:string,value:Settings|WeekPlan) {
    if(!auth.currentUser) throw new Error('יש להתחבר מחדש');
    await runTransaction(db,async tx=> {
      const ref=doc(db,collectionName,id),snap=await tx.get(ref);
      if((snap.data()?.revision??0)!==value.revision) throw new Error('התכנון עודכן במכשיר אחר. סגור את העריכה ופתח מחדש כדי לקבל את העדכון.');
      const next={...value,createdAt:snap.exists()?(snap.data()?.createdAt??null):serverTimestamp(),revision:value.revision+1,updatedAt:serverTimestamp(),updatedBy:auth.currentUser!.uid};
      // Immutable revision and live document are committed atomically.
      const revisionRef=doc(ref,'revisions',String(next.revision));
      tx.set(ref,next);
      tx.set(revisionRef,next);
    });
  }
  return {settings,plans,pallets,actuals,actualShipments,snapshots,snapshotError,loading:Object.keys(ready).length<5,error:Object.values(errors).filter(Boolean).join(' · '),offline:Object.values(offline).some(Boolean),saveSettings:(s:Settings)=>save('planningSettings','main',s),saveWeek:(w:WeekPlan)=>save('planningWeeks',w.id,w)};
}

export function usePlanningToday() {
  const [today,setToday]=useState(()=>dateKey(new Date()));
  useEffect(()=> {const id=setInterval(()=>setToday(dateKey(new Date())),60000);return ()=>clearInterval(id);},[]);
  return today;
}

export function useHolidays(start:string,end:string) {
  const [holidays,setHolidays]=useState<Holiday[]>([]),[error,setError]=useState('');
  useEffect(()=> {
    const controller=new AbortController();
    let disposed=false;
    const timer=setTimeout(()=>controller.abort(),12000);
    const other:Holiday[]=[];
    for(let year=Number(start.slice(0,4));year<=Number(end.slice(0,4));year++) {
      const nov=new Date(Date.UTC(year,10,1,12));const thanksgiving=1+(4-nov.getUTCDay()+7)%7+21;
      other.push({date:`${year}-12-25`,title:'כריסטמס'},{date:`${year}-11-${thanksgiving}`,title:'חג ההודיה (ארה״ב)'},{date:`${year}-01-01`,title:'ראש השנה האזרחית'});
    }
    setHolidays(other);setError('');
    fetch(`https://www.hebcal.com/hebcal?v=1&cfg=json&maj=on&min=on&mod=on&i=on&lg=he&start=${start}&end=${end}`,{signal:controller.signal})
      .then(r=> {if(!r.ok)throw new Error();return r.json();})
      .then(data=> {if(!controller.signal.aborted)setHolidays([...other,...(data.items??[]).filter((x:{category:string})=>x.category==='holiday').map((x:{date:string;hebrew?:string;title:string;yomtov?:boolean})=>({date:x.date.slice(0,10),title:x.hebrew??x.title,closed:!!x.yomtov}))]);})
      .catch(()=> {if(!disposed)setError('לא ניתן לטעון חגים יהודיים. יש לבדוק את ימי העבודה ידנית.');})
      .finally(()=>clearTimeout(timer));
    return ()=> {disposed=true;clearTimeout(timer);controller.abort();};
  },[start,end]);
  return {holidays,error};
}
