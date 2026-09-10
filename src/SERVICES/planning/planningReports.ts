import {
  addDays,
  daysBetween,
  weekStart,
  type Actual,
  type Product,
  type Settings,
  type WeekPlan,
} from "./planningEngine";
import { actualDate, actualUnits, matchesActual } from "./dailyPlanner";
export const CHECKPOINTS = [
  "lead4",
  "lead3",
  "lead2",
  "lead1",
  "opening",
] as const;
export type Checkpoint = (typeof CHECKPOINTS)[number];
export type PlanningSnapshot = {
  id: string;
  targetWeek: string;
  checkpoint: Checkpoint;
  plan: WeekPlan | null;
  settings: Settings | null;
  state: "captured" | "no-plan" | "history-unavailable";
  scheduledFor?: { seconds: number };
  capturedAt?: { seconds: number };
};
export const checkpointLabel: Record<Checkpoint, string> = {
  lead4: "4 שבועות מראש",
  lead3: "3 שבועות מראש",
  lead2: "שבועיים מראש",
  lead1: "שבוע מראש",
  opening: "פתיחת שבוע",
};
export function compareProduct(
  p: Product,
  plan: WeekPlan | null,
  actuals: Actual[],
  week: string,
) {
  const rows = (plan?.packaging ?? []).filter((r) => r.productId === p.id),
    planned = rows.reduce((s, r) => s + r.quantity, 0);
  const actual = actuals
    .filter(
      (a) =>
        matchesActual(p, a) &&
        actualDate(a) &&
        weekStart(actualDate(a)!) === week,
    )
    .sort((a, b) => actualDate(a)!.localeCompare(actualDate(b)!));
  const performed = actual.reduce((s, a) => s + actualUnits(p, a), 0);
  // Quantity-weighted timing match. Each unit is matched once, in chronological order.
  let weightedDelay = 0,
    matched = 0,
    index = 0,
    actualLeft = actual[0] ? actualUnits(p, actual[0]) : 0;
  for (const row of [...rows].sort((a, b) =>
    (a.date ?? "9999").localeCompare(b.date ?? "9999"),
  )) {
    let left = row.quantity;
    while (left > 0 && index < actual.length) {
      const take = Math.min(left, actualLeft);
      if (row.date) {
        weightedDelay +=
          take * daysBetween(row.date, actualDate(actual[index])!);
        matched += take;
      }
      left -= take;
      actualLeft -= take;
      if (actualLeft <= 0.00001) {
        index++;
        actualLeft = actual[index] ? actualUnits(p, actual[index]) : 0;
      }
    }
  }
  return {
    planned: plan ? planned : null,
    performed,
    delta: plan ? performed - planned : null,
    attainment: planned > 0 ? (performed / planned) * 100 : null,
    delay: matched > 0 ? weightedDelay / matched : null,
    matched,
  };
}
export function compareSnapshots(
  p: Product,
  snapshots: PlanningSnapshot[],
  week: string,
) {
  return CHECKPOINTS.map((key) => {
    const s = snapshots.find(
      (x) => x.targetWeek === week && x.checkpoint === key,
    );
    return {
      key,
      state: s?.state ?? "missing",
      quantity:
        s?.state === "captured"
          ? (s.plan?.packaging
              .filter((r) => r.productId === p.id)
              .reduce((sum, r) => sum + r.quantity, 0) ?? 0)
          : null,
    };
  });
}
export function learningAdvice(
  products: Product[],
  snapshots: PlanningSnapshot[],
  actuals: Actual[],
  today: string,
) {
  return products.flatMap((p) => {
    const evidence = snapshots
      .filter(
        (s) =>
          s.checkpoint === "opening" &&
          s.state === "captured" &&
          s.plan &&
          addDays(s.targetWeek, 7) <= today,
      )
      .map((s) => compareProduct(p, s.plan, actuals, s.targetWeek))
      .filter((r) => (r.planned ?? 0) > 0);
    if (evidence.length < 4) return [];
    const planned = evidence.reduce((s, r) => s + r.planned!, 0),
      actual = evidence.reduce((s, r) => s + r.performed, 0),
      ratio = actual / planned;
    if (ratio >= 0.9 && ratio <= 1.1) return [];
    return [
      {
        productId: p.id,
        weeks: evidence.length,
        ratio,
        message:
          ratio < 0.9
            ? "הביצוע נמוך מהתכנון באופן חוזר — לבדוק זמינות בירה, חומרי אריזה וקיבולת לפני הגדלת התוכנית."
            : "הביצוע גבוה מהתכנון באופן חוזר — לבדוק צורך ברזרבת אריזה ותזמון מוקדם יותר.",
        suggestedReview: "בדיקת מכסת ימי אריזה; אין שינוי אוטומטי במקדם מכירות",
      },
    ];
  });
}
