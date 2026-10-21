// Keep this pure helper independent of Firebase/React so the isolated
// regression runner can compile it without importing the browser runtime.
export type BrewSyncExecution = {
  batchNumber: string;
  activeBlockIndex: number;
  activeStepIndex?: number;
  reviewedSteps?: Record<string, boolean>;
  updatedAt: string;
  blocks: Record<string, { fields: Record<string, string> }>;
};
type BrewExecution = BrewSyncExecution;

/**
 * A browser cache can carry a new timestamp from navigation alone. Compare
 * against actual typing in this form session, not the cached updatedAt.
 */
export function shouldAcceptRemoteBrewingExecution(
  remote: BrewExecution,
  latestSessionEditAt: number,
): boolean {
  if (!latestSessionEditAt) return true;
  const remoteAt = Date.parse(remote.updatedAt || "");
  return Number.isFinite(remoteAt) && remoteAt >= latestSessionEditAt;
}

/** Apply only the cells the Sheet edit really changed and only if the user
 * has not independently edited that field since the baseline was captured. */
export function mergeBrewSheetEditDelta(
  previous: BrewExecution,
  baseline: BrewExecution,
  delta: BrewExecution,
  updatedAt: string = new Date().toISOString(),
): BrewExecution {
  if (previous.batchNumber !== baseline.batchNumber ||
      delta.batchNumber !== baseline.batchNumber) return previous;
  const blocks = { ...previous.blocks };
  let changed = false;
  for (const [blockId, block] of Object.entries(delta.blocks || {})) {
    const oldFields = baseline.blocks[blockId]?.fields || {};
    const currentFields = previous.blocks[blockId]?.fields || {};
    const fields = { ...currentFields };
    let blockChanged = false;
    for (const [key, value] of Object.entries(block.fields || {})) {
      if (value !== oldFields[key] && currentFields[key] === oldFields[key]) {
        fields[key] = value;
        changed = true;
        blockChanged = true;
      }
    }
    if (blockChanged) blocks[blockId] = { fields };
  }
  return changed ? { ...previous, blocks, updatedAt } : previous;
}


/** Explicit materials approval is NOT a Sheet-derived value. Only record the
 * confirmation after the Firestore write has acknowledged it. This avoids
 * showing a successful approval that existed solely in a debounced local cache
 * and could be discarded on form close.
 *
 * A/B/C confirmations are stored independently in their own fields map.
 */
export async function persistConfirmedBrewMaterials<T extends BrewSyncExecution>(
  execution: T,
  blockIndex: number,
  persist: (confirmed: T) => Promise<void>,
): Promise<T> {
  if (!Number.isInteger(blockIndex) || blockIndex < 1 || blockIndex > 3) {
    throw new Error("Invalid brew block for materials confirmation");
  }
  const block = String(blockIndex);
  const confirmed = {
    ...execution,
    updatedAt: new Date().toISOString(),
    blocks: {
      ...execution.blocks,
      [block]: {
        ...execution.blocks[block],
        fields: {
          ...(execution.blocks[block]?.fields || {}),
          materialsConfirmed: "yes",
        },
      },
    },
  } as T;
  // If this fails, the caller must not mark the confirmation as saved.
  await persist(confirmed);
  return confirmed;
}


/** Reopening a brew is a recovery read, not an instruction to overwrite a
 * populated Firestore field with a possibly stale Sheet snapshot. We still
 * import missing values and refresh semantic row addresses.
 */
export function reconcileBrewStartupFields(
  existing: Readonly<Record<string, string>>,
  sheet: Readonly<Record<string, string>>,
): { fields: Record<string, string>; conflicts: Array<{ key: string; appValue: string; sheetValue: string }> } {
  const fields = { ...existing };
  const conflicts: Array<{ key: string; appValue: string; sheetValue: string }> = [];
  for (const [key, sheetValue] of Object.entries(sheet)) {
    if (key.startsWith("__sheetRow.")) {
      fields[key] = sheetValue;
      continue;
    }
    // Only the brewer can approve lots. An imported Sheet cannot synthesize
    // or erase an explicit confirmation for A, B or C.
    if (key === "materialsConfirmed" || key.startsWith("materialLot.")) continue;
    const appValue = String(existing[key] ?? "");
    const incoming = String(sheetValue ?? "");
    if (!incoming.trim()) continue;
    if (!appValue.trim()) {
      fields[key] = incoming;
    } else if (appValue.trim() !== incoming.trim()) {
      // A live Sheet onEdit event is the supported path for later Sheet edits.
      // Silent startup must not reverse an acknowledged application edit.
      conflicts.push({ key, appValue, sheetValue: incoming });
    }
  }
  return { fields, conflicts };
}

/** Three-way Firestore reconcile: a remote change can update unrelated
 * blocks/fields, but must not replace a local value changed since the last
 * acknowledged remote snapshot. Comparing timestamps alone isn't enough.
 */
export function mergeBrewRemotePreservingLocalEdits<T extends BrewSyncExecution>(
  previous: T,
  baseline: T | null,
  remote: T,
): T {
  if (previous.batchNumber !== remote.batchNumber || !baseline ||
      baseline.batchNumber !== remote.batchNumber) {
    return {
      ...remote,
      activeBlockIndex: previous.activeBlockIndex,
      activeStepIndex: previous.activeStepIndex,
    };
  }
  const blocks = { ...remote.blocks };
  for (const [blockId, oldBlock] of Object.entries(previous.blocks || {})) {
    const original = baseline.blocks[blockId]?.fields || {};
    const remoteFields = remote.blocks[blockId]?.fields || {};
    const fields = { ...remoteFields };
    for (const [key, localValue] of Object.entries(oldBlock.fields || {})) {
      if (localValue !== original[key]) fields[key] = localValue;
    }
    if (Object.keys(fields).length) blocks[blockId] = { fields };
  }
  const result = {
    ...remote,
    blocks,
    activeBlockIndex: previous.activeBlockIndex,
    activeStepIndex: previous.activeStepIndex,
  };
  return JSON.stringify(result) === JSON.stringify(previous) ? previous : result as T;
}


/** A detached form may flush its draft, except when another explicit commit
 * (especially per-block material approval) is still pending. In that case a
 * stale unmount snapshot would be queued AFTER the new commit and undo it. */
export function shouldPersistBrewUnmount(
  firestoreHydrated: boolean,
  isClosing: boolean,
  materialConfirmationInFlight: boolean,
): boolean {
  return firestoreHydrated && !isClosing && !materialConfirmationInFlight;
}


/** Prevent a navigation-only or hydration-only render from scheduling a
 * Firestore write, which can race and invalidate the startup Sheet read.
 * Only a real process/material field difference justifies an autosave.
 */
export function hasUnsavedBrewFields(
  execution: BrewSyncExecution,
  lastRemote: BrewSyncExecution | null,
): boolean {
  if (!lastRemote || lastRemote.batchNumber !== execution.batchNumber) {
    return Object.values(execution.blocks || {}).some(block =>
      Object.entries(block.fields || {}).some(([key, value]) =>
        !key.startsWith("__sheetRow.") && String(value ?? "").trim() !== ""
      )
    );
  }
  return Object.entries(execution.blocks || {}).some(([blockId, block]) =>
    Object.entries(block.fields || {}).some(([field, value]) =>
      !field.startsWith("__sheetRow.") &&
      value !== lastRemote.blocks[blockId]?.fields?.[field]
    )
  );
}
