import { measurementDayKeyFromId, type MeasurementHistoryLike } from "./measurementHistoryModel";

/** Parsed Firestore outbox data, shared by all signed-in clients. The outbox is
 * written durably before the Sheet request starts, so no extra write or
 * per-batch listener is needed to make pending cellar actions visible. */
export type PendingCellarMeasurement = {
  batchId: string;
  measurement: MeasurementHistoryLike;
};

type PendingJob = {
  readingsJson?: unknown;
  createdAt?: unknown;
};

function localDay(value: unknown): string | null {
  let date: Date | null = null;
  if (value instanceof Date) date = value;
  else if (value && typeof value === "object") {
    const timestamp = value as { toDate?: () => Date; seconds?: number };
    if (typeof timestamp.toDate === "function") date = timestamp.toDate();
    else if (typeof timestamp.seconds === "number") date = new Date(timestamp.seconds * 1000);
  } else if (typeof value === "string" || typeof value === "number") {
    date = new Date(typeof value === "number" ? value : Date.parse(value));
  }
  if (!date || !Number.isFinite(date.getTime())) return null;
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")].join("-");
}

function numeric(value: unknown): number | null {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const number = Number(String(value).trim().replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

/** Ignore packaging metadata and live pressure-setpoint changes: the latter
 * are not a new morning-pressure measurement. Preserve action notes, though. */
export function pendingMeasurementsFromSyncJob(job: PendingJob): PendingCellarMeasurement[] {
  if (typeof job.readingsJson !== "string") return [];
  let readings: unknown;
  try { readings = JSON.parse(job.readingsJson); } catch { return []; }
  if (!Array.isArray(readings)) return [];
  const fallbackDay = localDay(job.createdAt);
  const result: PendingCellarMeasurement[] = [];

  for (const item of readings) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const reading = item as Record<string, unknown>;
    const batchId = String(reading.batchNumber ?? "").replace(/^#/, "").trim();
    if (!batchId || batchId.includes("/")) continue;
    const id = String(reading.id ?? "").trim();
    const day = measurementDayKeyFromId(id) ?? fallbackDay;
    if (!day) continue;

    const measurement: MeasurementHistoryLike = {
      id: measurementDayKeyFromId(id) ? id : day,
    };
    for (const field of ["temp", "pressure", "plato", "pH", "carbonation"] as const) {
      const value = numeric(reading[field]);
      if (value !== null) measurement[field] = value;
    }
    const notes = typeof reading.notes === "string" ? reading.notes.trim() : "";
    if (notes) measurement.notes = notes;
    if (Object.keys(measurement).length > 1) result.push({ batchId, measurement });
  }
  return result;
}
