/**
 * A brew can leave the screen only after all queued Sheet writes and the
 * current Firestore execution have been acknowledged. Reading latest()
 * AFTER Sheet writes finish also captures late edits/Sheet listener changes.
 */
export async function persistBrewBeforeExit<T>(
  latest: () => T,
  sheetWrites: readonly Promise<void>[],
  saveLocal: (snapshot: T) => T,
  saveRemote: (snapshot: T) => Promise<void>,
  saveHistory: (snapshot: T) => Promise<void>,
): Promise<T> {
  await Promise.all(sheetWrites);
  const snapshot = saveLocal(latest());
  await saveRemote(snapshot);
  await saveHistory(snapshot);
  return snapshot;
}
