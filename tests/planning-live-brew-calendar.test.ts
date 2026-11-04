import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceBrewCalendarEntries } from "../src/SERVICES/planning/liveBrewCalendar";

const date = "2026-11-04";
const week = "2026-11-01";
const live = { id: "tank-9", tankNumber: 9, action: 0,
  beerStyle: "IPA", brewDate: "04/11/2026", batchNumber: "#1614", beerVolume: 2800 };

test("a brew set for today appears in the current week before the planning decision is saved", () => {
  assert.deepEqual(sourceBrewCalendarEntries([live], [], week, date),
    [{ id: "tank-9", tankNumber: "9", style: "IPA", date, batchNumber: "1614", liters: 2800 }]);
});
test("a scheduled brew for today is not claimed as completed, and same-day active fermentation stays visible", () => {
  assert.equal(sourceBrewCalendarEntries([{ ...live, action: 1 }], [], week, date).length, 1);
});
test("existing plan decisions suppress the duplicate live brew, by tank or by batch", () => {
  const saved = { id: "brew-9", style: "IPA", tankId: "tank-9", date, liters: 2800 };
  assert.deepEqual(sourceBrewCalendarEntries([live], [saved], week, date), []);
  assert.deepEqual(sourceBrewCalendarEntries([live], [{ ...saved, tankId: "", batchNumber: "1614" }], week, date), []);
  assert.deepEqual(sourceBrewCalendarEntries([live], [{ ...saved, date: "2026-11-05" }], week, date).length, 1);
});
test("do not invent historical brewing, empty tanks or CLT source events", () => {
  const sources = [
    { ...live, brewDate: "03/11/2026" },
    { ...live, action: 3 },
    { ...live, tankStatus: true },
    { ...live, tankNumber: 1 },
    { ...live, beerStyle: "" },
    { ...live, batchNumber: "" },
  ];
  assert.deepEqual(sourceBrewCalendarEntries(sources, [], week, date), []);
});
test("only the matching week and valid brew date are projected; repeated snapshots are deduped", () => {
  assert.deepEqual(sourceBrewCalendarEntries([live], [], "2026-11-08", date), []);
  assert.equal(sourceBrewCalendarEntries([live, { ...live }], [], week, date).length, 1);
  assert.deepEqual(sourceBrewCalendarEntries([{ ...live, brewDate: "31/02/2026" }], [], week, date), []);
});
