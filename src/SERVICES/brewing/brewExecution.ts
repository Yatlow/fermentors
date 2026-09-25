import { doc, getDoc, onSnapshot, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";
import { auth, db } from "../../firebase";

export type BrewExecutionBlock = {
  fields: Record<string, string>;
};

export type BrewExecution = {
  batchNumber: string;
  activeBlockIndex: number;
  blocks: Record<string, BrewExecutionBlock>;
  reviewedSteps?: Record<string, boolean>;
  activeStepIndex?: number;
  updatedAt: string;
};

function emptyExecution(batchNumber: string): BrewExecution {
  return {
    batchNumber,
    activeBlockIndex: 1,
    blocks: {},
    reviewedSteps: {},
    updatedAt: new Date().toISOString(),
  };
}

function key(batchNumber: string) {
  return `fermentors:brewing:execution:${batchNumber}:v1`;
}

export function loadBrewingExecution(batchNumber: string): BrewExecution {
  try {
    const raw = window.localStorage.getItem(key(batchNumber));
    if (!raw) return emptyExecution(batchNumber);
    const parsed = JSON.parse(raw) as BrewExecution;
    return parsed?.batchNumber === batchNumber ? parsed : emptyExecution(batchNumber);
  } catch {
    return emptyExecution(batchNumber);
  }
}

export function saveBrewingExecutionLocal(execution: BrewExecution): BrewExecution {
  const next = {
    ...execution,
    updatedAt: new Date().toISOString(),
  };
  window.localStorage.setItem(key(execution.batchNumber), JSON.stringify(next));
  return next;
}

export function setBrewingExecutionField(
  execution: BrewExecution,
  blockIndex: number,
  field: string,
  value: string,
): BrewExecution {
  const blockKey = String(blockIndex);
  return saveBrewingExecutionLocal({
    ...execution,
    blocks: {
      ...execution.blocks,
      [blockKey]: {
        fields: {
          ...(execution.blocks[blockKey]?.fields || {}),
          [field]: value,
        },
      },
    },
  });
}

export function setBrewingExecutionActiveStep(
  execution: BrewExecution,
  activeStepIndex: number,
): BrewExecution {
  return saveBrewingExecutionLocal({ ...execution, activeStepIndex });
}

export function setBrewingExecutionActiveBlock(
  execution: BrewExecution,
  activeBlockIndex: number,
): BrewExecution {
  return saveBrewingExecutionLocal({ ...execution, activeBlockIndex });
}


export function replaceBrewingExecutionBlockFields(
  execution: BrewExecution,
  blockIndex: number,
  fields: Record<string, string>,
): BrewExecution {
  const blockKey = String(blockIndex);
  return saveBrewingExecutionLocal({
    ...execution,
    blocks: {
      ...execution.blocks,
      [blockKey]: {
        fields: { ...fields },
      },
    },
  });
}

export function setBrewingExecutionReviewedSteps(
  execution: BrewExecution,
  reviewedSteps: Record<string, boolean>,
): BrewExecution {
  return saveBrewingExecutionLocal({ ...execution, reviewedSteps: { ...reviewedSteps } });
}


export function subscribeToBrewingExecution(
  batchNumber: string,
  onExecution: (execution: BrewExecution) => void,
): () => void {
  const clean = String(batchNumber || "").replace("#", "").trim();
  if (!clean) return () => undefined;
  return onSnapshot(doc(db, "brews", clean), (snapshot) => {
    if (!snapshot.exists()) return;
    const data = snapshot.data() as { brewingExecution?: BrewExecution };
    const remote = data.brewingExecution;
    if (!remote || remote.batchNumber !== clean || !remote.blocks) return;
    onExecution(saveBrewingExecutionLocal(remote));
  });
}

export async function loadBrewingExecutionFromFirestore(
  batchNumber: string,
): Promise<BrewExecution | null> {
  const clean = String(batchNumber || "").replace("#", "").trim();
  if (!clean) return null;
  const snapshot = await getDoc(doc(db, "brews", clean));
  if (!snapshot.exists()) return null;
  const data = snapshot.data() as { brewingExecution?: BrewExecution };
  const remote = data.brewingExecution;
  if (!remote || remote.batchNumber !== clean || !remote.blocks) return null;
  return saveBrewingExecutionLocal(remote);
}

function acidHistoryFields(fields: Record<string, string>) {
  return {
    brewDate: String(fields.brewDate || ""),
    mashPh: String(fields.mashPh || ""),
    mashVolume: String(fields.mashVolume || ""),
    acidMl: String(fields.mashAcid85 || ""),
    outToBoilPh: String(fields.outToBoilPh || ""),
    boilPh: String(fields.boilPh || ""),
    kettleVolume: String(fields.kettleVolume || ""),
    boilAcidMl: String(fields.boilAcid85 || ""),
    outToFermentorPh: String(fields.outToFermentorPh || ""),
  };
}

export async function saveBrewAcidHistoryToFirestore(
  execution: BrewExecution,
  style: string,
): Promise<void> {
  const clean = String(execution.batchNumber || "").replace("#", "").trim();
  const batch = Number(clean);
  if (!clean || !Number.isFinite(batch)) return;
  const styleKey = String(style || "").trim().toLowerCase();
  if (!styleKey) return;

  await Promise.all(
    (["1", "2", "3"] as const).map(async (blockKey, blockIndex) => {
      const fields = execution.blocks?.[blockKey]?.fields;
      if (!fields) return;
      const compact = acidHistoryFields(fields);
      if (!Object.values(compact).some(Boolean)) return;
      const brewLetter = ["A", "B", "C"][blockIndex] as "A" | "B" | "C";
      await setDoc(
        doc(db, "brewAcidHistory", `${clean}-${brewLetter}`),
        {
          batchNumber: clean,
          brewLetter,
          ...compact,
          sheetName: "",
          sheetUrl: "",
          styleKey,
          sortKey: batch * 10 + blockIndex + 1,
          source: "brewing-workflow",
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
    }),
  );
}

export async function saveBrewingExecutionToFirestore(
  execution: BrewExecution,
): Promise<void> {
  const clean = String(execution.batchNumber || "").replace("#", "").trim();
  if (!clean) return;
  await setDoc(
    doc(db, "brews", clean),
    {
      brewingExecution: cleanForRemoteExecution(execution),
      brewingExecutionUpdatedAt: serverTimestamp(),
      brewingExecutionUpdatedBy: auth.currentUser?.uid || "",
    },
    { merge: true },
  );
}

function cleanForRemoteExecution(execution: BrewExecution): BrewExecution {
  return JSON.parse(JSON.stringify(execution)) as BrewExecution;
}


export type BrewingProgressUpdate = {
  blockCount: number;
  blockIndex: number;
  stageCode: number | null;
  stageName: string;
  stageStartTimeText?: string | null;
  stageEndTimeText?: string | null;
};

export async function saveBrewingProgressToFirestore(
  tankId: string,
  progress: BrewingProgressUpdate,
): Promise<void> {
  const cleanTankId = String(tankId || "").trim();
  if (!cleanTankId || cleanTankId.startsWith("history-")) {
    return;
  }

  // Update only the client-owned progress leaves. Replacing the whole map
  // would erase server-owned fields such as headerCount, blockStarts and the
  // canonical timestamp values written by extractBrewStageInfo().
  await updateDoc(doc(db, "fermentors", cleanTankId), {
    "brewProgress.blockCount": progress.blockCount,
    "brewProgress.blockIndex": progress.blockIndex,
    "brewProgress.stageCode": progress.stageCode,
    "brewProgress.stageName": progress.stageName,
    "brewProgress.stageStartTimeText": progress.stageStartTimeText ?? null,
    "brewProgress.stageEndTimeText": progress.stageEndTimeText ?? null,
    "brewProgress.dateAssumed": false,
    brewProgressUpdatedAt: serverTimestamp(),
    brewProgressUpdatedBy: auth.currentUser?.uid || "",
  });
}
