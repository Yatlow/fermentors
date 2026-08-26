import type { ReadingToSend } from "../App";

export type writeReadingResult = {
    success: boolean;
    tankId: string | number;
    message?: string;
    error?: string;
    [key: string]: unknown;
};

const GOOGLE_SCRIPT_URL =
    "https://script.google.com/macros/s/AKfycbzSq8vnL_P9DOkiXluKReSUNFILqlRkK-WxnPC_Q0BNt23rFHbLpRlkvPudbqElqw5h/exec";


export async function writeReadingsToSheets(
    readings: ReadingToSend[]
): Promise<writeReadingResult[]> {

    const payload = {
        action: "addFermentationMeasurements",
        readings: readings,
    };
    const response = await fetch(GOOGLE_SCRIPT_URL, {
        method: "POST",
        headers: {
            "Content-Type": "text/plain;charset=utf-8",
        },
        body: JSON.stringify(payload),
    });

    const text = await response.text();

    let parsed: { success: boolean; results?: writeReadingResult[]; error?: string; message?: string };

    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error("Google Apps Script returned invalid JSON: " + text);
    }
    

    if (!parsed.success) {
        throw new Error(
            parsed.error ||
            parsed.message ||
            "Batch update failed"
        );
    }
    return parsed.results ?? [];
}