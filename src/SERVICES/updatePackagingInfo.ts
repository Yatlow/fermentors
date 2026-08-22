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

const GOOGLE_SCRIPT_URL =
    "https://script.google.com/macros/s/AKfycbzSq8vnL_P9DOkiXluKReSUNFILqlRkK-WxnPC_Q0BNt23rFHbLpRlkvPudbqElqw5h/exec";

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

            const response = await fetch(GOOGLE_SCRIPT_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "text/plain;charset=utf-8",
                },
                body: JSON.stringify(payload),
            });

            const text = await response.text();

            let parsed: { success: boolean; result?: Record<string, unknown>; error?: string; message?: string };

            try {
                parsed = JSON.parse(text);
            } catch {
                throw new Error(
                    "Google Apps Script returned invalid JSON: " + text
                );
            }

            if (!parsed.success) {
                throw new Error(
                    parsed.error ||
                    parsed.message ||
                    "Packaging update failed"
                );
            }

            const flat: updatePackagingResult = {
                ...(parsed.result ?? {}),
                success: parsed.success,
                tankId: entry.tankId,
                tankNumber: entry.tankNumber,
            };

            console.log(
                "Tank packaging successfully updated:",
                entry.tankId
            );

            return flat;
        })
    );

    return results;
}