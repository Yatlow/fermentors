import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Unsubscribe,
} from "firebase/firestore";
import { auth, db } from "../../firebase";
import { recordGlobalServerRead } from "../globalReadDiagnostics";
import { scheduledDateValidationError } from "./scheduledDatePolicy";

export type ScheduledCellarActionType = "carbTest" | "yeastDrop" | "pressureChange" | "bottomCarbonation" | "coolDown" | "other";
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
  /** Snapshot of the creator's privileges at the time the instruction was entered. */
  createdByIsCellarManager?: boolean;
  createdAt?: { toDate: () => Date } | string | Date;
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
  if (actionType === "bottomCarbonation") {
    // A planned bottom-carbonation action is fulfilled by starting the procedure,
    // not by a carbonation test or merely closing a previous procedure.
    return /תחילת\s+גיזוז\s+מלמטה/.test(notes);
  }
  if (actionType === "coolDown") {
    // Only an executed cooling report is evidence. A note merely mentioning
    // cooling must not silently close a manager's scheduled instruction.
    return /קירור מיכל ל|התחלת קירור|הועבר לקירור/.test(notes);
  }
  if (actionType === "other") {
    // Free-form work has no reliable automated evidence: staff explicitly
    // mark each instruction done rather than guessing from unrelated notes.
    return false;
  }
  // Pressure decisions use the dedicated evaluator below. The latest pressure
  // report for the due day applies even if the decision was entered later.
  return false;
}


/** Actual pressure-adjustment reports contain a numeric result. Do not treat
 * a suggestion ("מומלץ להעלות לחץ") or a pressure measurement as an action. */
const PRESSURE_REPORT = /(?:העלאת|הורדת)\s+לחץ\s+ל\s*[:：=-]?\s*(\d+(?:[.,]\d+)?)/gu;

function evidenceMoment(measurement: ScheduledCellarEvidenceMeasurement): number | null {
  const match = String(measurement.id ?? "").match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})/);
  if (!match) return null;
  const date = new Date(+match[1], +match[2] - 1, +match[3], +match[4], +match[5]);
  return date.getFullYear() === +match[1] && date.getMonth() === +match[2] - 1
    && date.getDate() === +match[3] && date.getHours() === +match[4]
    && date.getMinutes() === +match[5] ? date.getTime() : null;
}

function pressureReports(notes: unknown): number[] {
  const text = String(notes ?? "");
  const result: number[] = [];
  for (const match of text.matchAll(PRESSURE_REPORT)) {
    const pressure = Number(match[1].replace(",", "."));
    if (Number.isFinite(pressure) && pressure >= 0 && pressure <= 5) result.push(pressure);
  }
  return result;
}

export type ScheduledPressureDecisionEvidence = {
  completionDate: string | null;
  latestPressure: number | null;
  hasPressureChange: boolean;
  mismatched: boolean;
};

export function scheduledPressureDecisionEvidence(
  row: ScheduledCellarRecommendation,
  measurements: ScheduledCellarEvidenceMeasurement[],
): ScheduledPressureDecisionEvidence {
  const none = { completionDate: null, latestPressure: null, hasPressureChange: false, mismatched: false };
  if (row.actionType !== "pressureChange") return none;

  const events = measurements.flatMap((measurement, index) => {
    const dateKey = scheduledEvidenceDateKey(measurement);
    if (!dateKey || dateKey < row.dueDate) return [];
    const reportedAt = evidenceMoment(measurement);
    return pressureReports(measurement.notes).map((pressure, innerIndex) => ({
      pressure, dateKey, order: reportedAt ?? new Date(dateKey + "T00:00:00").getTime(),
      index, innerIndex,
    }));
  }).sort((a, b) =>
    a.order - b.order || a.index - b.index || a.innerIndex - b.innerIndex
  );

  if (!events.length) return none;
  const latest = events[events.length - 1];
  const strict = row.createdByIsCellarManager === true;
  const target = row.targetPressure;
  const matches = !strict || (typeof target === "number" && Number.isFinite(target) &&
    Math.abs(latest.pressure - target) < 0.000001);
  return {
    completionDate: matches ? latest.dateKey : null,
    latestPressure: latest.pressure,
    hasPressureChange: true,
    mismatched: strict && !matches,
  };
}

/** Extra context when a manager's target conflicts with the latest pressure
 * change report, including one made earlier on the same scheduled day. */
export function scheduledPressureDecisionConflictText(
  row: ScheduledCellarRecommendation,
  measurements: ScheduledCellarEvidenceMeasurement[],
): string | null {
  const evidence = scheduledPressureDecisionEvidence(row, measurements);
  if (!evidence.mismatched || evidence.latestPressure === null) return null;
  const who = row.createdBy?.trim() || "מנהל סלרינג";
  const target = Number(row.targetPressure);
  if (!Number.isFinite(target)) return null;
  return `משתמש ${who} החליט על שינוי לחץ ל־${target} bar, שינוי לחץ בוצע ל־${evidence.latestPressure} bar — יש לשנות ל־${target} bar בהתאם להמלצה`;
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
  if (row.actionType === "pressureChange") {
    return scheduledPressureDecisionEvidence(row, measurements).completionDate;
  }
  const matchingDates = measurements
    .map((measurement) => ({
      measurement,
      dateKey: scheduledEvidenceDateKey(measurement),
    }))
    .filter((entry): entry is { measurement: ScheduledCellarEvidenceMeasurement; dateKey: string } =>
      entry.dateKey !== null && entry.dateKey >= row.dueDate
    )
    .filter((entry) => measurementCompletesScheduledAction(row.actionType, entry.measurement))
    .map((entry) => entry.dateKey)
    .sort();

  return matchingDates[0] ?? null;
}

export function scheduledActionLabel(action: ScheduledCellarActionType): string {
  if (action === "carbTest") return "בדיקת גיזוז";
  if (action === "yeastDrop") return "הורדת שמרים";
  if (action === "bottomCarbonation") return "גיזוז מלמטה";
  if (action === "coolDown") return "קירור";
  if (action === "other") return "אחר";
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
      if (!snapshot.metadata.fromCache) recordGlobalServerRead("Scheduled active", snapshot.size);
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
  // Enforce at the shared write boundary, not only in <input type="date">:
  // iOS date pickers, stale forms and direct callers can bypass HTML min.
  const dateError = scheduledDateValidationError(input.dueDate, todayDateKey());
  if (dateError) throw new Error(dateError);

  const user = auth.currentUser;
  if (!user?.email) throw new Error("אין משתמש מחובר");
  if (input.actionType === "other" && !input.note?.trim()) {
    throw new Error("יש להזין הוראה חופשית");
  }

  // A single self-document read at creation freezes who is authorized to give
  // binding pressure instructions. Do not re-read all users per dashboard render
  // or let a later role change silently rewrite past decisions.
  const creatorIsCellarManager = !isPullRequestPreview() && input.actionType === "pressureChange"
    ? await (async () => {
        const profile = await getDoc(doc(db, "approvedUsers", user.email!.toLowerCase()));
        if (!profile.exists()) throw new Error("לא נמצאה הרשאת משתמש מאושר");
        const data = profile.data();
        return data.isCellarManager === true || data.isAdmin === true;
      })()
    : false;

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
      createdByIsCellarManager: creatorIsCellarManager,
      createdAt: new Date().toISOString(),
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
    createdByIsCellarManager: creatorIsCellarManager,
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
  // Safety hotfix: HealthDashboard passes an explicit completion date when it
  // infers completion from measurements. That analysis runs repeatedly on mount
  // and on live-data changes, so it must remain read-only. Keep manual/user
  // status changes working (for example cancellation, which has no override).
  if (status === "completed" && resolvedDateOverride) return;

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
      if (!snapshot.metadata.fromCache) recordGlobalServerRead("Scheduled completed today", snapshot.size);
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

/**
 * A planned bottom-carbonation start is already the user's chosen response to
 * an out-of-spec carbonation test. Only active decisions for this exact batch
 * scheduled today or later suppress the generic automatic pressure advice.
 * An expired/cancelled decision must never hide a new action.
 */
export function hasUpcomingBottomCarbonationDecision(
  rows: ScheduledCellarRecommendation[],
  tankNumber: string | number | null | undefined,
  batchNumber: string | number | null | undefined,
  today = todayDateKey(),
): boolean {
  return scheduledForTank(rows, tankNumber, batchNumber).some((row) =>
    row.actionType === "bottomCarbonation" && row.dueDate >= today
  );
}

export function dueScheduledForTank(
  rows: ScheduledCellarRecommendation[],
  tankNumber: string | number | null | undefined,
  batchNumber: string | number | null | undefined,
  today = todayDateKey(),
): DueScheduledCellarRecommendation[] {
  // Scheduled cellar work is date-specific, not an overdue task queue.
  // Showing older/future rows in today's recommendation modal makes the first
  // post-measurement load surface actions that were not scheduled for today.
  return scheduledForTank(rows, tankNumber, batchNumber)
    .filter((row) => row.dueDate === today) as DueScheduledCellarRecommendation[];
}
