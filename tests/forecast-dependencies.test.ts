import test from "node:test";
import assert from "node:assert/strict";
import { validateForecastDependencies } from "../src/SERVICES/cellering/forecastDependencies";

const tank = { id: "17", tankNumber: "17", beerStyle: "IPA", stage: { name: "בתסיסה" } };
const hop = (date: string) => ({
  id: "17:plato-recheck:" + date, tankNumber: "17", dueDate: date,
  title: "צפי לדרייהופ — בדיקת תנאים", basis: "curve",
});
const cooling = (date: string) => ({
  id: "17:cooling-conditions:" + date, tankNumber: "17", dueDate: date,
  title: "צפי לסיום תסיסה לקראת קירור — בדיקת תנאים", basis: "curve",
});

test("tank 17: projected Thursday dry-hop entails Tuesday yeast and no cooling before Wednesday", () => {
  const forecast = validateForecastDependencies(tank, [], "2026-11-18",
    [hop("2026-11-19"), cooling("2026-11-22")]);
  assert.equal(forecast.find(x => x.id.includes("warm-yeast-after-projected"))?.dueDate, "2026-11-24");
  assert.equal(forecast.find(x => x.id.includes(":cooling-readiness:"))?.dueDate, "2026-11-25");
  assert.ok(!forecast.some(x => x.id.includes(":cooling-conditions:")));
  assert.equal(forecast.filter(x => /דרייהופ/.test(x.title) && x.title.includes("צפי לדרייהופ")).length, 1);
});

test("performed dry-hop starts the five-day actual clock; no duplicate projected yeast", () => {
  const forecast = validateForecastDependencies(tank,
    [{ id: "2026-11-19_1000", notes: "הוספת כשות" }], "2026-11-20",
    [cooling("2026-11-22")]);
  assert.equal(forecast.find(x => x.id.includes(":cooling-readiness:"))?.dueDate, "2026-11-25");
  assert.equal(forecast.some(x => x.id.includes(":warm-yeast-after-projected")), false);
});

test("completed yeast drop allows cooling from following day, never the same day", () => {
  const forecast = validateForecastDependencies(tank, [
    { id: "2026-11-19_0900", notes: "הוספת כשות" },
    { id: "2026-11-24_0800", notes: "הורדת שמרים 8 דליים" },
  ], "2026-11-24", [cooling("2026-11-24")]);
  assert.equal(forecast[0]?.dueDate, "2026-11-25");
});

test("a yeast drop BEFORE predicted dry-hop does not satisfy its five-day wait", () => {
  const result = validateForecastDependencies(tank,
    [{ id: "2026-11-18_0800", notes: "הורדת שמרים 2 דליים" }],
    "2026-11-18", [hop("2026-11-19"), cooling("2026-11-22")]);
  assert.equal(result.find(x => x.id.includes(":cooling-readiness:"))?.dueDate, "2026-11-25");
  assert.equal(result.filter(x => x.id.includes("warm-yeast-after-projected")).length, 1);
});

test("an overdue yeast drop is not assumed done; cooling waits until at least tomorrow", () => {
  const result = validateForecastDependencies(tank,
    [{ id: "2026-11-01_0900", notes: "הוספת כשות" }],
    "2026-11-18", [cooling("2026-11-18")]);
  assert.equal(result[0]?.dueDate, "2026-11-19");
});

test("Saturday future yeast is deferred to Sunday; cooling follows on Monday", () => {
  const result = validateForecastDependencies(tank, [], "2026-11-15",
    [hop("2026-11-16"), cooling("2026-11-19")]);
  assert.equal(result.find(x => x.id.includes("warm-yeast-after-projected"))?.dueDate, "2026-11-22");
  assert.equal(result.find(x => x.id.includes(":cooling-readiness:"))?.dueDate, "2026-11-23");
});

test("without actual or predictable warm yeast removal, curve alone cannot promise cooling", () => {
  const noHop = validateForecastDependencies(tank, [], "2026-11-18", [cooling("2026-11-22")]);
  assert.deepEqual(noHop, []);
  const wheat = { ...tank, beerStyle: "חיטה" };
  assert.deepEqual(validateForecastDependencies(wheat, [], "2026-11-18",
    [cooling("2026-11-22")]), []);
  const withYeast = validateForecastDependencies(wheat, [], "2026-11-18",
    [cooling("2026-11-22")], [{
      id: "17:non-hoppy-warm-yeast:2026-11-24", tankNumber: "17",
      dueDate: "2026-11-24", title: "צפי להורדת שמרים חמה — בדיקת תנאים", basis: "",
    }]);
  assert.equal(withYeast[0]?.dueDate, "2026-11-25");
});

test("recorded cooling removes warm-stage readiness estimates", () => {
  const result = validateForecastDependencies(tank,
    [{ id: "2026-11-18_0900", notes: "קירור מיכל ל4°C" }], "2026-11-18",
    [hop("2026-11-19"), cooling("2026-11-22")]);
  assert.equal(result.some(x => x.id.includes(":cooling-")), false);
});
