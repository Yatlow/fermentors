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

const lastRemoteExecutionFingerprint = new Map<string, string>();
const pendingLocalWriteFingerprint = new Map<string, string>();
const lastAcidHistoryFingerprint = new Map<string, string>();

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

function cleanBatchNumber(batchNumber: string) {
  return String(batchNumber || "").replace("#", "").trim();
}

function cleanForRemoteExecution(execution: BrewExecution): BrewExecution {
  return JSON.parse(JSON.stringify(execution)) as BrewExecution;
}

function executionFingerprint(execution: BrewExecution): string {
  return JSON.stringify(cleanForRemoteExecution(execution));
}

function persistRemoteExecutionLocal(execution: BrewExecution): BrewExecution {
  const clean = cleanBatchNumber(execution.batchNumber);
  if (!clean) return execution;
  window.localStorage.setItem(key(clean), JSON.stringify(execution));
  return execution;
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
  const clean = cleanBatchNumber(batchNumber);
  if (!clean) return () => undefined;

  let lastEmittedFingerprint = "";

  return onSnapshot(doc(db, "brews", clean), (snapshot) => {
    if (!snapshot.exists()) return;
    const data = snapshot.data() as { brewingExecution?: BrewExecution };
    const remote = data.brewingExecution;
    if (!remote || remote.batchNumber !== clean || !remote.blocks) return;

    const fingerprint = executionFingerprint(remote);
    lastRemoteExecutionFingerprint.set(clean, fingerprint);

    // A Firestore snapshot caused by our own autosave must not be fed back into
    // React state. Doing so creates a new object, re-triggers the autosave
    // effect, writes another server timestamp, and can loop indefinitely.
    if (pendingLocalWriteFingerprint.get(clean) === fingerprint) {
      pendingLocalWriteFingerprint.delete(clean);
      persistRemoteExecutionLocal(remote);
      lastEmittedFingerprint = fingerprint;
      return;
    }

    // Firestore can deliver the same document more than once (metadata changes,
    // reconnects, or outer-field updates). Only propagate real execution changes.
    if (fingerprint === lastEmittedFingerprint) {
      persistRemoteExecutionLocal(remote);
      return;
    }

    lastEmittedFingerprint = fingerprint;
    onExecution(persistRemoteExecutionLocal(remote));
  });
}

export async function loadBrewingExecutionFromFirestore(
  batchNumber: string,
): Promise<BrewExecution | null> {
  const clean = cleanBatchNumber(batchNumber);
  if (!clean) return null;
  const snapshot = await getDoc(doc(db, "brews", clean));
  if (!snapshot.exists()) return null;
  const data = snapshot.data() as { brewingExecution?: BrewExecution };
  const remote = data.brewingExecution;
  if (!remote || remote.batchNumber !== clean || !remote.blocks) return null;

  lastRemoteExecutionFingerprint.set(clean, executionFingerprint(remote));
  return persistRemoteExecutionLocal(remote);
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
  const clean = cleanBatchNumber(execution.batchNumber);
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
      const historyKey = `${clean}-${brewLetter}`;
      const fingerprint = JSON.stringify({ ...compact, styleKey });

      // The brew form autosaves the whole execution on any field edit. Acid
      // history only depends on this compact subset, so unrelated typing must
      // not rewrite the same history document over and over.
      if (lastAcidHistoryFingerprint.get(historyKey) === fingerprint) return;

      await setDoc(
        doc(db, "brewAcidHistory", historyKey),
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

      lastAcidHistoryFingerprint.set(historyKey, fingerprint);
    }),
  );
}

export async function saveBrewingExecutionToFirestore(
  execution: BrewExecution,
): Promise<void> {
  const clean = cleanBatchNumber(execution.batchNumber);
  if (!clean) return;

  const remoteExecution = cleanForRemoteExecution(execution);
  const fingerprint = executionFingerprint(remoteExecution);

  // Hydration/listener echoes are not user edits. If Firestore already contains
  // this exact execution, do not write a fresh serverTimestamp just because the
  // component mounted or received a snapshot.
  if (lastRemoteExecutionFingerprint.get(clean) === fingerprint) return;

  pendingLocalWriteFingerprint.set(clean, fingerprint);
  try {
    await setDoc(
      doc(db, "brews", clean),
      {
        brewingExecution: remoteExecution,
        brewingExecutionUpdatedAt: serverTimestamp(),
        brewingExecutionUpdatedBy: auth.currentUser?.uid || "",
      },
      { merge: true },
    );
    lastRemoteExecutionFingerprint.set(clean, fingerprint);
  } catch (error) {
    if (pendingLocalWriteFingerprint.get(clean) === fingerprint) {
      pendingLocalWriteFingerprint.delete(clean);
    }
    throw error;
  }
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
