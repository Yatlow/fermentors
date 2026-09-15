import type { ReadingToSend } from "../../App";
import { callAppsScriptPost, type AppsScriptEnvelope } from "./appsScriptClient";
import { pushCurrentDataToFirestore } from "./pushCurrentDataToFirestore";

export type writeReadingResult = {
    success: boolean;
    tankId: string | number;
    message?: string;
    error?: string;
    [key: string]: unknown;
};

export async function writeReadingsToSheets(
    readings: ReadingToSend[]
): Promise<writeReadingResult[]> {
    // Update currentData in Firestore before waiting for Google Sheets.
    // This lets the realtime dashboard reflect the user's values immediately,
    // while the caller still keeps its loading/sync UI open until Apps Script
    // confirms that the Sheet write actually succeeded.
    //
    // We intentionally do NOT write a brews/{batch}/measurements document here:
    // pushCurrentDataToFirestore only creates that historical measurement when
    // Apps Script later returns the authoritative sheetResult (date/time + merged row).
    try {
        await pushCurrentDataToFirestore(readings);
    } catch (error) {
        // A realtime UI update must never prevent the authoritative Sheet write.
        // The normal post-Sheet path will try Firestore again with sheetResult.
        console.warn("Optimistic Firestore currentData update failed:", error);
    }

    const payload = {
        action: "addFermentationMeasurements",
        readings,
    };

    const parsed = await callAppsScriptPost<AppsScriptEnvelope<writeReadingResult[]>>(payload);

    if (!parsed.success) {
        throw new Error(parsed.error || parsed.message || "Batch update failed");
    }

    return (parsed.results as writeReadingResult[] | undefined) ?? [];
}
