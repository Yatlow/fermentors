import assert from "node:assert/strict";
import test from "node:test";
import {
  collapseMeasurementsToLatestPerDay,
  measurementDayKeyFromId,
  mergeOptimisticMeasurementIntoHistory,
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

test("app carbonation updates today's visible measurement without inventing a second row", () => {
  const rows = mergeOptimisticMeasurementIntoHistory([
    { id: "2026-09-15_0900", carbonation: 2.31 },
    { id: "2026-09-16_0715", temp: 1.2, pressure: 1.1, carbonation: 2.36 },
  ], {
    id: "2026-09-16_1127",
    carbonation: 2.48,
  });

  assert.equal(rows.length, 2);
  assert.equal(rows[1].id, "2026-09-16_0715");
  assert.equal(rows[1].carbonation, 2.48);
  assert.equal(rows[1].pressure, 1.1);
});

test("app cellar action appends today's note immediately", () => {
  const rows = mergeOptimisticMeasurementIntoHistory([
    {
      id: "2026-09-16_0715",
      temp: 1.2,
      pressure: 1.1,
      notes: "בדיקת גיזוז 2.30",
    },
  ], {
    id: "2026-09-16_1130",
    notes: "כיוון פורק ל: 1.3 bar",
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "2026-09-16_0715");
  assert.equal(rows[0].notes, "בדיקת גיזוז 2.30 | כיוון פורק ל: 1.3 bar");
  assert.equal(rows[0].pressure, 1.1);
});


test("legacy three-digit measurement times are recognized and sorted chronologically", () => {
  assert.equal(measurementDayKeyFromId("2026-08-28_917"), "2026-08-28");

  const rows = collapseMeasurementsToLatestPerDay([
    { id: "2026-08-28_917", temp: 17 },
    { id: "2026-08-28_1010", temp: 18 },
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "2026-08-28_1010");
});
