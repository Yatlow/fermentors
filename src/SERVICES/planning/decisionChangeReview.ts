import { addDays, daysBetween, type Actual, type Product } from "./planningEngine";
import { actualDate, actualUnits, matchesActual } from "./dailyPlanner";
import { CHECKPOINTS, checkpointLabel, type PlanningSnapshot } from "./planningReports";

export type DecisionChangeFinding = {
  id: string;
  productId: string;
  title: string;
  checkpoint: string;
  evidence: string;
  experiment: string;
  limitation: string;
};

/** Only compare two consecutive *captured* checkpoints. Missing snapshots
 * are not interpreted as an unchanged plan or as zero production.
 * This diagnoses a changed decision; it never attributes causality.
 */
export function reviewPackagingDecisionChanges(
  products: Product[], snapshots: PlanningSnapshot[], actuals: Actual[],
  targetWeek: string, today: string,
): DecisionChangeFinding[] {
  if (addDays(targetWeek, 7) > today) return [];
  const forWeek = snapshots.filter((row) =>
    row.targetWeek === targetWeek && row.state === "captured" && row.plan);
  const ordered = CHECKPOINTS.map((checkpoint) =>
    forWeek.find((row) => row.checkpoint === checkpoint));
  const findings: DecisionChangeFinding[] = [];
  for (const product of products) {
    let first: { before: number; after: number; checkpoint: string; reason?: string } | null = null;
    for (let i = 1; i < ordered.length; i++) {
      const previous = ordered[i - 1], current = ordered[i];
      if (!previous?.plan || !current?.plan) continue;
      const quantity = (snapshot: PlanningSnapshot) =>
        snapshot.plan!.packaging.filter((row) => row.productId === product.id)
          .reduce((sum, row) => sum + Math.max(0, Number(row.quantity) || 0), 0);
      const before = quantity(previous), after = quantity(current);
      if (before !== after) {
        first = { before, after, checkpoint: checkpointLabel[current.checkpoint],
          reason: current.plan.changeReason };
        break;
      }
    }
    if (!first) continue;
    const execution = actuals.filter((row) => {
      const date = actualDate(row);
      return date && date >= targetWeek && date < addDays(targetWeek, 7) &&
        matchesActual(product, row);
    });
    // A zero reported quantity could be missing reporting. Only quantify the
    // performance gap when an actual matching record exists.
    const actualQty = execution.reduce((sum, row) => sum + actualUnits(product, row), 0);
    const title = `${product.style} · ${product.type === "crates" ? "ארגזים" : "חביות"}`;
    const delta = first.after - first.before;
    const direction = delta > 0 ? "הגדלה" : "הקטנה";
    const evidence = `${first.checkpoint}: ${direction} של ${Math.abs(delta).toLocaleString("he-IL")} יחידות (${first.before.toLocaleString("he-IL")} ← ${first.after.toLocaleString("he-IL")})` +
      (first.reason ? ` · סיבה שתועדה: ${first.reason}` : " · לא תועדה סיבת שינוי") +
      (execution.length ? ` · דווחו ${actualQty.toLocaleString("he-IL")} יחידות בשבוע` : " · אין דיווח אריזה תואם לשבוע");
    const experiment = execution.length
      ? `בתכנון הבא, לפני שינוי כמות של ${title}, השווה את מוכנות המיכלים ומכסת האריזה מול ${Math.abs(delta).toLocaleString("he-IL")} היחידות שהשתנו; בדוק אם ההחלטה המוקדמת הייתה ישימה.`
      : "בדוק קודם אם האריזה התבצעה ללא דיווח; לא ניתן להסיק על ביצוע מהיעדר דיווח.";
    findings.push({
      id: `${targetWeek}:${product.id}:${first.checkpoint}`,
      productId: product.id, title, checkpoint: first.checkpoint, evidence,
      experiment,
      limitation: "התיעוד מוכיח שינוי בתכנון, לא שהשינוי גרם לפער. זמינות המיכל במועד ההחלטה אינה מתועדת בצילומי התכנון.",
    });
  }
  return findings;
}
