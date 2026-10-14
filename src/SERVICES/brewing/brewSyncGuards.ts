import type { BrewExecution } from "./brewExecution";

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
