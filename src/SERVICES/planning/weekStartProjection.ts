import type { Pallet } from "../cooler/Pallettypes ";
import {
  addDays,
  daysBetween,
  productPallets,
  num,
  parseDate,
  weeklyDemand,
  weekStart,
  type Actual,
  type Product,
  type Settings,
  type WeekPlan,
} from "./planningEngine";
import { openRuns, type ShipmentEvent } from "./dailyPlanner";
import { pendingPlansAfterActualShipments } from "./shipmentActuals";

export type WeekStartProjection = {
  product: Product;
  tempoUnits: number | null;
  breweryUnits: number;
  tempoCover: number | null;
  totalCover: number | null;
  packagingBeforeWeek: number;
  shipmentsBeforeWeek: number;
};

/** Expected state at the START of the selected planning week. */
export function buildWeekStartProjection(args: {
  settings: Settings;
  pallets: Pallet[];
  plans: WeekPlan[];
  actuals: Actual[];
  today: string;
  week: string;
  actualShipments?: ShipmentEvent[];
}): Map<string, WeekStartProjection> {
  const { settings, pallets, plans, actuals, today, week } = args;
  const pendingPlans = pendingPlansAfterActualShipments(plans, args.actualShipments ?? [], settings.products);
  const currentWeek = weekStart(today);
  const open = openRuns(plans, settings.products, actuals);
  const result = new Map<string, WeekStartProjection>();

  for (const product of settings.products) {
    const demand = weeklyDemand(product);
    const daily = demand / 7;
    const parsedTempoDate = parseDate(product.tempoDate);

    let tempoUnits: number | null = product.tempo === null || parsedTempoDate === null
      ? null
      : num(product.tempo);

    if (tempoUnits !== null && parsedTempoDate !== null && parsedTempoDate < week) {
      // Project to Sunday morning of the selected week. The selected week's own
      // demand starts only after this opening value, so it is not subtracted here.
      const tempoDate = parsedTempoDate;
      const salesDays = Math.max(0, daysBetween(tempoDate, week));
      tempoUnits = Math.max(0, tempoUnits - salesDays * daily);

      const arrivalsBeforeWeek = pendingPlans
        .flatMap((plan) => plan.deliveries ?? [])
        .filter((delivery) =>
          delivery.productId === product.id &&
          delivery.quantity > 0 &&
          delivery.arrivalDate > tempoDate &&
          delivery.arrivalDate < week,
        )
        .reduce((sum, delivery) => sum + delivery.quantity, 0);
      tempoUnits += arrivalsBeforeWeek;
    }

    // Project physical lots chronologically instead of netting them first:
    // inventory which expires between two dispatches can be used for the
    // earlier one, but must not appear as stock at a later week opening.
    const physicalLots = productPallets(product, pallets).flatMap((pallet) => {
      const expiry = parseDate(pallet.expiryDateStr);
      const qty = Math.max(0, num(pallet.quantity));
      return expiry && expiry >= today && qty > 0 ? [{ expiry, qty }] : [];
    });
    const packEvents = open
      .filter((run) => run.productId === product.id && run.remaining > 0 &&
        run.week >= currentWeek && run.week < week)
      .map((run) => ({ date: run.date ?? addDays(run.week, 4),
        kind: "pack" as const, qty: run.remaining }))
      .filter((event) => event.date >= today && event.date < week);
    const shipmentEvents = pendingPlans
      .flatMap((plan) => plan.deliveries ?? [])
      .filter((delivery) => delivery.productId === product.id &&
        delivery.quantity > 0 && delivery.dispatchDate >= today &&
        delivery.dispatchDate < week)
      .map((delivery) => ({ date: delivery.dispatchDate, kind: "ship" as const,
        qty: delivery.quantity }));
    const packagingBeforeWeek = packEvents.reduce((sum, event) => sum + event.qty, 0);
    const shipmentsBeforeWeek = shipmentEvents.reduce((sum, event) => sum + event.qty, 0);
    const events = [...packEvents, ...shipmentEvents].sort((a, b) =>
      a.date.localeCompare(b.date) ||
      (a.kind === b.kind ? 0 : a.kind === "pack" ? -1 : 1));

    for (const event of events) {
      for (let i = physicalLots.length - 1; i >= 0; i--) {
        if (physicalLots[i].expiry < event.date) physicalLots.splice(i, 1);
      }
      if (event.kind === "pack") {
        physicalLots.push({ expiry: "9999-12-31", qty: event.qty });
        continue;
      }
      let remainingToDispatch = event.qty;
      physicalLots.sort((a, b) => a.expiry.localeCompare(b.expiry));
      for (const lot of physicalLots) {
        const sent = Math.min(lot.qty, remainingToDispatch);
        lot.qty -= sent;
        remainingToDispatch -= sent;
        if (remainingToDispatch <= 0) break;
      }
    }
    const breweryUnits = physicalLots.filter((lot) => lot.expiry >= week)
      .reduce((sum, lot) => sum + lot.qty, 0);
    result.set(product.id, {
      product,
      tempoUnits,
      breweryUnits,
      tempoCover: tempoUnits === null || demand <= 0 ? null : tempoUnits / demand,
      totalCover: tempoUnits === null || demand <= 0 ? null : (tempoUnits + breweryUnits) / demand,
      packagingBeforeWeek,
      shipmentsBeforeWeek,
    });
  }

  return result;
}
