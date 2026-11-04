export type PackagingSource = {
  id?: unknown;
  tankNumber?: unknown;
  batchNumber?: unknown;
  tankStatus?: unknown;
  action?: unknown;
  stage?: unknown;
};
import { sameStyle, weekStart, type Actual, type Plan, type Product, type WeekPlan } from "./planningEngine";
import { actualDate, matchesActual, openRuns } from "./dailyPlanner";

function persistedPlanKey(run: Plan, index: number) {
  return run.id ?? `${run.productId}:${run.tankId ?? ""}:${run.tankNumber ?? ""}:${run.batchNumber ?? ""}:${index}`;
}

function openRunKey(week: WeekPlan, run: Plan, index: number) {
  return run.id ?? `${week.id}:${run.productId}:${index}`;
}

function sourceForRun(run: Plan, sources: PackagingSource[]) {
  return sources.find((source) =>
    (!!run.tankId && source.id === run.tankId) ||
    (!!run.tankNumber && String(source.tankNumber) === String(run.tankNumber)),
  );
}

function sourceShowsTankClosed(run: Plan, source: PackagingSource | undefined) {
  if (!source) return false;

  if (
    run.batchNumber &&
    source.batchNumber &&
    String(run.batchNumber) !== String(source.batchNumber)
  ) return true;

  if (source.tankStatus === true) return true;
  if ([3, 4, 5].includes(Number(source.action))) return true;

  return ["stage-empty", "stage-clean", "stage-sanitized"].includes(
    typeof source.stage === "object" && source.stage !== null && "className" in source.stage
      ? String((source.stage as { className?: unknown }).className ?? "")
      : "",
  );
}

/**
 * A report is authoritative for its physical batch and actual day, not for
 * the day on which the planner originally expected to package it.
 * Never guess a historical date from a style-only match.
 */
function reportsForPhysicalRun(
  week: WeekPlan,
  run: Plan,
  products: Product[],
  actuals: Actual[],
  sources: PackagingSource[],
): Array<{ actual: Actual; date: string }> {
  const source = sourceForRun(run, sources);
  const tankNumber = run.tankNumber ?? source?.tankNumber;
  const batchNumber = run.batchNumber ?? source?.batchNumber;
  const product = products.find((p) => p.id === run.productId);
  const style = run.nonInventoryStyle ?? product?.style;
  const packagingType = run.nonInventoryType ?? product?.type;
  if (tankNumber == null || batchNumber == null || !style || !packagingType) return [];
  return actuals.flatMap((actual) => {
    const date = actualDate(actual);
    return date && weekStart(date) === week.id &&
      String(actual.tankNumber ?? "").trim() === String(tankNumber).trim() &&
      String(actual.batchNumber ?? "").replace("#", "").trim() === String(batchNumber).replace("#", "").trim() &&
      (product ? matchesActual(product, actual) : sameStyle(style, actual.beerStyle ?? "") &&
        actual.packagingType === (packagingType === "crates" ? "bottles" : "kegs")) &&
      Number(actual.quantity) > 0 ? [{ actual, date }] : [];
  });
}

/**
 * Special/seasonal packaging (for example winter kegs) has no inventory SKU,
 * so openRuns intentionally excludes it. Reconcile these decisions against
 * physical packaging reports by tank + batch + type instead of leaving every
 * such row permanently pending in the Gantt.
 *
 * Reports are consumed at most once across all matching special decisions.
 * An unidentified report never completes a special run by style alone.
 */
function specialPackagingRemaining(
  allPlans: WeekPlan[],
  products: Product[],
  actuals: Actual[],
  sources: PackagingSource[],
): Map<string, number> {
  const leftByActual = new Map<string, number>();
  const remaining = new Map<string, number>();
  const ordered = [...allPlans].sort((a, b) => a.id.localeCompare(b.id))
    .flatMap((week) => week.packaging.map((run, index) => ({ week, run, index })))
    .filter(({ run }) => !!run.nonInventoryStyle && !!run.nonInventoryType &&
      !products.some((product) => product.id === run.productId))
    .sort((a, b) => a.week.id.localeCompare(b.week.id) ||
      (a.run.date ?? "9999").localeCompare(b.run.date ?? "9999") ||
      String(a.run.id ?? a.index).localeCompare(String(b.run.id ?? b.index)));
  for (const { week, run, index } of ordered) {
    let outstanding = Math.max(0, run.quantity);
    for (const { actual } of reportsForPhysicalRun(week, run, products, actuals, sources)) {
      const units = Math.max(0, Number(actual.quantity) || 0) /
        (run.nonInventoryType === "crates" && actual.unit === "בקבוקים" ? 24 : 1);
      const available = leftByActual.get(actual.id) ?? units;
      const fulfilled = Math.min(outstanding, available);
      outstanding -= fulfilled;
      leftByActual.set(actual.id, available - fulfilled);
      if (outstanding <= 0) break;
    }
    remaining.set(openRunKey(week, run, index), outstanding);
  }
  return remaining;
}

/**
 * The calendar editor contains only remaining decisions. Actual quantities
 * are rendered separately from packagingLog on their real execution date.
 * Once a tank/batch is physically closed, its unproduced estimate is not an
 * additional packaging task, provided a matching report exists.
 */
export function pendingPackagingDecisions(
  week: WeekPlan,
  products: Product[],
  actuals: Actual[],
  sources: PackagingSource[],
  allPlans: WeekPlan[] = [week],
): Plan[] {
  // Keep one global physical-report pool across planned weeks. Running one
  // openRuns([week]) per card silently assigned the same packaging report to
  // several weeks after a reschedule.
  const completed = completionMap(week, products, actuals, allPlans, sources);
  return week.packaging.flatMap((run, index) => {
    const qty = completed.get(openRunKey(week, run, index))?.remaining ?? run.quantity;
    if (qty <= 0) return [];
    if (sourceShowsTankClosed(run, sourceForRun(run, sources)) &&
      reportsForPhysicalRun(week, run, products, actuals, sources).length > 0) return [];
    return [{ ...run, quantity: qty }];
  });
}

function completionMap(
  week: WeekPlan,
  products: Product[],
  actuals: Actual[],
  allPlans: WeekPlan[] = [week],
  sources: PackagingSource[] = [],
) {
  const completed = new Map<string, { remaining: number }>(
    openRuns(allPlans, products, actuals)
      .filter((run) => run.week === week.id)
      .map((run) => [run.key, { remaining: run.remaining }] as const),
  );
  for (const [key, remaining] of specialPackagingRemaining(allPlans, products, actuals, sources)) {
    if (week.packaging.some((run, index) => openRunKey(week, run, index) === key))
      completed.set(key, { remaining });
  }
  return completed;
}

function actualCompletedForRun(
  week: WeekPlan,
  run: Plan,
  index: number,
  completed: ReturnType<typeof completionMap>,
) {
  const open = completed.get(openRunKey(week, run, index));
  return open ? Math.max(0, run.quantity - open.remaining) : 0;
}

/**
 * Planning execution should treat a packaging decision as completed once the
 * operational tank is already empty/clean/sanitized (or has moved to another
 * batch), even when actual packed units are a little below the planned target.
 * The returned view keeps the real actual quantity so reports never pretend
 * that the missing units were produced.
 */
export function plansAfterActualPackagingCompletion(
  plans: WeekPlan[],
  products: Product[],
  actuals: Actual[],
  sources: PackagingSource[],
): WeekPlan[] {
  return plans.map((week) => {
    const completed = completionMap(week, products, actuals, plans, sources);
    return {
      ...week,
      packaging: week.packaging.map((run, index) => {
        const source = sourceForRun(run, sources);
        const actualQuantity = actualCompletedForRun(week, run, index, completed);
        if (!sourceShowsTankClosed(run, source) || actualQuantity <= 0) return run;
        return {
          ...run,
          quantity: actualQuantity,
          emptyTank: true,
        };
      }),
    };
  });
}

/**
 * Saving another decision in the same week must not rewrite the original
 * planned packaging quantity. Operationally completed rows are restored from
 * the persisted original while pending rows come from the edited plan.
 */
export function mergeCompletedPackagingBack(
  original: WeekPlan,
  edited: WeekPlan,
  products: Product[],
  actuals: Actual[],
  sources: PackagingSource[],
  allPlans: WeekPlan[] = [original],
): WeekPlan {
  const open = completionMap(original, products, actuals, allPlans, sources);
  const preserved: Plan[] = [];
  const pending = edited.packaging.map((run) => ({ ...run }));
  const consumed = new Set<number>();

  original.packaging.forEach((run, index) => {
    const actualQuantity = actualCompletedForRun(original, run, index, open);
    if (actualQuantity <= 0) return;
    // A prior save may already have split this decision. Never split the
    // preserved executed part a second time or invent another remaining row.
    // Remaining rows can become executed on a later day. They must be
    // reconciled just like their parent, rather than silently discarded.
    const source = sourceForRun(run, sources);
    const key = persistedPlanKey(run, index);
    const editedIndex = pending.findIndex((candidate, candidateIndex) =>
      !consumed.has(candidateIndex) &&
      persistedPlanKey(candidate, candidateIndex) === key,
    );
    const replacement = editedIndex >= 0 ? pending[editedIndex] : undefined;
    if (editedIndex >= 0) consumed.add(editedIndex);

    // An executed quantity must remain attached to its original tank, batch,
    // product and date, regardless of subsequent changes to the pending plan.
    // Split the unexecuted balance into a fresh decision with a distinct id.
    const actualDays = reportsForPhysicalRun(original, run, products, actuals, sources)
      .map((report) => report.date).sort();
    preserved.push({
      ...run,
      quantity: actualQuantity,
      // A past report must never be retained as a future execution decision.
      date: actualDays.at(-1) ?? run.date,
      emptyTank: sourceShowsTankClosed(run, source),
    });
    if (replacement) {
      // The editor may already contain the distinct pending balance from a
      // previous save. Do not subtract completed units from it again.
      const alreadySplit = !!run.id && edited.packaging.some((candidate) =>
        candidate.id === `${run.id}:remaining`
      );
      if (alreadySplit) {
        pending[editedIndex] = { ...replacement, quantity: 0 };
        return;
      }
      const outstanding = Math.max(0, replacement.quantity - actualQuantity);
      if (outstanding > 0) {
        pending[editedIndex] = {
          ...replacement,
          id: replacement.id ? `${replacement.id}:remaining` : undefined,
          quantity: outstanding,
        };
      } else {
        pending[editedIndex] = { ...replacement, quantity: 0 };
      }
    }
  });

  return {
    ...edited,
    packaging: [
      ...preserved,
      ...pending.filter((run) => run.quantity > 0 && !(
        sourceShowsTankClosed(run, sourceForRun(run, sources)) &&
        reportsForPhysicalRun(original, run, products, actuals, sources).length > 0
      )),
    ],
  };
}
