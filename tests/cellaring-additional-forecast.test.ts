import test from "node:test";
import assert from "node:assert/strict";
import { projectKnownYeastCompletions } from "../src/SERVICES/cellering/yeastCompletionForecast";
import { projectCoolingReadinessCheck } from "../src/SERVICES/cellering/platoThresholdForecast";
import { shouldShowNeglectedTank } from "../src/SERVICES/cellering/neglectWeekday";

const tank = {id:"tank-10", tankNumber:"10", beerStyle:"IPA", stage:{name:"בתסיסה"}};
test("warm completion appears only when a recorded quantity is below configured minimum",()=>{
  const rows = [{id:"2026-10-10_0810",notes:"הורדת שמרים 5 דליים",temp:18}];
  const result=projectKnownYeastCompletions(tank,rows,"2026-10-11",{yeastDropMinimums:{ipa_triple_warm:12}});
  assert.equal(result.length,1);
  assert.equal(result[0].dueDate,"2026-10-11");
  assert.match(result[0].title,/7 דליים/);
  assert.deepEqual(projectKnownYeastCompletions(tank,[{...rows[0],notes:"הורדת שמרים"}],"2026-10-11",{}),[]);
  assert.deepEqual(projectKnownYeastCompletions(tank,[{...rows[0],notes:"הורדת שמרים 12 דליים"}],"2026-10-11",{}),[]);
});
test("cold completion requires exactly one quantified post-cooling cold drop",()=>{
 const cold={...tank,stage:{name:"קר"}};
 const records=[{id:"2026-10-08_0800",notes:"קירור",temp:4},{id:"2026-10-09_0800",notes:"הורדת שמרים 4 דליים",temp:4}];
 const forecast=projectKnownYeastCompletions(cold,records,"2026-10-10",{});
 assert.equal(forecast.length,1);
 assert.equal(forecast[0].dueDate,"2026-10-11");
 assert.match(forecast[0].title,/8 דליים/);
 assert.deepEqual(projectKnownYeastCompletions(cold,[...records,{id:"2026-10-10_0800",notes:"הורדת שמרים 2 דליים",temp:4}],"2026-10-10",{}),[]);
});
test("cooling forecast is conditional and requires both yeast drop and falling fresh Plato",()=>{
 const rows=[{id:"2026-10-09_0800",plato:7,notes:"הורדת שמרים"},{id:"2026-10-10_0800",plato:6}];
 const result=projectCoolingReadinessCheck(tank,rows,"2026-10-10");
 assert.equal(result.length,1);
 assert.match(result[0].title,/בדיקת מוכנות לקירור/);
 assert.deepEqual(projectCoolingReadinessCheck(tank,rows.slice(1),"2026-10-10"),[]);
 assert.deepEqual(projectCoolingReadinessCheck(tank,[...rows,{id:"2026-10-10_0930",notes:"קירור"}],"2026-10-10"),[]);
});
test("neglect shown Monday through Thursday, never Sunday or Friday/Saturday",()=>{
 assert.deepEqual(Array.from({length:7},(_,day)=>shouldShowNeglectedTank(day)),[false,true,true,true,true,false,false]);
});
