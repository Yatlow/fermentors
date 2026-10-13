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
const brewExecutionWriteQueues = new Map<string, Promise<void>>();
const lastKnownExecution = new Map<string, BrewExecution>();

function changedExecutionBlocks(
  next: BrewExecution,
  previous?: BrewExecution,
): BrewExecution["blocks"] {
  const changed: BrewExecution["blocks"] = {};
  for (const [block, data] of Object.entries(next.blocks || {})) {
    const oldFields = previous?.blocks?.[block]?.fields || {};
    const fields = Object.fromEntries(
      Object.entries(data.fields || {}).filter(([field, value]) =>
        oldFields[field] !== value,
      ),
    );
    if (Object.keys(fields).length) changed[block] = { fields };
  }
  return changed;
}


/** Row addresses are an independent, creation-time metadata field. Do not
 * overwrite existing field values while hydrating this map. */
function withCreatedRowMap(
  batchNumber: string,
  execution: BrewExecution,
  rawMap: unknown,
): BrewExecution {
  if (typeof rawMap !== "string") return execution;
  try {
    const parsed = JSON.parse(rawMap) as {
      version?: number;
      blocks?: Record<string, Record<string, string>>;
    };
    if (parsed.version !== 1 || !parsed.blocks) return execution;
    const blocks = { ...execution.blocks };
    for (const [blockKey, metadata] of Object.entries(parsed.blocks)) {
      if (!/^[1-3]$/.test(blockKey) || !metadata || typeof metadata !== "object") continue;
      const current = blocks[blockKey]?.fields || {};
      const safeMetadata = Object.fromEntries(
        Object.entries(metadata).filter(([key, value]) =>
          key.startsWith("__sheetRow.") &&
          typeof value === "string" &&
          Number.isInteger(Number(value)) &&
          Number(value) > 0,
        ),
      );
      blocks[blockKey] = {
        fields: { ...current, ...safeMetadata },
      };
    }
    return { ...execution, batchNumber, blocks };
  } catch {
    return execution;
  }
}

function isOlderThanLocal(batchNumber: string, incoming: BrewExecution): boolean {
  // A missing cache must never beat a canonical Firestore execution merely
  // because emptyExecution() would have a freshly generated timestamp.
  try {
    if (!window.localStorage.getItem(key(batchNumber))) return false;
  } catch {
    return false;
  }
  const local = loadBrewingExecution(batchNumber);
  const localTime = Date.parse(local.updatedAt || "");
  const remoteTime = Date.parse(incoming.updatedAt || "");
  return Number.isFinite(localTime) && Number.isFinite(remoteTime) &&
    remoteTime < localTime;
}

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

function isBrewingFormControlFocused(): boolean {
  if (typeof document === "undefined") return false;
  const active = document.activeElement;
  return active instanceof Element && Boolean(active.closest(".brew-stepper"));
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
  let refreshAfterEditing = false;
  let disposed = false;

  const emitRemote = (remote: BrewExecution) => {
    const fingerprint = executionFingerprint(remote);

    // Ignore stale echoes even after the brewer moves focus away.
    // Focus-based guards alone cannot protect a just-committed input.
    if (isOlderThanLocal(clean, remote)) return;

    // A Firestore snapshot caused by our own autosave must not be fed back into
    // React state. Doing so creates a new object, re-triggers the autosave
    // effect, writes another server timestamp, and can loop indefinitely.
    if (pendingLocalWriteFingerprint.get(clean) === fingerprint) {
      pendingLocalWriteFingerprint.delete(clean);
      lastRemoteExecutionFingerprint.set(clean, fingerprint);
      persistRemoteExecutionLocal(remote);
      lastEmittedFingerprint = fingerprint;
      return;
    }

    // Never replace fields while the brewer is actively typing. A snapshot can
    // legitimately be older than the local keystrokes that are still being
    // committed to Firestore/Sheets. Re-read the canonical document after blur.
    if (isBrewingFormControlFocused()) {
      refreshAfterEditing = true;
      return;
    }

    lastRemoteExecutionFingerprint.set(clean, fingerprint);
    lastKnownExecution.set(clean, remote);

    // Firestore can deliver the same document more than once (metadata changes,
    // reconnects, or outer-field updates). Only propagate real execution changes.
    if (fingerprint === lastEmittedFingerprint) {
      persistRemoteExecutionLocal(remote);
      return;
    }

    lastEmittedFingerprint = fingerprint;
    onExecution(persistRemoteExecutionLocal(remote));
  };

  const unsubscribe = onSnapshot(doc(db, "brews", clean), (snapshot) => {
    if (!snapshot.exists()) return;
    const data = snapshot.data() as { brewingExecution?: BrewExecution; brewSheetRowMapJson?: string };
    const base = data.brewingExecution;
    if (base && (base.batchNumber !== clean || !base.blocks)) return;
    if (!base && !data.brewSheetRowMapJson) return;
    const mapped = withCreatedRowMap(clean, base || loadBrewingExecution(clean), data.brewSheetRowMapJson);
    const remote = isOlderThanLocal(clean, mapped)
      ? withCreatedRowMap(clean, loadBrewingExecution(clean), data.brewSheetRowMapJson)
      : mapped;
    emitRemote(remote);
  });

  const refreshAfterBlur = () => {
    if (!refreshAfterEditing) return;
    window.setTimeout(() => {
      if (disposed || isBrewingFormControlFocused() || !refreshAfterEditing) return;
      refreshAfterEditing = false;
      void getDoc(doc(db, "brews", clean))
        .then((snapshot) => {
          if (disposed || !snapshot.exists()) return;
          const data = snapshot.data() as { brewingExecution?: BrewExecution; brewSheetRowMapJson?: string };
          const base = data.brewingExecution;
          if (base && (base.batchNumber !== clean || !base.blocks)) return;
          if (!base && !data.brewSheetRowMapJson) return;
          const mapped = withCreatedRowMap(clean, base || loadBrewingExecution(clean), data.brewSheetRowMapJson);
          emitRemote(isOlderThanLocal(clean, mapped)
            ? withCreatedRowMap(clean, loadBrewingExecution(clean), data.brewSheetRowMapJson)
            : mapped);
        })
        .catch((error) =>
          console.warn("Failed refreshing brewing execution after edit", error),
        );
    }, 0);
  };

  if (typeof document !== "undefined") {
    document.addEventListener("focusout", refreshAfterBlur, true);
  }

  return () => {
    disposed = true;
    unsubscribe();
    if (typeof document !== "undefined") {
      document.removeEventListener("focusout", refreshAfterBlur, true);
    }
  };
}

export async function loadBrewingExecutionFromFirestore(
  batchNumber: string,
): Promise<BrewExecution | null> {
  const clean = cleanBatchNumber(batchNumber);
  if (!clean) return null;
  const snapshot = await getDoc(doc(db, "brews", clean));
  if (!snapshot.exists()) return null;
  const data = snapshot.data() as { brewingExecution?: BrewExecution; brewSheetRowMapJson?: string };
  const remote = data.brewingExecution;
  if (remote && (remote.batchNumber !== clean || !remote.blocks)) return null;
  if (!remote && !data.brewSheetRowMapJson) return null;
  const mapped = withCreatedRowMap(clean, remote || loadBrewingExecution(clean), data.brewSheetRowMapJson);
  if (isOlderThanLocal(clean, mapped)) {
    return persistRemoteExecutionLocal(withCreatedRowMap(
      clean, loadBrewingExecution(clean), data.brewSheetRowMapJson,
    ));
  }
  lastRemoteExecutionFingerprint.set(clean, executionFingerprint(mapped));
  lastKnownExecution.set(clean, mapped);
  return persistRemoteExecutionLocal(mapped);
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

  // Serialize writes from this browser, and write only changed field leaves.
  // Saving the entire blocks map clobbered concurrent updates from another
  // brewer working in the other A/B/C block.
  const previousWrite = brewExecutionWriteQueues.get(clean) || Promise.resolve();
  const queued = previousWrite.catch(() => undefined).then(async () => {
    if (isOlderThanLocal(clean, execution)) return;
    const remoteExecution = cleanForRemoteExecution(execution);
    const fingerprint = executionFingerprint(remoteExecution);
    if (lastRemoteExecutionFingerprint.get(clean) === fingerprint) return;

    const baseline = lastKnownExecution.get(clean);
    const blocks = changedExecutionBlocks(remoteExecution, baseline);
    const metadataChanged =
      !baseline ||
      baseline.activeBlockIndex !== remoteExecution.activeBlockIndex ||
      baseline.activeStepIndex !== remoteExecution.activeStepIndex ||
      JSON.stringify(baseline.reviewedSteps || {}) !== JSON.stringify(remoteExecution.reviewedSteps || {});
    if (!Object.keys(blocks).length && !metadataChanged) return;

    const patch = {
      batchNumber: clean,
      activeBlockIndex: remoteExecution.activeBlockIndex,
      activeStepIndex: remoteExecution.activeStepIndex ?? null,
      reviewedSteps: remoteExecution.reviewedSteps || {},
      updatedAt: remoteExecution.updatedAt,
      blocks,
    };

    pendingLocalWriteFingerprint.set(clean, fingerprint);
    try {
      await setDoc(
        doc(db, "brews", clean),
        {
          brewingExecution: patch,
          brewingExecutionUpdatedAt: serverTimestamp(),
          brewingExecutionUpdatedBy: auth.currentUser?.uid || "",
        },
        { merge: true },
      );
      lastRemoteExecutionFingerprint.set(clean, fingerprint);
      lastKnownExecution.set(clean, remoteExecution);
    } catch (error) {
      if (pendingLocalWriteFingerprint.get(clean) === fingerprint) {
        pendingLocalWriteFingerprint.delete(clean);
      }
      throw error;
    }
  });
  brewExecutionWriteQueues.set(clean, queued);
  try {
    await queued;
  } finally {
    if (brewExecutionWriteQueues.get(clean) === queued) {
      brewExecutionWriteQueues.delete(clean);
    }
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
