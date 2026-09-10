import { doc, runTransaction, serverTimestamp } from 'firebase/firestore';
import { auth, db } from '../../firebase';
import type { Pallet } from '../cooler/Pallettypes ';
import { dateKey, parseDate } from './planningEngine';
/** Explicit action only: no zone movement, shipment creation or stock deduction. */
export async function markPlanningPallets(selected:Pallet[]):Promise<void>{
  if(!auth.currentUser)throw new Error('נדרשת התחברות');
  if(!selected.length||selected.some(p=>p.id.startsWith('planning:')))throw new Error('ניתן לסמן רק משטחים קיימים בפועל');
  if(new Set(selected.map(p=>p.id)).size!==selected.length)throw new Error('משטח כפול');
  await runTransaction(db,async tx=>{
    const refs=selected.map(p=>doc(db,'pallets',p.id));
    const snapshots=await Promise.all(refs.map(ref=>tx.get(ref)));
    snapshots.forEach((snapshot,i)=>{
      const now=snapshot.data(),expected=selected[i];
      if(!snapshot.exists()||!now||!['cooler','pending','bottleRoom','loadingDock'].includes(now.zone)||now.quantity!==expected.quantity||now.itemType!==expected.itemType||now.beerStyle!==expected.beerStyle||now.batchNumber!==expected.batchNumber||now.expiryDateStr!==expected.expiryDateStr||!parseDate(now.expiryDateStr)||parseDate(now.expiryDateStr)!<dateKey(new Date()))throw new Error('המלאי השתנה או אינו תקף; רעננו את ההמלצה לפני סימון');
    });
    refs.forEach(ref=>tx.update(ref,{markedForShipment:true,updatedAt:serverTimestamp()}));
  });
}
