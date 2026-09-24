import {
  callAppsScriptPost,
  unwrapAppsScriptResult,
  type AppsScriptEnvelope,
} from "../getAndPost/appsScriptClient";

export type BrewingSheetWrite = {
  range: string;
  value: string | number | boolean | null;
  expectedValue?: string | number | boolean | null;
};

export type BrewingSheetHistoryRow = {
  batchNumber: string;
  brewLetter: "A" | "B" | "C";
  brewDate: string;
  mashPh: string;
  mashVolume: string;
  acidMl: string;
  outToBoilPh: string;
  boilPh: string;
  kettleVolume: string;
  boilAcidMl: string;
  outToFermentorPh: string;
  sheetName: string;
  sheetUrl: string;
};

export async function serverCreateBrewSheet(input: {
  batchNumber: string;
  style: string;
  tankNumber: string;
  tankType: "single" | "double" | "triple";
  name?: string;
  initialWrites?: BrewingSheetWrite[];
  mashRestCount?: number;
}) {
  const response = await callAppsScriptPost<
    AppsScriptEnvelope<{
      id: string;
      name: string;
      url: string;
      batchNumber: string;
      tankNumber: string;
      style: string;
      tankType: string;
    }>
  >({
    action: "BrewSheetCreate",
    ...input,
  });
  return unwrapAppsScriptResult(response, "יצירת Sheet לבישול נכשלה.");
}

export async function serverWriteBrewSheetCells(
  spreadsheetId: string,
  writes: BrewingSheetWrite[],
) {
  const startedAt = performance.now();
  console.info("[brewing-sheet] WRITE start", { spreadsheetId, cells: writes.length });
  const response = await callAppsScriptPost<
    AppsScriptEnvelope<{
      spreadsheetId: string;
      updated: number;
      conflicts: Array<{
        range: string;
        expectedValue: string;
        actualValue: string;
        proposedValue: unknown;
      }>;
      hasConflict: boolean;
    }>
  >({
    action: "BrewSheetWriteCells",
    spreadsheetId,
    writes,
  });
  const result = unwrapAppsScriptResult(response, "כתיבה ל-Sheet הבישול נכשלה.");
  console.info("[brewing-sheet] WRITE done", {
    spreadsheetId,
    cells: writes.length,
    ms: Math.round(performance.now() - startedAt),
  });
  return result;
}

export async function serverPingBrewSheetBridge() {
  const startedAt = performance.now();
  const response = await callAppsScriptPost<
    AppsScriptEnvelope<{ ok: boolean; serverTime: string }>
  >({ action: "BrewSheetPing" }, { retries: 0, timeoutMs: 15000 });
  const result = unwrapAppsScriptResult(response, "בדיקת Apps Script נכשלה.");
  console.info("[brewing-sheet] PING done", {
    ms: Math.round(performance.now() - startedAt),
    serverTime: result.serverTime,
  });
  return result;
}

export async function serverReadBrewSheetRange(
  spreadsheetId: string,
  range: string,
) {
  const startedAt = performance.now();
  console.info("[brewing-sheet] READ start", { spreadsheetId, range });
  const response = await callAppsScriptPost<
    AppsScriptEnvelope<{
      spreadsheetId: string;
      range: string;
      values: string[][];
      timing?: { openMs: number; readMs: number; totalMs: number };
    }>
  >({
    action: "BrewSheetReadRange",
    spreadsheetId,
    range,
  });
  const result = unwrapAppsScriptResult(response, "קריאה מ-Sheet הבישול נכשלה.");
  console.info("[brewing-sheet] READ done", {
    spreadsheetId,
    range,
    rows: result.values?.length || 0,
    ms: Math.round(performance.now() - startedAt),
    serverTiming: result.timing,
  });
  return result;
}

export async function serverPrintBrewSheetPdf(input: {
  spreadsheetId: string;
  batchNumber: string;
  tankNumber: string;
  style: string;
  tankType: "single" | "double" | "triple";
  brewDate?: string;
  mashRestCount?: number;
}) {
  const response = await callAppsScriptPost<
    AppsScriptEnvelope<{
      fileName: string;
      mimeType: string;
      base64: string;
      pages: number;
    }>
  >({
    action: "BrewSheetPrintPdf",
    ...input,
  }, { retries: 0, timeoutMs: 120000 });
  return unwrapAppsScriptResult(response, "יצירת PDF משולב לבישול נכשלה.");
}

export async function serverTrashBrewSheet(spreadsheetId: string) {
  const response = await callAppsScriptPost<
    AppsScriptEnvelope<{ spreadsheetId: string; trashed: boolean }>
  >({
    action: "BrewSheetTrash",
    spreadsheetId,
  });
  return unwrapAppsScriptResult(response, "מחיקת Sheet הבישול נכשלה.");
}

export async function serverRenameBrewSheet(input: {
  spreadsheetId: string;
  oldBatchNumber: string;
  newBatchNumber: string;
  style: string;
}) {
  const response = await callAppsScriptPost<
    AppsScriptEnvelope<{
      spreadsheetId: string;
      batchNumber: string;
      style: string;
      name: string;
    }>
  >({
    action: "BrewSheetRenameBatch",
    ...input,
  });
  return unwrapAppsScriptResult(response, "עדכון פרטי אצוות הבישול ב-Sheet נכשל.");
}

export type BrewingDriveHistoryRow = {
  id: string;
  fileId: string;
  fileName: string;
  batchNumber: string;
  beerStyle: string;
  brewDate: string;
  sheetUrl: string;
  tankNumber: string;
  tankType: "single" | "double" | "triple";
};

export async function serverListBrewDriveHistory(limit = 100) {
  const response = await callAppsScriptPost<
    AppsScriptEnvelope<BrewingDriveHistoryRow[]>
  >({
    action: "BrewSheetListHistory",
    limit,
  });
  return unwrapAppsScriptResult(
    response,
    "טעינת היסטוריית הבישולים מ-Drive נכשלה.",
  );
}

export async function serverLoadBrewAcidHistory(
  style: string,
  currentBatchNumber: string,
) {
  const response = await callAppsScriptPost<
    AppsScriptEnvelope<BrewingSheetHistoryRow[]>
  >({
    action: "BrewSheetAcidHistory",
    style,
    currentBatchNumber,
  });
  return unwrapAppsScriptResult(response, "טעינת היסטוריית הבישולים נכשלה.");
}


export async function serverEnsureBrewSheetEditTrigger(spreadsheetId: string) {
  const response = await callAppsScriptPost<
    AppsScriptEnvelope<{ spreadsheetId: string; installed: boolean; active: boolean }>
  >({
    action: "BrewSheetEnsureEditTrigger",
    spreadsheetId,
  });
  return unwrapAppsScriptResult(response, "הפעלת סנכרון העריכה של Sheet הבישול נכשלה.");
}

export async function serverRemoveBrewSheetEditTrigger(spreadsheetId: string) {
  const response = await callAppsScriptPost<
    AppsScriptEnvelope<{ spreadsheetId: string; removed: number; active: boolean }>
  >({
    action: "BrewSheetRemoveEditTrigger",
    spreadsheetId,
  });
  return unwrapAppsScriptResult(response, "הסרת סנכרון העריכה של Sheet הבישול נכשלה.");
}

export async function serverProcessQueuedBrewSheetJob(jobId: string) {
  const response = await callAppsScriptPost<
    AppsScriptEnvelope<{ found?: number; ready?: number; failed?: number; queued?: boolean; busy?: boolean }>
  >({
    action: "BrewSheetProcessQueuedJob",
    jobId,
  }, { retries: 0, timeoutMs: 120000 });
  return unwrapAppsScriptResult(response, "הפעלת יצירת ה-Sheet ברקע נכשלה.");
}
