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

  // Recipe/material placement is resolved by the server from semantic labels
  // in the copied Master. Do not encode physical row numbers in the client.
  // This keeps creation stable when rows are added/removed from a Master.

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
    recipeMaterials: input.recipe && input.ingredients ? {
      grains: input.recipe.grains.map((grain) => {
        const ingredient = input.ingredients!.find((item) => item.id === grain.ingredientId);
        const lot = ingredient ? activeLot(ingredient) : undefined;
        return {
          quantity: grain.kgPerBrew,
          label: (ingredient?.name || grain.ingredientId) + (lot?.lotNumber ? ` #${lot.lotNumber}` : ""),
          supplier: lot?.supplier || "",
        };
      }),
      hops: input.recipe.hops.filter((hop) => hop.purpose !== "dryHop").map((hop, index) => {
        const ingredient = input.ingredients!.find((item) => item.id === hop.ingredientId);
        const lot = ingredient ? activeLot(ingredient) : undefined;
        return {
          quantity: 0,
          alpha: lot?.alpha ?? hop.aa ?? "",
          label: `${index + 1})${ingredient?.name || hop.ingredientId}${lot?.lotNumber ? ` #${lot.lotNumber}` : ""}`,
        };
      }),
    } : undefined,
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

