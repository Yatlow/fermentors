import { collection, doc, getDocs, query, serverTimestamp, setDoc, where } from "firebase/firestore";
import { db } from "../../firebase";
import type { BrewingSheetWrite } from "./brewingSheetServer";

export type BrewSheetCreationJob = {
  batchNumber: string;
  style: string;
  tankNumber: string;
  tankType: "single" | "double" | "triple";
  state: "queued" | "creating" | "ready" | "failed";
  fileId?: string;
  fileName?: string;
  sheetUrl?: string;
  lastError?: string;
};

export async function enqueueBrewSheetCreation(input: {
  batchNumber: string;
  style: string;
  tankNumber: string;
  tankType: "single" | "double" | "triple";
  name: string;
  initialWrites: BrewingSheetWrite[];
}) {
  const batchNumber = String(input.batchNumber || "").replace("#", "").trim();
  if (!/^\d+$/.test(batchNumber)) throw new Error("מספר אצווה לא תקין.");
  await setDoc(doc(db, "brewSheetCreationJobs", batchNumber), {
    batchNumber,
    style: input.style,
    tankNumber: input.tankNumber,
    tankType: input.tankType,
    name: input.name,
    initialWritesJson: JSON.stringify(input.initialWrites),
    state: "queued",
    attempts: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return batchNumber;
}

export async function loadOpenBrewSheetCreationJobs(): Promise<BrewSheetCreationJob[]> {
  const snapshots = await Promise.all([
    getDocs(query(collection(db, "brewSheetCreationJobs"), where("state", "in", ["queued", "creating"]))),
    getDocs(query(collection(db, "brewSheetCreationJobs"), where("state", "==", "failed"))),
  ]);
  return snapshots.flatMap((snapshot) => snapshot.docs.map((item) => item.data() as BrewSheetCreationJob));
}
