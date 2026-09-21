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
  return unwrapAppsScriptResult(response, "כתיבה ל-Sheet הבישול נכשלה.");
}

export async function serverReadBrewSheetRange(
  spreadsheetId: string,
  range: string,
) {
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
  return unwrapAppsScriptResult(response, "קריאה מ-Sheet הבישול נכשלה.");
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
