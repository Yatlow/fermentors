import {
  callAppsScriptGet,
  callAppsScriptPost,
  type AppsScriptEnvelope,
} from "../getAndPost/appsScriptClient";

export type BatchCheckResult = {
  valid: boolean;
  warning: boolean;
  reason?: string;
  requestedBatch?: string;
  batchNumber?: string;
  tankNumber?: string;
  requestedTank?: string;
  actualTank?: string;
  beerStyle?: string;
  brewDate?: string;
  beerVolume?: string | number;
  startingPlato?: string | number;
  sheetUrl?: string;
  fileId?: string;
  fileName?: string;
};

export type NextBatchResult =
  | {
      found: true;
      batchNumber: string;
      tankNumber: string;
      beerStyle?: string;
      brewDate?: string;
      beerVolume?: string | number;
      startingPlato?: string | number;
      sheetUrl: string;
      fileId: string;
      fileName: string;
    }
  | null;

async function callGasGet(params: Record<string, string>) {
  const parsed = await callAppsScriptGet<AppsScriptEnvelope>(params);

  if (!parsed.success) {
    throw new Error(parsed.error || parsed.message || "Request failed");
  }

  return parsed.result;
}

export async function checkBatchAssignment(
  tankID: string,
  requestedBatch: number
): Promise<BatchCheckResult> {
  return callGasGet({
    action: "CheckBatchAssignment",
    tankID,
    requestedBatch: String(requestedBatch),
  }) as Promise<BatchCheckResult>;
}

export async function findNextBatchForTank(
  tankID: string,
  currentBatch: number
): Promise<NextBatchResult> {
  return callGasGet({
    action: "FindNextBatchForTank",
    tankID,
    currentBatch: String(currentBatch),
  }) as Promise<NextBatchResult>;
}

// Mirrors extractBatchFromFilename() on the Apps Script side,
// so the picked file is pre-validated before hitting the server.
export function extractBatchFromFilename(fileName: string): number | null {
  if (!fileName) return null;

  const text = fileName.trim();

  let match = text.match(/(\d{4,})\s*#/);
  if (match) {
    const batch = Number(match[1]);
    if (Number.isFinite(batch)) return batch;
  }

  match = text.match(/#\s*(\d{4,})/);
  if (match) {
    const batch = Number(match[1]);
    if (Number.isFinite(batch)) return batch;
  }

  return null;
}

export async function assignAndRefreshTank(
  fermentorID: string,
  sheetUrl: string,
  desiredAction: number,
  desiredTankStatus: boolean
): Promise<{
  fermentorID: string;
  batchNumber?: string;
  beerStyle?: string;
  brewDate?: string;
  sheetUrl: string;
}> {
  const parsed = await callAppsScriptPost<AppsScriptEnvelope>({
    action: "AssignAndRefreshTank",
    fermentorID,
    sheetUrl,
    desiredAction,
    desiredTankStatus,
  });

  if (!parsed.success) {
    throw new Error(parsed.error || parsed.message || "assignAndRefreshTank failed");
  }

  return parsed.result as {
    fermentorID: string;
    batchNumber?: string;
    beerStyle?: string;
    brewDate?: string;
    sheetUrl: string;
  };
}
