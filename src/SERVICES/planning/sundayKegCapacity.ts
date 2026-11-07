import type { Product, WeekPlan } from "./planningEngine";
import { packagingLimit, weekday } from "./productionCycle";

/** A planner-approved Sunday keg shift is tied to its date and *exact* total. */
export type SundayKegOverageApproval = { date: string; quantity: number };

export function sundayKegOverages(
  week: WeekPlan,
  products: Product[],
): SundayKegOverageApproval[] {
  const totals = new Map<string, number>();
  for (const run of week.packaging) {
    if (!run.date || weekday(run.date) !== 0 || !Number.isInteger(run.quantity) || run.quantity <= 0) continue;
    const type = products.find((product) => product.id === run.productId)?.type ?? run.nonInventoryType;
    if (type !== "kegs") continue;
    totals.set(run.date, (totals.get(run.date) ?? 0) + run.quantity);
  }
  return [...totals].filter(([date, quantity]) =>
    quantity > packagingLimit(date, "kegs"))
    .map(([date, quantity]) => ({ date, quantity }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function hasSundayKegOverageApproval(
  week: WeekPlan,
  approval: SundayKegOverageApproval,
): boolean {
  return (week.sundayKegOverageApprovals ?? []).some((saved) =>
    saved.date === approval.date && saved.quantity === approval.quantity);
}

/**
 * Keep only approvals still matching an actual Sunday keg shift. Approval of
 * a changed quantity/day must be requested anew; no global capacity bypass.
 * Passing newlyConfirmed is used only after the planner explicitly accepts
 * the confirmation modal.
 */
export function withSundayKegOverageApprovals(
  week: WeekPlan,
  products: Product[],
  newlyConfirmed: SundayKegOverageApproval[] = [],
): WeekPlan {
  return {
    ...week,
    sundayKegOverageApprovals: sundayKegOverages(week, products).filter((approval) =>
      hasSundayKegOverageApproval(week, approval) ||
      newlyConfirmed.some((candidate) =>
        candidate.date === approval.date && candidate.quantity === approval.quantity)),
  };
}
