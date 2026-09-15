import { callAppsScriptPost, type AppsScriptEnvelope } from "../getAndPost/appsScriptClient";

type UpdateTankStatusResult = {
  success: boolean;
  message?: string;
  error?: string;
  [key: string]: unknown;
};

export async function updateTankStatus(
  fermentorID: string | number,
  action: number | string,
  date: string | Date,
  pasivationDate?: string | null
): Promise<UpdateTankStatusResult> {
  if (!fermentorID) {
    throw new Error("Missing fermentorID");
  }

  if (action === undefined || action === null) {
    throw new Error("Missing tank action");
  }

  if (!date) {
    throw new Error("Missing date");
  }

  const payload = {
    action: "updateTankStatus",
    tankAction: Number(action),
    fermentorID: String(fermentorID),
    date: new Date(date).toISOString(),
    pasivationDate: pasivationDate || null,
  };

  console.log("Updating tank:", payload);

  const result = await callAppsScriptPost<AppsScriptEnvelope>(payload) as UpdateTankStatusResult;

  if (!result.success) {
    throw new Error(result.error || result.message || "Tank update failed");
  }

  console.log("Tank successfully updated:", fermentorID, "status:", action);
  return result;
}
