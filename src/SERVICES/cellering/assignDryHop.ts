const GOOGLE_SCRIPT_URL =
    "https://script.google.com/macros/s/AKfycbzSq8vnL_P9DOkiXluKReSUNFILqlRkK-WxnPC_Q0BNt23rFHbLpRlkvPudbqElqw5h/exec";

export async function assignDryHopToHopsTable(
    sheetUrl: string,
    grams: number,
    hopType: string,
    aa: number
) {
    if (!sheetUrl) throw new Error("Missing sheetUrl");
    if (!Number.isFinite(grams) || grams <= 0) throw new Error("Invalid grams");
    if (!hopType.trim()) throw new Error("Missing hopType");
    if (!Number.isFinite(aa) || aa <= 0 || aa > 100) throw new Error("Invalid aa");

    const payload = { action: "assignDryHop", sheetUrl, grams, hopType, aa };

    const response = await fetch(GOOGLE_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
    });

    const text = await response.text();
    let parsed: { success: boolean; result?: unknown; error?: string };

    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error("Google Apps Script returned invalid JSON: " + text);
    }

    if (!parsed.success) {
        throw new Error(parsed.error || "assignDryHop failed");
    }

    return parsed.result;
}