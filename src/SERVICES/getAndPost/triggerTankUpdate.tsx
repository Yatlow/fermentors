import { callAppsScriptPost, type AppsScriptEnvelope } from "./appsScriptClient";

export async function triggerTankUpdate() {
    const parsed = await callAppsScriptPost<AppsScriptEnvelope<Record<string, unknown>>>({
        action: "triggerTankUpdate",
    });

    if (!parsed.success) {
        throw new Error(parsed.error || parsed.message || "Tank update failed");
    }

    return parsed;
}
