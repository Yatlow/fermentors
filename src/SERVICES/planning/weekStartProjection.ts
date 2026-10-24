import type { Pallet } from "../cooler/Pallettypes ";
import {
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
import { forecastablePlansAfterActualShipments, settingsAfterActualShipments } from "./shipmentActuals";
import { tempoInventoryAt, type TempoReceipt } from "./tempoInventoryTimeline";
import { addForecastPackaging, dispatchForecastPallets, type ForecastPalletLot } from "./shipmentPalletLedger";

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
  const pendingPlans = forecastablePlansAfterActualShipments(plans, args.actualShipments ?? [], settings.products, today);
  const currentWeek = weekStart(today);
  const open = openRuns(plans, settings.products, actuals);
  const currentTempo = settingsAfterActualShipments(
    settings, args.actualShipments ?? [], today,
  );
  const result = new Map<string, WeekStartProjection>();

  for (const product of settings.products) {
    const demand = weeklyDemand(product);
    const daily = demand / 7;
    // Every engine starts from the same current physical balance, including
    // sales between the stock count and the shipments that actually arrived.
    const openingProduct = currentTempo.products.find((p) => p.id === product.id)
      ?? product;
    const forecastReceipts: TempoReceipt[] = [];

    // Project physical lots chronologically instead of netting them first:
    // inventory which expires between two dispatches can be used for the
    // earlier one, but must not appear as stock at a later week opening.
    const physicalLots: ForecastPalletLot[] = productPallets(product, pallets).flatMap((pallet) => {
      const expiry = parseDate(pallet.expiryDateStr);
      const qty = Math.max(0, num(pallet.quantity));
      return expiry && expiry >= today && qty > 0
        ? [{ id: pallet.id, expiry, quantity: qty }] : [];
    });
    const packEvents = open
      .filter((run) => run.productId === product.id && run.remaining > 0 &&
        run.week >= currentWeek && run.week < week)
      // Undated packaging is a planning intention, not committed inventory.
      // Do not invent a Thursday and promise those units to a later shipment.
      .filter((run) => !!run.date)
      .map((run) => ({ date: run.date!, kind: "pack" as const, qty: run.remaining }))
      .filter((event) => event.date >= today && event.date < week);
    const shipmentEvents = pendingPlans
      .flatMap((plan) => plan.deliveries ?? [])
      .filter((delivery) => delivery.productId === product.id &&
        delivery.quantity > 0 && delivery.dispatchDate >= today &&
        delivery.dispatchDate < week)
      .map((delivery) => ({ date: delivery.dispatchDate, kind: "ship" as const,
        qty: delivery.quantity, arrivalDate: delivery.arrivalDate }));
    const packagingBeforeWeek = packEvents.reduce((sum, event) => sum + event.qty, 0);
    const shipmentsBeforeWeek = shipmentEvents.reduce((sum, event) => sum + event.qty, 0);
    const events = [...packEvents, ...shipmentEvents].sort((a, b) =>
      a.date.localeCompare(b.date) ||
      (a.kind === b.kind ? 0 : a.kind === "pack" ? -1 : 1));

    const unitsPerPallet = product.type === "crates" ? 84 : 20;
    // The arrival ledger is independent from the warehouse dispatch ledger.
    // This prevents early or late arrival from changing the stock deducted
    // at the brewery, and sales are replayed BETWEEN arrivals rather than
    // subtracting the entire period's demand up front.
    events.forEach((event, index) => {
      if (event.kind === "pack") {
        addForecastPackaging(physicalLots, event.qty, unitsPerPallet,
          `future:${product.id}:${event.date}:${index}`);
      } else {
        // The planned departure occupies WHOLE pallets. The customer's
        // projected receipt is bounded by the physically available units,
        // not by the optimistic planned manifest. Respect arrival/transit.
        const consumed = dispatchForecastPallets(
          physicalLots, event.qty, unitsPerPallet, event.date);
        if (event.arrivalDate < week) {
          forecastReceipts.push({
            date: event.arrivalDate,
            quantity: Math.min(event.qty, consumed.shippedPhysical),
            forecast: true,
          });
        }
      }
    });
    const tempoUnits = tempoInventoryAt(
      openingProduct, week, forecastReceipts,
    );
    const breweryUnits = physicalLots.filter((lot) => lot.expiry >= week)
      .reduce((sum, lot) => sum + lot.quantity, 0);
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
