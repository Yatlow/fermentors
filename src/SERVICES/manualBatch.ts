const GOOGLE_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbzSq8vnL_P9DOkiXluKReSUNFILqlRkK-WxnPC_Q0BNt23rFHbLpRlkvPudbqElqw5h/exec";

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
  const url = new URL(GOOGLE_SCRIPT_URL);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));

  const response = await fetch(url.toString());
  const text = await response.text();

  let parsed: { success: boolean; result?: unknown; error?: string };

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Google Apps Script returned invalid JSON: " + text);
  }

  if (!parsed.success) {
      console.log(parsed.error)
    throw new Error(parsed.error || "Request failed");
  }
  console.log(parsed)
  return parsed.result;
}

export async function checkBatchAssignment(
  tankID: string,
  requestedBatch: number
): Promise<BatchCheckResult> {
    console.log("checkBatchAssignment called with tankID:", tankID, "requestedBatch:", requestedBatch);
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
    console.log("failsHere",tankID,currentBatch)

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
  const response = await fetch(GOOGLE_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({
      action: "AssignAndRefreshTank", // routes doPost to the new handler
      fermentorID,
      sheetUrl,
      desiredAction,       // <- separate name, avoids clashing with "action" above
      desiredTankStatus,
    }),
  });

  const text = await response.text();
  let parsed: { success: boolean; result?: unknown; error?: string };

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Google Apps Script returned invalid JSON: " + text);
  }

  if (!parsed.success) {
    throw new Error(parsed.error || "assignAndRefreshTank failed");
  }

  return parsed.result as {
    fermentorID: string;
    batchNumber?: string;
    beerStyle?: string;
    brewDate?: string;
    sheetUrl: string;
  };
}