const GOOGLE_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbzSq8vnL_P9DOkiXluKReSUNFILqlRkK-WxnPC_Q0BNt23rFHbLpRlkvPudbqElqw5h/exec";

export type TransitionWarning = {
  level: "info" | "warning";
  message: string;
};

export type StatusTransitionCheckResult = {
  tankNumber: string;
  fromAction: number;
  toAction: number;
  batchNumber?: string;
  beerStyle?: string;
  brewDate?: string;
  sheetMarkedEmpty: boolean;
  currentTemp: number | null;
  currentNotes: string | null;
  sheetUrl: string;
  warnings: TransitionWarning[];
};

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
    throw new Error(parsed.error || "Request failed");
  }
  return parsed.result;
}

export async function checkStatusTransition(
  tankID: string,
  toAction: number
): Promise<StatusTransitionCheckResult> {
  return callGasGet({
    action: "CheckStatusTransition",
    tankID,
    toAction: String(toAction),
  }) as Promise<StatusTransitionCheckResult>;
}

// Re-export so ManualStatusAssignment.tsx has a single import
// source; this is the SAME server action manualBatch.ts already
// uses to finalize a batch assignment — it doesn't require a
// new sheet, so it fits the "change status only" flow as-is.
export { assignAndRefreshTank } from "./manualBatch";