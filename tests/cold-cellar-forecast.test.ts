import test from "node:test";
import assert from "node:assert/strict";
import { projectColdCellarMilestones, projectYeastAfterDryHop } from "../src/SERVICES/cellering/coldCellarForecast";

import { projectKnownYeastCompletions } from "../src/SERVICES/cellering/yeastCompletionForecast";

const tank = { id: "11", tankNumber: "11", beerStyle: "IPA", stage: { name: "בתסיסה" } };

test("dry hop on 9 October forecasts warm yeast drop on 14 October", () => {
  const result = projectYeastAfterDryHop(tank, [
    { id: "2026-10-09_0800", notes: "הוספת כשות" },
    { id: "2026-10-10_0830", notes: "סבב טמפ ולחץ" },
  ], "2026-10-10");
  assert.equal(result.length, 1);
  assert.equal(result[0].dueDate, "2026-10-14");
  assert.match(result[0].title, /הורדת שמרים/);
});

test("completed yeast drop suppresses duplicate projection", () => {
  assert.deepEqual(projectYeastAfterDryHop(tank, [
    { id: "2026-10-09_0800", notes: "הוספת כשות" },
    { id: "2026-10-10_0830", notes: "הורדת שמרים" },
  ], "2026-10-10"), []);
});

test("non-hoppy tank and absence of dated dry hop do not get forecast", () => {
  assert.deepEqual(projectYeastAfterDryHop({ ...tank, beerStyle: "לאגר" }, [
    { id: "2026-10-09_0800", notes: "הוספת כשות" },
  ], "2026-10-10"), []);
  assert.deepEqual(projectYeastAfterDryHop(tank, [
    { id: "invalid", notes: "הוספת כשות" },
  ], "2026-10-10"), []);
});

test("seasonal batch with dry-hop recipe receives warm-yeast follow-up", () => {
  const seasonal = {...tank, beerStyle:"בירת חורף", dryHopRequired:true, dryHopTargetPlato:6.5};
  const readings = [{id:"2026-10-09_0800", notes:"הוספת כשות"}];
  assert.equal(projectYeastAfterDryHop(seasonal, readings, "2026-10-10")[0]?.dueDate, "2026-10-14");
  assert.deepEqual(projectYeastAfterDryHop({...seasonal,dryHopRequired:false}, readings, "2026-10-10"), []);
});


test("cold yeast minimum reached: no calendar-only repeat", () => {
  const coldTank = { id: "9", tankNumber: "9", beerStyle: "IPA", stage: { name: "קר" } };
  const readings = [
    { id: "2026-10-09_0800", notes: "קירור מיכל" },
    { id: "2026-10-11_0900", notes: "הורדת 12 דליי שמרים", temp: 3 },
  ];
  assert.deepEqual(projectColdCellarMilestones(coldTank, readings, "2026-10-11"), []);
  assert.deepEqual(projectKnownYeastCompletions(coldTank, readings, "2026-10-11", {}), []);
});

test("partial cold yeast is forecast only for missing amount", () => {
  const coldTank = { id: "9", tankNumber: "9", beerStyle: "IPA", stage: { name: "קר" } };
  const readings = [
    { id: "2026-10-09_0800", notes: "קירור מיכל" },
    { id: "2026-10-11_0900", notes: "הורדת 8 דליי שמרים", temp: 3 },
  ];
  const forecast = projectKnownYeastCompletions(coldTank, readings, "2026-10-11", {});
  assert.equal(forecast.length, 1);
  assert.equal(forecast[0].dueDate, "2026-10-13");
  assert.match(forecast[0].title, /4 דליים/);
});

test("two documented cold yeast drops sum to the target", () => {
  const coldTank = { id: "9", tankNumber: "9", beerStyle: "IPA", stage: { name: "קר" } };
  const readings = [
    { id: "2026-10-09_0800", notes: "קירור מיכל" },
    { id: "2026-10-10_0900", notes: "הורדת 7 דליי שמרים", temp: 3 },
    { id: "2026-10-11_0900", notes: "הורדת 5 דליי שמרים", temp: 3 },
  ];
  assert.deepEqual(projectKnownYeastCompletions(coldTank, readings, "2026-10-11", {}), []);
});


test("tank 10: five documented cold yeast drops are not a new completion action", () => {
  const tank10 = { id: "10", tankNumber: "10", beerStyle: "IPA", stage: { name: "קר" } };
  const rows = [
    { id: "2026-09-21_0800", notes: "קירור", temp: 4 },
    { id: "2026-09-22_0800", notes: "הורדת 10 דליי שמרים", temp: 18 },
    { id: "2026-09-24_0800", notes: "הורדת 11 דליי שמרים", temp: 18 },
    { id: "2026-09-27_0800", notes: "הורדת 4 דליי שמרים", temp: 4 },
    { id: "2026-09-29_0800", notes: "הורדת 0.5 דליי שמרים", temp: 4 },
    { id: "2026-10-04_0800", notes: "הורדת 0.75 דליי שמרים", temp: 4 },
    { id: "2026-10-08_0800", notes: "הורדת 0.5 דליי שמרים", temp: 4 },
    { id: "2026-10-11_0800", notes: "הורדת 0.5 דליי שמרים", temp: 4 },
  ];
  assert.deepEqual(projectKnownYeastCompletions(tank10, rows, "2026-10-11", {}), []);
});
