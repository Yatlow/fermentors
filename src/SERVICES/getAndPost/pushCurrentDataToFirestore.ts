import { doc, writeBatch } from "firebase/firestore";
import { db } from "../../firebase";

const CURRENT_DATA_FIELDS = [
    "temp",
    "plato",
    "pH",
    "pressure",
    "carbonation",
    "volume",
    "notes",
    "isEmpty",
    "kegs",
    "crates",
    "totalLiters",
    "shrinkagePercent",
] as const;

type SheetResult = {
    date?: unknown;
    time?: unknown;
    temperature?: unknown;
    sugar?: unknown;
    pressure?: unknown;
    pH?: unknown;
    carbonation?: unknown;
    notes?: unknown;
};

type ReadingLike = {
    tankId: string;
    batchNumber?: string | number | null;
    sheetResult?: unknown;
    [key: string]: unknown;
};

function hasValue(value: unknown): boolean {
    return value !== undefined && value !== null && value !== "";
}

function toNumberOrNull(value: unknown): number | null {
    if (!hasValue(value)) return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;

    const normalized = String(value)
        .replace(",", ".")
        .replace(/[^0-9.+-]/g, "");

    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeBatchId(batchNumber: string | number): string {
    return String(batchNumber).replace("#", "").trim();
}

function buildMeasurementId(dateValue: unknown, timeValue: unknown): string | null {
    const dateMatch = String(dateValue ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    const timeMatch = String(timeValue ?? "").trim().match(/^(\d{1,2}):(\d{2})$/);

    if (!dateMatch || !timeMatch) return null;

    const [, day, month, year] = dateMatch;
    const [, hour, minute] = timeMatch;

    return [
        year,
        String(Number(month)).padStart(2, "0"),
        String(Number(day)).padStart(2, "0"),
    ].join("-") + "_" +
        String(Number(hour)).padStart(2, "0") +
        String(Number(minute)).padStart(2, "0");
}

function asSheetResult(value: unknown): SheetResult | null {
    if (!value || typeof value !== "object") return null;
    return value as SheetResult;
}

export async function pushCurrentDataToFirestore(readings: ReadingLike[]) {
    if (readings.length === 0) return;

    const firestoreBatch = writeBatch(db);
    let writeCount = 0;

    readings.forEach((reading) => {
        const sheetResult = asSheetResult(reading.sheetResult);
        const currentData: Record<string, unknown> = {};

        CURRENT_DATA_FIELDS.forEach((field) => {
            if (reading[field] !== undefined) {
                currentData[field] = reading[field];
            }
        });

        // תוצאת השרת היא השורה הסופית לאחר מיזוג עם דיווח קודם מאותו יום.
        if (sheetResult) {
            const authoritativeValues: Record<string, unknown> = {
                temp: toNumberOrNull(sheetResult.temperature),
                plato: toNumberOrNull(sheetResult.sugar),
                pressure: toNumberOrNull(sheetResult.pressure),
                pH: toNumberOrNull(sheetResult.pH),
                carbonation: toNumberOrNull(sheetResult.carbonation),
                notes: String(sheetResult.notes ?? "").trim(),
            };

            Object.entries(authoritativeValues).forEach(([key, value]) => {
                if (value !== null && value !== "") currentData[key] = value;
            });
        }

        if (Object.keys(currentData).length > 0) {
            const tankRef = doc(db, "fermentors", reading.tankId);
            firestoreBatch.set(tankRef, { currentData }, { merge: true });
            writeCount += 1;
        }

        if (!sheetResult || !hasValue(reading.batchNumber)) return;

        const measurementId = buildMeasurementId(sheetResult.date, sheetResult.time);
        const batchId = normalizeBatchId(reading.batchNumber as string | number);

        if (!measurementId || !batchId) {
            console.warn("Skipping realtime measurement write: invalid date/time/batch", {
                tankId: reading.tankId,
                batchNumber: reading.batchNumber,
                date: sheetResult.date,
                time: sheetResult.time,
            });
            return;
        }

        const measurement = {
            date: String(sheetResult.date ?? ""),
            time: String(sheetResult.time ?? ""),
            temp: toNumberOrNull(sheetResult.temperature),
            plato: toNumberOrNull(sheetResult.sugar),
            pressure: toNumberOrNull(sheetResult.pressure),
            pH: toNumberOrNull(sheetResult.pH),
            carbonation: toNumberOrNull(sheetResult.carbonation),
            notes: String(sheetResult.notes ?? "").trim(),
        };

        const measurementRef = doc(
            db,
            "brews",
            batchId,
            "measurements",
            measurementId
        );

        firestoreBatch.set(measurementRef, measurement, { merge: true });
        writeCount += 1;
    });

    if (writeCount > 0) {
        await firestoreBatch.commit();
    }
}
