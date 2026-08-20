import type { ReadingToSend } from "../App";

type writeReadingResult = {
    success: boolean;
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
            console.log(
                "SENDING PAYLOAD:",
                payload
            );
            const response = await fetch(GOOGLE_SCRIPT_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "text/plain;charset=utf-8",
                },
                body: JSON.stringify(payload),
            });

            const text = await response.text();

            console.log(
                "Google Apps Script response:",
                text
            );

            let result: writeReadingResult;

            try {
                result = JSON.parse(text) as writeReadingResult;
            } catch {
                throw new Error(
                    "Google Apps Script returned invalid JSON: " + text
                );
            }

            if (!result.success) {
                throw new Error(
                    result.error ||
                    result.message ||
                    "Tank update failed"
                );
            }

            console.log(
                "Tank successfully updated:",
                reading.tankId
            );

            return result;
        })
    );

    return results;
}