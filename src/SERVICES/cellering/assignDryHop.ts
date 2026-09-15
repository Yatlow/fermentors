import { callAppsScriptPost, type AppsScriptEnvelope } from "../getAndPost/appsScriptClient";

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
    const payload = {
        action: "assignDryHop",
        sheetUrl,
        grams,
        hopType: hopType.trim(),
        aa: numericAa,
    };

    const parsed = await callAppsScriptPost<AppsScriptEnvelope>(payload);

    if (!parsed.success) {
        throw new Error(parsed.error || "assignDryHop failed");
    }

    pendingDryHopAaBySheet.delete(sheetUrl);
    return parsed.result;
}
