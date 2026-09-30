import type { BrewPlan, Plan, WeekPlan } from "./planningEngine";

export type PackagingPlan = Plan & { brewId?: string };
const normalizedBatch = (value: unknown) => String(value ?? "").replace("#", "").trim();

/** Resolve packaging to a stable brew identity, with legacy snapshot fallback. */
export function resolvePackagingBrewId(run: PackagingPlan, plans: WeekPlan[]): string | null {
  if (run.brewId) return run.brewId;
  const batch = normalizedBatch(run.batchNumber);
  const date = String(run.date ?? "");
  const brews = plans
    .flatMap((week) => week.brews ?? [])
    .filter((brew) => {
      if (run.tankId && brew.tankId !== run.tankId) return false;
      if (batch && normalizedBatch(brew.batchNumber) !== batch) return false;
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

/**
 * Canonicalize packaging around brewId. Once a row has a stable brew identity,
 * tankId and batchNumber are display/legacy snapshots and must follow the brew,
 * never become an independent relationship. This is what makes a tank move or
 * forecast renumbering propagate consistently to every planning consumer.
 */
export function withStablePackagingIdentity(plans: WeekPlan[]): WeekPlan[] {
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
      return {
        ...run,
        brewId,
        tankId: brew.tankId,
        ...(normalizedBatch(brew.batchNumber)
          ? { batchNumber: normalizedBatch(brew.batchNumber) }
          : {}),
      };
    }),
  }));
}
