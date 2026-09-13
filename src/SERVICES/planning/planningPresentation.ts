import {
  addDays,
  dateKey,
  num,
  parseDate,
  sameStyle,
  styleKey,
  tempoNow,
  weeklyDemand,
  type Product,
  type Settings,
  type Tank,
  type TankInput,
} from "./planningEngine";
import { shortDate, type DailyPoint } from "./dailyPlanner";
import type { PlanningAction } from "./workspace";

export const CORE_STYLES = [
  "IPA",
  "לאגר",
  "סטאוט",
  "פייל",
  "חיטה",
  "הופי לאגר",
];

export const displayStyle = (style: string) =>
  sameStyle(style, "פייל") ? "פייל" : style;

export const isCoreStyle = (style: string) =>
  CORE_STYLES.some((core) => sameStyle(core, style));

export const groupKey = (style: string) =>
  isCoreStyle(style) ? styleKey(style) : "other";

export const weekIsClosed = (week: string, today = dateKey(new Date())) =>
  today >= addDays(week, 5);

export const WEEK_DAYS = [
  "ראשון",
  "שני",
  "שלישי",
  "רביעי",
  "חמישי",
  "שישי",
  "שבת",
];

/**
 * Keep saved products intact, but normalize the lead time of each core style.
 * Special/seasonal products stay available in Firestore/history; they are not
 * part of the standard planning dashboard and can be selected manually as אחר.
 */
export function withSpecialTotals(settings: Settings): Settings {
  const products = settings.products.map((p) => {
    if (!isCoreStyle(p.style)) return p;
    const leads = settings.products
      .filter((x) => sameStyle(x.style, p.style))
      .map((x) => x.leadDays)
      .filter((n) => Number.isInteger(n) && n > 0);
    return {
      ...p,
      leadDays: leads.length
        ? Math.max(...leads)
        : p.style.includes("לאגר")
          ? 50
          : 21,
    };
  });
  return { ...settings, products };
}

export const isDataProduct = (p: Product) => isCoreStyle(p.style);

export function recommendationSettings(settings: Settings): Settings {
  return {
    ...settings,
    products: settings.products.map((p) =>
      isCoreStyle(p.style) ? p : { ...p, monthly: 0, tempo: null },
    ),
  };
}

export function styleGroups(settings: Settings) {
  return CORE_STYLES.map((style) => ({
    key: groupKey(style),
    style,
    products: settings.products.filter(
      (p) => isDataProduct(p) && groupKey(p.style) === groupKey(style),
    ),
  }));
}

export function coverageDays(product: Product, today: string): number | null {
  const stock = tempoNow(product, today),
    daily = weeklyDemand(product) / 7;
  return stock === null || !daily
    ? null
    : Math.max(0, Math.floor(stock / daily));
}

export function actionImpact(
  action: PlanningAction,
  settings: Settings,
  today: string,
  points: DailyPoint[],
): string {
  if (action.kind === "brew") {
    return `${Math.round(action.liters * 0.9).toLocaleString("he-IL")} ל׳ משוערים לאריזה מ־${shortDate(action.readyDate)}`;
  }
  const p = settings.products.find((p) => p.id === action.productId);
  if (!p) return "";
  const daily = weeklyDemand(p) / 7;
  const extra = daily > 0 ? Math.floor(action.quantity / daily) : null;
  if (action.kind === "packaging")
    return `מוסיף ${action.quantity} ${p.type === "crates" ? "ארגזים" : "חביות"} למלאי המוגמר${extra === null ? "" : ` · כ־${extra} ימי מכירה`}`;
  const current = coverageDays(p, today);
  const point = points.find(
    (x) => x.productId === p.id && x.date === action.date,
  );
  const after = point?.tempo == null || !daily ? null : Math.floor(point.tempo / daily);
  return [
    current === null ? "הכיסוי הנוכחי אינו ידוע" : `כיסוי היום: ${current} ימים`,
    extra === null ? "" : `המשלוח מוסיף כ־${extra} ימים`,
    after === null ? "" : `בסוף יום האיסוף: כ־${after} ימים`,
  ].filter(Boolean).join(" · ");
}

export function tankDiagnostics(
  sources: TankInput[],
  tanks: Tank[],
  today: string,
) {
  return sources
    .filter((t) => Number(t.tankNumber) !== 1)
    .map((source) => {
      const t = tanks.find((t) => t.id === source.id);
      let reason: string;
      if (Number(source.action) === 0)
        reason = "מחכה לבישול · פנוי לשיבוץ";
      else if (
        source.tankStatus === true ||
        ["stage-empty", "stage-clean", "stage-sanitized"].includes(
          source.stage?.className ?? "",
        )
      )
        reason = "ריק / בתהליך ניקיון";
      else if (!parseDate(source.brewDate)) reason = "תאריך הבישול חסר או לא תקין";
      else if (!source.beerStyle) reason = "חסר סגנון בירה";
      else if (!source.batchNumber) reason = "חסר מספר אצווה";
      else if (!num(source.beerVolume)) reason = "חסר נפח עבודה";
      else if (!t || t.liters <= 0) reason = "אין יתרה משוערת לאחר אריזות ופחת";
      else if (t.ready > today) reason = `הבשלה משוערת עד ${shortDate(t.ready)}`;
      else reason = "זמין לבדיקה ולשיבוץ אריזה";
      return {
        id: source.id,
        number: String(source.tankNumber ?? source.id),
        style: source.beerStyle ? displayStyle(source.beerStyle) : "—",
        liters: t?.liters ?? null,
        reason,
      };
    })
    .sort((a, b) => Number(a.number) - Number(b.number));
}

export function dayForWeek(week: string, day: number) {
  return addDays(week, day);
}
