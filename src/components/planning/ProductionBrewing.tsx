import type { Fermentor } from '../../App';
import type { Pallet } from '../../SERVICES/cooler/Pallettypes ';
import { type Actual, type Settings, type Tank, type WeekPlan } from '../../SERVICES/planning/planningEngine';
import { shortDate } from '../../SERVICES/planning/dailyPlanner';
import { brewProposals } from '../../SERVICES/planning/brewScheduler';
import { tankReleases } from '../../SERVICES/planning/productionCycle';
export default function ProductionBrewing({settings,pallets,tanks,plans,actuals,brews,today}:{settings:Settings;pallets:Pallet[];tanks:Tank[];plans:WeekPlan[];actuals:Actual[];brews:Fermentor[];today:string}){
 const proposals=brewProposals(settings,pallets,tanks,plans,actuals,brews,today),releases=tankReleases(brews,tanks,plans,settings,actuals,today);
 return <section><h2>שיבוץ בישולים מוצע · עד 12 שבועות</h2><p>מבוסס על נפח העבודה בדאשבורד ועל ריקון בתוכנית השמורה. אין שיבוץ למיכל שנפחו חסר. ההצעה היא למילוי מיכל; מספר הבישולים והמשמרות טעונים בדיקה משום שלא הוגדרו נפח וזמן למחזור בישול.</p><div className="bp-product-grid">{proposals.map(b=><article className="bp-card" key={b.id}><h3>{shortDate(b.date)} · {b.style}</h3><b>מיכל {brews.find(t=>t.id===b.tankId)?.tankNumber??b.tankId} · {b.liters.toLocaleString()} ל׳</b><p>מוכן לאריזה משוער: {shortDate(b.readyDate)}</p><p>{b.reason}</p><small>לא אושר · ניתן להעתיק בטיוטת השבוע בלוח הייצור</small></article>)}</div>{!proposals.length&&<p>אין שיבוץ ישים כרגע. בדקו צורך בבישול, נפח עבודה ותוכנית לריקון מיכלים.</p>}<details><summary>זמינות מיכלים לבישול</summary>{releases.map(r=><p key={r.tankId}>מיכל {brews.find(t=>t.id===r.tankId)?.tankNumber??r.tankId}: {r.date?shortDate(r.date):'ללא מועד שחרור'} · {r.reason}{!r.workLiters?' · חסר נפח עבודה בדאשבורד':''}</p>)}</details></section>;
}
