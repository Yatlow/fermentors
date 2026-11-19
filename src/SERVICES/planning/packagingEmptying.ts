import { type Plan, type Product, type Tank } from "./planningEngine";

export type PlannedDrainConfirmation = {
  tankNumber: string;
  remainderLiters: number;
  availableLiters: number;
};

/**
 * Keep the planner's final-emptying decision when the package format changes.
 * A 104-keg drain (2080 L) becoming 252 crates (1995.84 L) still means the
 * planner intends to EMPTY that same physical batch; the leftover is possible
 * process loss, not more crates or a reason to silently cancel the next brew.
 *
 * Never inherit this marker across tank/batch/brew identities. An inferred
 * previous drain is only accepted when its entire original weekly plan really
 * consumed the available physical volume. A sizable new residual requires
 * the planner's explicit confirmation before saving.
 */
export function reconcileEditedPackagingEmptying(
  next: Plan[],
  previous: Plan[],
  products: Product[],
  availableLitersByTank: ReadonlyMap<string, number>,
  physicalTanks: Tank[],
  completedById: ReadonlyMap<string, number> = new Map(),
): { packaging: Plan[]; confirmations: PlannedDrainConfirmation[] } {
  const batch = (value: unknown) => String(value ?? "").replace("#", "").trim();
  const keyFor = (run: Plan) =>
    run.brewId ? `brew:${run.brewId}:batch:${batch(run.batchNumber)}` :
      run.tankId ? `physical:${run.tankId}:${batch(run.batchNumber)}` : "";
  const productFor = (run: Plan) =>
    run.nonInventoryType
      ? { type: run.nonInventoryType }
      : products.find((product) => product.id === run.productId);
  const unitLiters = (run: Plan) => {
    const p = productFor(run);
    return p ? (p.type === "crates" ? 24 * 0.33 : 20) : 0;
  };
  const pendingLiters = (run: Plan) =>
    Math.max(0, run.quantity - (run.id ? completedById.get(run.id) ?? 0 : 0)) * unitLiters(run);
  const availableFor = (run: Plan): number | undefined => {
    const key = run.brewId ? `planned:${run.brewId}` : run.tankId;
    const fromModel = key ? availableLitersByTank.get(key) : undefined;
    if (fromModel !== undefined) return fromModel;
    const physical = physicalTanks.find((tank) => tank.id === run.tankId);
    return physical?.liters;
  };
  const groups = new Map<string, number[]>();
  next.forEach((run, index) => {
    const key = keyFor(run);
    if (!key) return;
    const list = groups.get(key) ?? [];
    list.push(index);
    groups.set(key, list);
  });
  const result = next.map((run) => ({ ...run }));
  const confirmations: PlannedDrainConfirmation[] = [];

  for (const [cycle, indices] of groups) {
    const sorted = [...indices].sort((a, b) =>
      (next[a].date ?? "9999-99-99").localeCompare(next[b].date ?? "9999-99-99") || a - b);
    const finalIndex = sorted.at(-1)!;
    const final = next[finalIndex];
    const base = availableFor(final);
    const measurable = base !== undefined && Number.isFinite(base) && base > 0 &&
      indices.every((index) => unitLiters(next[index]) > 0);
    const nextRemaining = measurable
      ? base! - indices.reduce((sum, index) => sum + pendingLiters(next[index]), 0) : NaN;

    const oldCycle = previous.filter((run) => keyFor(run) === cycle);
    const oldFinal = [...oldCycle].sort((a, b) =>
      (a.date ?? "9999-99-99").localeCompare(b.date ?? "9999-99-99") ||
      previous.indexOf(a) - previous.indexOf(b)).at(-1);
    const originalWasDrained = !!oldFinal &&
      (oldFinal.emptyTank === true ||
        (measurable && oldCycle.every((run) => unitLiters(run) > 0) &&
         (() => {
           const remaining = base! - oldCycle.reduce((sum, run) => sum + pendingLiters(run), 0);
           return remaining >= -0.01 && remaining < 20;
         })()));
    // A single fully-draining row can become two crate shifts (252 + 10).
    // The final row then gets a new id, but its batch/cycle identity is still
    // identical to the original. Carry the *decision*, not the row id.
    const carried = oldCycle.length > 0 && originalWasDrained;
    const automaticallyEmpty = measurable && nextRemaining >= -0.01 && nextRemaining < 20;
    const emptiesTank = final.emptyTank === true || carried || automaticallyEmpty;

    for (const index of indices) result[index].emptyTank = index === finalIndex && emptiesTank;

    if (emptiesTank && measurable && nextRemaining >= 20) {
      const oldRun = previous.find((run) => run.id && run.id === final.id && keyFor(run) === cycle);
      const edited = !oldRun || oldRun.productId !== final.productId ||
        oldRun.nonInventoryType !== final.nonInventoryType ||
        oldRun.quantity !== final.quantity || oldRun.emptyTank !== true;
      if (edited) confirmations.push({
        tankNumber: final.tankNumber ??
          physicalTanks.find((tank) => tank.id === final.tankId)?.number ??
          final.tankId ?? "לא ידוע",
        remainderLiters: nextRemaining,
        availableLiters: base!,
      });
    }
  }

  return { packaging: result, confirmations };
}
