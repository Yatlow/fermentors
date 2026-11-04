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

test("tank 9 in progress remains on today's Gantt when brewDate is still missing", () => {
  const inProgress = { ...live, batchNumber: "#1615", brewDate: "",
    tankStatus: true, brewProgress: { stageName: "הכנת מים", stageCode: 10, stageStartTimeText: "10:24" } };
  const entries = sourceBrewCalendarEntries([inProgress], [], week, date);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    id: "tank-9", tankNumber: "9", style: "IPA", date,
    batchNumber: "1615", liters: 2800, dateUnverified: true,
  });
  assert.equal(sourceBrewCalendarEntries([inProgress], [{ id: "saved", date, tankId: "tank-9",
    style: "IPA", liters: 2800 }], week, date).length, 0,
    "do not duplicate a correctly linked weekly brewing plan");
});
test("do not invent a new brew from blank date without live stage evidence", () => {
  const stale = { ...live, brewDate: "", tankStatus: true };
  assert.deepEqual(sourceBrewCalendarEntries([stale], [], week, date), []);
  assert.deepEqual(sourceBrewCalendarEntries([{ ...stale, brewProgress: {
    stageName: "הוצאה לתסיסה", stageCode: 120,
  }}], [], week, date), []);
  assert.deepEqual(sourceBrewCalendarEntries([{ ...live, action: 1, brewDate: "",
    brewProgress: { stageName: "קר", stageCode: 20, stageStartTimeText: "08:00" }
  }], [], week, date), []);
  assert.deepEqual(sourceBrewCalendarEntries([{ ...live, action: 3, brewDate: "",
    brewProgress: { stageName: "הכנת מים", stageCode: 10, stageStartTimeText: "08:00" }
  }], [], week, date), []);
});
test("malformed or historically dated brew is not incorrectly moved to today", () => {
  const active = { ...live, brewProgress: {
    stageName: "הכנת מים", stageCode: 10, stageStartTimeText: "10:24",
  } };
  for (const brewDate of ["31/02/2026", "03/11/2026"]) {
    assert.deepEqual(sourceBrewCalendarEntries([{ ...active, brewDate }], [], week, date), []);
  }
  const synced = sourceBrewCalendarEntries([{ ...active, brewDate: "04/11/2026" }], [], week, date);
  assert.equal(synced.length, 1);
  assert.equal(synced[0].dateUnverified, undefined, "remove the provisional warning once the date is synced");
});
