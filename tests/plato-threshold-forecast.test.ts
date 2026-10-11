import { dryHopThreshold, dryHopThresholdKey, recipeDryHopThreshold, batchDryHopThreshold } from "../src/SERVICES/cellering/dryHopThreshold";
import test from "node:test";
import assert from "node:assert/strict";
import { projectPlatoThresholdRecheck, projectLagerDiacetylRest } from "../src/SERVICES/cellering/platoThresholdForecast";

const specs = { tolorances: { dryHopMinPlato: 8, shutTankMinPlato: 5 } };
const fermentor = (beerStyle: string, stage = "בתסיסה") => ({
  id: "tank-10", tankNumber: "10", beerStyle, stage: { name: stage },
});

test("IPA Plato trend projects a conditional recheck, not an automatic dry hop", () => {
  const result = projectPlatoThresholdRecheck(fermentor("IPA"), [
    { id: "2026-10-08_0800", plato: 10 },
    { id: "2026-10-09_0800", plato: 9 },
  ], "2026-10-09", specs);
  assert.equal(result.length, 1);
  assert.equal(result[0].dueDate, "2026-10-11");
  assert.match(result[0].basis, /טמפרטורה ולחץ/);
});

test("Pale and Hoppy are classified as dry-hop styles", () => {
  for (const style of ["Pale", "Hoppy"]) {
    const forecast = projectPlatoThresholdRecheck(fermentor(style), [
      { id: "2026-10-08_0800", plato: 10 },
      { id: "2026-10-09_0800", plato: 9 },
    ], "2026-10-09", specs);
    assert.equal(forecast[0]?.title, "בדיקת תנאים לדרייהופ");
  }
});

test("does not project thresholds from stale or flat Plato readings", () => {
  const tank = fermentor("IPA");
  assert.deepEqual(projectPlatoThresholdRecheck(tank, [
    { id: "2026-10-01_0800", plato: 10 },
    { id: "2026-10-02_0800", plato: 9 },
  ], "2026-10-09", specs), []);
  assert.deepEqual(projectPlatoThresholdRecheck(tank, [
    { id: "2026-10-08_0800", plato: 9 },
    { id: "2026-10-09_0800", plato: 9 },
  ], "2026-10-09", specs), []);
});

test("stops projecting a completed action and avoids non-fermenting tanks", () => {
  assert.deepEqual(projectPlatoThresholdRecheck(fermentor("IPA"), [
    { id: "2026-10-08_0800", plato: 10 },
    { id: "2026-10-09_0800", plato: 9, notes: "כשות" },
  ], "2026-10-09", specs), []);
  assert.deepEqual(projectPlatoThresholdRecheck(fermentor("IPA", "קר"), [
    { id: "2026-10-08_0800", plato: 10 },
    { id: "2026-10-09_0800", plato: 9 },
  ], "2026-10-09", specs), []);
});

test("lager rest appears as a measured-rule action only with current Plato and 9–13°C", () => {
  const lager = fermentor("לאגר");
  const readings = [{ id: "2026-10-10_0800", plato: 7.5, temp: 11 }];
  const result = projectLagerDiacetylRest(lager, readings, "2026-10-10", { tolorances: { dycitalRestMinPlato: 8 } });
  assert.equal(result.length, 1);
  assert.match(result[0].title, /מנוחת דיאציטיל/);
  assert.match(result[0].id, /diacetyl-ready/);
  assert.deepEqual(projectLagerDiacetylRest(lager, [{ ...readings[0], temp: 8 }], "2026-10-10", specs), []);
  assert.deepEqual(projectLagerDiacetylRest(lager, [...readings, {id:"2026-10-10_0900",notes:"מנוחת דיאציטיל"}], "2026-10-10", specs), []);
});
test("lager future rest is only a conditional temperature-and-Plato recheck", () => {
  const result = projectLagerDiacetylRest(fermentor("לאגר"), [
    { id:"2026-10-09_0800", plato: 10, temp: 11 },
    { id:"2026-10-10_0800", plato: 9, temp: 11 },
  ], "2026-10-10", { tolorances: { dycitalRestMinPlato: 8 } });
  assert.equal(result.length, 1);
  assert.equal(result[0].dueDate, "2026-10-12");
  assert.match(result[0].title, /בדיקת תנאים/);
  assert.match(result[0].basis, /טמפרטורה/);
});
test("no lagers, completed rest and stale Plato do not produce a rest forecast", () => {
  assert.deepEqual(projectLagerDiacetylRest(fermentor("IPA"), [{id:"2026-10-10_0800",plato:7,temp:11}], "2026-10-10", specs), []);
  assert.deepEqual(projectLagerDiacetylRest(fermentor("לאגר"), [{id:"2026-10-01_0800",plato:7,temp:11}], "2026-10-10", specs), []);
});

test("dry hop thresholds depend on style and preserve explicit overrides", () => {
  assert.equal(dryHopThreshold("IPA", {}), 8);
  assert.equal(dryHopThreshold("פייל", {}), 7);
  assert.equal(dryHopThreshold("Hoppy Lager", {}), 6);
  assert.equal(dryHopThreshold("לאגר", {}), null);
  assert.equal(dryHopThresholdKey("Stout"), null);
  assert.equal(dryHopThreshold("פייל", {dryHopMinPlato: 12}), 7);
  assert.equal(dryHopThreshold("פייל", {dryHopMinPlatoPale: 6.5}), 6.5);
});
test("forecast uses pale and hoppy thresholds instead of old global value", () => {
  const rows = [{ id:"2026-10-08_0800",plato:9 },{ id:"2026-10-09_0800",plato:8 }];
  const spec = {tolorances:{dryHopMinPlato: 12}};
  const ipa = projectPlatoThresholdRecheck(fermentor("IPA"),rows,"2026-10-09",spec);
  const pale = projectPlatoThresholdRecheck(fermentor("פייל"),rows,"2026-10-09",spec);
  const hoppy = projectPlatoThresholdRecheck(fermentor("הופי"),rows,"2026-10-09",spec);
  assert.equal(ipa[0].dueDate,"2026-10-10");
  assert.equal(pale[0].dueDate,"2026-10-11");
  assert.equal(hoppy[0].dueDate,"2026-10-12");
});

test("recipe dry hop marker determines need; seasonal target is explicit", () => {
  const recipe = {style:"בירת חורף",hops:[{purpose:"whirlpool"},{purpose:"dryHop"}],dryHopTargetPlato:6.5};
  assert.equal(recipeDryHopThreshold(recipe,{}),6.5);
  assert.equal(recipeDryHopThreshold({...recipe,hops:[{purpose:"whirlpool"}]},{}),null);
  assert.equal(recipeDryHopThreshold({...recipe,dryHopTargetPlato:undefined},{}),null);
  assert.equal(recipeDryHopThreshold({...recipe,style:"IPA"}, {dryHopMinPlatoIpa:7.5}),7.5);
  assert.equal(recipeDryHopThreshold({...recipe,dryHopTargetPlato:31},{}),null);
});

test("batch settings drive live thresholds without changing Specs for IPA Pale Hoppy", () => {
  assert.equal(batchDryHopThreshold("IPA", { dryHopMinPlatoIpa: 8 }, {dryHopRequired:true,dryHopTargetPlato:6.5}),8);
  assert.equal(batchDryHopThreshold("פייל", { dryHopMinPlatoPale: 7 }, {dryHopRequired:true}),7);
  assert.equal(batchDryHopThreshold("הופי", { dryHopMinPlatoHoppy: 6 }, {dryHopRequired:true}),6);
  assert.equal(batchDryHopThreshold("בירת חורף", {}, {dryHopRequired:true,dryHopTargetPlato:6.5}),6.5);
  assert.equal(batchDryHopThreshold("בירת חורף", {}, {dryHopRequired:false,dryHopTargetPlato:6.5}),null);
  assert.equal(batchDryHopThreshold("IPA", {}, {dryHopRequired:false}),null);
  assert.equal(batchDryHopThreshold("IPA", {}, {}),8); // legacy records retain original inference
});
test("seasonal batch gets predicted dry-hop conditions from its recipe threshold", () => {
  const tank = { ...fermentor("בירת חורף"), dryHopRequired:true, dryHopTargetPlato:6 };
  const readings = [{id:"2026-10-08_0800",plato:9},{id:"2026-10-09_0800",plato:8}];
  const projected = projectPlatoThresholdRecheck(tank, readings, "2026-10-09", specs);
  assert.equal(projected[0]?.title, "בדיקת תנאים לדרייהופ");
  assert.equal(projected[0]?.dueDate, "2026-10-12");
  const notRequired = projectPlatoThresholdRecheck({...tank,dryHopRequired:false},readings,"2026-10-09",specs);
  assert.equal(notRequired[0]?.title,"בדיקת תנאים לסגירת נשם");
});
