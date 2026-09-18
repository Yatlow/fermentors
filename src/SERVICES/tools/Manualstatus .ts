import { callAppsScriptGet, callAppsScriptPost, type AppsScriptEnvelope } from "../getAndPost/appsScriptClient";

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

export async function applyManualStatusChange(
  fermentorID: string,
  desiredAction: number,
  desiredTankStatus: boolean,
  expectedBatchNumber?: string | number | null,
  expectedFromAction?: number | null
) {
  const parsed = await callAppsScriptPost<AppsScriptEnvelope>({
    action: "ApplyManualStatus",
    fermentorID,
    desiredAction,
    desiredTankStatus,
    expectedBatchNumber: expectedBatchNumber ?? "",
    expectedFromAction: expectedFromAction ?? null,
  }, {
    timeoutMs: 30000,
    retries: 1,
  });

  if (!parsed.success) {
    throw new Error(parsed.error || parsed.message || "ApplyManualStatus failed");
  }

  return parsed.result;
}
