import {
  addDays,
  litersPerUnit,
  num,
  sameStyle,
  weekStart,
  type Settings,
  type Tank,
  type WeekPlan,
} from "./planningEngine";
import { actualDate, openRuns } from "./dailyPlanner";
import type { Actual } from "./planningEngine";

export const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
export const nextBrewingWeek = (emptied: string) => addDays(weekStart(emptied), 8);
export const packagingLimit = (date: string, type: "crates" | "kegs") => weekday(date) === 0 ? (type === "crates" ? 168 : 100) : (type === "crates" ? 252 : Infinity);

export type TankSource = { id: string; tankNumber?: string | number | null; beerStyle?: string | null; beerVolume?: unknown; tankStatus?: unknown; action?: unknown; stage?: { className?: string; name?: string } };
export type Release = { tankId: string; date: string | null; emptyDate: string | null; remaining: number; workLiters: number; reason: string };

export function estimatedBrewVolume(tankNumber: unknown, beerStyle?: string | null): number {
  const tank = Number(tankNumber), style = String(beerStyle ?? "");
  if (!Number.isFinite(tank) || tank <= 0) return 0;
  if (tank <= 4) return 1100;
  const isPale = style.includes("פייל"), isHoppyLager = style.includes("הופי") && style.includes("לאגר"), isLager = style.includes("לאגר"), isWheat = style.includes("חיטה"), isIpa = /ipa/i.test(style);
  if (tank <= 8) { if (isIpa) return 1960; if (isPale) return 2200; if (isHoppyLager || isLager) return 2500; if (isWheat) return 2100; return 2200; }
  if (isIpa) return 3000; if (isPale) return 3200; if (isHoppyLager) return 3600; if (isLager) return 3700; if (isWheat) return 3400; return 3400;
}

function isReadyForBrew(source: TankSource) {
  return Number(source.action) === 0 || source.stage?.name === "מחכה לבישול" || source.stage?.className === "stage-waiting" || source.tankStatus === true || ["stage-empty", "stage-clean", "stage-sanitized"].includes(source.stage?.className ?? "");
}

export function tankReleases(sources: TankSource[], tanks: Tank[], plans: WeekPlan[], settings: Settings, actuals: Actual[], today: string): Release[] {
  const runs = openRuns(plans, settings.products, actuals).filter((r) => r.date && r.date >= today && r.remaining > 0);
  return sources.map((source) => {
    const workLiters = num(source.beerVolume) || estimatedBrewVolume(source.tankNumber, source.beerStyle);
    if (isReadyForBrew(source)) {
      const packedThisWeek = actuals.filter((a) => source.tankNumber != null && String(a.tankNumber) === String(source.tankNumber)).map(actualDate).filter((date): date is string => !!date && date >= weekStart(today) && date <= today).sort().at(-1);
      return { tankId: source.id, date: packedThisWeek ? nextBrewingWeek(packedThisWeek) : today, emptyDate: packedThisWeek ?? null, remaining: 0, workLiters, reason: packedThisWeek ? "המיכל נארז השבוע; זמין לבישול מהשבוע הבא לאחר ניקיון" : Number(source.action) === 0 || source.stage?.name === "מחכה לבישול" ? `המיכל מחכה לבישול וזמין לשיבוץ${num(source.beerVolume) ? "" : " · הנפח משוער לפי גודל המיכל"}` : "המיכל פנוי; יש לאמת ניקיון וחיטוי" };
    }
    const tank = tanks.find((t) => t.id === source.id);
    if (!tank) return { tankId: source.id, date: null, emptyDate: null, remaining: 0, workLiters, reason: "חסרים נתוני מיכל מאומתים" };
    let remaining = tank.liters, emptyDate: string | null = null;
    for (const r of runs.filter((r) => r.tankId === source.id).sort((a, b) => a.date!.localeCompare(b.date!))) {
      const p = settings.products.find((p) => p.id === r.productId);
      if (!p || !sameStyle(p.style, tank.style) || r.date! < tank.ready) continue;
      remaining -= r.remaining * litersPerUnit(p);
      if (remaining <= 0.01 || (r.emptyTank && remaining < 20)) { emptyDate = r.date!; break; }
    }
    return { tankId: source.id, date: emptyDate ? nextBrewingWeek(emptyDate) : null, emptyDate, remaining: Math.max(0, remaining), workLiters, reason: emptyDate ? "לאחר ריקון מתוכנן וניקיון חמישי" : "אין עדיין תוכנית לריקון המיכל" };
  });
}

export function validateProduction(plans: WeekPlan[], settings: Settings, tanks: Tank[], actuals: Actual[], today: string): string | null {
  const runs = openRuns(plans, settings.products, actuals).filter((r) => r.remaining > 0 && (!r.date || r.date >= today)).sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  const tankRuns = new Map<string, { date: string; type: "crates" | "kegs" }[]>(), used = new Map<string, number>();
  for (const r of runs) {
    if (!r.tankId || !r.date) return "יש לשייך מיכל מקור ויום לכל אריזה עתידית";
    const t = tanks.find((t) => t.id === r.tankId), p = settings.products.find((p) => p.id === r.productId);
    if (!t || !p || !sameStyle(t.style, p.style) || r.date < t.ready) return "מיכל האריזה אינו תואם לסגנון או טרם הבשיל";
    const history = tankRuns.get(t.id) ?? []; history.push({ date: r.date, type: p.type }); tankRuns.set(t.id, history);
    const dates = [...new Set(history.map((x) => x.date))], types = new Set(history.map((x) => x.type)), allowExceptions = plans.find((w) => w.id === r.week)?.allowExceptions;
    if (!allowExceptions && dates.length > 1 && types.size < 2) return `מיכל ${t.number}: פיצול לימים שונים מותר רק בין בקבוקים לחביות`;
    if (!allowExceptions && dates.length > 2) return `מיכל ${t.number}: ניתן לפצל לכל היותר לשני ימי אריזה`;
    used.set(t.id, (used.get(t.id) ?? 0) + r.remaining * litersPerUnit(p));
    if (used.get(t.id)! > t.liters + 0.01) return `מיכל ${t.number}: הכמות המתוכננת גדולה מהנפח הזמין`;
    if (r.emptyTank && t.liters - used.get(t.id)! >= 20) return `מיכל ${t.number}: לא ניתן לסמן סיום — נשארת כמות שניתנת לאריזה מהמיכל`;
  }
  return null;
}

export function validateBrewReleases(sources: TankSource[], tanks: Tank[], plans: WeekPlan[], settings: Settings, actuals: Actual[], today: string): string | null {
  const releases = tankReleases(sources, tanks, plans, settings, actuals, today);
  for (const b of plans.flatMap((w) => w.brews).filter((b) => b.date >= today)) {
    // A weekly brew decision intentionally has no tank yet. Release/capacity
    // validation starts only after the work manager assigns a physical tank.
    if (!b.tankId) continue;
    if (tanks.some((t) => t.id === b.tankId && t.brewed === b.date && sameStyle(t.style, b.style))) continue;
    const release = releases.find((r) => r.tankId === b.tankId);
    if (!release?.date || b.date < release.date) return `בישול ${b.style}: תוכנית הריקון עדיין לא משחררת את המיכל בשבוע הזה`;
    if (!release.workLiters) { const source = sources.find((s) => s.id === b.tankId); return `למיכל ${source?.tankNumber ?? b.tankId} חסר נפח עבודה ולא ניתן היה לחשב אומדן`; }
    if (b.liters > release.workLiters) { const source = sources.find((s) => s.id === b.tankId); return `מיכל ${source?.tankNumber ?? b.tankId}: תוכננו ${Math.round(b.liters)} ל׳, אבל נפח העבודה המחושב הוא ${Math.round(release.workLiters)} ל׳`; }
  }
  return null;
}
