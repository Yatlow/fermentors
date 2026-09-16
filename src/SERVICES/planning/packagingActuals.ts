import type { Fermentor } from "../../App";
import type { Actual, Plan, Product, WeekPlan } from "./planningEngine";
import { openRuns } from "./dailyPlanner";

function persistedPlanKey(run: Plan, index: number) {
  return run.id ?? `${run.productId}:${run.tankId ?? ""}:${run.tankNumber ?? ""}:${run.batchNumber ?? ""}:${index}`;
}

function openRunKey(week: WeekPlan, run: Plan, index: number) {
  return run.id ?? `${week.id}:${run.productId}:${index}`;
}

function sourceForRun(run: Plan, sources: Fermentor[]) {
  return sources.find((source) =>
    (!!run.tankId && source.id === run.tankId) ||
    (!!run.tankNumber && String(source.tankNumber) === String(run.tankNumber)),
  );
}

function sourceShowsTankClosed(run: Plan, source: Fermentor | undefined) {
  if (!source) return false;

  if (
    run.batchNumber &&
    source.batchNumber &&
    String(run.batchNumber) !== String(source.batchNumber)
  ) return true;

  if (source.tankStatus === true) return true;
  if ([3, 4, 5].includes(Number(source.action))) return true;

  return ["stage-empty", "stage-clean", "stage-sanitized"].includes(
    source.stage?.className ?? "",
  );
}

function completionMap(
  week: WeekPlan,
  products: Product[],
  actuals: Actual[],
) {
  return new Map(
    openRuns([week], products, actuals).map((run) => [run.key, run] as const),
  );
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
  sources: Fermentor[],
): WeekPlan[] {
  return plans.map((week) => {
    const completed = completionMap(week, products, actuals);
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
  sources: Fermentor[],
): WeekPlan {
  const open = completionMap(original, products, actuals);
  const completed = new Map<string, Plan>();

  original.packaging.forEach((run, index) => {
    const source = sourceForRun(run, sources);
    const actualQuantity = actualCompletedForRun(original, run, index, open);
    if (sourceShowsTankClosed(run, source) && actualQuantity > 0) {
      completed.set(persistedPlanKey(run, index), run);
    }
  });

  const pendingEdited = edited.packaging.filter((run, index) =>
    !completed.has(persistedPlanKey(run, index)),
  );

  return {
    ...edited,
    packaging: [...completed.values(), ...pendingEdited],
  };
}
