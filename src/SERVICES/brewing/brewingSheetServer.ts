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
  });
  return result;
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
