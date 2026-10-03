import type { BrewPlan, Plan, WeekPlan } from "./planningEngine";

export type PackagingPlan = Plan & { brewId?: string };
const normalizedBatch = (value: unknown) => String(value ?? "").replace("#", "").trim();

function brewIdFromRecommendationId(value: unknown): string {
  const id = String(value ?? "");
  const marker = ":brew:";
  const start = id.indexOf(marker);
  if (start < 0) return "";
  const tail = id.slice(start + marker.length);
  const productSeparator = tail.lastIndexOf(":");
  return (productSeparator >= 0 ? tail.slice(0, productSeparator) : tail).trim();
}

/** Resolve packaging to a stable brew identity, with safe migration fallbacks. */
export function resolvePackagingBrewId(run: PackagingPlan, plans: WeekPlan[]): string | null {
  if (run.brewId) {
    return plans.some((week) => week.brews?.some((brew) => brew.id === run.brewId))
      ? run.brewId
      : null;
  }

  // Weekly recommendations encode their canonical cycle key in the stable row id.
  // This keeps identity intact even through older UI save paths that preserve
  // unknown fields poorly and have not yet copied brewId explicitly.
  const encoded = brewIdFromRecommendationId(run.id);
  if (encoded && plans.some((week) => week.brews?.some((brew) => brew.id === encoded))) return encoded;

  const date = String(run.date ?? "");
  const batch = normalizedBatch(run.batchNumber);
  const allBrews = plans.flatMap((week) => week.brews ?? []);

  // A batch number is the strongest legacy identity signal after brewId.
  if (batch) {
    const byBatch = allBrews
      .filter((brew) => {
        if (run.tankId && brew.tankId !== run.tankId) return false;
        if (normalizedBatch(brew.batchNumber) !== batch) return false;
        if (date && brew.date > date) return false;
        return true;
      })
      .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    const match = byBatch.at(-1);
    if (match) return match.id;
  }

  // Migration bridge for already-approved future packaging rows created before
  // brewId was persisted. A dated row on a tank may safely attach to the latest
  // planned brew on that same tank that occurs before the packaging date. This
  // does NOT use tank-only matching for undated/current packaging, so a physical
  // cycle cannot leak into a different future cycle.
  if (run.tankId && date) {
    const byTankAndDate = allBrews
      .filter((brew) => brew.tankId === run.tankId && brew.date <= date)
      .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    const match = byTankAndDate.at(-1);
    if (match) return match.id;
  }

  return null;
}

export function brewById(plans: WeekPlan[], brewId: string): BrewPlan | null {
  for (const week of plans) {
    const brew = (week.brews ?? []).find((candidate) => candidate.id === brewId);
    if (brew) return brew;
  }
  return null;
}

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
        ...(normalizedBatch(brew.batchNumber) ? { batchNumber: normalizedBatch(brew.batchNumber) } : {}),
      };
    }),
  }));
}
