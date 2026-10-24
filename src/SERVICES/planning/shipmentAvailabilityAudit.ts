import type { Pallet } from "../cooler/Pallettypes ";
import { calcTruckSlots, MAX_TRUCK_SLOTS } from "../cooler/truckCapacity";
import { addDays, productPallets, parseDate, sameStyle, weekStart, type Actual, type Product, type Settings, type WeekPlan } from "./planningEngine";
import { openRuns, type ShipmentEvent } from "./dailyPlanner";
import { addForecastPackaging, dispatchForecastPallets, reservedPhysicalPalletIds, type ForecastPalletLot } from "./shipmentPalletLedger";
import { forecastablePlansAfterActualShipments } from "./shipmentActuals";
import { truckPlanningGroupKey } from "./truckPlanner";

export type PlanningAvailabilityIssue = {
  week: string;
  date: string;
  productId: string;
  /** Missing pallet positions, not missing actual units. */
  missing: number;
  /** Partial pallets can cover planned pallet positions without fulfilling the quantity. */
  missingUnits?: number;
  severity?: "blocking" | "partial" | "advisory";
  message: string;
};

const size = (p: Product) => p.type === "crates" ? 84 : 20;



/**
 * Audit planned dispatches in date order. Two ledgers must be kept separately:
 * pallet positions (partial pallet occupies a whole position) and ACTUAL units.
 * Physical pallets expire at the dispatch date, not at today's date.
 * Future packaging has unknown expiry and is eligible only after its planned
 * packaging date. Reports already completed are removed by openRuns.
 */
export function auditShipmentAvailability(
  settings: Settings,
  pallets: Pallet[],
  plans: WeekPlan[],
  actuals: Actual[],
  today: string,
  actualShipments: ShipmentEvent[] = [],
): PlanningAvailabilityIssue[] {
  const open = openRuns(plans, settings.products, actuals);
  const pending = forecastablePlansAfterActualShipments(plans, actualShipments, settings.products, today);
  const issues: PlanningAvailabilityIssue[] = [];
  // Physical slot footprint is aggregated by real truck, across ALL SKUs.
  // A nominal 12-pallet manifest can require 24 floor positions when its
  // actual stock consists of 24 half-height, non-stackable physical pallets.
  const physicallySelectedTrucks = new Map<string, Pallet[]>();
  const approvedOversizeTrucks = new Set<string>();
  const horizon = addDays(weekStart(today), 91);

  // A planner may explicitly pin physical pallets to a future truck. The FEFO
  // quantity ledger cannot silently replace that saved pallet with a different
  // SKU-equivalent pallet: the chosen one might expire, be removed or shrink
  // before dispatch. Such a manifest is not physically executable unchanged.
  const liveById = new Map(pallets.map((pallet) => [pallet.id, pallet]));
  for (const week of pending) {
    for (const delivery of week.deliveries ?? []) {
      if (delivery.dispatchDate < today || delivery.dispatchDate > horizon) continue;
      const product = settings.products.find((p) => p.id === delivery.productId);
      for (const assigned of delivery.pallets ?? []) {
        // Virtual future production is assessed by the dated packaging ledger,
        // not by looking for a nonexistent physical pallet today.
        if (assigned.id.startsWith("planning:")) continue;
        const live = liveById.get(assigned.id);
        const valid = !!live && !!product &&
          live.itemType === product.type &&
          sameStyle(live.beerStyle, product.style) &&
          sameStyle(live.beerStyle, assigned.beerStyle) &&
          live.itemType === assigned.itemType &&
          Number(live.quantity) === Number(assigned.quantity) &&
          !!parseDate(live.expiryDateStr) &&
          parseDate(live.expiryDateStr)! >= delivery.dispatchDate &&
          (!live.autoReservationTruckId ||
            live.autoReservationTruckId ===
              String(delivery.truckId || `date:${delivery.dispatchDate}`));
        if (!valid) {
          issues.push({
            week: week.id, date: delivery.dispatchDate,
            productId: `pallet:${assigned.id}`, missing: 1,
            severity: "blocking",
            message: `משלוח ${delivery.dispatchDate}: המשטח המשויך ${assigned.palletNumber ?? assigned.id} אינו קיים בכמות, בסגנון, בתוקף או בשיוך הנדרשים. אין להחליפו אוטומטית במשטח אחר ללא אישור.`,
          });
        }
      }
    }
  }

  for (const product of settings.products) {
    const reservedIds = reservedPhysicalPalletIds(pending.flatMap((week) =>
      (week.deliveries ?? []).filter((delivery) => delivery.productId === product.id)));
    const unitPerPallet = size(product);
    const lots: ForecastPalletLot[] = productPallets(product, pallets).flatMap((pallet) => {
      const expiry = parseDate(pallet.expiryDateStr);
      const physical = Math.max(0, Number(pallet.quantity) || 0);
      if (!expiry || expiry < today || physical <= 0) return [];
      return [{ id: pallet.id, expiry, quantity: physical }];
    });
    const events: Array<{
      date: string; kind: "pack" | "ship"; qty: number; week: string;
      truckId?: string; pallets?: Pallet[]; oversizeApproved?: boolean;
    }> = [];
    for (const run of open) {
      if (run.productId !== product.id || run.remaining <= 0 ||
          !run.date || run.date < today || run.date > horizon) continue;
      events.push({ date: run.date, kind: "pack", qty: run.remaining, week: run.week });
    }
    for (const week of pending) {
      for (const delivery of week.deliveries ?? []) {
        if (delivery.productId !== product.id || delivery.quantity <= 0 ||
            delivery.dispatchDate < today || delivery.dispatchDate > horizon) continue;
        events.push({ date: delivery.dispatchDate, kind: "ship", qty: delivery.quantity,
          week: week.id, truckId: String(delivery.truckId || `date:${delivery.dispatchDate}`),
          pallets: delivery.pallets,
          oversizeApproved: (week.oversizeTruckApprovals ?? []).includes(truckPlanningGroupKey(delivery)) });
      }
    }
    events.sort((a, b) =>
      a.date.localeCompare(b.date) ||
      (a.kind === b.kind ? 0 : a.kind === "pack" ? -1 : 1));

    for (const event of events) {
      // A pallet is not ship-ready after its own expiry date. This also
      // prevents it being used for a later shipment simply because it was
      // valid on the day the planner opened the dashboard.
      for (let i = lots.length - 1; i >= 0; i--) {
        if (lots[i].expiry < event.date) lots.splice(i, 1);
      }
      if (event.kind === "pack") {
        // Unproduced stock is a forecast only, but its loading positions still
        // behave like physical indivisible pallets in the simulation.
        addForecastPackaging(lots, event.qty, unitPerPallet,
          `future:${event.week}:${event.date}:${product.id}`);
        continue;
      }
      const { missingSlots: missing, missingUnits, selectedLots, missingPinnedIds } =
        dispatchForecastPallets(lots, event.qty, unitPerPallet, event.date,
          event.pallets, reservedIds);
      const truckKey = `${event.week}:${event.date}:${event.truckId ?? `date:${event.date}`}`;
      if (event.oversizeApproved) approvedOversizeTrucks.add(truckKey);
      const picked = physicallySelectedTrucks.get(truckKey) ?? [];
      picked.push(...selectedLots.map((lot) => {
        // Keep the real physical pallet record for height and future capacity
        // rules. Provisional packaging receives explicit synthetic metadata.
        const original = liveById.get(lot.id);
        return original
          ? { ...original, quantity: lot.quantity }
          : {
              id: lot.id, itemType: product.type, beerStyle: product.style,
              quantity: lot.quantity, zone: "pending" as const, heightUnits: 1,
            };
      }));
      physicallySelectedTrucks.set(truckKey, picked);
      for (const id of missingPinnedIds) {
        if (issues.some((issue) => issue.productId === `pallet:${id}` &&
            issue.date === event.date && issue.week === event.week)) continue;
        issues.push({
          week: event.week, date: event.date, productId: `pallet:${id}`,
          missing: 1, missingUnits, severity: "blocking",
          message: `משלוח ${event.date}: המשטח ${id} כבר נצרך במשלוח קודם, אינו זמין בתוקף/בכמות המדויקת, או שאינו משויך עוד למלאי. לא בוצעה החלפה אוטומטית.`,
        });
      }
      if (missing > 0) {
        issues.push({
          week: event.week, date: event.date, productId: product.id,
          missing, missingUnits, severity: "blocking",
          message: `משלוח ${event.date}: חסרים ${missing} מקומות משטח זמינים של ${product.style} (${product.type === "crates" ? "ארגזים" : "חביות"}); יש לבדוק גם תוקף מלאי`,
        });
      } else if (missingUnits > 0.001) {
        issues.push({
          week: event.week, date: event.date, productId: product.id,
          missing: 0, missingUnits, severity: "partial",
          message: `משלוח ${event.date}: חסרות ${Math.ceil(missingUnits)} יחידות ${product.style} בפועל. משטח חלקי מכסה מקום במשאית, לא את כמות ההזמנה`,
        });
      }
    }
  }
  // The saved manifest's nominal capacity check is necessary but not enough:
  // a partial pallet is an indivisible physical load. Validate the ACTUAL
  // picked load using the same two-high stack-aware rule as dispatch itself.
  for (const [truckKey, selected] of physicallySelectedTrucks) {
    const [week, date, ...truckParts] = truckKey.split(":");
    const truckId = truckParts.join(":");
    try {
      const slots = calcTruckSlots(selected);
      if (slots > MAX_TRUCK_SLOTS) {
        issues.push({
          week, date, productId: `truck:${truckId}`,
          missing: slots - MAX_TRUCK_SLOTS, missingUnits: 0,
          severity: approvedOversizeTrucks.has(truckKey) ? "advisory" : "blocking",
          message: approvedOversizeTrucks.has(truckKey)
            ? `משאית ${truckId} ב־${date}: אושרה חריגה תכנונית של ${slots - MAX_TRUCK_SLOTS} מקומות (${slots} במקום ${MAX_TRUCK_SLOTS}). יש לתאם רכב מתאים או לפצל את המשלוח; שילוח פיזי במשאית רגילה עדיין מוגבל ל־${MAX_TRUCK_SLOTS}.`
            : `משאית ${truckId} ב־${date}: המשטחים הפיזיים דורשים ${slots} מקומות העמסה (מותר ${MAX_TRUCK_SLOTS}). ניתן לבקש אישור חריג תכנוני למשאית זו.`,
        });
      }
    } catch {
      issues.push({
        week, date, productId: `truck:${truckId}`,
        missing: 1, missingUnits: 0, severity: "blocking",
        message: `משאית ${truckId} ב־${date}: משטח גבוה מהמותר להעמסה.`,
      });
    }
  }
  return issues.sort((a, b) => a.date.localeCompare(b.date) ||
    a.productId.localeCompare(b.productId));
}

/** Per-SKU/date difference between a prior plan and its edited successor. */
export type PlanningShortageIncrease = {
  issue: PlanningAvailabilityIssue;
  addedSlots: number;
  addedUnits: number;
  totalSlots: number;
  totalUnits: number;
};

/**
 * Full change set, not just the first issue. Two trucks on the same date
 * with the same SKU must sum their deficits before comparing revisions.
 * Planner-approved truck overages and advisory-only partial stock are not
 * turned into hard blockers by this helper.
 */
export function newlyWorsenedShipmentShortages(
  before: PlanningAvailabilityIssue[],
  after: PlanningAvailabilityIssue[],
): PlanningShortageIncrease[] {
  const key = (issue: PlanningAvailabilityIssue) =>
    `${issue.week}:${issue.date}:${issue.productId}`;
  const totals = (issues: PlanningAvailabilityIssue[]) => {
    const byKey = new Map<string, { slots: number; units: number }>();
    for (const issue of issues.filter((entry) => !entry.severity || entry.severity === "blocking")) {
      const k = key(issue);
      const previous = byKey.get(k) ?? { slots: 0, units: 0 };
      byKey.set(k, {
        slots: previous.slots + Math.max(0, issue.missing),
        units: previous.units + Math.max(0, issue.missingUnits ?? 0),
      });
    }
    return byKey;
  };
  const previous = totals(before);
  const next = totals(after);
  const displayed = new Set<string>();
  return after.flatMap((issue) => {
    if (issue.severity === "partial" || issue.severity === "advisory") return [];
    const k = key(issue);
    if (displayed.has(k)) return [];
    displayed.add(k);
    const old = previous.get(k) ?? { slots: 0, units: 0 };
    const current = next.get(k) ?? { slots: 0, units: 0 };
    const addedSlots = Math.max(0, current.slots - old.slots);
    const addedUnits = Math.max(0, current.units - old.units);
    return addedSlots || addedUnits
      ? [{ issue, addedSlots, addedUnits, totalSlots: current.slots, totalUnits: current.units }]
      : [];
  });
}

/**
 * Only downstream SKU quantity/slot shortfalls may be saved after explicit
 * acknowledgement. Bad pallet identity, unsafe unapproved truck loading, and
 * a new shortfall in the edited week remain blocking safety errors.
 */
export function classifyPlanningShortageIncreases(
  increases: readonly PlanningShortageIncrease[],
  editedWeekId: string,
): { blocking: PlanningShortageIncrease[]; confirmable: PlanningShortageIncrease[] } {
  const unsafe = (increase: PlanningShortageIncrease) =>
    increase.issue.week <= editedWeekId ||
    increase.issue.productId.startsWith("pallet:") ||
    increase.issue.productId.startsWith("truck:");
  return {
    blocking: increases.filter(unsafe),
    confirmable: increases.filter((increase) => !unsafe(increase)),
  };
}

/** Human-readable specificity used in the planner's pre-save confirmation. */
export function describePlanningShortageIncrease(
  increase: PlanningShortageIncrease,
  products: readonly Product[],
): string {
  const { issue, addedSlots, addedUnits, totalSlots, totalUnits } = increase;
  const product = products.find((entry) => entry.id === issue.productId);
  const subject = product
    ? `${product.style} (${product.type === "crates" ? "ארגזים" : "חביות"})`
    : issue.productId;
  const parts = [`שבוע ${issue.week} | תאריך משלוח ${issue.date} | ${subject}`];
  if (addedSlots > 0) parts.push(`נוספו ${addedSlots} מקומות משטח חסרים (סה״כ ${totalSlots})`);
  if (addedUnits > 0) parts.push(`נוספו ${Math.ceil(addedUnits)} יחידות חסרות (סה״כ ${Math.ceil(totalUnits)})`);
  return parts.join(" — ");
}

/** A partial pallet is operationally permitted but must never be invisible.
 * Blocking shortages are those lacking physical pallet positions entirely.
 */
export function newlyWorsenedShipmentShortage(
  before: PlanningAvailabilityIssue[],
  after: PlanningAvailabilityIssue[],
): PlanningAvailabilityIssue | undefined {
  return newlyWorsenedShipmentShortages(before, after)[0]?.issue;
}
