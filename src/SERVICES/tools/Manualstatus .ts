import { callAppsScriptGet, type AppsScriptEnvelope } from "../getAndPost/appsScriptClient";

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
  const parsed = await callAppsScriptGet<AppsScriptEnvelope>(params);

  if (!parsed.success) {
    throw new Error(parsed.error || parsed.message || "Request failed");
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
