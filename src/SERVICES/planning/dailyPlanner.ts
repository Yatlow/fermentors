import { packagingLimit, weekday as dayOfWeek } from './productionCycle';
import { projectedPallets, selectTruck, validateTruckGroups, type StockPallet } from './truckPlanner';
import type { Pallet } from '../cooler/Pallettypes ';
import { addDays, allocate, dateKey, litersPerUnit, num, parseDate, sameStyle, styleKey, tempoNow, weekStart, weeklyDemand, type Actual, type Allocation, type Holiday, type Plan, type Product, type Settings, type Tank, type WeekPlan } from './planningEngine';

export const shortDate=(date:string)=>date.split('-').reverse().join('/');
/** Round DOWN to complete covered days; fractional-day risk is never hidden by rounding up. */
export function coverageLabel(weeks:number|null,today:string):string {
  if(weeks===null||!Number.isFinite(weeks))return 'ללא קצב מכירות';
  const days=Math.max(0,Math.floor(weeks*7+1e-9));
  if(weeks<=0)return `אזל · ${shortDate(today)}`;
  const duration=days===0?'פחות מיום':`${Math.floor(days/7)} ש׳, ${days%7} י׳`;
  return `${duration} · עד ${shortDate(addDays(today,days))}`;
}
export function actualDate(a:Actual){return parseDate(a.date)??(num(a.timestamp)>0?dateKey(new Date(a.timestamp!)):null);}
export function matchesActual(p:Product,a:Actual){return sameStyle(p.style,a.beerStyle??'')&&a.packagingType===(p.type==='crates'?'bottles':'kegs');}
export function actualUnits(p:Product,a:Actual){return num(a.quantity)/(p.type==='crates'&&a.unit==='בקבוקים'?24:1);}
export type OpenRun=Plan & {key:string;week:string;remaining:number};
/** Allocate actual quantities once across sorted dated/legacy lines, never per line independently. */
export function openRuns(plans:WeekPlan[],products:Product[],actuals:Actual[]):OpenRun[]{
  return plans.flatMap(w=>products.flatMap(p=> {
    const completed=actuals.filter(a=>matchesActual(p,a)&&actualDate(a)&&weekStart(actualDate(a)!)===w.id).map(a=>({actual:a,left:actualUnits(p,a)}));
    return w.packaging.map((r,i)=>({...r,key:r.id??`${w.id}:${r.productId}:${i}`,week:w.id})).filter(r=>r.productId===p.id).sort((a,b)=>(a.date??'9999').localeCompare(b.date??'9999')||a.key.localeCompare(b.key)).map(r=>{
      let remaining=r.quantity;
      for(const entry of completed){if(r.tankNumber&&String(entry.actual.tankNumber)!==r.tankNumber||r.batchNumber&&String(entry.actual.batchNumber)!==r.batchNumber)continue;const amount=Math.min(entry.left,remaining);entry.left-=amount;remaining-=amount;}
      return {...r,remaining:Math.max(0,remaining)};
    });
  }));
}
export function futureTanks(tanks:Tank[],plans:WeekPlan[],settings:Settings):Tank[]{
  const seen=new Set<string>();
  const future=plans.flatMap(w=>w.brews).flatMap(b=> {
    const key=`${b.tankId}:${b.date}:${styleKey(b.style)}`;
    if(seen.has(key)||tanks.some(t=>t.id===b.tankId&&t.brewed===b.date&&sameStyle(t.style,b.style)))return [];
    seen.add(key);
    const leads=settings.products.filter(p=>sameStyle(p.style,b.style)).map(p=>p.leadDays);
    if(!parseDate(b.date)||!b.tankId||!b.liters)return [];
    return [{id:`planned:${b.id}`,number:`${b.tankId} · בישול מתוכנן`,style:b.style,batch:'מתוכנן',brewed:b.date,ready:addDays(b.date,Math.max(...leads,21)),liters:b.liters*0.9,cold:false}];
  });
  return [...tanks,...future].sort((a,b)=>a.brewed.localeCompare(b.brewed)||a.id.localeCompare(b.id));
}
export type DailyPoint={date:string;productId:string;brewery:number;tempo:number|null;packed:number;arrived:number;shortage:number|null};
export type DailySuggestion={id:string;kind:'packaging'|'delivery';date:string;arrivalDate?:string;productId:string;quantity:number;allocations:Allocation[];truckId?:string;pallets?:Pallet[];slots?:number;reason?:string};
export type DailyResult={points:DailyPoint[];suggestions:DailySuggestion[];warnings:string[];open:OpenRun[]};
type Lot=StockPallet;
export type ShipmentEvent={id:string;date:string};
export function dailyForecast(settings:Settings,pallets:Pallet[],tanks:Tank[],plans:WeekPlan[],actuals:Actual[],today:string,holidays:Holiday[]=[],recommend=false,actualShipments:ShipmentEvent[]=[]):DailyResult{
  const warnings=new Set<string>(),products=settings.products,open=openRuns(plans,products,actuals),end=addDays(weekStart(today),84);
  const pool=futureTanks(tanks,plans.map(w=>({...w,brews:w.brews.filter(b=>b.date>=today||tanks.some(t=>t.id===b.tankId&&t.brewed===b.date))})),settings);
  const available=new Map(pool.map(t=>[t.id,t.liters]));
  const bookings=new Map<string,Allocation[]>();
  const dated=open.filter(r=>r.remaining>0&&parseDate(r.date)&&r.date!>=today&&r.date!<end).sort((a,b)=>a.date!.localeCompare(b.date!)||a.key.localeCompare(b.key));
  for(const r of open.filter(r=>r.remaining>0))if(!parseDate(r.date)||r.date!<today)warnings.add(`${r.week}: ${products.find(p=>p.id===r.productId)?.style??r.productId} — ${!r.date?'לא נקבע יום':'אריזה באיחור'}; לא נכללת כאספקה ודאית`);
  for(const r of dated){const p=products.find(p=>p.id===r.productId);if(!p)continue;const allocations=allocate(r.tankId?pool.filter(t=>t.id===r.tankId):pool,available,p,r.remaining,r.date!);bookings.set(r.key,allocations);const shortage=r.remaining*litersPerUnit(p)-allocations.reduce((s,a)=>s+a.liters,0);if(shortage>.01)warnings.add(`${shortDate(r.date!)} · ${p.style}: חסרים ${Math.ceil(shortage)} ליטר לתוכנית`);}
  const lots=new Map<string,Lot[]>(),tempo=new Map<string,number|null>();
  for(const p of products){lots.set(p.id,pallets.filter(x=>x.zone!=='shipped'&&x.itemType===p.type&&sameStyle(x.beerStyle,p.style)&&parseDate(x.expiryDateStr)&&parseDate(x.expiryDateStr)!>=today).map(x=>({pallet:x,quantity:num(x.quantity),expiry:parseDate(x.expiryDateStr)!})));tempo.set(p.id,tempoNow(p,today));}
  const stock=(id:string)=>lots.get(id)!.reduce((s,l)=>s+l.quantity,0);
  function take(id:string,quantity:number){let need=quantity;const ls=lots.get(id)!;ls.sort((a,b)=>a.expiry.localeCompare(b.expiry));for(const l of ls){const qty=Math.min(l.quantity,need);l.quantity-=qty;need-=qty;if(need<=0)break;}return quantity-need;}
  const incoming=new Map<string,Map<string,number>>();
  const addIncoming=(day:string,id:string,qty:number)=>{const values=incoming.get(day)??new Map<string,number>();values.set(id,(values.get(id)??0)+qty);incoming.set(day,values);};
  const deliveries=plans.flatMap(w=>w.deliveries??[]);
  const transit=Math.max(1,Math.min(7,settings.deliveryTransitDays??1));
  const maxTrips=settings.maxWeeklyDeliveries??2;
  const tripDates=new Set([...deliveries.filter(d=>d.quantity>0).map(d=>d.dispatchDate),...actualShipments.map(s=>s.date)]);
  const actualTripDates=new Set(actualShipments.map(s=>s.date));
  const batchDates=new Map<string,string>();
  for(const p of products)for(const t of tanks)if(sameStyle(p.style,t.style))batchDates.set(`${t.batch}:${p.id}`,t.brewed);
  for(const w of plans){const error=validateTruckGroups(w.deliveries??[],products,maxTrips);if(error)warnings.add(error);}

  for(const d of deliveries)if(d.dispatchDate<today)warnings.add(`משלוח ${d.id.slice(0,6)} מתוארך בעבר: יש לעדכן מלאי טמפו ולסגור/לתקן את התכנון. אינו נספר כקליטה עתידית.`);
  const busy=new Set<string>(),counts=new Map<string,number>();
  for(const w of plans){const dates=new Set([...w.packaging.filter(r=>r.quantity>0&&r.date).map(r=>r.date!),...actuals.map(actualDate).filter((d):d is string=>!!d&&weekStart(d)===w.id)]);for(const date of dates)busy.add(date);counts.set(w.id,dates.size+w.packaging.filter(r=>r.quantity>0&&!r.date).reduce((s,r)=>s+(products.find(p=>p.id===r.productId)?.type==='crates'?Math.ceil(r.quantity/252):1),0));}
  // Actual runs also consume capacity in a week without a saved plan.
  for(const a of actuals){const date=actualDate(a);if(date&&date>=weekStart(today)&&!busy.has(date)){busy.add(date);counts.set(weekStart(date),(counts.get(weekStart(date))??0)+1);}}
  const points:DailyPoint[]=[],suggestions:DailySuggestion[]=[];
  const tankDays=new Map<string,Set<string>>();
  for(const t of pool){const dates=actuals.filter(a=>String(a.tankNumber)===t.number&&String(a.batchNumber)===t.batch).map(actualDate).filter((d):d is string=>!!d&&d>=t.brewed);if(dates.length)tankDays.set(t.id,new Set(dates));}
  for(const r of dated)for(const a of bookings.get(r.key)??[]){const ds=tankDays.get(a.tankId)??new Set<string>();ds.add(r.date!);tankDays.set(a.tankId,ds);}
  for(let day=today;day<end;day=addDays(day,1)){
    const packed=new Map<string,number>(),arrived=new Map<string,number>();
    for(const p of products)lots.set(p.id,lots.get(p.id)!.filter(l=>l.expiry>=day));
    for(const r of dated.filter(r=>r.date===day)){const p=products.find(p=>p.id===r.productId)!;const units=(bookings.get(r.key)??[]).reduce((s,a)=>s+a.liters,0)/litersPerUnit(p);lots.get(p.id)!.push(...projectedPallets(p,units,r.key));packed.set(p.id,(packed.get(p.id)??0)+units);}
    const week=weekStart(day),plan=plans.find(w=>w.id===week);const weekday=new Date(`${day}T12:00:00Z`).getUTCDay();
    const working=weekday<5&&!holidays.some(h=>h.date===day&&h.closed);
    if(recommend&&working&&weekday<4&&!busy.has(day)&&(counts.get(week)??0)<Math.min(settings.preferredRuns,plan?.maxRuns??settings.preferredRuns)){
      const ranked=products.filter(p=>weeklyDemand(p)>0&&tempo.get(p.id)!==null).sort((a,b)=>((tempo.get(a.id)??0)+stock(a.id))/weeklyDemand(a)-((tempo.get(b.id)??0)+stock(b.id))/weeklyDemand(b));
      for(const p of ranked){const daily=weeklyDemand(p)/7;const deficit=daily*(settings.targetWeeks*7+1)-stock(p.id)-(tempo.get(p.id)??0);const finishing=pool.some(t=>sameStyle(t.style,p.style)&&(tankDays.get(t.id)?.size??0)===1&&(available.get(t.id)??0)>=20);if(deficit<=0&&!finishing)continue;
        const tank=pool.find(t=>sameStyle(t.style,p.style)&&t.ready<=day&&(available.get(t.id)??0)>=litersPerUnit(p)*(p.type==='crates'?84:1)&&(tankDays.get(t.id)?.size??0)<2);
        if(!tank)continue;
        const supply=(available.get(tank.id)??0)/litersPerUnit(p),step=p.type==='crates'?84:1;
        const quantity=Math.min(packagingLimit(day,p.type),Math.floor((supply+1e-8)/step)*step);if(quantity<=0)continue;
        // Do not start a tank unless its remainder can fit in one more permitted packing day.
        const residual=(available.get(tank.id)??0)-quantity*litersPerUnit(p);
        const secondProduct=products.find(x=>sameStyle(x.style,p.style)&&x.type==='kegs'&&x.monthly>0);
        if(residual>=20&&((counts.get(week)??0)+2>Math.min(settings.preferredRuns,plan?.maxRuns??settings.preferredRuns)))continue;
        if(residual>=20&&(!secondProduct||(tankDays.get(tank.id)?.size??0)>=1))continue;
        if(residual>=20&&![1,2,3].some(offset=>{const d=addDays(day,offset);return weekStart(d)===week&&dayOfWeek(d)>=1&&dayOfWeek(d)<=3&&!busy.has(d)&&!holidays.some(h=>h.date===d&&h.closed);}))continue;
        const allocations=allocate([tank],available,p,quantity,day);
        const ds=tankDays.get(tank.id)??new Set<string>();ds.add(day);tankDays.set(tank.id,ds);
        suggestions.push({id:`pack:${day}:${p.id}`,kind:'packaging',date:day,productId:p.id,quantity,allocations,reason:residual<20?'ריקון מיכל ביום אחד; שארית קטנה מ־20 ליטר לבדיקה':'אריזה ראשונה; יתרת המיכל מיועדת לחביות ביום נוסף'});lots.get(p.id)!.push(...projectedPallets(p,quantity,`pack:${day}:${p.id}`));packed.set(p.id,(packed.get(p.id)??0)+quantity);busy.add(day);counts.set(week,(counts.get(week)??0)+1);break;
      }
    }
    for(const d of deliveries.filter(d=>d.dispatchDate===day&&!actualTripDates.has(day))){if(!lots.has(d.productId)||d.arrivalDate<day)continue;let sent=0;
      if(d.pallets?.length){for(const selected of d.pallets){if(selected.id.startsWith('planning:')){sent+=take(d.productId,selected.quantity);continue;}const lot=lots.get(d.productId)!.find(x=>x.pallet.id===selected.id);const qty=Math.min(lot?.quantity??0,selected.quantity);if(lot)lot.quantity-=qty;sent+=qty;}}
      else sent=take(d.productId,d.quantity);addIncoming(d.arrivalDate,d.productId,sent);if(sent+.01<d.quantity)warnings.add(`${shortDate(day)}: אין מספיק מלאי למשלוח ${d.id.slice(0,6)}; נשלחות בתחזית רק ${Math.floor(sent)} יחידות`);}
    // Process arrivals after dispatch; same-day receipt is an explicit user assumption.
    for(const [id,qty] of incoming.get(day)??[]){if(tempo.get(id)!==null)tempo.set(id,(tempo.get(id)??0)+qty);arrived.set(id,qty);}
    if(recommend&&working&&!tripDates.has(day)){
      const scheduled=[...tripDates].filter(d=>weekStart(d)===week).sort();
      const count=actualShipments.filter(x=>weekStart(x.date)===week).length+scheduled.filter(date=>!actualTripDates.has(date)).length;
      const pending=[...deliveries].filter(d=>d.dispatchDate>=day&&weekStart(d.dispatchDate)===week);
      // Prefer the existing booked trip over inventing another trip before it.
      if(count<maxTrips&&!pending.length){
        const needs=new Map<string,number>(),coverDays=new Map<string,number>();
        const nextRegularArrival=addDays(week,7+transit);
        const daysToNext=Math.max(1,Math.round((Date.parse(nextRegularArrival)-Date.parse(day))/86400000));
        let urgent=false;
        for(const p of products){const value=tempo.get(p.id),daily=weeklyDemand(p)/7;if(value===null||!daily)continue;
          const pipeline=[...incoming.entries()].filter(([date])=>date>day).reduce((sum,[,v])=>sum+(v.get(p.id)??0),0);
          coverDays.set(p.id,(value??0)/daily);
          const need=Math.max(0,Math.ceil(daily*(settings.targetWeeks*7+transit)-(value??0)-pipeline));
          // A second/exceptional trip exists only to cover demand until next week's regular receipt.
          const atRisk=(value??0)+pipeline<daily*daysToNext;
          if(atRisk&&stock(p.id)>0)urgent=true;
          if(count===0||atRisk)needs.set(p.id,need);
        }
        const mondaySupply=dated.some(r=>r.date===addDays(week,1))||pool.some(t=>t.ready===addDays(week,1));
        const mondaySafe=products.every(p=>{const daily=weeklyDemand(p)/7;return !daily||tempo.get(p.id)===null||(tempo.get(p.id)??0)>=daily*(1+transit);});
        const waitForMonday=weekday===0&&(mondaySupply||settings.preferredDeliveryDay===1)&&mondaySafe;
        const permitted=count===0?((weekday<=1&&!waitForMonday)||(weekday>1&&urgent)):urgent;
        if(permitted){
          const reservedIds=new Set(deliveries.filter(x=>x.dispatchDate>day).flatMap(x=>x.pallets??[]).map(x=>x.id));
          const selection=selectTruck(products,[...lots.values()].flat().filter(x=>!reservedIds.has(x.pallet.id)),needs,coverDays,batchDates);
          selection.warnings.forEach(w=>warnings.add(w));
          if(selection.pallets.length){const arrival=addDays(day,transit),truckId=`truck:${day}`;
            const reason=count>0?'משלוח שני נדרש לכיסוי עד הקליטה הרגילה בשבוע הבא':weekday>1?'משלוח חריג באמצע שבוע למניעת מחסור':weekday===1?'משלוח שבועי ביום שני':'משלוח שבועי ביום ראשון';
            for(const p of products){const chosen=selection.pallets.filter(x=>x.itemType===p.type&&sameStyle(x.beerStyle,p.style));if(!chosen.length)continue;
              const quantity=chosen.reduce((sum,x)=>sum+x.quantity,0);
              for(const chosenPallet of chosen){const lot=lots.get(p.id)!.find(x=>x.pallet.id===chosenPallet.id);if(lot)lot.quantity-=chosenPallet.quantity;}
              addIncoming(arrival,p.id,quantity);suggestions.push({id:`ship:${day}:${p.id}`,kind:'delivery',date:day,arrivalDate:arrival,productId:p.id,quantity,allocations:[],truckId,pallets:chosen,slots:selection.slots,reason});
            }
            tripDates.add(day);
          }
        }
      }
    }
    for(const p of products){const before=tempo.get(p.id);const demand=weeklyDemand(p)/7;const shortage=before===null?null:Math.max(0,demand-(before??0));const after=before===null?null:Math.max(0,(before??0)-demand);tempo.set(p.id,after);points.push({date:day,productId:p.id,brewery:stock(p.id),tempo:after,packed:packed.get(p.id)??0,arrived:arrived.get(p.id)??0,shortage});}
  }
  for(const [id,ds] of tankDays)if(ds.size&&(available.get(id)??0)>=20)warnings.add(`מיכל ${pool.find(t=>t.id===id)?.number??id}: נותרו ${Math.ceil(available.get(id)??0)} ליטר; טרם נמצא שיבוץ לריקון, המיכל לא ישוחרר לבישול`);
  return {points,suggestions,warnings:[...warnings],open};
}
/** Client validation is paired with role/revision protection in Firestore rules. */
export function validateDatedPlan(w:WeekPlan,settings:Settings,all:WeekPlan[],today:string):string|null{
  if(!Number.isInteger(w.maxRuns)||w.maxRuns<0||w.maxRuns>5)return 'מכסת האריזה חייבת להיות בין 0 ל־5';
  const days=new Map<string,{id:string;qty:number}>();
  const ids=new Set<string>();
  for(const r of w.packaging){const p=settings.products.find(p=>p.id===r.productId);if(!p||!Number.isInteger(r.quantity)||r.quantity<0)return 'פריט או כמות אריזה לא תקינים';if(r.id&&ids.has(r.id))return 'מזהה אריזה כפול';if(r.id)ids.add(r.id);if(!r.quantity)continue;
    if(r.date&&(!parseDate(r.date)||weekStart(r.date)!==w.id))return 'תאריך האריזה חייב להיות בתוך השבוע';
    if(p.type==='crates'&&r.quantity%84!==0)return 'יש לתכנן ארגזים במדרגות של 84';
    if(r.date&&dayOfWeek(r.date)>4)return 'אין אריזה רגילה בשישי או שבת';
    if(r.date){const old=days.get(r.date);if(old&&old.id!==p.id)return 'לא ניתן לארוז שני פריטים שונים באותו יום';const qty=(old?.qty??0)+r.quantity;if(qty>packagingLimit(r.date,p.type))return dayOfWeek(r.date)===0?'בראשון: עד 168 ארגזים או 100 חביות':'עד 252 ארגזים ביום';days.set(r.date,{id:p.id,qty});}
  }
  const undated=w.packaging.filter(r=>!r.date&&r.quantity>0).reduce((s,r)=>s+(settings.products.find(p=>p.id===r.productId)?.type==='crates'?Math.ceil(r.quantity/252):1),0);
  if(days.size+undated>w.maxRuns)return 'חריגה ממכסת ימי האריזה השבועית';
  for(const d of w.deliveries??[]){if(!settings.products.some(p=>p.id===d.productId)||!Number.isInteger(d.quantity)||d.quantity<=0||!parseDate(d.dispatchDate)||!parseDate(d.arrivalDate)||weekStart(d.dispatchDate)!==w.id||d.arrivalDate<d.dispatchDate)return 'יש להשלים משלוח בכמות חיובית, תאריך יציאה בשבוע ותאריך קליטה שאינו מוקדם ממנו';}
  const truckError=validateTruckGroups(w.deliveries??[],settings.products,settings.maxWeeklyDeliveries??2);if(truckError)return truckError;
  const savedIds=new Set(all.filter(x=>x.id!==w.id).flatMap(x=>x.deliveries??[]).flatMap(x=>x.pallets??[]).map(x=>x.id));if((w.deliveries??[]).flatMap(x=>x.pallets??[]).some(x=>savedIds.has(x.id)))return 'משטח כבר משויך למשלוח בשבוע אחר';
  for(const b of w.brews){if(dayOfWeek(b.date)<1||dayOfWeek(b.date)>3)return 'בישול משובץ בימים שני–רביעי בלבד';if(!parseDate(b.date)||weekStart(b.date)!==w.id||!b.style||!b.tankId||!Number.isFinite(b.liters)||b.liters<=0)return 'יש להשלים תאריך, סגנון, מיכל וכמות בישול';if(b.date>=today&&[...all.filter(x=>x.id!==w.id).flatMap(x=>x.brews),...w.brews.filter(x=>x.id!==b.id)].some(x=>x.tankId===b.tankId&&x.date>=today))return 'המיכל כבר משובץ לבישול עתידי';}
  if(!w.changeReason?.trim())return 'יש לבחור סיבה לשמירה או לשינוי התכנון';
  return null;
}
