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

export type ScheduledCellarActionType = "carbTest" | "yeastDrop";
export type ScheduledCellarRecommendation = {
  id: string;
  tankNumber: string;
  batchNumber: string;
  actionType: ScheduledCellarActionType;
  dueDate: string;
  note?: string;
  status: "active" | "completed" | "cancelled";
  createdBy?: string;
};

const COLLECTION = "scheduledCellarRecommendations";

export function todayDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function scheduledActionLabel(action: ScheduledCellarActionType): string {
  return action === "carbTest" ? "בדיקת גיזוז" : "הורדת שמרים";
}

export function subscribeScheduledCellarRecommendations(
  callback: (rows: ScheduledCellarRecommendation[]) => void,
  onError?: (error: Error) => void,
): Unsubscribe {
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
}): Promise<string> {
  const user = auth.currentUser;
  if (!user?.email) throw new Error("אין משתמש מחובר");

  const ref = doc(collection(db, COLLECTION));
  await setDoc(ref, {
    tankNumber: String(input.tankNumber),
    batchNumber: String(input.batchNumber),
    actionType: input.actionType,
    dueDate: input.dueDate,
    note: input.note?.trim() || "",
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
): Promise<void> {
  await updateDoc(doc(db, COLLECTION, id), {
    status,
    updatedAt: serverTimestamp(),
  });
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
): ScheduledCellarRecommendation[] {
  return scheduledForTank(rows, tankNumber, batchNumber)
    .filter((row) => row.dueDate <= today);
}
