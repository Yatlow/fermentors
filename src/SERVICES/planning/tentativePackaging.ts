import {
  addDays,
  litersPerUnit,
  sameStyle,
  type Settings,
  type Tank,
  type WeekPlan,
} from "./planningEngine";

/**
 * Display-only enrichment for the five-week calendar.
 * It never persists a tentative tank as a real tankId; it only supplies the
 * tankNumber fallback used by the calendar until the operator confirms a tank.
 */
export function withTentativePackagingTankNumbers(
  plans: WeekPlan[],
  tanks: Tank[],
  settings: Settings,
): WeekPlan[] {
  const reservedLiters = new Map<string, number>();

  // Real allocations reserve capacity first.
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
    .map((plan) => ({
      ...plan,
      packaging: plan.packaging.map((run) => {
        if (run.tankId || run.tankNumber || run.quantity <= 0) return run;
        const product = settings.products.find((item) => item.id === run.productId);
        if (!product) return run;

        const neededLiters = run.quantity * litersPerUnit(product);
        const readyBy = run.date ?? addDays(plan.id, 6);
        const candidate = tanks
          .filter((tank) =>
            sameStyle(tank.style, product.style) &&
            tank.ready <= readyBy &&
            tank.liters - (reservedLiters.get(tank.id) ?? 0) >= neededLiters,
          )
          .sort((a, b) =>
            a.ready.localeCompare(b.ready) || Number(a.number) - Number(b.number),
          )[0];

        if (!candidate) return run;
        reservedLiters.set(
          candidate.id,
          (reservedLiters.get(candidate.id) ?? 0) + neededLiters,
        );
        return { ...run, tankNumber: `${candidate.number} (מוצע)` };
      }),
    }));
}
