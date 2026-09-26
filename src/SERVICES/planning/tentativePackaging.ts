import {
  addDays,
  litersPerUnit,
  sameStyle,
  type Settings,
  type Tank,
  type WeekPlan,
} from "./planningEngine";

type DisplayBrew = WeekPlan["brews"][number] & { tentativeTankId?: string };

/**
 * Display-only enrichment for five-week planning.
 * Saved tankId remains the confirmed assignment. tentativeTankId is only a
 * recommendation and is never persisted as an assignment.
 */
export function withTentativeFiveWeekTanks(
  plans: WeekPlan[],
  tanks: Tank[],
  settings: Settings,
): WeekPlan[] {
  const reservedLiters = new Map<string, number>();

  for (const plan of plans) {
    for (const run of plan.packaging) {
      if (!run.tankId || run.quantity <= 0) continue;
      const product = settings.products.find((item) => item.id === run.productId);
      if (!product) continue;
      reservedLiters.set(
        run.tankId,
        (reservedLiters.get(run.tankId) ?? 0) + run.quantity * litersPerUnit(product),
      );
    }
  }

  return [...plans]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((plan) => {
      const reservedBrewTanks = new Set<string>();
      const weekEnd = addDays(plan.id, 6);

      const brews = plan.brews.map((rawBrew) => {
        const brew = rawBrew as DisplayBrew;
        const confirmedTank = brew.tankId ? tanks.find((tank) => tank.id === brew.tankId) : undefined;

        if (brew.tankId) {
          // Preserve the saved assignment even when the capacity model does not
          // currently contain that tank (for example an empty/sanitized tank).
          // Display code can resolve its number from the Fermentor source list.
          if (confirmedTank) reservedBrewTanks.add(confirmedTank.id);
          return { ...brew, tentativeTankId: undefined } as DisplayBrew;
        }

        const candidate = tanks
          .filter((tank) => tank.ready <= weekEnd && !reservedBrewTanks.has(tank.id))
          .sort((a, b) => a.ready.localeCompare(b.ready) || Number(a.number) - Number(b.number))[0];

        if (!candidate) return { ...brew, tentativeTankId: undefined } as DisplayBrew;
        reservedBrewTanks.add(candidate.id);
        return { ...brew, tentativeTankId: candidate.id } as DisplayBrew;
      });

      const packaging = plan.packaging.map((run) => {
        const confirmedTank = tanks.find((tank) => tank.id === run.tankId);
        if (confirmedTank || run.tankNumber || run.quantity <= 0) return run;

        const product = settings.products.find((item) => item.id === run.productId);
        if (!product) return run;

        const neededLiters = run.quantity * litersPerUnit(product);
        const readyBy = run.date ?? weekEnd;
        const candidate = tanks
          .filter((tank) =>
            sameStyle(tank.style, product.style) &&
            tank.ready <= readyBy &&
            tank.liters - (reservedLiters.get(tank.id) ?? 0) >= neededLiters,
          )
          .sort((a, b) => a.ready.localeCompare(b.ready) || Number(a.number) - Number(b.number))[0];

        if (!candidate) return run.tankId && !confirmedTank ? { ...run, tankId: "" } : run;
        reservedLiters.set(candidate.id, (reservedLiters.get(candidate.id) ?? 0) + neededLiters);
        return { ...run, tankId: "", tankNumber: `${candidate.number} (מוצע)` };
      });

      return { ...plan, brews, packaging };
    });
}
