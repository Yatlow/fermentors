import { callAppsScriptPost, type AppsScriptEnvelope } from "../getAndPost/appsScriptClient";

export type PackagingEntry = {
    tankId: string | number;
    tankNumber?: string | number;
    sheetUrl: string | null;
    isEmpty?: boolean;
    kegs?: string | number;
    crates?: string | number; // בפועל: כמות בקבוקים
    totalLiters?: Number;
    shrinkagePercent?: Number;
};

export type updatePackagingResult = {
    success: boolean;
    tankId: string | number;
    message?: string;
    error?: string;
    [key: string]: unknown;
};

export async function updatePackagingInfo(
    entries: PackagingEntry[]
) {
    const results = await Promise.all(
        entries.map(async (entry) => {
            const payload = {
                sheetUrl: entry.sheetUrl,
                isEmpty: entry.isEmpty,
                kegs: entry.kegs,
                crates: entry.crates,
                totalLiters: entry.totalLiters,
                shrinkagePercent: entry.shrinkagePercent,
                action: "updatePackagingInfo",
            };

            const parsed = await callAppsScriptPost<AppsScriptEnvelope<Record<string, unknown>>>(payload);

            if (!parsed.success) {
                throw new Error(parsed.error || parsed.message || "Packaging update failed");
            }

            const flat: updatePackagingResult = {
                ...(parsed.result ?? {}),
                success: parsed.success,
                tankId: entry.tankId,
                tankNumber: entry.tankNumber,
            };

            console.log("Tank packaging successfully updated:", entry.tankId);
            return flat;
        })
    );

    return results;
}
