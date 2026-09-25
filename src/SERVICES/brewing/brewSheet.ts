type BrewTankDescriptor = { tankType: "single" | "double" | "triple" };
import type { BrewRecipe } from "./brewRecipe";
import type { IngredientDefinition } from "./ingredientLibrary";
import {
  serverReadBrewSheetRange,
  serverWriteBrewSheetCells,
} from "./brewingSheetServer";

type TankType = BrewTankDescriptor["tankType"];

function layoutFor(tankType: TankType) {
  if (tankType === "single") {
    return {
      blockHeaderRows: [4],
      fermentationHeaderRow: 57,
      startingPlatoRow: 59,
      startingPlatoFormula: '',
    };
  }
  if (tankType === "double") {
    return {
      blockHeaderRows: [4, 54],
      fermentationHeaderRow: 104,
      startingPlatoRow: 106,
      startingPlatoFormula: '',
    };
  }
  return {
    blockHeaderRows: [4, 54, 102],
    fermentationHeaderRow: 154,
    startingPlatoRow: 156,
    startingPlatoFormula: '',
  };
}


function tankLabel(tankType: TankType) {
  return tankType === "single" ? "בודד" : tankType === "double" ? "כפול" : "משולש";
}

export function buildBrewSheetInitialWrites(input: {
  batchNumber: string;
  style: string;
  tankNumber: string;
  tankType: TankType;
  recipe?: BrewRecipe;
  ingredients?: IngredientDefinition[];
}) {
  const layout = layoutFor(input.tankType);
  const styleLabel =
    input.tankType === "single"
      ? input.style
      : input.style + " " + tankLabel(input.tankType);
  const suffixes = ["A", "B", "C"];
  const writes: Array<{ range: string; value: string | number | boolean | null }> = [
    { range: "'גיליון1'!B1", value: input.style },
    { range: "'גיליון1'!D1", value: input.tankNumber },
    { range: "'גיליון1'!F1", value: input.batchNumber },
    { range: "'גיליון1'!H1", value: "" },
  ];

  layout.blockHeaderRows.forEach((row, index) => {
    writes.push(
      { range: `'גיליון1'!C${row}`, value: styleLabel },
      { range: `'גיליון1'!E${row}`, value: `${input.batchNumber}${suffixes[index] || ""}` },
      { range: `'גיליון1'!H${row}`, value: "" },
    );
  });

  // Recipe/material placement is resolved by the server from semantic labels
  // in the copied Master. Do not encode physical row numbers in the client.
  // This keeps creation stable when rows are added/removed from a Master.

  writes.push(
    { range: `'גיליון1'!B${layout.fermentationHeaderRow}`, value: styleLabel },
    { range: `'גיליון1'!D${layout.fermentationHeaderRow}`, value: input.batchNumber },
    { range: `'גיליון1'!G${layout.fermentationHeaderRow}`, value: input.tankNumber },
  );

  return writes;
}

export async function productionBrewSheetExists(
  batchNumber: string,
): Promise<boolean> {
  const clean = String(batchNumber || "").replace("#", "").trim();
  if (!/^\d+$/.test(clean)) return false;
  const { serverListBrewDriveHistory } = await import("./brewingSheetServer");
  const rows = await serverListBrewDriveHistory(150);
  return rows.some((row) => String(row.batchNumber || "").replace("#", "").trim() === clean);
}

export async function readBrewSheetRange(
  fileId: string,
  range: string,
): Promise<string[][]> {
  if (!fileId) {
    throw new Error("חסר מזהה Sheet לקריאה.");
  }
  const result = await serverReadBrewSheetRange(fileId, range);
  const values = Array.isArray(result.values) ? result.values : [];
  rememberBrewSheetRange(fileId, range, values);
  return values;
}

type SheetCellValue = string | number | boolean | null;
type SheetWrite = { range: string; value: SheetCellValue; expectedValue?: SheetCellValue };

const sheetBaselines = new Map<string, Map<string, string>>();

function normalizeSheetValue(value: SheetCellValue | undefined): string {
  const text = String(value == null ? "" : value).trim();
  if (!text) return "";
  // Sheets may render a numeric value with a custom unit/format (for example
  // 14 -> "14.0%aa" or 1335 -> "ליטר 1335"). Treat those as the same value
  // for optimistic-write reconciliation, while leaving ordinary text exact.
  const numeric = text.replace(/,/g, ".").match(/-?\d+(?:\.\d+)?/);
  const unitlessRemainder = numeric
    ? text.replace(numeric[0], "").replace(/%aa/gi, "").replace(/ליטר|ק"ג|ק״ג|קג|גרם/gi, "").replace(/[%°\s]/g, "")
    : text;
  if (numeric && !/[A-Za-z\u0590-\u05ff]/.test(unitlessRemainder)) {
    const parsed = Number(numeric[0]);
    if (Number.isFinite(parsed)) return `#num:${parsed}`;
  }
  return text;
}

function baselineFor(fileId: string) {
  let baseline = sheetBaselines.get(fileId);
  if (!baseline) {
    baseline = new Map();
    sheetBaselines.set(fileId, baseline);
  }
  return baseline;
}

export function resetBrewSheetBaseline(fileId: string): void {
  if (!fileId) return;
  sheetBaselines.delete(fileId);
}

export function rememberBrewSheetRange(
  fileId: string,
  range: string,
  values: string[][],
): void {
  const match = range.match(/^(?:(.+)!)?\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)$/i);
  if (!match) return;
  const startCol = match[2].toUpperCase().charCodeAt(0) - 64;
  const startRow = Number(match[3]);
  const endCol = match[4].toUpperCase().charCodeAt(0) - 64;
  const endRow = Number(match[5]);
  if (startCol < 1 || endCol > 26) return;
  const sheet = match[1] ? `${match[1]}!` : "";
  const baseline = baselineFor(fileId);
  for (let row = startRow; row <= endRow; row += 1) {
    for (let col = startCol; col <= endCol; col += 1) {
      const cellRange = `${sheet}${String.fromCharCode(64 + col)}${row}`;
      baseline.set(cellRange, normalizeSheetValue(values[row - startRow]?.[col - startCol]));
    }
  }
}

type SheetOutbox = {
  pending: Map<string, SheetWrite>;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
};

const sheetOutboxes = new Map<string, SheetOutbox>();
const SHEET_WRITE_DEBOUNCE_MS = 650;

function getSheetOutbox(fileId: string): SheetOutbox {
  let outbox = sheetOutboxes.get(fileId);
  if (!outbox) {
    outbox = { pending: new Map(), timer: null, inFlight: false, waiters: [] };
    sheetOutboxes.set(fileId, outbox);
  }
  return outbox;
}

async function flushSheetOutbox(fileId: string): Promise<void> {
  const outbox = getSheetOutbox(fileId);
  if (outbox.inFlight || outbox.pending.size === 0) return;

  if (outbox.timer) {
    clearTimeout(outbox.timer);
    outbox.timer = null;
  }

  const writes = Array.from(outbox.pending.values());
  outbox.pending.clear();
  const waiters = outbox.waiters.splice(0);
  outbox.inFlight = true;

  try {
    // The brewing app is now allowed to be authoritative for explicit user
    // writes. Do not block an app edit because the Sheet changed since the last
    // read; send it unguarded and then make the successful app value the new
    // baseline. Sheet→app sync remains available for edits made in Sheets.
    const result = await serverWriteBrewSheetCells(fileId, writes);
    if (result.updated !== writes.length) {
      throw new Error(
        `Google Sheets אישר רק ${result.updated} מתוך ${writes.length} כתיבות.`,
      );
    }
    const baseline = baselineFor(fileId);
    writes.forEach((write) => baseline.set(write.range, normalizeSheetValue(write.value)));
    waiters.forEach(({ resolve }) => resolve());
  } catch (error) {
    // A lost/late ContentService response does not mean the Sheet write failed.
    // Re-read the requested cells once; if they already contain the proposed
    // values, acknowledge the batch instead of showing a false failure.
    try {
      const baseline = baselineFor(fileId);
      const checks = await Promise.all(writes.map(async (write) => {
        const values = await readBrewSheetRange(fileId, write.range);
        const actual = values[0]?.[0] ?? "";
        baseline.set(write.range, normalizeSheetValue(actual));
        return normalizeSheetValue(actual) === normalizeSheetValue(write.value);
      }));
      if (checks.every(Boolean)) {
        waiters.forEach(({ resolve }) => resolve());
      } else {
        waiters.forEach(({ reject }) => reject(error));
      }
    } catch {
      waiters.forEach(({ reject }) => reject(error));
    }
  } finally {
    outbox.inFlight = false;
    if (outbox.pending.size > 0) {
      outbox.timer = setTimeout(() => void flushSheetOutbox(fileId), SHEET_WRITE_DEBOUNCE_MS);
    }
  }
}

export function queueBrewSheetCells(
  fileId: string,
  data: SheetWrite[],
): Promise<void> {
  if (!fileId) {
    return Promise.reject(new Error("חסר מזהה Sheet לכתיבה."));
  }
  if (data.length === 0) return Promise.resolve();

  const outbox = getSheetOutbox(fileId);
  data.forEach((write) => outbox.pending.set(write.range, write));

  const promise = new Promise<void>((resolve, reject) => {
    outbox.waiters.push({ resolve, reject });
  });

  if (outbox.timer) clearTimeout(outbox.timer);
  outbox.timer = setTimeout(() => void flushSheetOutbox(fileId), SHEET_WRITE_DEBOUNCE_MS);
  return promise;
}

export async function flushBrewSheetWrites(fileId: string): Promise<void> {
  const outbox = getSheetOutbox(fileId);
  if (outbox.timer) {
    clearTimeout(outbox.timer);
    outbox.timer = null;
  }
  await flushSheetOutbox(fileId);
}

export async function writeBrewSheetCells(
  fileId: string,
  data: SheetWrite[],
): Promise<void> {
  await queueBrewSheetCells(fileId, data);
}

