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
 * Display-only enrichment for the five-week calendar.
 * Tentative values are never persisted as confirmed assignments.
 */
export function withTentativeFiveWeekTanks(
  plans: WeekPlan[],
  tanks: Tank[],
  settings: Settings,
): WeekPlan[] {
  const reservedLiters = new Map<string, number>();

  // Real packaging allocations reserve capacity first.
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
        const confirmedTank = tanks.find((tank) => tank.id === brew.tankId);
        if (confirmedTank) {
          reservedBrewTanks.add(confirmedTank.id);
          return brew;
        }

        // Old recommendations may contain a placeholder/obsolete tankId. For
        // display purposes do not let that invalid id become "מיכל ?".
        const candidate = tanks
          .filter((tank) => tank.ready <= weekEnd && !reservedBrewTanks.has(tank.id))
          .sort((a, b) => a.ready.localeCompare(b.ready) || Number(a.number) - Number(b.number))[0];

        if (!candidate) {
          return brew.tankId && !confirmedTank ? { ...brew, tankId: "" } : brew;
        }
        reservedBrewTanks.add(candidate.id);
        return {
          ...brew,
          tankId: "",
          tentativeTankId: candidate.id,
        } as DisplayBrew;
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
          .sort((a, b) =>
            a.ready.localeCompare(b.ready) || Number(a.number) - Number(b.number),
          )[0];

        if (!candidate) {
          return run.tankId && !confirmedTank ? { ...run, tankId: "" } : run;
        }
        reservedLiters.set(
          candidate.id,
          (reservedLiters.get(candidate.id) ?? 0) + neededLiters,
        );
        return { ...run, tankId: "", tankNumber: `${candidate.number} (מוצע)` };
      });

      return { ...plan, brews, packaging };
    });
}
