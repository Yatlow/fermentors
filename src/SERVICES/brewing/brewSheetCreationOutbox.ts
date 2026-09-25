import { collection, doc, getDocs, query, serverTimestamp, setDoc, where } from "firebase/firestore";
import { db } from "../../firebase";
import { serverProcessQueuedBrewSheetJob, type BrewingSheetWrite } from "./brewingSheetServer";

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
  recipeMaterials?: {
    grains?: Array<{ quantity: number; label: string; supplier: string }>;
    hops?: Array<{ quantity: number; alpha: string | number; label: string }>;
  };
  mashRestCount?: number;
}) {
  const batchNumber = String(input.batchNumber || "").replace("#", "").trim();
  if (!/^\d+$/.test(batchNumber)) throw new Error("מספר אצווה לא תקין.");
  try {
    await setDoc(doc(db, "brewSheetCreationJobs", batchNumber), {
      batchNumber,
      style: input.style,
      tankNumber: String(input.tankNumber),
      tankType: input.tankType,
      name: input.name,
      initialWritesJson: JSON.stringify(input.initialWrites),
      recipeMaterialsJson: JSON.stringify(input.recipeMaterials || {}),
      mashRestCount: Number(input.mashRestCount || 2),
      state: "queued",
      attempts: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`brewSheetCreationJobs/${batchNumber}: ${message}`);
  }
  // Fire immediately after the durable Firestore write. Maintenance remains a
  // fallback only; a failed/closed request leaves the queued job intact.
  void serverProcessQueuedBrewSheetJob(batchNumber).catch((error) => {
    console.warn("Immediate brew Sheet worker failed; maintenance will retry", error);
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
