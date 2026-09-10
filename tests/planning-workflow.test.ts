import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultSettings,
  emptyWeek,
  inventory,
  parseDate,
  tanksFrom,
  type Product,
  type Tank,
} from "../src/SERVICES/planning/planningEngine";
import {
  dailyForecast,
  validateDatedPlan,
} from "../src/SERVICES/planning/dailyPlanner";
import {
  planningWorkspace,
  withMarkedDeliveries,
  suggestedDispatchDate,
  adoptAction,
} from "../src/SERVICES/planning/workspace";
import type { Pallet } from "../src/SERVICES/cooler/Pallettypes ";

const today = "2026-09-06";
const product: Product = {
  id: "c",
  sku: "c",
  style: "IPA",
  type: "crates",
  monthly: 294,
  tempo: 0,
  tempoDate: today,
  leadDays: 21,
};
const keg: Product = { ...product, id: "k", sku: "k", type: "kegs" };
const settings = {
  ...defaultSettings(),
  targetWeeks: 5,
  totalTargetWeeks: 8.5,
  products: [product, keg],
};
const tank: Tank = {
  id: "t",
  number: "2",
  batch: "17",
  style: "IPA",
  brewed: "2026-08-01",
  ready: today,
  liters: 3000,
  cold: true,
};
function pallet(id = "p", quantity = 84): Pallet {
  return {
    id,
    quantity,
    itemType: "crates",
    beerStyle: "IPA",
    zone: "cooler",
    expiryDateStr: "31/12/2026",
    heightUnits: 1,
  };
}
const plan = () => ({ ...emptyWeek(today), changeReason: "תכנון" });

test("Israeli dates reject impossible dates and parse day before month", () => {
  assert.equal(parseDate("10/09/2026"), "2026-09-10");
  assert.equal(parseDate("31/02/2026"), null);
  assert.equal(parseDate("09/30/2026"), null);
});
test("all brewery zones count until a shipment is issued", () => {
  const items = [
    "cooler",
    "loadingDock",
    "bottleRoom",
    "pending",
    "shipped",
  ].map((zone, i) => ({ ...pallet(String(i)), zone }) as Pallet);
  const result = inventory(product, items);
  assert.equal(result.brewery + result.dock, 4 * 84);
});
test("recommended shipment arrives today rather than disappearing into tomorrow", () => {
  const f = dailyForecast(settings, [pallet()], [], [], [], today, [], true);
  const point = f.points.find((x) => x.date === today && x.productId === "c")!;
  assert.equal(point.arrived, 84);
  assert.equal(point.tempo, 74);
  assert.equal(point.brewery, 0);
});
test("explicit shipment dates replace automatic weekly dates", () => {
  const w = { ...plan(), deliveryDates: ["2026-09-08"] };
  const f = dailyForecast(settings, [pallet()], [], [w], [], today, [], true);
  const shipments = f.suggestions.filter((x) => x.kind === "delivery");
  assert.equal(shipments[0].date, "2026-09-08");
  assert.equal(shipments[0].arrivalDate, shipments[0].date);
});
test("a deliberately empty collection schedule means no recommended pickup this week", () => {
  const w = { ...plan(), deliveryDates: [] };
  const f = dailyForecast(settings, [pallet()], [], [w], [], today, [], true);
  assert.ok(
    !f.suggestions.some((x) => x.kind === "delivery" && x.date < "2026-09-13"),
  );
});
test("legacy maximum does not block three manually scheduled collections", () => {
  const w = {
    ...plan(),
    deliveries: ["2026-09-06", "2026-09-07", "2026-09-08"].map((date) => ({
      id: date,
      productId: "c",
      quantity: 84,
      dispatchDate: date,
      arrivalDate: date,
    })),
  };
  assert.equal(
    validateDatedPlan(w, { ...settings, maxWeeklyDeliveries: 1 }, [], today),
    null,
  );
});
test("truck physical capacity remains enforced", () => {
  const w = {
    ...plan(),
    deliveries: [
      {
        id: "x",
        productId: "c",
        quantity: 84 * 13,
        dispatchDate: today,
        arrivalDate: today,
      },
    ],
  };
  assert.ok(validateDatedPlan(w, settings, [], today));
});
test("mature beer can be packaged despite a large finished-stock buffer", () => {
  const abundant = {
    ...settings,
    products: settings.products.map((p) => ({ ...p, tempo: 10000 })),
  };
  const f = dailyForecast(
    abundant,
    [pallet("many", 10000)],
    [tank],
    [],
    [],
    today,
    [],
    true,
  );
  assert.ok(f.suggestions.some((x) => x.kind === "packaging"));
});
test("hiding one dated recommendation does not suppress other dates", () => {
  const first = dailyForecast(settings, [], [tank], [], [], today, [], true);
  const suggestion = first.suggestions.find((x) => x.kind === "packaging")!;
  const w = { ...plan(), dismissedRecommendations: [suggestion.id] };
  const next = dailyForecast(settings, [], [tank], [w], [], today, [], true);
  assert.ok(!next.suggestions.some((x) => x.id === suggestion.id));
  assert.ok(next.suggestions.some((x) => x.kind === "packaging"));
});
test("marked pallets infer next Sunday from Wednesday, but stay physical brewery stock", () => {
  const marked = { ...pallet(), markedForShipment: true };
  assert.equal(suggestedDispatchDate("2026-09-09"), "2026-09-13");
  const result = withMarkedDeliveries([], [marked], settings, "2026-09-09");
  assert.equal(
    result.flatMap((w) => w.deliveries ?? [])[0].dispatchDate,
    "2026-09-13",
  );
  assert.equal(inventory(product, [marked]).brewery, 84);
});
test("marked pallets already assigned to a decision are not duplicated", () => {
  const marked = { ...pallet(), markedForShipment: true };
  const w = {
    ...plan(),
    deliveries: [
      {
        id: "decision",
        productId: "c",
        quantity: 84,
        dispatchDate: today,
        arrivalDate: today,
        pallets: [marked],
      },
    ],
  };
  assert.equal(
    withMarkedDeliveries([w], [marked], settings, today).flatMap(
      (x) => x.deliveries ?? [],
    ).length,
    1,
  );
});
test("marked pallets contribute one collection and one receipt", () => {
  const marked = { ...pallet(), markedForShipment: true };
  const model = planningWorkspace(
    settings,
    [marked],
    [],
    [],
    [],
    [],
    today,
    [],
    [],
  );
  const point = model.forecast.points.find(
    (x) => x.productId === "c" && x.date === today,
  )!;
  assert.equal(point.arrived, 84);
  assert.equal(point.brewery, 0);
  assert.ok(
    !model.actions.some((a) => a.kind === "delivery" && a.date === today),
  );
});
test("accepting a recommendation creates a decision without mutating the original", () => {
  const model = planningWorkspace(
    settings,
    [],
    [tank],
    [],
    [],
    [],
    today,
    [],
    [],
  );
  const action = model.actions.find((a) => a.kind === "packaging")!;
  const w = plan();
  const adopted = adoptAction(w, action);
  assert.equal(w.packaging.length, 0);
  assert.equal(adopted.packaging.length, 1);
  const recomputed = planningWorkspace(
    settings,
    [],
    [tank],
    [adopted],
    [],
    [],
    today,
    [],
    [],
  );
  assert.ok(!recomputed.actions.some((a) => a.id === action.id));
});
test("unapproved brewing participates in future supply without becoming a saved decision", () => {
  const w = plan();
  const model = planningWorkspace(
    settings,
    [],
    [],
    [w],
    [],
    [{ id: "free", tankStatus: true, beerVolume: 3000 }],
    today,
    [],
    [],
  );
  assert.ok(model.actions.some((a) => a.kind === "brew"));
  assert.ok(
    model.actions.some((a) => a.kind === "packaging" && a.date >= "2026-09-28"),
  );
  assert.equal(w.brews.length, 0);
});
test("no invented brewing capacity when dashboard volume is missing", () => {
  const model = planningWorkspace(
    settings,
    [],
    [],
    [],
    [],
    [{ id: "free", tankStatus: true }],
    today,
    [],
    [],
  );
  assert.ok(!model.actions.some((a) => a.kind === "brew"));
});
test("exceptions relax work-day rules but never truck capacity", () => {
  const w = {
    ...plan(),
    allowExceptions: true,
    packaging: [{ id: "x", productId: "c", quantity: 42, date: "2026-09-11" }],
  };
  assert.equal(validateDatedPlan(w, settings, [], today), null);
  assert.ok(
    validateDatedPlan({ ...w, allowExceptions: false }, settings, [], today),
  );
});
test("fixed shrinkage stays 10 percent", () => {
  const result = tanksFrom(
    [
      {
        id: "t",
        beerVolume: 3000,
        batchNumber: "17",
        beerStyle: "IPA",
        brewDate: "01/08/2026",
      },
    ],
    { ...settings, lossPercent: 0 },
  );
  assert.equal(result[0].liters, 2700);
});
