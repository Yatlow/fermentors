/** Local-only, per-device draft. Never writes unsent measurements to Firestore. */
export const CELLAR_DRAFT_TTL_MS = 4 * 60 * 60 * 1000;
export type DraftTankIdentity = { id: string; batchNumber?: unknown };
type StoredReading = { batch: string; fields: Record<string, unknown> };
export type CellarDraft = {
  savedAt: number;
  readings: Record<string, StoredReading>;
};
const batchKey = (value: unknown): string => String(value ?? "").replace("#", "").trim();

export function encodeCellarDraft(
  readings: Record<string, Record<string, unknown>>,
  tanks: readonly DraftTankIdentity[],
  savedAt: number,
): CellarDraft {
  const batchByTank = new Map(tanks.map((tank) => [tank.id, batchKey(tank.batchNumber)]));
  const entries = Object.entries(readings).flatMap(([tankId, fields]) => {
    const batch = batchByTank.get(tankId);
    if (batch === undefined || !fields || !Object.keys(fields).length) return [];
    return [[tankId, { batch, fields }] as const];
  });
  return { savedAt, readings: Object.fromEntries(entries) };
}

export function restoreCellarDraft(
  raw: unknown,
  tanks: readonly DraftTankIdentity[],
  now: number,
): Record<string, Record<string, unknown>> {
  if (!raw || typeof raw !== "object") return {};
  const stored = raw as Partial<CellarDraft>;
  if (!Number.isFinite(stored.savedAt) || Number(stored.savedAt) > now ||
      now - Number(stored.savedAt) > CELLAR_DRAFT_TTL_MS ||
      !stored.readings || typeof stored.readings !== "object") return {};
  const valid = new Map(tanks.map((tank) => [tank.id, batchKey(tank.batchNumber)]));
  return Object.fromEntries(Object.entries(stored.readings).flatMap(([tankId, entry]) => {
    if (!entry || typeof entry !== "object" || !entry.fields ||
        typeof entry.fields !== "object" || Array.isArray(entry.fields) ||
        valid.get(tankId) === undefined || valid.get(tankId) !== entry.batch) return [];
    return [[tankId, entry.fields] as const];
  }));
}
