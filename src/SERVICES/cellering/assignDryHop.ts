const GOOGLE_SCRIPT_URL =
    "https://script.google.com/macros/s/AKfycbzSq8vnL_P9DOkiXluKReSUNFILqlRkK-WxnPC_Q0BNt23rFHbLpRlkvPudbqElqw5h/exec";

// NoteToFermentor and SendMessurmentsHeader are separate components. The former
// owns the editable aa field, while the latter performs the actual batch send.
// Keep the edited value keyed by brew sheet for the short lifetime of that form.
const pendingDryHopAaBySheet = new Map<string, number>();

export function rememberDryHopAa(sheetUrl: string | null | undefined, aa: number): void {
    if (!sheetUrl || !Number.isFinite(aa) || aa <= 0 || aa > 100) return;
    pendingDryHopAaBySheet.set(sheetUrl, aa);
}

export function forgetDryHopAa(sheetUrl: string | null | undefined): void {
    if (sheetUrl) pendingDryHopAaBySheet.delete(sheetUrl);
}

export async function assignDryHopToHopsTable(
    sheetUrl: string,
    grams: number,
    hopType: string,
    aa?: number
) {
    if (!sheetUrl) throw new Error("Missing sheetUrl");
    if (!Number.isFinite(grams) || grams <= 0) throw new Error("Invalid grams");
    if (!hopType.trim()) throw new Error("Missing hopType");

    const resolvedAa = aa ?? pendingDryHopAaBySheet.get(sheetUrl);
    if (!Number.isFinite(resolvedAa) || Number(resolvedAa) <= 0 || Number(resolvedAa) > 100) {
        throw new Error("Invalid aa");
    }

    const numericAa = Number(resolvedAa);

    // The currently deployed Apps Script dispatcher forwards only its third
    // argument to assignDryHopToHopsTable. Encode aa in that argument as a
    // backwards-compatible bridge, while also sending a dedicated aa field.
    // The server function strips this suffix before writing the hop name.
    const transportHopType = `${hopType.trim()}::aa=${numericAa}`;
    const payload = {
        action: "assignDryHop",
        sheetUrl,
        grams,
        hopType: transportHopType,
        aa: numericAa,
    };

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

    pendingDryHopAaBySheet.delete(sheetUrl);
    return parsed.result;
}