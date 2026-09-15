import { callAppsScriptPost, type AppsScriptEnvelope } from "./appsScriptClient";

export async function refreshSingleTank(fermentorID: string, sheetUrl: string) {
    if (!sheetUrl) return null;

    const payload = { action: "refreshSingleTank", fermentorID, sheetUrl };
    const parsed = await callAppsScriptPost<AppsScriptEnvelope>(payload);

    if (!parsed.success) {
        throw new Error(parsed.error || parsed.message || "refreshSingleTank failed");
    }

    return parsed.result;
}
