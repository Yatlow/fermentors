import { addDays, daysBetween, litersPerUnit, parseDate, sameStyle, tempoNow, weeklyDemand, type Actual, type Settings } from "./planningEngine";
import { actualDate, actualUnits, matchesActual } from "./dailyPlanner";
import type { PlanningSnapshot } from "./planningReports";
import { planningTargetsForStyle } from "./planningTargets";

export type PlanningMacroInsight = {
  id: string;
  title: string;
  evidence: string;
  recommendation: string;
  scope: "style" | "sku";
  /** Count of distinct completed weeks supporting the pattern. */
  sampleWeeks: number;
  /** Weeks meeting the explicit trigger. */
  affectedWeeks: number;
};

/** Only completed, explicitly captured opening plans count as historical evidence. */
export function planningMacroInsights(
  settings: Settings, snapshots: PlanningSnapshot[], actuals: Actual[], today: string,
): PlanningMacroInsight[] {
  const opening = snapshots.filter((s) => s.checkpoint === "opening" && s.state === "captured" &&
    s.plan && s.settings && addDays(s.targetWeek, 7) <= today)
    .sort((a, b) => a.targetWeek.localeCompare(b.targetWeek));
  const unique = [...new Map(opening.map((row) => [row.targetWeek, row])).values()].slice(-12);
  const results: PlanningMacroInsight[] = [];
  const styles = [...new Set(settings.products.filter((p) => p.monthly > 0).map((p) => p.style))];
  for (const style of styles) {
    const weeks = unique.flatMap((snapshot) => {
      const items = snapshot.settings!.products.filter((p) => sameStyle(p.style, style) && p.monthly > 0);
      const demandLiters = items.reduce((sum, p) => sum + weeklyDemand(p) * litersPerUnit(p), 0);
      if (demandLiters <= 0) return [];
      const plannedLiters = snapshot.plan!.packaging.reduce((sum, run) => {
        const product = items.find((p) => p.id === run.productId);
        return sum + (product ? Math.max(0, run.quantity) * litersPerUnit(product) : 0);
      }, 0);
      const completedLiters = items.reduce((sum, p) =>
        sum + actuals.filter((a) => matchesActual(p, a) && actualDate(a) &&
          actualDate(a)! >= snapshot.targetWeek && actualDate(a)! < addDays(snapshot.targetWeek, 7))
          .reduce((total, actual) => total + actualUnits(p, actual) * litersPerUnit(p), 0), 0);
      return [{ week: snapshot.targetWeek, plannedLiters, completedLiters, demandLiters }];
    });
    if (weeks.length < 4) continue;
    const last = weeks.slice(-6);
    // Completed output must be analyzed independently from the sales target:
    // a brewery can meet demand from previously packaged stock.
    const plannedProductionWeeks = last.filter((row) => row.plannedLiters > 0);
    const underexecuted = plannedProductionWeeks.filter((row) => row.completedLiters < row.plannedLiters * 0.85);
    if (plannedProductionWeeks.length >= 4 && underexecuted.length >= 3) {
      const plannedTotal = plannedProductionWeeks.reduce((sum, row) => sum + row.plannedLiters, 0);
      const completedTotal = plannedProductionWeeks.reduce((sum, row) => sum + row.completedLiters, 0);
      results.push({
        id: "execution:" + style, scope: "style",
        title: `${style}: פער חוזר בין אריזה שתוכננה לבין אריזה שדווחה`,
        evidence: `${underexecuted.length} מתוך ${plannedProductionWeeks.length} שבועות עם אריזה מתוכננת הסתיימו בפחות מ־85% מהכמות; ביצוע מצטבר ${Math.round(completedTotal / plannedTotal * 100)}% מהתכנון.`,
        recommendation: "לבדוק מול יומן האריזה אם חסרים דיווחים; אם הדיווח מלא, לבדוק מוכנות מיכלים, תזמון וקיבולת. אין להסיק שהביקוש לא סופק ללא נתוני מלאי.",
        sampleWeeks: plannedProductionWeeks.length, affectedWeeks: underexecuted.length,
      });
    }
    const underplanned = last.filter((w) => w.plannedLiters < w.demandLiters * 0.8);
    if (underplanned.length >= 4) {
      const ratio = last.reduce((sum, w) => sum + w.plannedLiters, 0) /
        last.reduce((sum, w) => sum + w.demandLiters, 0);
      results.push({
        sampleWeeks: last.length, affectedWeeks: underplanned.length,
        id: "style:" + style, scope: "style",
        title: `${style}: תכנון אריזה נמוך מהביקוש שהוגדר באופן חוזר`,
        evidence: `${underplanned.length} מתוך ${last.length} שבועות מתועדים תוכננו בפחות מ־80% מהביקוש המשוער; יחס הכמות המתוכננת לביקוש המצטבר: ${Math.round(ratio * 100)}%.`,
        recommendation: "לבדוק מלאי פתיחה, משלוחים ומועדי בישול לפני הגדלת התוכנית. אריזה מתחת לביקוש אינה הוכחה למחסור אם קיים מלאי מספיק.",
      });
    }
  }
  for (const p of settings.products.filter((item) => item.monthly > 0)) {
    const observations = unique.flatMap((snapshot) => {
      const product = snapshot.settings!.products.find((item) => item.id === p.id);
      if (!product || product.tempo == null || !product.tempoDate) return [];
      const date = parseDate(product.tempoDate);
      if (!date || date > snapshot.targetWeek || daysBetween(date, snapshot.targetWeek) > 7) return [];
      const stock = tempoNow(product, snapshot.targetWeek);
      const demand = weeklyDemand(product);
      if (stock === null || demand <= 0) return [];
      const cover = stock / demand;
      const target = planningTargetsForStyle(snapshot.settings!, product.style).targetWeeks;
      return [{ week: snapshot.targetWeek, cover, target }];
    });
    const last = observations.slice(-6);
    const below = last.filter((observation) => observation.cover < observation.target * 0.6);
    if (last.length >= 4 && below.length >= 3) {
      results.push({
        sampleWeeks: last.length, affectedWeeks: below.length,
        id: "sku:" + p.id, scope: "sku",
        title: `${p.style} · ${p.type === "crates" ? "ארגזים" : "חביות"}: כיסוי מלאי נמוך שחוזר בדגימות`,
        evidence: `${below.length} מתוך ${last.length} דגימות מלאי שבועיות היו מתחת ל־60% מיעד הכיסוי.`,
        recommendation: "לבדוק תדירות משלוחים ואמינות הביקוש שהוגדר; לשקול בדיקה של יעד הכיסוי לסגנון. אין כרגע יעד כיסוי נפרד למק״ט ואין הצדקה לעדכן הגדרות אוטומטית.",
      });
    }
  }
  return results.sort((a, b) => (b.affectedWeeks / b.sampleWeeks) - (a.affectedWeeks / a.sampleWeeks));
}
