import test from "node:test";
import assert from "node:assert/strict";
import { reviewPackagingDecisionChanges } from "../src/SERVICES/planning/decisionChangeReview";
import { emptyWeek } from "../src/SERVICES/planning/planningEngine";
import type { PlanningSnapshot } from "../src/SERVICES/planning/planningReports";

const product = { id:"wheat-c", sku:"wheat-c", style:"חיטה", type:"crates" as const, monthly:420, tempo:null, tempoDate:"", leadDays:7 };
const snapshot = (checkpoint:"lead2"|"lead1"|"opening", amount:number, reason?:string): PlanningSnapshot => ({
  id:"2026-09-20:"+checkpoint, targetWeek:"2026-09-20", checkpoint, state:"captured",
  settings:null, plan:{...emptyWeek("2026-09-20"), changeReason:reason,
    packaging:[{productId:"wheat-c",quantity:amount,date:"2026-09-21"}]},
});
test("describes a changed decision only between two captured adjacent checkpoints",()=>{
 const evidence=reviewPackagingDecisionChanges([product],[
  snapshot("lead2",100),snapshot("lead1",150,"הגדלת ביקוש"),snapshot("opening",150)
 ],[{id:"a",date:"2026-09-21",beerStyle:"חיטה",packagingType:"bottles",quantity:120,unit:"ארגזים"}],"2026-09-20","2026-10-10");
 assert.equal(evidence.length,1);
 assert.match(evidence[0].evidence,/100 ← 150/);
 assert.match(evidence[0].evidence,/120/);
 assert.match(evidence[0].limitation,/לא שהשינוי גרם/);
});
test("never infers an intermediate change across absent historical checkpoints",()=>{
 const evidence=reviewPackagingDecisionChanges([product],[
  snapshot("lead2",100),snapshot("opening",150)
 ],[],"2026-09-20","2026-10-10");
 assert.deepEqual(evidence,[]);
});
test("does not evaluate unfinished weeks or invent zero execution",()=>{
 const rows=[snapshot("lead2",100),snapshot("lead1",150)];
 assert.deepEqual(reviewPackagingDecisionChanges([product],rows,[],"2026-09-20","2026-09-22"),[]);
 const findings=reviewPackagingDecisionChanges([product],rows,[],"2026-09-20","2026-10-10");
 assert.match(findings[0].evidence,/אין דיווח/);
 assert.doesNotMatch(findings[0].evidence,/דווחו 0/);
});
