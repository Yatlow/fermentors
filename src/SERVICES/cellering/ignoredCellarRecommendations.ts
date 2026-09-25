import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
  type Unsubscribe,
} from "firebase/firestore";
import { auth, db } from "../../firebase";
import { todayDateKey } from "./scheduledCellarRecommendations";

export type IgnoredCellarRecommendation = {
  id: string;
  tankNumber: string;
  batchNumber: string;
  recommendationKey: string;
  title: string;
  detail: string;
  importance: number;
  ignoredDate: string;
  ignoredBy?: string;
};

const COLLECTION = "ignoredCellarRecommendations";
const PREVIEW_STORAGE_KEY = "preview_ignored_cellar_recommendations_v1";
const PREVIEW_EVENT = "preview-ignored-cellar-recommendations";

function isPullRequestPreview(): boolean {
  return typeof window !== "undefined" && window.location.hostname.includes("--pr");
}

function readPreviewRows(): IgnoredCellarRecommendation[] {
  if (!isPullRequestPreview()) return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PREVIEW_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writePreviewRows(rows: IgnoredCellarRecommendation[]) {
  window.localStorage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(rows));
  window.dispatchEvent(new Event(PREVIEW_EVENT));
}

function documentId(input: {
  tankNumber: string | number;
  batchNumber: string | number;
  recommendationKey: string;
  ignoredDate?: string;
}): string {
  const date = input.ignoredDate || todayDateKey();
  const safe = (value: string | number) =>
    String(value).trim().replace(/[^a-zA-Z0-9_-]/g, "_");
  return [
    date,
    safe(input.tankNumber),
    safe(String(input.batchNumber).replace("#", "")),
    safe(input.recommendationKey),
  ].join("__");
}

export function subscribeIgnoredCellarRecommendationsToday(
  callback: (rows: IgnoredCellarRecommendation[]) => void,
  onError?: (error: Error) => void,
): Unsubscribe {
  const today = todayDateKey();

  if (isPullRequestPreview()) {
    const emit = () => callback(
      readPreviewRows().filter((row) => row.ignoredDate === today)
    );
    emit();
    window.addEventListener(PREVIEW_EVENT, emit);
    return () => window.removeEventListener(PREVIEW_EVENT, emit);
  }

  return onSnapshot(
    query(collection(db, COLLECTION), where("ignoredDate", "==", today)),
    (snapshot) => {
      callback(snapshot.docs.map((item) => ({
        id: item.id,
        ...(item.data() as Omit<IgnoredCellarRecommendation, "id">),
      })));
    },
    (error) => onError?.(error),
  );
}

export async function ignoreCellarRecommendation(input: {
  tankNumber: string | number;
  batchNumber: string | number;
  recommendationKey: string;
  title: string;
  detail: string;
  importance: number;
}): Promise<void> {
  const user = auth.currentUser;
  if (!user?.email) throw new Error("אין משתמש מחובר");

  const ignoredDate = todayDateKey();
  const id = documentId({ ...input, ignoredDate });
  const row: IgnoredCellarRecommendation = {
    id,
    tankNumber: String(input.tankNumber),
    batchNumber: String(input.batchNumber).replace("#", ""),
    recommendationKey: input.recommendationKey,
    title: input.title,
    detail: input.detail,
    importance: Math.max(1, Math.min(3, Number(input.importance) || 1)),
    ignoredDate,
    ignoredBy: user.email,
  };

  if (isPullRequestPreview()) {
    const rows = readPreviewRows().filter((item) => item.id !== id);
    rows.push(row);
    writePreviewRows(rows);
    return;
  }

  await setDoc(doc(db, COLLECTION, id), {
    tankNumber: row.tankNumber,
    batchNumber: row.batchNumber,
    recommendationKey: row.recommendationKey,
    title: row.title,
    detail: row.detail,
    importance: row.importance,
    ignoredDate: row.ignoredDate,
    ignoredBy: user.email,
    ignoredByUid: user.uid,
    ignoredAt: serverTimestamp(),
  });
}

export async function restoreIgnoredCellarRecommendation(id: string): Promise<void> {
  if (isPullRequestPreview()) {
    writePreviewRows(readPreviewRows().filter((row) => row.id !== id));
    return;
  }

  await deleteDoc(doc(db, COLLECTION, id));
}

export function isRecommendationIgnored(
  rows: IgnoredCellarRecommendation[],
  tankNumber: string | number,
  batchNumber: string | number,
  recommendationKey: string,
): boolean {
  const tank = String(tankNumber).trim();
  const batch = String(batchNumber).replace("#", "").trim();

  return rows.some((row) =>
    row.tankNumber === tank &&
    row.batchNumber.replace("#", "").trim() === batch &&
    row.recommendationKey === recommendationKey
  );
}
