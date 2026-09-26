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
 * Display-only enrichment for the five-week planning views.
 *
 * Brew assignments have one source of truth: the tankId saved on the WeekPlan
 * decision. Never promote a suggested/tentative tank, or a tank that happens to
 * contain the same batch number, into a confirmed assignment. This keeps Gantt
 * and Calendar aligned with the saved planning decision.
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
      const weekEnd = addDays(plan.id, 6);

      const brews = plan.brews.map((rawBrew) => {
        const brew = rawBrew as DisplayBrew;
        const confirmedTank = brew.tankId
          ? tanks.find((tank) => tank.id === brew.tankId)
          : undefined;

        if (confirmedTank) {
          return { ...brew, tentativeTankId: undefined } as DisplayBrew;
        }

        // A missing or obsolete tankId is unassigned. Suggestions belong in the
        // recommendation/editor UI only; Calendar/Gantt must not present them as
        // real assignments.
        return {
          ...brew,
          tankId: "",
          tentativeTankId: undefined,
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
