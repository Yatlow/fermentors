import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../server/addFermentationMeasurement.js", import.meta.url), "utf8");
const grid = Array.from({ length: 26 }, () => Array(10).fill(""));
grid[0][0] = "כמות";
grid[0][1] = "אחוז אלפה";
grid[0][2] = "סוג/אצווה";
for (let n = 1; n <= 5; n++) {
  grid[n][2] = n + ")";
  if (n <= 3) { grid[n][0] = 150 * n; grid[n][1] = 12; grid[n][2] += "Cascade"; }
}
grid[14][3] = "הוספת כשות 4";
grid[15][3] = "הוספת כשות 5";

const sheet = {
  getLastRow: () => grid.length,
  getLastColumn: () => 10,
  getRange(row, col, rows = 1, cols = 1) {
    const snapshot = () => Array.from({length: rows}, (_, r) =>
      Array.from({length: cols}, (_, c) => String(grid[row - 1 + r][col - 1 + c] ?? "")));
    return {
      getDisplayValues: snapshot,
      getDisplayValue: () => snapshot()[0][0],
      setValues(values) {
        for (let r=0;r<rows;r++) for (let c=0;c<cols;c++) grid[row - 1+r][col - 1+c] = values[r][c];
      },
      setValue(value) { grid[row-1][col-1] = value; },
      setNumberFormat() {},
    };
  },
};
const ctx = {
  SpreadsheetApp: { openById: () => ({ getSheets: () => [sheet] }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  Utilities: { formatDate: () => "(01/11/2026) 12:05" },
  Logger: { log() {} },
  extractSpreadsheetId: () => "test-sheet",
};
vm.createContext(ctx);
vm.runInContext(source, ctx);
const first = ctx.assignDryHopToHopsTable("test", 3600, "Citra", 12.5);
const original = grid[4].slice(0,3);
assert.equal(first.entryNumber, 4);
const second = ctx.assignDryHopToHopsTable("test", 1200, "Mosaic", 11.1);
assert.equal(second.entryNumber, 5);
assert.equal(second.row, first.row + 1);
assert.deepEqual(grid[4].slice(0,3), original, "second entry must not alter the first dry-hop");
assert.deepEqual(grid[5].slice(0,3), [1200, 11.1, "5)Mosaic"]);
assert.equal(grid[14][4], "(01/11/2026) 12:05");
assert.equal(grid[15][4], "(01/11/2026) 12:05");
console.log("Dry-hop first and second lines remain separate");
