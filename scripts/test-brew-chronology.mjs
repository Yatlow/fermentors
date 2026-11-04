import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/SERVICES/brewing/brewChronology.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { currentRecordedBrewStage, confidentPmClockCorrection } = await import(
  "data:text/javascript;base64," + Buffer.from(compiled).toString("base64")
);
const stages = [
  { key: "mashIn", label: "הכנסת לתת" },
  { key: "endTransfer", label: "סוף העברה" },
  { key: "boil", label: "רתיחה" },
  { key: "hop1", label: "הוספת כשות 1" },
  { key: "wp", label: "WP" },
  { key: "outToFermentor", label: "הוצאה לתסיסה" },
];

test("brew B's actual boil outranks brew A's finished fermentation transfer", () => {
  const blocks = {
    1: { fields: { brewDate: "2026-11-04", "mashIn.start": "09:54",
      "outToFermentor.start": "16:33", "outToFermentor.end": "17:01" } },
    2: { fields: { brewDate: "2026-11-04", "mashIn.start": "17:16",
      "endTransfer.start": "22:11", "boil.start": "22:21", "hop1.start": "22:21",
      "wp.start": "23:21", "outToFermentor.start": "23:41" } },
    3: { fields: {} },
  };
  const latest = currentRecordedBrewStage(blocks, stages, 3, "04/11/2026",
    new Date(2026, 10, 4, 22, 33));
  assert.equal(latest?.blockIndex, 2);
  assert.equal(latest?.start, "22:21");
  assert.notEqual(latest?.stage.key, "outToFermentor",
    "planned future transfer must not count as already reached");
});

test("an open B brew remains active before its future boil starts", () => {
  const blocks = {
    1: { fields: { brewDate: "2026-11-04", "outToFermentor.start": "16:33" } },
    2: { fields: { brewDate: "2026-11-04", "mashIn.start": "17:16",
      "endTransfer.start": "22:11", "boil.start": "22:21" } },
  };
  const latest = currentRecordedBrewStage(blocks, stages, 2, "04/11/2026",
    new Date(2026, 10, 4, 22, 15));
  assert.equal(latest?.blockIndex, 2);
  assert.equal(latest?.stage.key, "endTransfer");
});

test("B's rinse is more recent than A's finished transfer", () => {
  const withRinse = [
    { key: "mashIn", label: "הכנסת לתת" },
    { key: "rinse4", label: "שטיפה 4" },
    { key: "outToFermentor", label: "הוצאה לתסיסה" },
  ];
  const latest = currentRecordedBrewStage({
    1: { fields: { brewDate: "2026-11-04",
      "outToFermentor.start": "16:33", "outToFermentor.end": "17:01" } },
    2: { fields: { brewDate: "2026-11-04",
      "mashIn.start": "17:16", "rinse4.start": "21:32" } },
  }, withRinse, 2, "2026-11-04", new Date(2026, 10, 4, 21, 40));
  assert.equal(latest?.blockIndex, 2);
  assert.equal(latest?.stage.key, "rinse4");
});

test("a real overnight time crossover stays on the next calendar day", () => {
  const overnightStages = [
    { key: "mashIn", label: "מאש" },
    { key: "rest1", label: "השריה" },
  ];
  const latest = currentRecordedBrewStage({
    1: { fields: { brewDate: "04/11/2026", "mashIn.start": "23:50",
      "mashIn.end": "00:20", "rest1.start": "00:20" } },
  }, overnightStages, 1, "04/11/2026", new Date(2026, 10, 5, 0, 35));
  assert.equal(latest?.stage.key, "rest1");
});

test("the next undated block can start after midnight", () => {
  const latest = currentRecordedBrewStage({
    1: { fields: { brewDate: "2026-11-04", "mashIn.start": "21:40" } },
    2: { fields: { "mashIn.start": "01:00" } },
  }, stages, 2, "2026-11-04", new Date(2026, 10, 5, 1, 30));
  assert.equal(latest?.blockIndex, 2);
});

test("high-confidence 12-hour entry is corrected using neighboring process times", () => {
  assert.equal(confidentPmClockCorrection("10:11", "21:32", "22:21"), "22:11");
  assert.equal(confidentPmClockCorrection("10:11", "21:32", "10:21"), "22:11",
    "the next stage may also be mistyped with a 12-hour clock");
  assert.equal(confidentPmClockCorrection("10:11", "21:32"), "22:11");
  assert.equal(confidentPmClockCorrection("06:15", "17:45"), "18:15");
});

test("real midnight, implausible and already-24h times are never auto-changed", () => {
  assert.equal(confidentPmClockCorrection("00:20", "23:50"), null);
  assert.equal(confidentPmClockCorrection("09:05", "21:32"), null);
  assert.equal(confidentPmClockCorrection("10:11", "08:00"), null);
  assert.equal(confidentPmClockCorrection("22:11", "21:32"), null);
});

test("form writes the corrected time via the same Sheet + Firestore path", () => {
  const form = readFileSync(new URL("../src/components/brewing/BrewFormStepper.tsx", import.meta.url), "utf8");
  assert.match(form, /currentRecordedBrewStage\(/);
  assert.match(form, /const corrected = confidentPmClockCorrection\(value, previous, next\)/);
  assert.match(form, /onBlur=\{\(e\) => void commitBoilStart\(correctTypedClock\(/);
  assert.match(form, /normalizeUserTime\(correctTypedClock\(`rinse\$\{index\}\.time`/);
  assert.match(form, /setLocal\(key, corrected\)/);
  const rinse = form.slice(form.indexOf("async function commitRinse("), form.indexOf("async function commitBoilStart("));
  const boil = form.slice(form.indexOf("async function commitBoilStart("), form.indexOf("async function commitBoilEvent("));
  assert.match(rinse, /publishRecordedProgress\(nextExecution\)/);
  assert.match(boil, /publishRecordedProgress\(nextExecution\)/);
});

test("fermentation table defaults newest-first; timeline opens latest without repeated snaps", () => {
  const table = readFileSync(new URL("../src/components/dashboard/FermentationTable.tsx", import.meta.url), "utf8");
  const timeline = readFileSync(new URL("../src/components/dashboard/BatchTimeline.tsx", import.meta.url), "utf8");
  assert.match(table, /useState\(true\)/);
  assert.match(table, /newestFirst \? -1 : 1/);
  assert.match(table, /setNewestFirst\(\(current\) => !current\)/);
  assert.match(timeline, /initiallyPositionedTimeline\.current === timelineIdentity/);
  assert.match(timeline, /scrollToLatest\("instant"\)/);
  assert.match(timeline, /לאירוע האחרון/);
});
