import { doc, runTransaction, serverTimestamp, writeBatch } from "firebase/firestore";
import { auth, db } from "../../firebase";
import {
    applyOptimisticMeasurementUpdate,
    upsertMeasurementInCache,
} from "./gettAllDataByBatch";
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
const MEASUREMENT_FIELDS = ["temp", "plato", "pH", "pressure", "carbonation", "notes"] as const;

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
    confirmedSheetRequestId?: string;
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

// A pressure action changes live tank pressure, not the daily measurement.
// The immutable observation time prevents late Sheet replies or older requests
// from rolling back a newer measurement/action.
function reportedPressureUpdate(reading: ReadingLike): { pressure: number; at: string; source: string } | null {
    const isAction = hasValue(reading.pressureAfterAction);
    const raw = isAction ? reading.pressureAfterAction : reading.pressure;
    if (!hasValue(raw)) return null;
    const pressure = toNumberOrNull(raw);
    const at = String(reading.pressureRecordedAt ?? "");
    if (pressure === null || pressure < 0 || !Number.isFinite(Date.parse(at))) return null;
    return { pressure, at, source: isAction ? "action" : "measurement" };
}

function isNewerPressureUpdate(existing: unknown, incoming: string): boolean {
    return !existing || typeof existing !== "string" ||
        !Number.isFinite(Date.parse(existing)) || Date.parse(incoming) >= Date.parse(existing);
}

function normalizeBatchId(batchNumber: string | number): string {
    return String(batchNumber).replace("#", "").trim();
}

// A deterministic document per brew/day. Time stays a DATA field, not identity.
function buildMeasurementId(dateValue: unknown, timeValue: unknown): string | null {
    const dateMatch = String(dateValue ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    const timeMatch = String(timeValue ?? "").trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!dateMatch || !timeMatch || +timeMatch[1] > 23 || +timeMatch[2] > 59) return null;
    const [, day, month, year] = dateMatch;
    const stamp = new Date(Date.UTC(+year, +month - 1, +day));
    if (stamp.getUTCFullYear() !== +year || stamp.getUTCMonth() !== +month - 1 ||
        stamp.getUTCDate() !== +day) return null;
    return [year, String(+month).padStart(2, "0"), String(+day).padStart(2, "0")].join("-");
}

function asSheetResult(value: unknown): SheetResult | null {
    if (!value || typeof value !== "object") return null;
    return value as SheetResult;
}

function sheetOutboxPayload(readings: ReadingLike[]): string {
    return JSON.stringify(
        readings.map((reading) => ({
            tankId: String(reading.tankId),
            tankNumber: reading.tankNumber == null ? null : String(reading.tankNumber),
            batchNumber: reading.batchNumber == null ? null : String(reading.batchNumber),
            temp: reading.temp ?? null,
            pressure: reading.pressure ?? null,
            pressureAfterAction: reading.pressureAfterAction ?? null,
            pressureRecordedAt: reading.pressureRecordedAt ?? null,
            plato: reading.plato ?? null,
            pH: reading.pH ?? null,
            carbonation: reading.carbonation ?? null,
            isEmpty: reading.isEmpty ?? null,
            kegs: reading.kegs ?? null,
            crates: reading.crates ?? null,
            totalLiters: reading.totalLiters ?? null,
            shrinkagePercent: reading.shrinkagePercent ?? null,
            boldNotes: reading.boldNotes ?? null,
            notes: String(reading.notes ?? "").trim(),
        }))
    );
}

function optimisticMeasurementFromReading(reading: ReadingLike): Measurement | null {
    if (!hasValue(reading.id)) return null;

    const measurement: Measurement = {
        id: String(reading.id),
    };
    let hasMeasurementValue = false;

    MEASUREMENT_FIELDS.forEach((field) => {
        const value = reading[field];
        if (!hasValue(value)) return;

        hasMeasurementValue = true;
        if (field === "notes") {
            measurement.notes = String(value).trim();
            return;
        }

        const numeric = toNumberOrNull(value);
        if (numeric !== null) {
            measurement[field] = numeric;
        }
    });

    return hasMeasurementValue ? measurement : null;
}

/**
 * Only the latest submitted Sheet request for a tank may reconcile a complete
 * Sheet row. Firestore retries this transaction when a newer report commits
 * while a delayed response is being processed.
 */
async function reconcileConfirmedReadings(
    readings: ReadingLike[],
    confirmedRequestId: string,
): Promise<void> {
    const rows = readings.map(reading => {
        const result = asSheetResult(reading.sheetResult);
        const batchId = hasValue(reading.batchNumber)
            ? normalizeBatchId(reading.batchNumber as string | number) : "";
        const measurementId = result && buildMeasurementId(result.date, result.time);
        if (!result || !batchId || !measurementId) {
            throw new Error("Cannot reconcile Sheet result: invalid batch, date or time");
        }
        return { reading, result, batchId, measurementId,
            tankRef: doc(db, "fermentors", reading.tankId) };
    });
    let applied: Array<{ batchId: string; measurement: Measurement }> = [];
    await runTransaction(db, async transaction => {
        const tanks = await Promise.all(rows.map(row => transaction.get(row.tankRef)));
        const nextApplied: typeof applied = [];
        rows.forEach((row, index) => {
            const latestId = String(tanks[index].data()?.latestSheetSyncRequestId ?? "");
            if (latestId && latestId !== confirmedRequestId) return;
            const measurement = {
                date: String(row.result.date ?? ""),
                time: String(row.result.time ?? ""),
                temp: toNumberOrNull(row.result.temperature),
                plato: toNumberOrNull(row.result.sugar),
                pressure: toNumberOrNull(row.result.pressure),
                pH: toNumberOrNull(row.result.pH),
                carbonation: toNumberOrNull(row.result.carbonation),
                notes: String(row.result.notes ?? "").trim(),
            };
            const currentData = Object.fromEntries(
                Object.entries(measurement)
                    // A complete Sheet row contains the morning pressure even
                    // for unrelated afternoon notes. Never let it roll back the
                    // current tank pressure.
                    .filter(([key, value]) => key !== "date" && key !== "time" &&
                        key !== "pressure" && value !== null && value !== ""),
            );
            const live = tanks[index].data();
            const expectedBatch = normalizeBatchId(String(row.reading.batchNumber ?? ""));
            const liveBatch = normalizeBatchId(String(live?.batchNumber ?? ""));
            const reported = reportedPressureUpdate(row.reading);
            if (reported && expectedBatch === liveBatch &&
                (String(live?.currentData?.pressureBatchNumber ?? "") !== expectedBatch ||
                    isNewerPressureUpdate(live?.currentData?.pressureUpdatedAt, reported.at))) {
                currentData.pressure = reported.pressure;
                currentData.pressureUpdatedAt = reported.at;
                currentData.pressureSource = reported.source;
                currentData.pressureBatchNumber = expectedBatch;
            }
            transaction.set(doc(db, "brews", row.batchId, "measurements", row.measurementId),
                measurement, { merge: true });
            if (Object.keys(currentData).length) {
                transaction.set(row.tankRef, {
                    currentData,
                    lastChangeSource: "APP",
                    measurementsRevision: crypto.randomUUID(),
                }, { merge: true });
            }
            nextApplied.push({
                batchId: row.batchId,
                measurement: { id: row.measurementId, ...measurement },
            });
        });
        applied = nextApplied;
    });
    applied.forEach(({ batchId, measurement }) => upsertMeasurementInCache(batchId, measurement));
}

export async function pushCurrentDataToFirestore(
    readings: ReadingLike[],
    options: PushCurrentDataOptions = {}
) {
    if (readings.length === 0) return;
    if (options.confirmedSheetRequestId) {
        await reconcileConfirmedReadings(readings, options.confirmedSheetRequestId);
        return;
    }

    const firestoreBatch = writeBatch(db);
    let writeCount = 0;
    const cacheUpdates: Array<{
        batchId: string;
        measurement: Measurement;
    }> = [];
    const optimisticCacheUpdates: Array<{
        batchId: string;
        measurement: Measurement;
    }> = [];
    const pressureUpdates: Array<{ tankId: string; batchId: string; update: NonNullable<ReturnType<typeof reportedPressureUpdate>> }> = [];

    readings.forEach((reading) => {
        const sheetResult = asSheetResult(reading.sheetResult);

        const currentData: Record<string, unknown> = {};
        const revision = sheetResult && hasValue(reading.batchNumber) && buildMeasurementId(sheetResult.date, sheetResult.time)
            ? crypto.randomUUID() : null;

        CURRENT_DATA_FIELDS.forEach((field) => {
            if (field !== "pressure" && reading[field] !== undefined) {
                currentData[field] = normalizeCurrentDataValue(field, reading[field]);
            }
        });

        // תוצאת השרת היא השורה הסופית לאחר מיזוג עם דיווח קודם מאותו יום.
        if (sheetResult) {
            const authoritativeValues: Record<string, unknown> = {
                temp: toNumberOrNull(sheetResult.temperature),
                plato: toNumberOrNull(sheetResult.sugar),
                pH: toNumberOrNull(sheetResult.pH),
                carbonation: toNumberOrNull(sheetResult.carbonation),
                notes: String(sheetResult.notes ?? "").trim(),
            };

            Object.entries(authoritativeValues).forEach(([key, value]) => {
                if (value !== null && value !== "") currentData[key] = value;
            });
        }

        const reported = reportedPressureUpdate(reading);
        if (reported) {
            pressureUpdates.push({
                tankId: reading.tankId,
                batchId: normalizeBatchId(String(reading.batchNumber ?? "")),
                update: reported,
            });
        }

        if (Object.keys(currentData).length > 0) {
            const tankRef = doc(db, "fermentors", reading.tankId);
            firestoreBatch.set(tankRef, {
                currentData,
                lastChangeSource: "APP",
                ...(revision ? { measurementsRevision: revision } : {}),
                ...(options.sheetSyncRequestId
                    ? { latestSheetSyncRequestId: options.sheetSyncRequestId }
                    : {}),
            }, { merge: true });
            writeCount += 1;
        }

        if (!hasValue(reading.batchNumber)) return;
        const batchId = normalizeBatchId(reading.batchNumber as string | number);
        if (!batchId) return;

        // Before Apps Script answers, immediately overlay the app-originated
        // reading on today's visible history. This makes carbonation, pressure,
        // PRV/yeast/cooling notes and every other cellar action affect the score
        // and recommendations as soon as the Firestore optimistic write succeeds.
        if (!sheetResult) {
            const optimisticMeasurement = optimisticMeasurementFromReading(reading);
            if (optimisticMeasurement) {
                optimisticCacheUpdates.push({ batchId, measurement: optimisticMeasurement });
            }
            return;
        }

        const measurementId = buildMeasurementId(sheetResult.date, sheetResult.time);

        if (!measurementId) {
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

        const uniqueTanks = [...new Set(readings.map(reading => String(reading.tankNumber ?? reading.tankId)).filter(Boolean))];
        const uniqueBatches = [...new Set(readings.map(reading => String(reading.batchNumber ?? "")).filter(Boolean))];
        const operationTypes = [...new Set(readings.map(reading => {
            if (hasValue(reading.kegs) || hasValue(reading.crates) || reading.isEmpty !== undefined) return "אריזה";
            if (hasValue(reading.carbonation)) return "בדיקת גיזוז";
            if (hasValue(reading.plato) || hasValue(reading.pH)) return "פלאטו / pH";
            if (hasValue(reading.pressureAfterAction)) return "שינוי לחץ / לחץ אחרי פעולה";
            if (hasValue(reading.temp) || hasValue(reading.pressure)) return "טמפרטורה / לחץ";
            if (hasValue(reading.notes)) return "פעולת סלרינג";
            return "מדידה";
        }))];
        firestoreBatch.set(doc(db, "sheetSyncJobs", requestId), {
            requestId,
            action: "addFermentationMeasurements",
            tankNumber: uniqueTanks.length === 1 ? uniqueTanks[0] : null,
            batchNumber: uniqueBatches.length === 1 ? uniqueBatches[0] : null,
            tankNumbers: uniqueTanks,
            operationType: operationTypes.join(" + "),
            ownerUid: user.uid,
            ownerEmail: user.email,
            state: "pending",
            attempts: 0,
            readingsJson: sheetOutboxPayload(readings),
            createdAt: serverTimestamp(),
        });
        writeCount += 1;
    }

    if (writeCount === 0) return;

    const commitAndRefreshCache = async () => {
        await firestoreBatch.commit();
        if (pressureUpdates.length) {
            await runTransaction(db, async transaction => {
                const refs = pressureUpdates.map(item => doc(db, "fermentors", item.tankId));
                const current = await Promise.all(refs.map(ref => transaction.get(ref)));
                pressureUpdates.forEach(({ batchId, update }, index) => {
                    const live = current[index].data();
                    if (!live || normalizeBatchId(String(live.batchNumber ?? "")) !== batchId ||
                        (String(live.currentData?.pressureBatchNumber ?? "") === batchId &&
                        !isNewerPressureUpdate(live.currentData?.pressureUpdatedAt, update.at))) return;
                    transaction.set(refs[index], {
                        currentData: {
                            pressure: update.pressure,
                            pressureUpdatedAt: update.at,
                            pressureSource: update.source,
                            pressureBatchNumber: batchId,
                        },
                        lastChangeSource: "APP",
                    }, { merge: true });
                });
            });
        }

        optimisticCacheUpdates.forEach(({ batchId, measurement }) => {
            applyOptimisticMeasurementUpdate(batchId, measurement);
        });

        cacheUpdates.forEach(({ batchId, measurement }) => {
            upsertMeasurementInCache(batchId, measurement);
        });
    };

    // Do not swallow an authoritative reconciliation failure. Callers must
    // only clear their durable recovery job after this commit succeeds.
    await commitAndRefreshCache();
}
