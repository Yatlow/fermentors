import type { Pallet } from "../cooler/Pallettypes ";
import {
  addDays,
  daysBetween,
  inventory,
  num,
  parseDate,
  weeklyDemand,
  weekStart,
  type Actual,
  type Product,
  type Settings,
  type WeekPlan,
} from "./planningEngine";
import { openRuns } from "./dailyPlanner";

export type WeekStartProjection = {
  product: Product;
  tempoUnits: number | null;
  breweryUnits: number;
  tempoCover: number | null;
  totalCover: number | null;
  packagingBeforeWeek: number;
  shipmentsBeforeWeek: number;
};

/**
 * Expected state at the START of the selected planning week.
 *
 * The weekly planner should not consume the selected week's sales yet. It does,
 * however, need to carry forward everything that is expected to happen before
 * that week starts:
 *  - sales forecast after the latest Tempo count and through the previous week;
 *  - shipment decisions arriving at Tempo before the selected week;
 *  - open packaging decisions from earlier planning weeks;
 *  - shipment decisions that will leave the brewery before the selected week.
 *
 * Physical brewery stock is today's real map state, so only still-future/open
 * decisions are applied on top of it. This avoids counting completed packaging
 * twice or subtracting shipments that have already disappeared from the map.
 */
export function buildWeekStartProjection(args: {
  settings: Settings;
  pallets: Pallet[];
  plans: WeekPlan[];
  actuals: Actual[];
  today: string;
  week: string;
}): Map<string, WeekStartProjection> {
  const { settings, pallets, plans, actuals, today, week } = args;
  const currentWeek = weekStart(today);
  const previousWeekEnd = addDays(week, -1);
  const open = openRuns(plans, settings.products, actuals);
  const result = new Map<string, WeekStartProjection>();

  for (const product of settings.products) {
    const demand = weeklyDemand(product);
    const daily = demand / 7;
    const tempoDate = parseDate(product.tempoDate);

    let tempoUnits: number | null = product.tempo === null || !tempoDate
      ? null
      : num(product.tempo);

    if (tempoUnits !== null && tempoDate < week) {
      // Do not consume the selected week itself. When the latest count is already
      // inside the selected week, use that real count as-is.
      const salesDays = Math.max(0, daysBetween(tempoDate, previousWeekEnd));
      tempoUnits = Math.max(0, tempoUnits - salesDays * daily);

      const arrivalsBeforeWeek = plans
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

    const inv = inventory(product, pallets);
    const physicalBrewery = inv.brewery + inv.dock;

    // `openRuns` already subtracts actual packaging, so only the remaining part of
    // an earlier-week decision is projected into future brewery stock.
    const packagingBeforeWeek = open
      .filter((run) =>
        run.productId === product.id &&
        run.remaining > 0 &&
        run.week >= currentWeek &&
        run.week < week,
      )
      .reduce((sum, run) => sum + run.remaining, 0);

    // The map is current physical stock. Only shipments that have not happened yet
    // should be subtracted from it when projecting a later planning week.
    const shipmentsBeforeWeek = plans
      .flatMap((plan) => plan.deliveries ?? [])
      .filter((delivery) =>
        delivery.productId === product.id &&
        delivery.quantity > 0 &&
        delivery.dispatchDate >= today &&
        delivery.dispatchDate < week,
      )
      .reduce((sum, delivery) => sum + delivery.quantity, 0);

    const breweryUnits = Math.max(0, physicalBrewery + packagingBeforeWeek - shipmentsBeforeWeek);
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
