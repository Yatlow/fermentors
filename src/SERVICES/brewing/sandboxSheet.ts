import { runtimeConfig } from "../../config/runtimeConfig";
import type { SandboxDemoTank } from "./brewingSandbox";
import type { BrewRecipe } from "./brewRecipe";
import { activeLot, type IngredientDefinition } from "./ingredientLibrary";
import {
  serverCreateBrewSheet,
  serverReadBrewSheetRange,
  serverTrashBrewSheet,
  serverWriteBrewSheetCells,
} from "./brewingSheetServer";

type TankType = SandboxDemoTank["tankType"];

export type SandboxSheetResult = {
  id: string;
  name: string;
  url: string;
};

export type AccessibleBrewSheet = {
  id: string;
  name: string;
  url: string;
  modifiedTime?: string;
};

function layoutFor(tankType: TankType) {
  if (tankType === "single") {
    return {
      blockHeaderRows: [4],
      fermentationHeaderRow: 57,
      startingPlatoRow: 59,
      startingPlatoFormula: '=IF(B48<>"",B48+0.05,"")',
    };
  }
  if (tankType === "double") {
    return {
      blockHeaderRows: [4, 54],
      fermentationHeaderRow: 104,
      startingPlatoRow: 106,
      startingPlatoFormula:
        '=IF(B98<>"",IF(AND(C48<>"",C98<>""),(((B48+0.05)*C48)+((B98+0.05)*C98))/(C48+C98),""),IF(B48<>"",B48+0.05,""))',
    };
  }
  return {
    blockHeaderRows: [4, 54, 102],
    fermentationHeaderRow: 154,
    startingPlatoRow: 156,
    startingPlatoFormula:
      '=IF(B145<>"",IF(AND(C48<>"",C98<>"",C145<>""),(((B48+0.05)*C48)+((B98+0.05)*C98)+((B145+0.05)*C145))/(C48+C98+C145),""),IF(B98<>"",IF(AND(C48<>"",C98<>""),(((B48+0.05)*C48)+((B98+0.05)*C98))/(C48+C98),""),IF(B48<>"",B48+0.05,"")))',
  };
}


function tankLabel(tankType: TankType) {
  return tankType === "single" ? "בודד" : tankType === "double" ? "כפול" : "משולש";
}

export async function deleteSandboxBrewSheet(fileId: string): Promise<void> {
  if (!fileId) return;
  // Sandbox/demo batches can also be visible from the production-configured
  // brewing screen. Deleting the demo must not silently no-op just because the
  // current Firebase build is not tagged as preview.
  await serverTrashBrewSheet(fileId);
}

export async function ensureSandboxSheetAccess(): Promise<void> {
  if (runtimeConfig.deployEnv !== "preview") {
    throw new Error("הרשאת Sandbox זמינה רק ב-Preview.");
  }
  // Access is authenticated by the Firebase ID token in appsScriptClient.
}

export function buildBrewSheetInitialWrites(input: {
  batchNumber: string;
  style: string;
  tankNumber: string;
  tankType: TankType;
  recipe?: BrewRecipe;
  ingredients?: IngredientDefinition[];
  production?: boolean;
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

  // The Masters are structural templates only. Never inherit recipe quantities
  // from whichever beer happened to be saved in the template. Material rows
  // must always come from the selected recipe snapshot.
  if (input.recipe && input.ingredients) {
    // Material tables start five rows below each block header. Derive this
    // from the canonical layout instead of maintaining a second set of magic
    // row numbers (the old C value was off by one: 107 instead of 106).
    const grainStarts = layout.blockHeaderRows.map((headerRow) => headerRow + 5);
    grainStarts.forEach((startRow) => {
      for (let slot = 0; slot < 5; slot += 1) {
        const row = startRow + slot;
        const grain = input.recipe!.grains[slot];
        if (!grain) {
          writes.push(
            { range: `'גיליון1'!A${row}`, value: "" },
            { range: `'גיליון1'!B${row}`, value: "" },
            { range: `'גיליון1'!C${row}`, value: "" },
          );
          continue;
        }
        const ingredient = input.ingredients!.find((item) => item.id === grain.ingredientId);
        const lot = ingredient ? activeLot(ingredient) : undefined;
        const ingredientLabel = ingredient?.name || grain.ingredientId;
        const lotSuffix = lot?.lotNumber ? ` #${lot.lotNumber}` : "";
        writes.push(
          { range: `'גיליון1'!A${row}`, value: grain.kgPerBrew },
          { range: `'גיליון1'!B${row}`, value: ingredientLabel + lotSuffix },
          { range: `'גיליון1'!C${row}`, value: lot?.supplier || "" },
        );
      }
    });
  }
  // Acid labels are template structure, not recipe data. Do not manufacture
  // a second/third addition here: that was the source of the stray "3" seen
  // after row insertion. The Master owns the labels and the form writes only
  // actual acid amounts during brewing.

  // Process geometry belongs to the Master. A three-rest recipe needs two
  // additional physical rows; the server inserts them after the ordinary
  // Master has been populated so all downstream cells shift together.

  if (input.recipe && input.ingredients) {
    const ingredients = input.ingredients;
    // Hop table is twenty rows below the block header. The old hard-coded C
    // coordinate (122) was likewise one row too low; header 102 => row 121.
    const hopStarts = layout.blockHeaderRows.map((headerRow) => headerRow + 19);
    const kettleHops = input.recipe.hops.filter((hop) => hop.purpose !== "dryHop");
    hopStarts.forEach((startRow) => {
      for (let slot = 0; slot < 5; slot += 1) {
        const row = startRow + slot;
        const hop = kettleHops[slot];
        if (!hop) {
          writes.push(
            { range: `'גיליון1'!A${row}`, value: "" },
            { range: `'גיליון1'!B${row}`, value: "" },
            { range: `'גיליון1'!C${row}`, value: "" },
          );
          continue;
        }
        const ingredient = ingredients.find((item) => item.id === hop.ingredientId);
        const lot = ingredient ? activeLot(ingredient) : undefined;
        const ingredientLabel = ingredient?.name || hop.ingredientId;
        const lotSuffix = lot?.lotNumber ? ` #${lot.lotNumber}` : "";
        writes.push(
          { range: `'גיליון1'!A${row}`, value: 0 },
          { range: `'גיליון1'!B${row}`, value: lot?.alpha ?? hop.aa ?? "" },
          { range: `'גיליון1'!C${row}`, value: `${slot + 1})${ingredientLabel}${lotSuffix}` },
        );
      }
    });
  }

  writes.push(
    { range: `'גיליון1'!B${layout.fermentationHeaderRow}`, value: styleLabel },
    { range: `'גיליון1'!D${layout.fermentationHeaderRow}`, value: input.batchNumber },
    { range: `'גיליון1'!G${layout.fermentationHeaderRow}`, value: input.tankNumber },
  );

  if (!input.production) {
    writes.push(
      { range: `'גיליון1'!B${layout.startingPlatoRow}`, value: "" },
      { range: `'גיליון1'!D${layout.startingPlatoRow}`, value: layout.startingPlatoFormula },
    );
  }

  return writes;
}

export async function createSandboxBrewSheet(input: {
  batchNumber: string;
  style: string;
  tankNumber: string;
  tankType: TankType;
  recipe?: BrewRecipe;
  ingredients?: IngredientDefinition[];
  production?: boolean;
}): Promise<SandboxSheetResult> {
  if (runtimeConfig.deployEnv !== "preview") {
    throw new Error("יצירת Sheet מענף הפיתוח זמינה רק ב-Preview.");
  }
  const typeSuffix =
    input.tankType === "single" ? "" : " " + tankLabel(input.tankType);
  const name = input.production
    ? input.style + typeSuffix + " " + input.batchNumber + "#"
    : "[SANDBOX] " + input.style + " " + tankLabel(input.tankType) + " " + input.batchNumber + "#";

  const writes = buildBrewSheetInitialWrites(input);
  const created = await serverCreateBrewSheet({
    batchNumber: input.batchNumber,
    style: input.style,
    tankNumber: input.tankNumber,
    tankType: input.tankType,
    name,
    initialWrites: writes,
    mashRestCount: input.recipe?.mash.steps.some((step) => step.id === "rest3") ? 3 : 2,
  });
  return { id: created.id, name: created.name, url: created.url };
}

export async function productionBrewSheetExists(
  batchNumber: string,
): Promise<boolean> {
  const clean = String(batchNumber || "").replace("#", "").trim();
  if (!/^\\d+$/.test(clean)) return false;
  const { serverListBrewDriveHistory } = await import("./brewingSheetServer");
  const rows = await serverListBrewDriveHistory(150);
  return rows.some((row) => String(row.batchNumber || "").replace("#", "").trim() === clean);
}

export async function searchAccessibleBrewSheetsByStyle(
  style: string,
  maxResults = 80,
): Promise<AccessibleBrewSheet[]> {
  if (runtimeConfig.deployEnv !== "preview") {
    throw new Error("חיפוש Sheets היסטוריים זמין כרגע ב-Preview בלבד.");
  }
  const cleanStyle = String(style || "").trim().toLowerCase();
  if (!cleanStyle) return [];
  const { serverListBrewDriveHistory } = await import("./brewingSheetServer");
  const rows = await serverListBrewDriveHistory(Math.max(10, Math.min(150, maxResults)));
  return rows
    .filter((row) => String(row.beerStyle || "").trim().toLowerCase().includes(cleanStyle))
    .map((row) => ({
      id: row.fileId || row.id,
      name: row.fileName,
      url: row.sheetUrl,
    }))
    .filter((row) => !!row.id);
}

export async function readSandboxSheetRange(
  fileId: string,
  range: string,
): Promise<string[][]> {
  if (!fileId) {
    throw new Error("חסר מזהה Sheet לקריאה.");
  }
  const result = await serverReadBrewSheetRange(fileId, range);
  const values = Array.isArray(result.values) ? result.values : [];
  rememberSandboxSheetRange(fileId, range, values);
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

function a1Cell(range: string): { sheet: string; col: string; row: number } | null {
  const match = range.match(/^(?:(.+)!)?\$?([A-Z]+)\$?(\d+)$/i);
  if (!match) return null;
  return { sheet: match[1] || "", col: match[2].toUpperCase(), row: Number(match[3]) };
}

async function ensureWriteBaselines(fileId: string, writes: SheetWrite[]): Promise<SheetWrite[]> {
  const baseline = baselineFor(fileId);
  const missing = writes.filter((write) => !baseline.has(write.range));
  if (missing.length) {
    const cells = missing.map((write) => a1Cell(write.range));
    if (cells.some((cell) => !cell)) throw new Error("לא ניתן לאמת את מצב ה-Sheet לפני הכתיבה.");

    const sheetNames = new Set(cells.map((cell) => cell!.sheet));
    const cols = cells.map((cell) => cell!.col.charCodeAt(0) - 64);
    if (sheetNames.size !== 1 || cols.some((col) => col < 1 || col > 26)) {
      // Rare fallback: read each cell. Correctness is more important than batching here.
      await Promise.all(missing.map(async (write) => {
        const values = await readSandboxSheetRange(fileId, write.range);
        baseline.set(write.range, normalizeSheetValue(values[0]?.[0]));
      }));
    } else {
      const rows = cells.map((cell) => cell!.row);
      const minRow = Math.min(...rows);
      const maxRow = Math.max(...rows);
      const minCol = Math.min(...cols);
      const maxCol = Math.max(...cols);
      const colName = (n: number) => String.fromCharCode(64 + n);
      const sheet = cells[0]!.sheet;
      const readRange = `${sheet ? `${sheet}!` : ""}${colName(minCol)}${minRow}:${colName(maxCol)}${maxRow}`;
      const values = await readSandboxSheetRange(fileId, readRange);
      missing.forEach((write) => {
        const cell = a1Cell(write.range)!;
        const row = cell.row - minRow;
        const col = cell.col.charCodeAt(0) - 64 - minCol;
        baseline.set(write.range, normalizeSheetValue(values[row]?.[col]));
      });
    }
  }

  return writes.map((write) => ({
    ...write,
    expectedValue: baseline.get(write.range) ?? "",
  }));
}

export function resetSandboxSheetBaseline(fileId: string): void {
  if (!fileId) return;
  sheetBaselines.delete(fileId);
}

export function rememberSandboxSheetRange(
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
    const guardedWrites = await ensureWriteBaselines(fileId, writes);
    const result = await serverWriteBrewSheetCells(fileId, guardedWrites);
    if (result.hasConflict || result.conflicts?.length) {
      const conflicts = result.conflicts || [];
      const baseline = baselineFor(fileId);
      conflicts.forEach((conflict) => baseline.set(conflict.range, normalizeSheetValue(conflict.actualValue)));

      // A stale baseline is not an external edit when the Sheet already contains
      // exactly the value this request wanted to write (common after Sheet→Firestore
      // sync or a previous request completed while the tab was hidden/closing).
      const realConflicts = conflicts.filter(
        (conflict) =>
          normalizeSheetValue(conflict.actualValue) !==
          normalizeSheetValue(
            conflict.proposedValue as SheetCellValue | undefined,
          ),
      );
      if (realConflicts.length) {
        const conflict = realConflicts[0];
        throw new Error(
          `ה-Sheet השתנה מחוץ לאפליקציה ב-${conflict.range}. הערך באפליקציה לא דרס את הערך "${conflict.actualValue}".`,
        );
      }
    }
    const resolvedConflictCount = result.conflicts?.filter(
      (conflict) =>
        normalizeSheetValue(conflict.actualValue) ===
        normalizeSheetValue(conflict.proposedValue as SheetCellValue | undefined),
    ).length || 0;
    if (result.updated + resolvedConflictCount !== guardedWrites.length) {
      throw new Error(
        `Google Sheets אישר רק ${result.updated} מתוך ${guardedWrites.length} כתיבות.`,
      );
    }
    const baseline = baselineFor(fileId);
    guardedWrites.forEach((write) => baseline.set(write.range, normalizeSheetValue(write.value)));
    waiters.forEach(({ resolve }) => resolve());
  } catch (error) {
    // A lost/late ContentService response does not mean the Sheet write failed.
    // Re-read the requested cells once; if they already contain the proposed
    // values, acknowledge the batch instead of showing a false failure.
    try {
      const baseline = baselineFor(fileId);
      const checks = await Promise.all(writes.map(async (write) => {
        const values = await readSandboxSheetRange(fileId, write.range);
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

export function queueSandboxSheetCells(
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

export async function flushSandboxSheetWrites(fileId: string): Promise<void> {
  const outbox = getSheetOutbox(fileId);
  if (outbox.timer) {
    clearTimeout(outbox.timer);
    outbox.timer = null;
  }
  await flushSheetOutbox(fileId);
}

export async function writeSandboxSheetCells(
  fileId: string,
  data: SheetWrite[],
): Promise<void> {
  await queueSandboxSheetCells(fileId, data);
}

