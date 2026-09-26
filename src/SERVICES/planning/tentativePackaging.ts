import {
  addDays,
  litersPerUnit,
  sameStyle,
  type Settings,
  type Tank,
  type WeekPlan,
} from "./planningEngine";

type DisplayBrew = WeekPlan["brews"][number] & { tentativeTankId?: string };

const normalizedBatch = (value: unknown) => String(value ?? "").replace("#", "").trim();

/**
 * Display-only enrichment for the five-week calendar.
 * Tentative values are never persisted as confirmed assignments.
 *
 * A real assignment always wins. Besides an explicit brew.tankId, a batch that
 * is already present on a real tank is considered confirmed as well. This is
 * important because the execution flow can assign a planned batch to a tank
 * before that assignment is reflected back into the planning row itself.
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
        const batch = normalizedBatch(brew.batchNumber);
        const confirmedById = tanks.find((tank) => tank.id === brew.tankId);
        const confirmedByBatch = batch
          ? tanks.find((tank) => normalizedBatch(tank.batch) === batch)
          : undefined;
        const confirmedTank = confirmedById ?? confirmedByBatch;

        if (confirmedTank) {
          reservedBrewTanks.add(confirmedTank.id);
          return {
            ...brew,
            tankId: confirmedTank.id,
            tentativeTankId: undefined,
          } as DisplayBrew;
        }

        // Old recommendations may contain a placeholder/obsolete tankId. For
        // display purposes do not let that invalid id become "מיכל ?".
        const candidate = tanks
          .filter((tank) => tank.ready <= weekEnd && !reservedBrewTanks.has(tank.id))
          .sort((a, b) => a.ready.localeCompare(b.ready) || Number(a.number) - Number(b.number))[0];

        if (!candidate) {
          return brew.tankId && !confirmedById ? { ...brew, tankId: "", tentativeTankId: undefined } : brew;
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
