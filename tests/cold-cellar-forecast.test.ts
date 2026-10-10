import test from "node:test";
import assert from "node:assert/strict";
import { projectYeastAfterDryHop } from "../src/SERVICES/cellering/coldCellarForecast";

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
