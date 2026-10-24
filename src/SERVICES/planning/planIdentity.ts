import type { BrewPlan, Plan, WeekPlan } from "./planningEngine";

export type PackagingPlan = Plan & { brewId?: string };
const normalizedBatch = (value: unknown) => String(value ?? "").replace("#", "").trim();

function brewIdFromRecommendationId(value: unknown, plans: WeekPlan[]): string {
  const id = String(value ?? "");
  // Product ids and appended ":drain:N"/":finish" suffixes may themselves
  // contain colons. Match against the actual persisted brew identities rather
  // than guessing which colon terminates the cycle key.
  return plans.flatMap((week) => week.brews ?? [])
    .filter((brew) => brew.id && id.includes(`:brew:${brew.id}:`))
    .sort((a, b) => b.id.length - a.id.length)[0]?.id ?? "";
}

/** Resolve packaging to a stable brew identity, with legacy snapshot fallback. */
export function resolvePackagingBrewId(run: PackagingPlan, plans: WeekPlan[]): string | null {
  if (run.brewId) {
    const brew = plans.flatMap((week) => week.brews ?? []).find((candidate) => candidate.id === run.brewId);
    if (!brew) return null;
    // A packaging decision cannot belong to a brew scheduled after its date.
    // Old planner rows can retain stale brewId after a tank is reused.
    if (run.date && brew.date > run.date) return null;
    const batch = normalizedBatch(run.batchNumber);
    const brewBatch = normalizedBatch(brew.batchNumber);
    if (batch && brewBatch && batch !== brewBatch) return null;
    return brew.id;
  }

  // Weekly recommendations encode their canonical cycle key in the stable row id.
  // This keeps identity intact even through older UI save paths that preserve
  // unknown fields poorly and have not yet copied brewId explicitly.
  const encoded = brewIdFromRecommendationId(run.id, plans);
  if (encoded) {
    const brew = plans.flatMap((week) => week.brews ?? []).find((candidate) => candidate.id === encoded);
    if (brew && (!run.date || brew.date <= run.date) &&
        (!normalizedBatch(run.batchNumber) || !normalizedBatch(brew.batchNumber) ||
         normalizedBatch(run.batchNumber) === normalizedBatch(brew.batchNumber))) return encoded;
  }

  // Legacy snapshot inference is only safe when a batch number is present.
  // Tank-only matching can silently attach today's physical packaging to a
  // different future cycle planned on the same tank.
  const batch = normalizedBatch(run.batchNumber);
  if (!batch) return null;
  const date = String(run.date ?? "");
  const brews = plans
    .flatMap((week) => week.brews ?? [])
    .filter((brew) => {
      if (run.tankId && brew.tankId !== run.tankId) return false;
      if (normalizedBatch(brew.batchNumber) !== batch) return false;
      if (date && brew.date > date) return false;
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  return brews.at(-1)?.id ?? null;
}

export function brewById(plans: WeekPlan[], brewId: string): BrewPlan | null {
  for (const week of plans) {
    const brew = (week.brews ?? []).find((candidate) => candidate.id === brewId);
    if (brew) return brew;
  }
  return null;
}

export function withStablePackagingIdentity(
  plans: WeekPlan[], tankNumbersById: Readonly<Record<string, string | number>> = {},
): WeekPlan[] {
  const source = plans.map((week) => ({
    ...week,
    packaging: (week.packaging ?? []).map((raw) => ({ ...raw })),
    brews: (week.brews ?? []).map((brew) => ({ ...brew })),
  }));

  return source.map((week) => ({
    ...week,
    packaging: week.packaging.map((raw) => {
      const run = raw as PackagingPlan;
      const brewId = resolvePackagingBrewId(run, source);
      if (!brewId) return run;
      const brew = brewById(source, brewId);
      if (!brew) return { ...run, brewId };
      const tankMoved = !!run.tankId && !!brew.tankId && run.tankId !== brew.tankId;
      const resolvedNumber = tankNumbersById[brew.tankId];
      return {
        ...run,
        brewId,
        tankId: brew.tankId,
        // The operational number comes from the physical tank, never the
        // Firestore document id. Clear stale numbers after a brew moves if
        // a fresh physical number has not been supplied.
        ...(resolvedNumber != null ? { tankNumber: String(resolvedNumber) } :
          tankMoved ? { tankNumber: undefined } : {}),
        ...(normalizedBatch(brew.batchNumber) ? { batchNumber: normalizedBatch(brew.batchNumber) } : {}),
      };
    }),
  }));
}
