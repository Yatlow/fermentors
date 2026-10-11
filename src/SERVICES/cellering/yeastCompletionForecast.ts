import type { ForecastTank, ConditionalForecast } from "./coldCellarForecast";

/** Complements only documented, quantity-known yeast drops; uncertain text is not scored. */
export type YeastCompletionReading = { id?: string | number | null; notes?: string | number | null; temp?: string | number | null };
type Size = "single" | "double" | "triple";
type Phase = "warm" | "cold";
const defaults: Record<string, Partial<Record<Size, Record<Phase, number>>>> = {
  ipa: { double: { warm: 8, cold: 8 }, triple: { warm: 12, cold: 12 } },
  "פייל": { double: { warm: 7, cold: 7 }, triple: { warm: 8, cold: 8 } },
  "חיטה": { single: { warm: 1, cold: 1 }, double: { warm: 2, cold: 2 }, triple: { warm: 4, cold: 4 } },
  "לאגר": { triple: { warm: 7, cold: 7 } },
  "הופי": { double: { warm: 7, cold: 5 }, triple: { warm: 7, cold: 6 } },
  "סטאוט": { single: { warm: 3, cold: 1 } },
};
const dateOf = (id: unknown) => String(id ?? "").match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
const addDays = (day: string, count: number) => {
  const date = new Date(day + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
};
const parseAmount = (note: string): number | null => {
  const normalized = note.replace(/,/g, ".");
  const numeric = normalized.match(/(\d+(?:\.\d+)?)\s*(?:דליים|דליי|דלי)/);
  if (numeric) return Number(numeric[1]);
  // Only unambiguous singular units are inferred, never invent quantities.
  return /(?:^|\s)דלי(?:\s|$)/.test(normalized) ? 1 : null;
};
function styleKey(input: unknown): string | null {
  const style = String(input ?? "").trim().toLowerCase();
  if (style.includes("ipa")) return "ipa";
  if (/פייל|pale/.test(style)) return "פייל";
  if (/חיטה|wheat/.test(style)) return "חיטה";
  if ((style.includes("הופי") && style.includes("לאגר")) || (style.includes("hoppy") && style.includes("lager"))) return "הופי";
  if (/לאגר|lager/.test(style)) return "לאגר";
  if (/סטאוט|stout/.test(style)) return "סטאוט";
  return null;
}

export function projectKnownYeastCompletions(
  tank: ForecastTank, readings: YeastCompletionReading[], today: string,
  specs: { yeastDropMinimums?: Record<string, number> },
): ConditionalForecast[] {
  const style = styleKey(tank.beerStyle), number = Number(tank.tankNumber);
  const size: Size | null = number >= 2 && number <= 4 ? "single" :
    number >= 5 && number <= 8 ? "double" : number >= 9 && number <= 19 ? "triple" : null;
  if (!style || !size || !["בתסיסה", "קר"].includes(tank.stage?.name ?? "")) return [];
  const sorted = [...readings].sort((a,b) => String(a.id ?? "").localeCompare(String(b.id ?? "")));
  const cooling = sorted.find((row) => /קירור/.test(String(row.notes ?? "")));
  const coolingDate = cooling ? dateOf(cooling.id) : null;
  const drops = sorted.flatMap((row) => {
    const note = String(row.notes ?? "");
    if (!/שמרים|שמרי/.test(note)) return [];
    const date = dateOf(row.id), quantity = parseAmount(note), temp = row.temp;
    if (!date || quantity === null || temp == null || temp === "" || !Number.isFinite(Number(temp))) return [];
    return [{ date, quantity, phase: Number(temp) <= 9 ? "cold" as const : "warm" as const }];
  });
  const results: ConditionalForecast[] = [];
  const add = (phase: Phase, firstDate: string, remaining: number, days: number) => {
    const due = addDays(firstDate, days);
    const on = due < today ? today : due;
    results.push({ id: `${tank.id}:yeast-completion-${phase}:${due}`,
      tankNumber: String(tank.tankNumber ?? tank.id), dueDate: on,
      title: `השלמת הורדת שמרים ${phase === "warm" ? "חמה" : "קרה"} — ${Number(remaining.toFixed(2))} דליים`,
      basis: `נדרשת השלמה לפי הוצאה מתועדת של ${phase === "warm" ? "שמרים חמים" : "שמרים קרים"}; בכפוף לאי־ביצוע עד מועד ההשלמה` });
  };
  if (tank.stage?.name === "בתסיסה" && !coolingDate) {
    const warm = drops.filter((drop) => drop.phase === "warm");
    const targetRaw = Number(specs.yeastDropMinimums?.[`${style}_${size}_warm`]);
    const target = Number.isFinite(targetRaw) && targetRaw >= 0 && specs.yeastDropMinimums?.[`${style}_${size}_warm`] != null ?
      targetRaw : defaults[style]?.[size]?.warm;
    if (warm.length && target != null) {
      const total = warm.reduce((sum, row) => sum + row.quantity, 0);
      if (total < target) add("warm", warm[warm.length - 1].date, target - total, 1);
    }
  }
  if (tank.stage?.name === "קר" && coolingDate) {
    const cold = drops.filter((drop) => drop.phase === "cold" && drop.date >= coolingDate);
    const targetRaw = Number(specs.yeastDropMinimums?.[`${style}_${size}_cold`]);
    const target = Number.isFinite(targetRaw) && targetRaw >= 0 && specs.yeastDropMinimums?.[`${style}_${size}_cold`] != null ?
      targetRaw : defaults[style]?.[size]?.cold;
    // Repeated cold draws are ongoing maintenance, not a missing first drop.\n    // Do not manufacture a new future action after the operator has already\n    // performed several post-cooling drops (tank 10 scenario).\n    if (cold.length === 1 && target != null) {
      const total = cold.reduce((sum, row) => sum + row.quantity, 0);
      if (total < target) add("cold", cold[cold.length - 1].date, target - total, 2);
    }
  }
  return results;
}
