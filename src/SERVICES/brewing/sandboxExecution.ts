import { doc, getDoc, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";
import { auth, db } from "../../firebase";

export type BrewExecutionBlock = {
  fields: Record<string, string>;
};

export type BrewExecution = {
  batchNumber: string;
  activeBlockIndex: number;
  blocks: Record<string, BrewExecutionBlock>;
  reviewedSteps?: Record<string, boolean>;
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
  return `fermentors:brewing-sandbox:execution:${batchNumber}:v1`;
}

export function loadSandboxExecution(batchNumber: string): BrewExecution {
  try {
    const raw = window.localStorage.getItem(key(batchNumber));
    if (!raw) return emptyExecution(batchNumber);
    const parsed = JSON.parse(raw) as BrewExecution;
    return parsed?.batchNumber === batchNumber ? parsed : emptyExecution(batchNumber);
  } catch {
    return emptyExecution(batchNumber);
  }
}

export function saveSandboxExecution(execution: BrewExecution): BrewExecution {
  const next = {
    ...execution,
    updatedAt: new Date().toISOString(),
  };
  window.localStorage.setItem(key(execution.batchNumber), JSON.stringify(next));
  return next;
}

export function setSandboxExecutionField(
  execution: BrewExecution,
  blockIndex: number,
  field: string,
  value: string,
): BrewExecution {
  const blockKey = String(blockIndex);
  return saveSandboxExecution({
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

export function setSandboxExecutionActiveBlock(
  execution: BrewExecution,
  activeBlockIndex: number,
): BrewExecution {
  return saveSandboxExecution({ ...execution, activeBlockIndex });
}


export function replaceSandboxExecutionBlockFields(
  execution: BrewExecution,
  blockIndex: number,
  fields: Record<string, string>,
): BrewExecution {
  const blockKey = String(blockIndex);
  return saveSandboxExecution({
    ...execution,
    blocks: {
      ...execution.blocks,
      [blockKey]: {
        fields: { ...fields },
      },
    },
  });
}

export function setSandboxExecutionReviewedSteps(
  execution: BrewExecution,
  reviewedSteps: Record<string, boolean>,
): BrewExecution {
  return saveSandboxExecution({ ...execution, reviewedSteps: { ...reviewedSteps } });
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
  return saveSandboxExecution(remote);
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
  stageCode: number;
  stageName: string;
  stageStartTimeText?: string | null;
  stageEndTimeText?: string | null;
};

export async function saveBrewingProgressToFirestore(
  tankId: string,
  progress: BrewingProgressUpdate,
): Promise<void> {
  const cleanTankId = String(tankId || "").trim();
  if (!cleanTankId || cleanTankId.startsWith("history-") || cleanTankId.startsWith("sandbox-")) {
    return;
  }

  await updateDoc(doc(db, "fermentors", cleanTankId), {
    brewProgress: {
      ...progress,
      stageStartTime: progress.stageStartTimeText || null,
      stageEndTime: progress.stageEndTimeText || null,
      dateAssumed: false,
    },
    brewProgressUpdatedAt: serverTimestamp(),
    brewProgressUpdatedBy: auth.currentUser?.uid || "",
  });
}
