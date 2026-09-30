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

export function withStablePackagingIdentity(plans: WeekPlan[]): WeekPlan[] {
  return plans.map((week) => ({
    ...week,
    packaging: (week.packaging ?? []).map((raw) => {
      const run = raw as PackagingPlan;
      if (run.brewId) return run;
      const brewId = resolvePackagingBrewId(run, plans);
      return brewId ? { ...run, brewId } : run;
    }),
  }));
}
