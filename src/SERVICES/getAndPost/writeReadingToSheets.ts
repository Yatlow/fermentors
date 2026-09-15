import type { ReadingToSend } from "../../App";
import { callAppsScriptPost, type AppsScriptEnvelope } from "./appsScriptClient";

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
