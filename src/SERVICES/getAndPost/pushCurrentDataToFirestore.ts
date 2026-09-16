import { doc, serverTimestamp, writeBatch } from "firebase/firestore";
import { auth, db } from "../../firebase";
import { upsertMeasurementInCache } from "./gettAllDataByBatch";
import type { Measurement } from "../cellering/calculateCelleringRecomendations";

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

const TWO_DECIMAL_FIELDS = new Set(["kegs", "crates", "totalLiters", "shrinkagePercent"]);

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
    tankNumber?: string | number | null;
    batchNumber?: string | number | null;
    notes?: unknown;
    sheetResult?: unknown;
    [key: string]: unknown;
};

export type PushCurrentDataOptions = {
    sheetSyncRequestId?: string;
};

function hasValue(value: unknown): boolean {
    return value !== undefined && value !== null && value !== "";
}

function round2(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
}

function normalizeCurrentDataValue(field: string, value: unknown): unknown {
    if (!TWO_DECIMAL_FIELDS.has(field)) return value;

    const numeric = typeof value === "number" ? value : Number(value);
    return Number.isFinite(numeric) ? round2(numeric) : value;
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

function noteOutboxPayload(readings: ReadingLike[]): string {
    return JSON.stringify(
        readings.map((reading) => ({
            tankId: String(reading.tankId),
            tankNumber: reading.tankNumber == null ? null : String(reading.tankNumber),
            batchNumber: reading.batchNumber == null ? null : String(reading.batchNumber),
            notes: String(reading.notes ?? "").trim(),
        }))
    );
}

export async function pushCurrentDataToFirestore(
    readings: ReadingLike[],
    options: PushCurrentDataOptions = {}
) {
    if (readings.length === 0) return;

    const firestoreBatch = writeBatch(db);
    let writeCount = 0;
    let hasAuthoritativeSheetResult = false;
    const cacheUpdates: Array<{
        batchId: string;
        measurement: Measurement;
    }> = [];

    readings.forEach((reading) => {
        const sheetResult = asSheetResult(reading.sheetResult);
        if (sheetResult) hasAuthoritativeSheetResult = true;

        const currentData: Record<string, unknown> = {};
        const revision = sheetResult && hasValue(reading.batchNumber) && buildMeasurementId(sheetResult.date, sheetResult.time)
            ? crypto.randomUUID() : null;

        CURRENT_DATA_FIELDS.forEach((field) => {
            if (reading[field] !== undefined) {
                currentData[field] = normalizeCurrentDataValue(field, reading[field]);
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
            firestoreBatch.set(tankRef, {
                currentData,
                ...(revision ? { measurementsRevision: revision } : {}),
            }, { merge: true });
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
        cacheUpdates.push({
            batchId,
            measurement: {
                id: measurementId,
                ...measurement,
            },
        });
    });

    if (options.sheetSyncRequestId) {
        const user = auth.currentUser;
        if (!user?.email) throw new Error("אין משתמש מחובר. יש להתחבר מחדש.");

        const requestId = options.sheetSyncRequestId.trim();
        if (!requestId) throw new Error("Missing Sheet sync requestId");

        firestoreBatch.set(doc(db, "sheetSyncJobs", requestId), {
            requestId,
            action: "addFermentationMeasurements",
            ownerUid: user.uid,
            ownerEmail: user.email,
            state: "pending",
            attempts: 0,
            readingsJson: noteOutboxPayload(readings),
            createdAt: serverTimestamp(),
        });
        writeCount += 1;
    }

    if (writeCount === 0) return;

    const commitAndRefreshCache = async () => {
        await firestoreBatch.commit();
        cacheUpdates.forEach(({ batchId, measurement }) => {
            upsertMeasurementInCache(batchId, measurement);
        });
    };

    // Before the Sheet request, callers use this function for the optimistic
    // realtime dashboard update. That write should still be awaited so the
    // dashboard is consistent before the authoritative response can arrive.
    //
    // After Apps Script has already confirmed the Sheet write, sheetResult is
    // present. At that point this second Firestore write is reconciliation only:
    // do it in the background so the UI can close immediately after Sheet
    // confirmation instead of waiting for another network round trip.
    if (hasAuthoritativeSheetResult) {
        void commitAndRefreshCache().catch((error) => {
            console.error("Background authoritative Firestore reconciliation failed:", error);
        });
        return;
    }

    await commitAndRefreshCache();
}
