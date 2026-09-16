import type { Fermentor } from "../../App";
import {
  sameStyle,
  weekStart,
  type Actual,
  type Plan,
  type Product,
  type WeekPlan,
} from "./planningEngine";
import { actualDate, actualUnits, matchesActual } from "./dailyPlanner";

function planKey(run: Plan, index: number) {
  return run.id ?? `${run.productId}:${run.tankId ?? ""}:${run.tankNumber ?? ""}:${run.batchNumber ?? ""}:${index}`;
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

function actualForRun(
  week: WeekPlan,
  run: Plan,
  product: Product,
  actuals: Actual[],
) {
  return actuals
    .filter((actual) => {
      const date = actualDate(actual);
      if (!date || weekStart(date) !== week.id || !matchesActual(product, actual)) return false;
      if (run.tankNumber && String(actual.tankNumber) !== String(run.tankNumber)) return false;
      if (run.batchNumber && String(actual.batchNumber) !== String(run.batchNumber)) return false;
      return true;
    })
    .reduce((sum, actual) => sum + actualUnits(product, actual), 0);
}

function isOperationallyCompleted(
  week: WeekPlan,
  run: Plan,
  product: Product | undefined,
  actuals: Actual[],
  sources: Fermentor[],
) {
  if (!product) return false;
  const source = sourceForRun(run, sources);
  if (!sourceShowsTankClosed(run, source)) return false;

  return actualForRun(week, run, product, actuals) > 0;
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
  return plans.map((week) => ({
    ...week,
    packaging: week.packaging.map((run) => {
      const product = products.find((candidate) => candidate.id === run.productId);
      if (!isOperationallyCompleted(week, run, product, actuals, sources) || !product) return run;
      return {
        ...run,
        quantity: actualForRun(week, run, product, actuals),
        emptyTank: true,
      };
    }),
  }));
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
  const completed = new Map<string, Plan>();

  original.packaging.forEach((run, index) => {
    const product = products.find((candidate) => candidate.id === run.productId);
    if (isOperationallyCompleted(original, run, product, actuals, sources)) {
      completed.set(planKey(run, index), run);
    }
  });

  const pendingEdited = edited.packaging.filter((run, index) => !completed.has(planKey(run, index)));

  return {
    ...edited,
    packaging: [...completed.values(), ...pendingEdited],
  };
}
