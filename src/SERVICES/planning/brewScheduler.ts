import { addDays, brewAdvice, sameStyle, weekStart, type Actual, type BrewPlan, type Settings, type Tank, type WeekPlan } from './planningEngine';
import type { Pallet } from '../cooler/Pallettypes ';
import { tankReleases, weekday, type TankSource } from './productionCycle';
export type BrewProposal=BrewPlan & {reason:string;readyDate:string;dependent:boolean};
export function brewProposals(settings:Settings,pallets:Pallet[],tanks:Tank[],plans:WeekPlan[],actuals:Actual[],sources:TankSource[],today:string):BrewProposal[]{
  const releases=tankReleases(sources,tanks,plans,settings,actuals,today),booked=new Set(plans.flatMap(w=>w.brews).filter(b=>b.date>=today).map(b=>b.tankId));
  const result:BrewProposal[]=[];
  for(const need of brewAdvice(settings,pallets,tanks,plans,today).sort((a,b)=>a.brewBy.localeCompare(b.brewBy))){
    let remaining=need.liters;
    for(const release of releases.filter(r=>r.date&&r.workLiters>0&&!booked.has(r.tankId)).sort((a,b)=>a.date!.localeCompare(b.date!))){
      if(remaining<=0)break;
      let date=[today,release.date!,need.brewBy].sort().at(-1)!;
      while(weekday(date)<1||weekday(date)>3)date=addDays(date,1);
      if(date>=addDays(weekStart(today),84))continue;
      const lead=Math.max(...settings.products.filter(p=>sameStyle(p.style,need.style)).map(p=>p.leadDays),21);
      result.push({id:`brew:${release.tankId}:${date}:${need.style}`,tankId:release.tankId,style:need.style,date,liters:release.workLiters,readyDate:addDays(date,lead),dependent:!!release.emptyDate,reason:release.reason+(date>need.brewBy?' · מאוחר ממועד הביקוש הרצוי':'')});
      remaining-=release.workLiters*.9;booked.add(release.tankId);
    }
  }
  return result;
}
