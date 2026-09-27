import {
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Unsubscribe,
} from "firebase/firestore";
import { auth, db } from "../../firebase";

export type ScheduledCellarActionType = "carbTest" | "yeastDrop" | "pressureChange";
export type PressureChangeDirection = "raise" | "lower";
export type ScheduledCellarRecommendation = {
  id: string;
  tankNumber: string;
  batchNumber: string;
  actionType: ScheduledCellarActionType;
  dueDate: string;
  note?: string;
  pressureDirection?: PressureChangeDirection;
  targetPressure?: number;
  source?: "user";
  status: "active" | "completed" | "cancelled";
  createdBy?: string;
  resolvedDate?: string;
};

export type ScheduledCellarEvidenceMeasurement = {
  id?: string | number | null;
  date?: unknown;
  notes?: unknown;
  carbonation?: unknown;
};

type DueScheduledCellarRecommendation = Omit<ScheduledCellarRecommendation, "actionType"> & {
  // Due rows can now also contain a user pressure decision. Legacy consumers
  // that only auto-complete carb/yeast actions should simply ignore any other
  // runtime action value instead of failing the TypeScript build.
  actionType: any;
};

const COLLECTION = "scheduledCellarRecommendations";
const PREVIEW_STORAGE_KEY = "preview_scheduled_cellar_recommendations_v1";
const PREVIEW_EVENT = "preview-scheduled-cellar-recommendations";

function isPullRequestPreview(): boolean {
  return typeof window !== "undefined" && window.location.hostname.includes("--pr");
}

function readPreviewRows(): ScheduledCellarRecommendation[] {
  if (!isPullRequestPreview()) return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PREVIEW_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writePreviewRows(rows: ScheduledCellarRecommendation[]) {
  window.localStorage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(rows));
  window.dispatchEvent(new Event(PREVIEW_EVENT));
}

export function todayDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day;
}

export function scheduledEvidenceDateKey(
  measurement: ScheduledCellarEvidenceMeasurement,
): string | null {
  const idMatch = String(measurement.id ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:_|$)/);
  if (idMatch) {
    const year = Number(idMatch[1]);
    const month = Number(idMatch[2]);
    const day = Number(idMatch[3]);
    if (!validCalendarDate(year, month, day)) return null;
    return `${idMatch[1]}-${idMatch[2]}-${idMatch[3]}`;
  }

  const dateMatch = String(measurement.date ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!dateMatch) return null;

  let year = Number(dateMatch[3]);
  if (year < 100) year += 2000;
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[1]);
  if (!validCalendarDate(year, month, day)) return null;

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function hasFiniteCarbonation(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  return Number.isFinite(Number(value));
}

function measurementCompletesScheduledAction(
  actionType: ScheduledCellarActionType,
  measurement: ScheduledCellarEvidenceMeasurement,
): boolean {
  const notes = String(measurement.notes ?? "");

  if (actionType === "carbTest") {
    return hasFiniteCarbonation(measurement.carbonation) || /בדיקת\s+גיזוז/.test(notes);
  }
  if (actionType === "yeastDrop") {
    return /שמרים|שמרי/.test(notes);
  }
  return /הורדת לחץ|העלאת לחץ|להוריד לחץ|להעלות לחץ|שינוי לחץ|גיזוז מלמטה/.test(notes);
}

/**
 * The due date is the point from which a scheduled recommendation becomes
 * actionable. Completion is derived from real cellar data, never from a
 * manual "done" button: the first matching measurement/note on or after the
 * due date resolves the recommendation.
 */
export function scheduledRecommendationCompletionDate(
  row: ScheduledCellarRecommendation,
  measurements: ScheduledCellarEvidenceMeasurement[],
): string | null {
  const matchingDates = measurements
    .map((measurement) => ({
      measurement,
      dateKey: scheduledEvidenceDateKey(measurement),
    }))
    .filter((entry): entry is { measurement: ScheduledCellarEvidenceMeasurement; dateKey: string } =>
      Boolean(entry.dateKey) && entry.dateKey >= row.dueDate
    )
    .filter((entry) => measurementCompletesScheduledAction(row.actionType, entry.measurement))
    .map((entry) => entry.dateKey)
    .sort();

  return matchingDates[0] ?? null;
}

export function scheduledActionLabel(action: ScheduledCellarActionType): string {
  if (action === "carbTest") return "בדיקת גיזוז";
  if (action === "yeastDrop") return "הורדת שמרים";
  return "שינוי לחץ";
}

export function subscribeScheduledCellarRecommendations(
  callback: (rows: ScheduledCellarRecommendation[]) => void,
  onError?: (error: Error) => void,
): Unsubscribe {
  if (isPullRequestPreview()) {
    const emit = () => callback(readPreviewRows().filter((row) => row.status === "active"));
    emit();
    window.addEventListener(PREVIEW_EVENT, emit);
    return () => window.removeEventListener(PREVIEW_EVENT, emit);
  }

  return onSnapshot(
    query(collection(db, COLLECTION), where("status", "==", "active")),
    (snapshot) => {
      callback(snapshot.docs.map((item) => ({
        id: item.id,
        ...(item.data() as Omit<ScheduledCellarRecommendation, "id">),
      })));
    },
    (error) => onError?.(error),
  );
}

export async function createScheduledCellarRecommendation(input: {
  tankNumber: string | number;
  batchNumber: string | number;
  actionType: ScheduledCellarActionType;
  dueDate: string;
  note?: string;
  pressureDirection?: PressureChangeDirection;
  targetPressure?: number;
  source?: "user";
}): Promise<string> {
  const user = auth.currentUser;
  if (!user?.email) throw new Error("אין משתמש מחובר");

  const sourceFields = input.source === "user"
    ? { source: "user" as const }
    : {};
  const pressureFields = input.actionType === "pressureChange"
    ? {
        pressureDirection: input.pressureDirection,
        targetPressure: input.targetPressure,
        source: "user" as const,
      }
    : sourceFields;

  if (isPullRequestPreview()) {
    const id = globalThis.crypto?.randomUUID?.() ?? `preview-${Date.now()}`;
    const rows = readPreviewRows();
    rows.push({
      id,
      tankNumber: String(input.tankNumber),
      batchNumber: String(input.batchNumber),
      actionType: input.actionType,
      dueDate: input.dueDate,
      note: input.note?.trim() || "",
      ...pressureFields,
      status: "active",
      createdBy: user.email,
    });
    writePreviewRows(rows);
    return id;
  }

  const ref = doc(collection(db, COLLECTION));
  await setDoc(ref, {
    tankNumber: String(input.tankNumber),
    batchNumber: String(input.batchNumber),
    actionType: input.actionType,
    dueDate: input.dueDate,
    note: input.note?.trim() || "",
    ...pressureFields,
    status: "active",
    createdBy: user.email,
    createdByUid: user.uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

export async function setScheduledCellarRecommendationStatus(
  id: string,
  status: "completed" | "cancelled",
  resolvedDateOverride?: string,
): Promise<void> {
  const resolvedDate = resolvedDateOverride || todayDateKey();

  if (isPullRequestPreview()) {
    writePreviewRows(
      readPreviewRows().map((row) =>
        row.id === id ? { ...row, status, resolvedDate } : row
      )
    );
    return;
  }

  await updateDoc(doc(db, COLLECTION, id), {
    status,
    resolvedDate,
    resolvedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export function subscribeCompletedScheduledCellarRecommendationsToday(
  callback: (rows: ScheduledCellarRecommendation[]) => void,
  onError?: (error: Error) => void,
): Unsubscribe {
  const today = todayDateKey();

  if (isPullRequestPreview()) {
    const emit = () => callback(
      readPreviewRows().filter((row) => row.status === "completed" && row.resolvedDate === today)
    );
    emit();
    window.addEventListener(PREVIEW_EVENT, emit);
    return () => window.removeEventListener(PREVIEW_EVENT, emit);
  }

  return onSnapshot(
    query(collection(db, COLLECTION), where("resolvedDate", "==", today)),
    (snapshot) => {
      callback(
        snapshot.docs
          .map((item) => ({
            id: item.id,
            ...(item.data() as Omit<ScheduledCellarRecommendation, "id">),
          }))
          .filter((row) => row.status === "completed")
      );
    },
    (error) => onError?.(error),
  );
}

export function scheduledForTank(
  rows: ScheduledCellarRecommendation[],
  tankNumber: string | number | null | undefined,
  batchNumber: string | number | null | undefined,
): ScheduledCellarRecommendation[] {
  const tank = String(tankNumber ?? "").trim();
  const batch = String(batchNumber ?? "").replace("#", "").trim();
  return rows
    .filter((row) =>
      row.status === "active" &&
      row.tankNumber === tank &&
      row.batchNumber.replace("#", "").trim() === batch
    )
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

export function dueScheduledForTank(
  rows: ScheduledCellarRecommendation[],
  tankNumber: string | number | null | undefined,
  batchNumber: string | number | null | undefined,
  today = todayDateKey(),
): DueScheduledCellarRecommendation[] {
  return scheduledForTank(rows, tankNumber, batchNumber)
    .filter((row) => row.dueDate <= today) as DueScheduledCellarRecommendation[];
}
