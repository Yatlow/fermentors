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
  tankId?: string;
  emptyTank?: boolean;
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
  id: string;
  style: string;
  tankId: string;
  date: string;
  liters: number;
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
      // Existing TankCard treats currentData.crates/kegs as liters, not unit counts.
      // Use max of synchronized legacy totals and packaging log totals, never their sum.
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
      return [
        {
          id: t.id,
          number: String(t.tankNumber ?? t.id),
          style: t.beerStyle,
          batch: String(t.batchNumber),
          brewed,
          ready: addDays(brewed, lead),
          liters,
          cold: t.stage?.className === "stage-cold",
        },
      ];
    })
    .sort(
      (a, b) => a.brewed.localeCompare(b.brewed) || a.id.localeCompare(b.id),
    );
}
export function productPallets(p: Product, pallets: Pallet[]) {
  return pallets.filter(
    (x) =>
      x.itemType === p.type &&
      sameStyle(x.beerStyle, p.style) &&
      x.zone !== "shipped",
  );
}
export function inventory(p: Product, pallets: Pallet[]) {
  const all = productPallets(p, pallets);
  return {
    brewery: all
      .filter((x) => x.zone !== "loadingDock")
      .reduce((s, x) => s + num(x.quantity), 0),
    dock: all
      .filter((x) => x.zone === "loadingDock")
      .reduce((s, x) => s + num(x.quantity), 0),
  };
}
/** Physical inventory remains visible; expired/undated lots cannot cover a forecast. */
export function usableInventory(p: Product, pallets: Pallet[], today: string) {
  return inventory(
    p,
    pallets.filter(
      (x) =>
        !!parseDate(x.expiryDateStr) && parseDate(x.expiryDateStr)! >= today,
    ),
  );
}
export function actualQuantity(p: Product, week: string, actuals: Actual[]) {
  return actuals.reduce((sum, a) => {
    const day =
      parseDate(a.date) ??
      (num(a.timestamp) > 0 ? dateKey(new Date(a.timestamp!)) : null);
    if (
      !day ||
      weekStart(day) !== week ||
      !sameStyle(a.beerStyle ?? "", p.style) ||
      a.packagingType !== (p.type === "crates" ? "bottles" : "kegs")
    )
      return sum;
    // Existing logger stores crates. Explicit historical bottle-unit records are converted.
    return (
      sum +
      num(a.quantity) / (p.type === "crates" && a.unit === "בקבוקים" ? 24 : 1)
    );
  }, 0);
}
export function remaining(p: Product, w: WeekPlan, actuals: Actual[]) {
  return Math.max(
    0,
    w.packaging
      .filter((x) => x.productId === p.id)
      .reduce((s, x) => s + num(x.quantity), 0) -
      actualQuantity(p, w.id, actuals),
  );
}
export function shipmentAdvice(
  p: Product,
  pallets: Pallet[],
  tanks: Tank[],
  settings: Settings,
  today: string,
) {
  const tempo = tempoNow(p, today);
  const all = productPallets(p, pallets);
  const reserved = all
    .filter(
      (x) =>
        (x.zone === "loadingDock" || x.markedForShipment) &&
        !!parseDate(x.expiryDateStr) &&
        parseDate(x.expiryDateStr)! >= today,
    )
    .reduce((s, x) => s + num(x.quantity), 0);
  const need =
    tempo === null
      ? 0
      : Math.max(
          0,
          Math.ceil(weeklyDemand(p) * settings.targetWeeks - tempo - reserved),
        );
  const production = (x: Pallet) =>
    tanks.find(
      (t) =>
        t.batch === String(x.batchNumber) && sameStyle(t.style, x.beerStyle),
    )?.brewed ?? null;
  const eligible = all.filter(
    (x) =>
      x.zone !== "loadingDock" &&
      !x.markedForShipment &&
      num(x.quantity) > 0 &&
      !!parseDate(x.expiryDateStr) &&
      parseDate(x.expiryDateStr)! >= today,
  );
  const fifoKnown = eligible.every((x) => !!production(x));
  eligible.sort(
    (a, b) =>
      (fifoKnown
        ? production(a)!.localeCompare(production(b)!)
        : parseDate(a.expiryDateStr)!.localeCompare(
            parseDate(b.expiryDateStr)!,
          )) || a.id.localeCompare(b.id),
  );
  let selected = 0;
  const picks = eligible.filter((x) => {
    if (selected >= need) return false;
    selected += num(x.quantity);
    return true;
  });
  return {
    need,
    picks,
    selected,
    reserved,
    fifoKnown,
    missing: Math.max(0, need - selected),
    unknownExpiry: all.filter((x) => !parseDate(x.expiryDateStr)).length,
  };
}
export function allocate(
  tanks: Tank[],
  available: Map<string, number>,
  p: Product,
  units: number,
  byDate: string,
): Allocation[] {
  let need = units * litersPerUnit(p);
  const result: Allocation[] = [];
  for (const t of tanks) {
    if (!sameStyle(t.style, p.style) || t.ready > byDate || need <= 0.001)
      continue;
    const take = Math.min(need, available.get(t.id) ?? 0);
    if (take > 0) {
      result.push({
        tankId: t.id,
        number: t.number,
        liters: take,
        ready: t.ready,
        cold: t.cold,
      });
      available.set(t.id, (available.get(t.id) ?? 0) - take);
      need -= take;
    }
  }
  return result;
}
/** Plans reserve tank volume first; suggestions share the remaining pool across all SKUs/weeks. */
export function buildSchedule(
  settings: Settings,
  pallets: Pallet[],
  tanks: Tank[],
  plans: WeekPlan[],
  actuals: Actual[],
  today: string,
) {
  const products = settings.products;
  const start = weekStart(today);
  const available = new Map(tanks.map((t) => [t.id, t.liters]));
  // Protect saved future commitments from being consumed by earlier suggestions.
  const booked = new Map<string, PackagingSuggestion[]>();
  for (let index = 0; index < 12; index++) {
    const id = addDays(start, index * 7),
      plan = plans.find((w) => w.id === id) ?? {
        ...emptyWeek(id),
        maxRuns: settings.preferredRuns,
      };
    booked.set(
      id,
      products
        .filter((p) => remaining(p, plan, actuals) > 0)
        .map((p) => {
          const quantity = remaining(p, plan, actuals),
            allocations = allocate(
              tanks,
              available,
              p,
              quantity,
              addDays(id, 6),
            );
          return {
            productId: p.id,
            quantity,
            allocations,
            gap: Math.max(
              0,
              quantity * litersPerUnit(p) -
                allocations.reduce((s, a) => s + a.liters, 0),
            ),
          };
        }),
    );
  }
  const physicallyRemaining = new Map(tanks.map((t) => [t.id, t.liters]));
  const stocks = new Map(
    products.map((p) => [
      p.id,
      usableInventory(p, pallets, today).brewery +
        usableInventory(p, pallets, today).dock +
        (tempoNow(p, today) ?? 0),
    ]),
  );
  return Array.from({ length: 12 }, (_, index) => {
    const id = addDays(start, index * 7),
      end = addDays(id, 6),
      plan = plans.find((w) => w.id === id) ?? {
        ...emptyWeek(id),
        maxRuns: settings.preferredRuns,
      };
    const days = index === 0 ? daysBetween(today, addDays(id, 7)) : 7;
    const suggestions: PackagingSuggestion[] = [];
    const commitments = booked.get(id) ?? [];
    for (const c of commitments) {
      const p = products.find((p) => p.id === c.productId)!;
      stocks.set(
        c.productId,
        (stocks.get(c.productId) ?? 0) +
          c.allocations.reduce((sum, a) => sum + a.liters, 0) /
            litersPerUnit(p),
      );
    }
    // Already executed runs consume this week's capacity too; quantities never become zero-day runs.
    const used = products.reduce(
      (s, p) =>
        s +
        Math.max(
          Math.ceil(
            actualQuantity(p, id, actuals) /
              (p.type === "crates" ? 252 : Infinity),
          ) || (actualQuantity(p, id, actuals) > 0 ? 1 : 0),
          p.type === "crates"
            ? Math.ceil(
                (remaining(p, plan, actuals) + actualQuantity(p, id, actuals)) /
                  252,
              )
            : remaining(p, plan, actuals) + actualQuantity(p, id, actuals) > 0
              ? 1
              : 0,
        ),
      0,
    );
    let slots = Math.max(
      0,
      Math.min(plan.maxRuns, settings.preferredRuns) - used,
    );
    const ranked = [...products]
      .filter((p) => weeklyDemand(p) > 0 && tempoNow(p, today) !== null)
      .sort(
        (a, b) =>
          (stocks.get(a.id) ?? 0) / weeklyDemand(a) -
          (stocks.get(b.id) ?? 0) / weeklyDemand(b),
      );
    for (const p of ranked) {
      if (
        slots <= 0 ||
        commitments.some((c) => c.productId === p.id) ||
        actualQuantity(p, id, actuals) > 0
      )
        continue;
      const demand = weeklyDemand(p),
        deficit =
          demand * (settings.targetWeeks + days / 7) - (stocks.get(p.id) ?? 0);
      if (deficit <= 0) continue;
      const supply =
        tanks
          .filter((t) => sameStyle(t.style, p.style) && t.ready <= end)
          .reduce((s, t) => s + (available.get(t.id) ?? 0), 0) /
        litersPerUnit(p);
      const step = p.type === "crates" ? 84 : 1;
      const quantity = Math.min(
        p.type === "crates" ? 252 : Infinity,
        Math.ceil(deficit / step) * step,
        Math.floor((supply + 1e-8) / step) * step,
      );
      if (quantity <= 0) continue;
      const allocations = allocate(tanks, available, p, quantity, end);
      suggestions.push({ productId: p.id, quantity, allocations, gap: 0 });
      stocks.set(p.id, (stocks.get(p.id) ?? 0) + quantity);
      slots--;
    }
    const balances = products.map((p) => {
      const endStock = (stocks.get(p.id) ?? 0) - (weeklyDemand(p) * days) / 7;
      stocks.set(p.id, endStock);
      return {
        productId: p.id,
        stock: endStock,
        known: tempoNow(p, today) !== null,
      };
    });
    for (const c of [...commitments, ...suggestions])
      for (const a of c.allocations)
        physicallyRemaining.set(
          a.tankId,
          (physicallyRemaining.get(a.tankId) ?? 0) - a.liters,
        );
    return {
      id,
      plan,
      commitments,
      suggestions,
      balances,
      used,
      available: new Map(physicallyRemaining),
    };
  });
}
export function brewAdvice(
  settings: Settings,
  pallets: Pallet[],
  tanks: Tank[],
  plans: WeekPlan[],
  today: string,
) {
  const styles = [...new Set(settings.products.map((p) => styleKey(p.style)))];
  return styles
    .flatMap((key) => {
      const products = settings.products.filter(
        (p) => styleKey(p.style) === key,
      );
      if (products.some((p) => p.monthly > 0 && tempoNow(p, today) === null))
        return [];
      const demand = products.reduce(
        (s, p) => s + weeklyDemand(p) * litersPerUnit(p),
        0,
      );
      if (!demand) return [];
      const lead = Math.max(...products.map((p) => p.leadDays));
      const stock = products.reduce((s, p) => {
        const inv = usableInventory(p, pallets, today);
        return (
          s +
          (inv.brewery + inv.dock + (tempoNow(p, today) ?? 0)) *
            litersPerUnit(p)
        );
      }, 0);
      const wip = tanks.filter(
        (t) => styleKey(t.style) === key && t.ready <= addDays(today, lead),
      );
      const planned = plans
        .flatMap((w) => w.brews)
        .filter(
          (b) =>
            styleKey(b.style) === key &&
            b.date >= today &&
            !tanks.some(
              (t) =>
                t.id === b.tankId &&
                t.brewed === b.date &&
                sameStyle(t.style, b.style),
            ),
        );
      const plannedByNeed = planned.filter(
        (b) =>
          addDays(b.date, lead) <=
          addDays(
            today,
            lead + Math.ceil((settings.totalTargetWeeks ?? 8.5) * 7),
          ),
      );
      const supply =
        stock +
        wip.reduce((s, t) => s + t.liters, 0) +
        plannedByNeed.reduce((s, b) => s + b.liters * 0.9, 0);
      const deficit = Math.max(
        0,
        Math.ceil(
          demand * (lead / 7 + (settings.totalTargetWeeks ?? 8.5)) - supply,
        ),
      );
      const brewBy = addDays(
        today,
        Math.floor(
          ((stock + wip.reduce((s, t) => s + t.liters, 0)) / demand) * 7,
        ) - lead,
      );
      return [
        {
          style: products[0].style,
          liters: deficit,
          brewBy,
          lead,
          weeklyLiters: demand,
        },
      ];
    })
    .filter((x) => x.liters > 0)
    .sort((a, b) => a.brewBy.localeCompare(b.brewBy));
}
