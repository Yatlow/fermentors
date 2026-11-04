import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../server/brewSheetHourlyReconciliation.js", import.meta.url), "utf8");
const now = new Date("2026-11-04T08:00:00.000Z");

function sheetRows(blocks = 1) {
  const rows = Array.from({ length: 168 }, () => Array(8).fill(""));
  rows[0][3] = "13"; // D1: tank number, not the current user's ID
  rows[0][5] = "#1614"; // F1: real Sheet batch number
  const headerRows = [4, 59, 106];
  for (let index = 0; index < blocks; index++) {
    const header = headerRows[index] - 1;
    rows[header][1] = "סוג:";
    rows[header][3] = "אצווה:";
    rows[header][4] = "1614" + "ABC"[index];
    rows[header + 13][0] = "HLT";
    rows[header + 14][0] = "MASH IN";
    rows[header + 15][3] = "הכנסת לתת";
    rows[header + 17][3] = "השריה 1";
    rows[header + 18][0] = "F.R.";
    rows[header + 19][0] = "L.R.";
  }
  return rows;
}

function startedExecution(blocks = {
  1: { fields: {
    "mashIn.start": "13:21",
    hltWaterAmount: "1550", hltWaterTemp: "62",
    lauterWaterAmount: "850", lauterWaterTemp: "67.1",
  } },
}) {
  return { batchNumber: "1614", blocks };
}

function environment(options = {}) {
  const rows = options.rows ?? sheetRows(options.blockCount ?? 1);
  const properties = new Map();
  const calls = { sheets: 0, reads: 0, writes: [], flushes: 0, log: [] };
  const data = {
    action: options.action ?? 0,
    tankNumber: options.tankNumber ?? 13,
    batchNumber: options.batchNumber ?? "#1614",
    sheetUrl: "https://docs.google.com/spreadsheets/d/test-sheet-id/edit",
    tankStatus: false,
    brewDate: options.brewDate ?? "04/11/2026",
    brewProgress: options.progress ?? { stageStartTimeText: "13:21" },
  };
  const execution = options.execution ?? startedExecution();
  const entry = { id: "13", data };
  const sheet = {
    getDataRange() {
      return { getDisplayValues() { return rows.map(row => [...row]); } };
    },
    getRange(row, col) {
      assert.ok(row >= 1 && row <= rows.length);
      assert.ok(col >= 1 && col <= 8);
      return {
        getDisplayValue() { return String(rows[row - 1][col - 1] ?? ""); },
        getFormula() { return (options.formulas ?? {})[row + ":" + col] ?? ""; },
        setValue(value) {
          rows[row - 1][col - 1] = String(value);
          calls.writes.push({ row, col, value });
          return this;
        },
      };
    },
  };
  const context = {
    Date, Map, Number, Array, Object, String, RegExp, JSON, Math, Logger: {
      log(message) { calls.log.push(String(message)); },
    },
    Utilities: { formatDate() { return "20261104"; } },
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty(name) { return properties.get(name) || null; },
          setProperty(name, value) { properties.set(name, String(value)); },
        };
      },
    },
    ScriptApp: { getOAuthToken() { return "token"; } },
    UrlFetchApp: { fetch(url) {
      calls.reads++;
      assert.match(url, /\/brews\/1614$/);
      return {
        getResponseCode() { return options.brewNotFound ? 404 : 200; },
        getContentText() { return JSON.stringify({
          fields: { brewingExecution: { value: execution } },
        }); },
      };
    } },
    SpreadsheetApp: {
      openById(id) {
        assert.equal(id, "test-sheet-id");
        calls.sheets++;
        return { getSheets() { return [sheet]; } };
      },
      flush() { calls.flushes++; },
    },
    FIREBASE_PROJECT_ID: "test-project",
    FC_CYCLE_CONTEXT_: null,
    extractSpreadsheetId() { return "test-sheet-id"; },
    normalizeFirestoreValue(field) { return field.value; },
    getFermentorFromFirestore(_project, id) {
      assert.equal(id, "13");
      return options.stale ? { ...data, action: 1 } : data;
    },
  };
  vm.runInNewContext(source, context, { filename: "brewSheetHourlyReconciliation.js" });
  return { context, rows, calls, entry, properties, sheet };
}

test("a started action-0 brew fills missing HLT temperature + both MASH IN water cells automatically", () => {
  const h = environment();
  const hlt = 4 - 1 + 13;
  const mash = 4 - 1 + 14;
  h.rows[hlt][1] = "1550"; // already correctly present, MUST NOT be rewritten
  const result = h.context.brewSheetHourlyMaintenance_([h.entry], now);
  assert.equal(result.due, true);
  assert.equal(result.processed, 1);
  assert.equal(result.repaired, 4); // three water gaps + the already-recorded mash-in start
  assert.equal(result.verified, 4);
  assert.equal(h.rows[hlt][2], "62");
  assert.equal(h.rows[mash][1], "850");
  assert.equal(h.rows[mash][2], "67.1");
  assert.equal(h.calls.writes.length, 4);
  assert.equal(h.calls.flushes, 1);
  assert.ok(h.calls.writes.every(write => [2, 3, 5].includes(write.col)));
  assert.match(h.calls.log.join("\n"), /BREW HOURLY RECONCILE/);
});

test("reconciliation is hourly, idempotent and does not produce duplicate Sheet writes", () => {
  const h = environment();
  const first = h.context.brewSheetHourlyMaintenance_([h.entry], now);
  assert.equal(first.repaired, 5);
  assert.equal(h.context.brewSheetHourlyMaintenance_([h.entry], new Date(now.getTime() + 5 * 60000)).due, false);
  assert.equal(h.context.brewSheetHourlyMaintenance_([h.entry], new Date(now.getTime() + 3600000)).repaired, 0);
  assert.equal(h.calls.writes.length, 5);
  assert.equal(h.calls.reads, 2);
});

test("a staged brew in another block is mapped strictly to its own A/B/C labels", () => {
  const h = environment({
    blockCount: 3,
    execution: startedExecution({
      1: { fields: { "mashIn.start": "13:21", hltWaterTemp: "62" } },
      2: { fields: { hltWaterTemp: "63", lauterWaterAmount: "950" } },
      3: { fields: { hltWaterTemp: "64", lauterWaterAmount: "1000" } },
    }),
  });
  const result = h.context.brewSheetHourlyMaintenance_([h.entry], now);
  assert.equal(result.repaired, 6);
  assert.equal(h.rows[4 - 1 + 13][2], "62");
  assert.equal(h.rows[59 - 1 + 13][2], "63");
  assert.equal(h.rows[106 - 1 + 13][2], "64");
  assert.equal(h.rows[59 - 1 + 14][1], "950");
  assert.equal(h.rows[106 - 1 + 14][1], "1000");
  assert.equal(h.rows[4 - 1 + 15][4], "13:21");
});

test("physical brew start, action 0, date and current assignment must all be safe", () => {
  for (const condition of [
    { action: 1 },
    { action: 5 },
    { brewDate: "05/11/2026" },
    { progress: {}, execution: startedExecution({ 1: { fields: { hltWaterTemp: "62" } } }) },
    { stale: true },
    { brewNotFound: true },
  ]) {
    const h = environment(condition);
    const result = h.context.brewSheetHourlyMaintenance_([h.entry], now);
    assert.equal(result.repaired, 0, JSON.stringify(condition));
    assert.equal(h.calls.writes.length, 0);
  }
});

test("never overwrite a manual value, a formula or a misplaced semantic label", () => {
  const h = environment({
    formulas: { "17:3": "=IF(A1,62,\"\")" },
  });
  const hlt = 4 - 1 + 13;
  const mash = 4 - 1 + 14;
  h.rows[hlt][2] = "63"; // manual correction, never clobber
  h.rows[mash][1] = "999"; // manual correction, never clobber
  const result = h.context.brewSheetHourlyMaintenance_([h.entry], now);
  assert.equal(result.repaired, 3); // stage timestamp + two still-missing cells
  assert.equal(h.rows[hlt][2], "63");
  assert.equal(h.rows[mash][1], "999");

  const withFormula = environment({
    formulas: { [String(hlt + 1) + ":3"]: '=IF(TRUE,"","")' },
  });
  const output = withFormula.context.brewSheetHourlyMaintenance_([withFormula.entry], now);
  assert.equal(output.repaired, 4);
  assert.equal(withFormula.rows[hlt][2], "");

  const wrongLabel = environment();
  wrongLabel.rows[hlt][0] = "יוצא";
  assert.equal(wrongLabel.context.brewSheetHourlyMaintenance_([wrongLabel.entry], now).repaired, 3);
  assert.equal(wrongLabel.rows[hlt][2], "");
});

test("a mismatched sheet or ambiguous block never receives corrections", () => {
  for (const mutate of [
    rows => { rows[0][5] = "1613"; },
    rows => { rows[0][3] = "19"; },
    rows => { rows[3][4] = "1613A"; },
    rows => { rows[18][0] = "HLT"; }, // duplicate HLT row in the same A block
  ]) {
    const h = environment();
    mutate(h.rows);
    const result = h.context.brewSheetHourlyMaintenance_([h.entry], now);
    if (h.rows[0][5] === "1613" || h.rows[0][3] === "19" ||
        h.rows[3][4] === "1613A") {
      assert.equal(result.repaired, 0);
      assert.ok(result.errors > 0 || result.unmapped > 0);
    } else {
      assert.equal(h.rows[4 - 1 + 13][2], "");
    }
  }
});

test("stage times and measured Plato only go into semantically labeled rows", () => {
  const h = environment({
    execution: startedExecution({
      1: { fields: {
        "mashIn.start": "13:21",
        "mashIn.end": "13:43",
        "rest1.start": "13:43",
        "rest1.temp": "68.5",
        frPlato: "15.6",
      } },
    }),
  });
  const result = h.context.brewSheetHourlyMaintenance_([h.entry], now);
  assert.equal(result.repaired, 5);
  const header = 4 - 1;
  assert.equal(h.rows[header + 15][4], "13:21");
  assert.equal(h.rows[header + 15][5], "13:43");
  assert.equal(h.rows[header + 17][4], "13:43");
  assert.equal(h.rows[header + 17][6], "68.5°C");
  assert.equal(h.rows[header + 18][1], "15.6");
});

test("no extra trigger is installed: the existing optimized cycle owns the hourly gate", () => {
  const optimized = readFileSync(new URL("../server/fermentor-cycle-optimization.js", import.meta.url), "utf8");
  assert.match(optimized, /brewSheetHourlyMaintenance_\(fermentors, new Date\(\)\)/);
  assert.match(source, /BREW_SHEET_HOURLY_INTERVAL_MS_ = 60 \* 60 \* 1000/);
  assert.doesNotMatch(source, /ScriptApp\.newTrigger/);
});


test("the newest intentional manual Sheet clear is never repopulated from an old execution", () => {
  const h = environment();
  const first = 4 - 1 + 13;
  h.entry.data.brewSheetEditRevision = Date.now();
  h.entry.data.brewSheetEditRange = "C17";
  h.entry.data.brewSheetEditValue = "";
  const result = h.context.brewSheetHourlyMaintenance_([h.entry], now);
  assert.equal(result.repaired, 4); // other three water cells + stage start
  assert.equal(h.rows[first][2], "", "the manually cleared HLT temperature must stay blank");
  assert.equal(h.rows[first][1], "1550");
});
