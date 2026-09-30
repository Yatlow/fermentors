/** Pure planning calculations. No writes to operational collections. */
import { getCatalogEntry } from "../cooler/PalletCatalog";
import type { Pallet } from "../cooler/Pallettypes ";

export const DAY = 86400000;
export const WEEKS_PER_MONTH = 4.2; // Matches the user's existing planning sheet.
export type Product = {
  id: string;
  style: string;
  type: "crates" | "kegs";
  sku: string;
  monthly: number;
  tempo: number | null;
  tempoDate: string;
  leadDays: number;
};
export type Settings = {
  products: Product[];
  targetWeeks: number;
  totalTargetWeeks?: number;
  preferredRuns: number;
  lossPercent: number;
  maxWeeklyDeliveries?: 1 | 2;
  deliveryTransitDays?: number;
  preferredDeliveryDay?: 0 | 1;
  revision: number;
};
export type Plan = {
  id?: string;
  productId: string;
  quantity: number;
  date?: string;
  source?: "manual" | "recommendation";
  /** Stable logical relation to the planned brew. Prefer this over tank/batch snapshots. */
  brewId?: string;
  tankId?: string;
  emptyTank?: boolean;
  earlyPackagingOverride?: boolean;
  tankNumber?: string;
  batchNumber?: string;
};
export type DeliveryPlan = {
  id: string;
  productId: string;
  quantity: number;
  dispatchDate: string;
  arrivalDate: string;
  truckId?: string;
  pallets?: Pallet[];
};
export type BrewPlan = {
  /** Stable planning identity. It must survive forecast batch renumbering and tank moves. */
  id: string;
  style: string;
  tankId: string;
  date: string;
  liters: number;
  batchNumber?: string;
  tankAssignmentStatus?: "tentative" | "confirmed";
};
export type WeekPlan = {
  id: string;
  revision: number;
  packaging: Plan[];
  brews: BrewPlan[];
  note: string;
  maxRuns: number;
  deliveries?: DeliveryPlan[];
  changeReason?: string;
  deliveryDates?: string[];
  dismissedRecommendations?: string[];
  allowExceptions?: boolean;
};
export type Actual = {
  id: string;
  timestamp?: number;
  date?: string;
  beerStyle?: string;
  packagingType?: string;
  quantity?: number;
  unit?: string;
  batchNumber?: string | number;
  tankNumber?: string | number;
};
export type TankInput = {
  id: string;
  tankNumber?: unknown;
  beerStyle?: string | null;
  brewDate?: string | null;
  beerVolume?: unknown;
  tankStatus?: unknown;
  action?: unknown;
  batchNumber?: unknown;
  currentData?: {
    volume?: unknown;
    crates?: unknown;
    kegs?: unknown;
    totalLiters?: unknown;
  } | null;
  stage?: { className: string };
};
export type Tank = {
  id: string;
  number: string;
  style: string;
  batch: string;
  brewed: string;
  ready: string;
  liters: number;
  cold: boolean;
};
export type Allocation = {
  tankId: string;
  number: string;
  liters: number;
  ready: string;
  cold: boolean;
};
export type PackagingSuggestion = {
  productId: string;
  quantity: number;
  allocations: Allocation[];
  gap: number;
};
export type Holiday = { date: string; title: string; closed?: boolean };
export const num = (v: unknown) =>
  Number.isFinite(Number(typeof v === "string" ? v.replace(/[,\s]/g, "") : v))
    ? Math.max(0, Number(typeof v === "string" ? v.replace(/[,\s]/g, "") : v))
    : 0;
export function dateKey(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}
export function parseDate(s?: string | null): string | null {
  if (typeof s !== "string" || !s) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s.trim());
  const iso = m
    ? `${m[3].length === 2 ? "20" + m[3] : m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`
    : s.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(`${iso}T12:00:00Z`);
  return Number.isFinite(+d) && d.toISOString().slice(0, 10) === iso
    ? iso
    : null;
}
export const addDays = (d: string, days: number) =>
  new Date(Date.parse(`${d}T12:00:00Z`) + days * DAY)
    .toISOString()
    .slice(0, 10);
export const daysBetween = (a: string, b: string) =>
  Math.round(
    (Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY,
  );
// Sunday–Saturday, using the ISO number of the Monday in that operational week.
export function weekStart(d: string): string {
  return addDays(d, -new Date(`${d}T12:00:00Z`).getUTCDay());
}
export function weekNumber(start: string): number {
  const d = new Date(`${addDays(start, 1)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  return Math.ceil(((+d - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY + 1) / 7);
}
export function styleKey(style: string): string {
  const sku =
    getCatalogEntry(style, "crates")?.sku ??
    getCatalogEntry(style, "kegs")?.sku;
  return sku ?? style.trim().toLowerCase();
}
export const sameStyle = (a: string, b: string) => styleKey(a) === styleKey(b);
export const litersPerUnit = (p: Product) =>
  p.type === "crates" ? 24 * 0.33 : 20;
export const weeklyDemand = (p: Product) => num(p.monthly) / WEEKS_PER_MONTH;
export const coverage = (stock: number, demand: number) =>
  demand > 0 ? stock / demand : null;
export const emptyWeek = (id: string): WeekPlan => ({
  id,
  revision: 0,
  packaging: [],
  brews: [],
  note: "",
  maxRuns: 4,
});
export function defaultSettings(): Settings {
  const styles = [
    "IPA",
    "לאגר",
    "סטאוט",
    "פייל אייל",
    "חיטה",
    "הופי לאגר",
    "מהדורת חורף",
    "סאוור",
    "סשן IPA",
    "דאבל IPA",
    "אגסים",
  ];
  return {
    revision: 0,
    targetWeeks: 5,
    totalTargetWeeks: 8.5,
    preferredRuns: 4,
    lossPercent: 10,
    products: styles.flatMap((style) =>
      (["crates", "kegs"] as const).flatMap((type) => {
        const entry = getCatalogEntry(style, type);
        return entry
          ? [
              {
                id: entry.sku,
                sku: entry.sku,
                style,
                type,
                monthly: 0,
                tempo: null,
                tempoDate: "",
                leadDays: style.includes("לאגר") ? 50 : 21,
              },
            ]
          : [];
      }),
    ),
  };
}
export function tempoNow(p: Product, today: string): number | null {
  const date = parseDate(p.tempoDate);
  if (p.tempo === null || !date || date > today) return null;
  return Math.max(
    0,
    num(p.tempo) - (daysBetween(date, today) * weeklyDemand(p)) / 7,
  );
}
export function tanksFrom(
  brews: TankInput[],
  settings: Settings,
  actuals: Actual[] = [],
): Tank[] {
  return brews
    .flatMap((t) => {
      const brewed = parseDate(t.brewDate);
      const empty =
        t.tankStatus === true ||
        ["stage-empty", "stage-clean", "stage-sanitized"].includes(
          t.stage?.className ?? "",
        );
      if (empty || !brewed || !t.beerStyle || !t.batchNumber) return [];
      const leads = settings.products
        .filter((p) => sameStyle(p.style, t.beerStyle!))
        .map((p) => p.leadDays);
      const lead = leads.length
        ? Math.max(...leads)
        : t.beerStyle.includes("לאגר")
          ? 50
          : 21;
      const logged = actuals
        .filter(
          (a) =>
            String(a.batchNumber) === String(t.batchNumber) &&
            sameStyle(a.beerStyle ?? "", t.beerStyle!),
        )
        .reduce(
          (sum, a) =>
            sum +
            num(a.quantity) *
              (a.packagingType === "kegs"
                ? 20
                : a.unit === "בקבוקים"
                  ? 0.33
                  : 7.92),
          0,
        );
      const packed = Math.max(
        logged,
        num(t.currentData?.totalLiters),
        num(t.currentData?.crates) + num(t.currentData?.kegs),
      );
      const liters = Math.max(0, num(t.beerVolume) * 0.9 - packed);
      return [{ id: t.id, number: String(t.tankNumber ?? t.id), style: t.beerStyle, batch: String(t.batchNumber), brewed, ready: addDays(brewed, lead), liters, cold: t.stage?.className === "stage-cold" }];
    })
    .sort((a, b) => a.brewed.localeCompare(b.brewed) || a.id.localeCompare(b.id));
}
export function productPallets(p: Product, pallets: Pallet[]) { return pallets.filter((x) => x.itemType === p.type && sameStyle(x.beerStyle, p.style) && x.zone !== "shipped"); }
export function inventory(p: Product, pallets: Pallet[]) { const all = productPallets(p, pallets); return { brewery: all.filter((x) => x.zone !== "loadingDock").reduce((s, x) => s + num(x.quantity), 0), dock: all.filter((x) => x.zone === "loadingDock").reduce((s, x) => s + num(x.quantity), 0) }; }
export function usableInventory(p: Product, pallets: Pallet[], today: string) { return inventory(p, pallets.filter((x) => !!parseDate(x.expiryDateStr) && parseDate(x.expiryDateStr)! >= today)); }
export function actualQuantity(p: Product, week: string, actuals: Actual[]) { return actuals.reduce((sum, a) => { const day = parseDate(a.date) ?? (num(a.timestamp) > 0 ? dateKey(new Date(a.timestamp!)) : null); if (!day || weekStart(day) !== week || !sameStyle(a.beerStyle ?? "", p.style) || a.packagingType !== (p.type === "crates" ? "bottles" : "kegs")) return sum; return sum + num(a.quantity) / (p.type === "crates" && a.unit === "בקבוקים" ? 24 : 1); }, 0); }
export function remaining(p: Product, w: WeekPlan, actuals: Actual[]) { return Math.max(0, w.packaging.filter((x) => x.productId === p.id).reduce((s, x) => s + num(x.quantity), 0) - actualQuantity(p, w.id, actuals)); }

// The rest of this module intentionally remains pure. Keep helpers below this point
// source-compatible with existing callers while the planning lifecycle projection
// owns identity/linkage semantics.
export function shipmentAdvice(p: Product, pallets: Pallet[], tanks: Tank[], settings: Settings, today: string) {
  const tempo = tempoNow(p, today); const all = productPallets(p, pallets); const reserved = all.filter((x) => (x.zone === "loadingDock" || x.markedForShipment) && !!parseDate(x.expiryDateStr) && parseDate(x.expiryDateStr)! >= today).reduce((s, x) => s + num(x.quantity), 0); const need = tempo === null ? 0 : Math.max(0, Math.ceil(weeklyDemand(p) * settings.targetWeeks - tempo - reserved)); const production = (x: Pallet) => tanks.find((t) => t.batch === String(x.batchNumber) && sameStyle(t.style, x.beerStyle))?.brewed ?? null; const eligible = all.filter((x) => x.zone !== "loadingDock" && !x.markedForShipment && num(x.quantity) > 0 && !!parseDate(x.expiryDateStr) && parseDate(x.expiryDateStr)! >= today); const fifoKnown = eligible.every((x) => !!production(x)); eligible.sort((a, b) => (fifoKnown ? production(a)!.localeCompare(production(b)!) : parseDate(a.expiryDateStr)!.localeCompare(parseDate(b.expiryDateStr)!)) || a.id.localeCompare(b.id)); let selected = 0; const picks = eligible.filter((x) => { if (selected >= need) return false; selected += num(x.quantity); return true; }); return { need, picks, selected, reserved, fifoKnown, missing: Math.max(0, need - selected), unknownExpiry: all.filter((x) => !parseDate(x.expiryDateStr)).length };
}
export function allocate(tanks: Tank[], available: Map<string, number>, p: Product, units: number, byDate: string): Allocation[] { let need = units * litersPerUnit(p); const result: Allocation[] = []; for (const t of tanks) { if (!sameStyle(t.style, p.style) || t.ready > byDate || need <= 0) continue; const liters = Math.min(available.get(t.id) ?? 0, need); if (liters <= 0) continue; result.push({ tankId: t.id, number: t.number, liters, ready: t.ready, cold: t.cold }); available.set(t.id, (available.get(t.id) ?? 0) - liters); need -= liters; } return result; }
export function packagingAdvice(p: Product, w: WeekPlan, tanks: Tank[], actuals: Actual[]): PackagingSuggestion { const target = remaining(p, w, actuals); const available = new Map(tanks.map((t) => [t.id, t.liters])); const allocations = allocate(tanks, available, p, target, addDays(w.id, 6)); const supplied = allocations.reduce((s, x) => s + x.liters, 0) / litersPerUnit(p); return { productId: p.id, quantity: Math.min(target, supplied), allocations, gap: Math.max(0, target - supplied) }; }
