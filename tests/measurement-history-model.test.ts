import assert from "node:assert/strict";
import test from "node:test";
import {
  collapseMeasurementsToLatestPerDay,
  measurementDayKeyFromId,
} from "../src/SERVICES/getAndPost/measurementHistoryModel";

test("measurement day key ignores the time suffix", () => {
  assert.equal(measurementDayKeyFromId("2026-09-16_0715"), "2026-09-16");
  assert.equal(measurementDayKeyFromId("2026-09-16_1802"), "2026-09-16");
});

test("latest Firestore document wins when a Sheet row was recreated on the same day", () => {
  const rows = collapseMeasurementsToLatestPerDay([
    { id: "2026-09-15_0900", temp: 18 },
    { id: "2026-09-16_0715", temp: 19, notes: "old test row" },
    { id: "2026-09-16_1042", temp: 20, notes: "current Sheet row" },
    { id: "2026-09-17_0810", temp: 18.5 },
  ]);

  assert.deepEqual(rows.map((row) => row.id), [
    "2026-09-15_0900",
    "2026-09-16_1042",
    "2026-09-17_0810",
  ]);
  assert.equal(rows[1].notes, "current Sheet row");
});

test("unknown legacy ids are preserved instead of silently deleted", () => {
  const rows = collapseMeasurementsToLatestPerDay([
    { id: "legacy-row", temp: 17 },
    { id: "2026-09-16_0715", temp: 19 },
    { id: "2026-09-16_1042", temp: 20 },
  ]);

  assert.equal(rows.some((row) => row.id === "legacy-row"), true);
  assert.equal(rows.some((row) => row.id === "2026-09-16_0715"), false);
  assert.equal(rows.some((row) => row.id === "2026-09-16_1042"), true);
});
