import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultSettings,
  dateKey,
  num,
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
import { tankReleases } from "../src/SERVICES/planning/productionCycle";
import {
  productionNeeds,
  productionDay,
} from "../src/SERVICES/planning/productionNeeds";
import {
  actionImpact,
  dayForWeek,
  groupKey,
  recommendationSettings,
  styleGroups,
  tankDiagnostics,
  weekIsClosed,
  withSpecialTotals,
} from "../src/SERVICES/planning/planningPresentation";

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
test("dashboard short Israeli dates and formatted volumes remain usable", () => {
  assert.equal(parseDate("1/9/26"), "2026-09-01");
  assert.equal(parseDate(" 1/9/2026 "), "2026-09-01");
  assert.equal(parseDate("29/2/26"), null);
  assert.equal(parseDate("29/2/24"), "2024-02-29");
  assert.equal(num(" 3,000 "), 3000);
  const source = {
    id: "t2",
    tankNumber: 2,
    beerStyle: "IPA",
    batchNumber: 7,
    brewDate: "1/8/26",
    beerVolume: "3,000",
  };
  assert.equal(tanksFrom([source], settings)[0]?.liters, 2700);
});
test("all production tanks are recognized, not just tanks 16 and 17", () => {
  const sources = Array.from({ length: 16 }, (_, i) => ({
    id: String(i + 2),
    tankNumber: i + 2,
    beerStyle: "IPA",
    batchNumber: i + 10,
    brewDate: "1/8/26",
    beerVolume: 3000,
  }));
  const available = tanksFrom(sources, settings);
  assert.equal(available.length, 16);
  const diagnostics = tankDiagnostics(sources, available, today);
  assert.deepEqual(
    diagnostics.map((t) => Number(t.number)),
    sources.map((t) => t.tankNumber),
  );
  assert.ok(diagnostics.every((t) => t.reason === "זמין לבדיקה ולשיבוץ אריזה"));
  const invalid = sources.map((s) =>
    s.id === "2" ? { ...s, brewDate: "" } : s,
  );
  assert.match(
    tankDiagnostics(invalid, tanksFrom(invalid, settings), today)[0].reason,
    /תאריך/,
  );
});
test("week locks exactly at Friday midnight in Israel, including year rollover", () => {
  assert.equal(weekIsClosed(today, "2026-09-10"), false);
  assert.equal(weekIsClosed(today, "2026-09-11"), true);
  assert.equal(weekIsClosed("2026-12-27", "2027-01-01"), true);
  assert.equal(weekIsClosed("2026-09-13", "2026-09-11"), false);
  assert.equal(
    weekIsClosed(today, dateKey(new Date("2026-09-10T20:59:59Z"))),
    false,
  );
  assert.equal(
    weekIsClosed(today, dateKey(new Date("2026-09-10T21:00:00Z"))),
    true,
  );
});
test("day selection resolves to the selected week's Israeli calendar dates", () => {
  assert.equal(dayForWeek(today, 0), today);
  assert.equal(dayForWeek(today, 4), "2026-09-10");
});
test("special editions share a reporting group without sharing production demand", () => {
  const original = {
    ...settings,
    products: [
      ...settings.products,
      { ...product, id: "winter", style: "מהדורת חורף", monthly: 80 },
    ],
  };
  const expanded = withSpecialTotals(original);
  assert.equal(original.products.length, 3);
  assert.equal(
    withSpecialTotals(expanded).products.length,
    expanded.products.length,
  );
  assert.equal(groupKey("אגסים"), "special");
  assert.equal(groupKey("סשן IPA"), "special");
  const groups = styleGroups(expanded);
  assert.deepEqual(
    groups.find((g) => g.style === "IPA")?.products.map((p) => p.type),
    ["crates", "kegs"],
  );
  assert.deepEqual(
    groups.find((g) => g.key === "special")?.products.map((p) => p.id),
    ["special:crates", "special:kegs"],
  );
  assert.equal(
    recommendationSettings(expanded).products.find((p) => p.id === "winter")
      ?.monthly,
    0,
  );
  assert.equal(expanded.products.find((p) => p.id === "winter")?.monthly, 80);
});
test("legacy bottle and keg maturity settings converge on one style duration", () => {
  const original = {
    ...settings,
    products: [
      { ...product, leadDays: 21 },
      { ...keg, leadDays: 28 },
    ],
  };
  const normalized = withSpecialTotals(original);
  assert.deepEqual(
    normalized.products.filter((p) => p.style === "IPA").map((p) => p.leadDays),
    [28, 28],
  );
  assert.equal(original.products[0].leadDays, 21);
});
test("packaging and brewing demand remain visible without any available tank", () => {
  const workspace = planningWorkspace(
    settings,
    [],
    [],
    [],
    [],
    [],
    today,
    [],
    [],
  );
  assert.ok(
    workspace.needs.some(
      (n) =>
        n.kind === "packaging" && n.productId === product.id && !n.nextTank,
    ),
  );
  assert.ok(
    workspace.needs.some(
      (n) =>
        n.kind === "brew" && n.style === "IPA" && n.quantity > 0 && !n.nextTank,
    ),
  );
  assert.ok(
    !workspace.actions.some((a) => a.kind === "brew" || a.kind === "packaging"),
  );
  assert.ok(workspace.forecast.points.every((p) => p.packed === 0));
});
test("unmet packaging shows the next matching tank and first maturity date", () => {
  const immature = {
    ...tank,
    number: "2",
    brewed: "2026-08-27",
    ready: "2026-09-17",
  };
  const workspace = planningWorkspace(
    settings,
    [],
    [immature],
    [],
    [],
    [],
    today,
    [],
    [],
  );
  const need = workspace.needs.find(
    (n) => n.kind === "packaging" && n.productId === product.id,
  )!;
  assert.equal(need.nextTank?.id, tank.id);
  assert.equal(need.nextTank?.ready, "2026-09-17");
  assert.match(need.problem, /יבשיל|בשל/);
  assert.ok(need.nextTank!.firstDay >= need.nextTank!.ready);
});
test("brewing demand identifies a later release after tank emptying and cleaning", () => {
  const hypothetical = [
    {
      ...plan(),
      packaging: [
        {
          id: "empty",
          productId: product.id,
          quantity: 378,
          date: today,
          tankId: tank.id,
          emptyTank: true,
        },
      ],
    },
  ];
  const source = {
    id: tank.id,
    tankNumber: 2,
    tankStatus: false,
    beerVolume: 3333,
  };
  const forecast = dailyForecast(settings, [], [tank], [], [], today);
  const needs = productionNeeds(
    settings,
    [],
    [tank],
    [],
    hypothetical,
    [],
    forecast,
    [],
    [source],
    [],
    today,
    [],
  );
  const brew = needs.find((n) => n.kind === "brew")!;
  assert.ok(brew.quantity > 0);
  assert.equal(brew.nextTank?.number, "2");
  assert.equal(brew.nextTank?.ready, "2026-09-14");
  assert.equal(brew.nextTank?.firstDay, "2026-09-14");
});
test("resource-free needs can be dismissed for their own date without creating production", () => {
  const initial = planningWorkspace(
    settings,
    [],
    [],
    [],
    [],
    [],
    today,
    [],
    [],
  );
  const need = initial.needs.find((n) => n.kind === "packaging")!;
  const next = planningWorkspace(
    settings,
    [],
    [],
    [{ ...plan(), dismissedRecommendations: [need.id] }],
    [],
    [],
    today,
    [],
    [],
  );
  assert.ok(!next.needs.some((n) => n.id === need.id));
  assert.ok(next.needs.some((n) => n.kind === "brew"));
  assert.ok(next.forecast.points.every((p) => p.packed === 0));
  assert.equal(productionDay("2026-09-11", "packaging"), "2026-09-13");
  assert.equal(productionDay("2026-09-11", "brew"), "2026-09-14");
});
test("shipment explanation uses daily consumption, including current and added coverage", () => {
  const s = { ...settings, products: [{ ...keg, tempo: 200 }] };
  const impact = actionImpact(
    {
      id: "ship",
      kind: "delivery",
      status: "recommended",
      date: today,
      productId: keg.id,
      quantity: 120,
      allocations: [],
      reason: "",
    },
    s,
    today,
    [
      {
        date: today,
        productId: keg.id,
        brewery: 0,
        tempo: 310,
        packed: 0,
        arrived: 120,
        shortage: 0,
      },
    ],
  );
  assert.match(impact, /כיסוי היום: 20 ימים/);
  assert.match(impact, /מוסיף כ־12 ימים/);
  assert.match(impact, /בסוף יום האיסוף: כ־31 ימים/);
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
test("an empty dashboard tank packaged this week waits until the following Monday", () => {
  const sources = [
    { id: "t2", tankNumber: 2, tankStatus: true, beerVolume: 3000 },
  ];
  const actuals = [{ id: "packed", tankNumber: 2, date: "2026-09-07" }];
  assert.equal(
    tankReleases(sources, [], [], settings, actuals, "2026-09-08")[0].date,
    "2026-09-14",
  );
  assert.equal(
    tankReleases(sources, [], [], settings, actuals, "2026-09-14")[0].date,
    "2026-09-14",
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
