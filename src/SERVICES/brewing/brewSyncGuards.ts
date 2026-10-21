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
