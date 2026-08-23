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
) {
    const results = await Promise.all(
        readings.map(async (reading) => {
            const payload = {
                ...reading,
                action: "addFermentationMeasurement",
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
                    "Tank update failed"
                );
            }

            const flat: writeReadingResult = {
                ...(parsed.result ?? {}),
                success: parsed.success,
                tankId: reading.tankId,
                tankNumber: (reading as any).tankNumber,
            };
            

            return flat;
        })
    );

    return results;
}