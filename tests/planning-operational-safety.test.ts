import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultSettings, emptyWeek, shipmentAdvice, type Product, type Tank, type WeekPlan,
} from "../src/SERVICES/planning/planningEngine";
import type { Pallet } from "../src/SERVICES/cooler/Pallettypes ";
import { dailyForecast, futureTanks } from "../src/SERVICES/planning/dailyPlanner";
import { simulatedGanttBrews } from "../src/SERVICES/planning/ganttBrewProjection";
import { buildWeekStartProjection } from "../src/SERVICES/planning/weekStartProjection";
import {
  completedShipmentQueueTruckId, matchActualShipments,
  pendingPlansAfterActualShipments, mergeCompletedDeliveriesBack,
} from "../src/SERVICES/planning/shipmentActuals";
import { auditShipmentAvailability } from "../src/SERVICES/planning/shipmentAvailabilityAudit";
import { validatePlanningDecisionChange } from "../src/SERVICES/planning/planningDecisionSafety";
import { planningWeekIssues } from "../src/SERVICES/planning/planningValidation";
import { buildWeeklyPlanningModel } from "../src/SERVICES/planning/weeklyPlanningModel";
import { selectTruck } from "../src/SERVICES/planning/truckPlanner";
import { automaticReservationDelta } from "../src/SERVICES/planning/automaticReservationReconciliation";
import { replaceShipmentTrip } from "../src/SERVICES/planning/shipmentEdit";
import { packagingLimit } from "../src/SERVICES/planning/productionCycle";
import { validateBrewReleaseIssues, validateProductionIssues } from "../src/SERVICES/planning/productionCycle";
import { planningRequiresCrossWeekFence, planningSaveFenceConflict, planningSaveFenceWeekIds } from "../src/SERVICES/planning/planningSaveFence";

const today = "2026-10-18";
const ipa: Product = {
  id: "ipa-crates", sku: "ipa-crates", style: "IPA",
  type: "crates", monthly: 300, tempo: 0, tempoDate: today, leadDays: 21,
};
const settings = { ...defaultSettings(), products: [ipa] };
const pallet: Pallet = {
  id: "still-here", itemType: "crates", beerStyle: "IPA", quantity: 84,
  zone: "cooler", expiryDateStr: "31/12/2026", heightUnits: 1,
};
const twoTrips = { ...emptyWeek("2026-10-18"), deliveries: [
  { id: "trip-a", truckId: "truck-a", productId: ipa.id,
    quantity: 84, dispatchDate: "2026-10-19", arrivalDate: "2026-10-19" },
  { id: "trip-b", truckId: "truck-b", productId: ipa.id,
    quantity: 84, dispatchDate: "2026-10-19", arrivalDate: "2026-10-19" },
]};
const oneActual = {
  id: "actual-a", date: "2026-10-19",
  totals: [{ itemType: "crates" as const, beerStyle: "IPA", totalQuantity: 84 }],
};

test("cross-week save fence includes prior, current, future and absent weeks", () => {
  const ids = planningSaveFenceWeekIds("2026-10-24");
  assert.equal(ids.length, 25);
  assert.equal(ids[0], "2026-07-26");
  assert.equal(ids[12], "2026-10-18");
  assert.equal(ids.at(-1), "2027-01-10");
  const before = [
    { ...emptyWeek("2026-10-25"), revision: 4 },
    { ...emptyWeek("2026-11-01"), revision: 9 },
  ];
  const snapshot = [
    { id: "2026-10-25", revision: 4 },
    { id: "2026-11-01", revision: 9 },
    { id: "2026-11-08", revision: null },
  ];
  assert.equal(planningSaveFenceConflict(before, snapshot, "2026-10-25"), null);
  assert.equal(planningSaveFenceConflict(before,
    snapshot.map((item) => item.id === "2026-11-01"
      ? { ...item, revision: 10 } : item), "2026-10-25"), "2026-11-01",
    "a concurrent DIFFERENT week save must force replanning");
  assert.equal(planningSaveFenceConflict(before,
    snapshot.map((item) => item.id === "2026-11-08"
      ? { ...item, revision: 1 } : item), "2026-10-25"), "2026-11-08",
    "a concurrent creation of a previously absent week is not invisible");
  assert.equal(planningSaveFenceConflict(before, [
    ...snapshot, { id: "2026-10-25", revision: 6 },
  ], "2026-10-25"), null, "the edited week has its own version check");
});

test("metadata-only weekly saves avoid 25-document fence without weakening operational edits", () => {
  const previous = emptyWeek("2026-10-25");
  assert.equal(planningRequiresCrossWeekFence(previous, {
    ...previous, note: "הערת מתכנן", changeReason: "שינוי הערה",
    dismissedRecommendations: ["optional-note"],
  }), false, "notes and dismissal alone cannot reserve stock or a tank");
  assert.equal(planningRequiresCrossWeekFence(previous, {
    ...previous, deliveries: [{
      id: "delivery", productId: ipa.id, quantity: 84,
      dispatchDate: "2026-10-26", arrivalDate: "2026-10-26",
    }],
  }), true, "real shipments require the full concurrency fence");
  assert.equal(planningRequiresCrossWeekFence(previous, {
    ...previous, packaging: [{
      id: "pack", productId: ipa.id, quantity: 84, date: "2026-10-27",
    }],
  }), true, "packaging may release a downstream tank and stock");
  assert.equal(planningRequiresCrossWeekFence(previous, {
    ...previous, maxRuns: 3,
  }), true, "capacity rules remain fully fenced");
  assert.equal(planningRequiresCrossWeekFence(previous, {
    ...previous, calendarEvents: [{ id: "shift", date: "2026-10-26" }],
  } as WeekPlan), true, "calendar events are not assumed to be cosmetic");
  assert.equal(planningRequiresCrossWeekFence(undefined, previous), true,
    "new week creation is always protected");
  assert.equal(planningSaveFenceWeekIds("2026-10-24").length, 25,
    "sensitive changes still read the full, bounded 25-week window");
});

test("one specifically approved oversize truck does not unlock other trucks or packaging limits", () => {
  const first = { id: "oversize-1", productId: ipa.id, quantity: 13 * 84,
    dispatchDate: "2026-10-26", arrivalDate: "2026-10-26", truckId: "A" };
  const second = { id: "oversize-2", productId: ipa.id, quantity: 13 * 84,
    dispatchDate: "2026-10-27", arrivalDate: "2026-10-27", truckId: "B" };
  const base = { ...emptyWeek("2026-10-25"), deliveries: [first, second] };
  assert.ok(planningWeekIssues(base, settings, [base], "2026-10-22")
    .some((message) => message.includes("נדרשים 13 מקומות")));
  const approvedOne = { ...base, oversizeTruckApprovals: ["2026-10-26::A"] };
  assert.ok(planningWeekIssues(approvedOne, settings, [approvedOne], "2026-10-22")
    .some((message) => message.includes("2026-10-27")),
    "approving A does not silently approve B");
  const approvedBoth = { ...base, oversizeTruckApprovals: ["2026-10-26::A", "2026-10-27::B"] };
  assert.ok(!planningWeekIssues(approvedBoth, settings, [approvedBoth], "2026-10-22")
    .some((message) => message.includes("מקומות")),
    "both approved physical trips can be saved as exceptional plans");
  assert.equal(planningRequiresCrossWeekFence(base, approvedOne), true,
    "capacity approval changes planning operations and must remain transaction-fenced");
  const illegalPackaging = { ...approvedBoth, packaging: [{
    id: "too-much", productId: ipa.id, quantity: 253, date: "2026-10-28",
  }] };
  assert.ok(planningWeekIssues(illegalPackaging, settings, [illegalPackaging], "2026-10-22")
    .some((message) => message.includes("קיבולת 252")),
    "truck capacity approval never grants an unrelated packaging exception");
});

test("one of two same-day dispatches leaves one real open trip", () => {
  const matches = matchActualShipments(twoTrips.deliveries, [oneActual], settings.products);
  assert.equal(matches.filter((match) => match.status === "pending").length, 1);
  assert.equal(matches.filter((match) => match.status === "matched").length, 1);
  const pending = pendingPlansAfterActualShipments([twoTrips], [oneActual], settings.products);
  assert.equal(pending[0]!.deliveries!.length, 1);
  assert.equal(pending[0]!.deliveries![0]!.truckId, "truck-b");
});

test("actual with an unrelated manifest cannot close a planned dispatch", () => {
  const unrelated = { ...oneActual, totals: [
    { itemType: "crates" as const, beerStyle: "חיטה", totalQuantity: 84 },
  ] };
  assert.equal(matchActualShipments(twoTrips.deliveries, [unrelated], settings.products)
    .filter((match) => match.status === "pending").length, 2);
  assert.equal(completedShipmentQueueTruckId(twoTrips.deliveries, { "unknown-sku": 84 },
    "2026-10-19"), null);
});

test("day forecast reserves stock for the second same-day trip after the first has left", () => {
  const result = dailyForecast(settings, [pallet], [], [twoTrips], [], today,
    [], false, [oneActual]);
  const after = result.points.find((point) =>
    point.date === "2026-10-19" && point.productId === ipa.id);
  assert.ok(after);
  assert.equal(after.brewery, 0, "still-open truck consumes the one remaining pallet");
  assert.equal(after.arrived, 84, "a completed truck is not projected as a second dispatch");
});

test("later weekly opening stock counts only unfulfilled same-day trips", () => {
  const row = buildWeekStartProjection({
    settings, pallets: [pallet], plans: [twoTrips], actuals: [],
    today, week: "2026-10-25", actualShipments: [oneActual],
  }).get(ipa.id);
  assert.equal(row?.shipmentsBeforeWeek, 84);
  assert.equal(row?.breweryUnits, 0);
  const issues = auditShipmentAvailability(settings, [pallet], [twoTrips], [],
    today, [oneActual]);
  assert.equal(issues.length, 0, "one still-open truck is covered by one remaining pallet");
});

test("weekly decision save rejects removing tank 4 release needed by an existing future brew", () => {
  const wheat: Product = { ...ipa, id: "wheat-kegs", sku: "wheat-kegs",
    style: "חיטה", type: "kegs", monthly: 240 };
  const wheatSettings = { ...defaultSettings(), products: [wheat] };
  const tank: Tank = {
    id: "tank-4", number: "4", batch: "1614", style: "חיטה",
    brewed: "2026-10-12", ready: "2026-11-02", liters: 1120, cold: true,
  };
  const source = { id: tank.id, tankNumber: 4, batchNumber: tank.batch,
    brewDate: "12/10/2026", beerStyle: tank.style, action: 1 };
  const liveBrew = { ...emptyWeek("2026-10-11"), brews: [{
    id: "brew-live-wheat-4", tankId: tank.id, style: tank.style,
    date: "2026-10-12", batchNumber: tank.batch, liters: 1100,
  }] };
  const packed = { ...emptyWeek("2026-11-01"), packaging: [{
    id: "wheat4-kegs", productId: wheat.id, quantity: 56,
    tankId: tank.id, tankNumber: "4", batchNumber: tank.batch,
    brewId: "brew-live-wheat-4", date: "2026-11-05",
  }] };
  const future = { ...emptyWeek("2026-11-08"), brews: [{
    id: "next-wheat", tankId: tank.id, style: tank.style,
    date: "2026-11-09", liters: 1100,
  }] };
  const before: WeekPlan[] = [liveBrew, packed, future];
  const edited = { ...packed, packaging: [{ ...packed.packaging[0], quantity: 55 }] };
  const after: WeekPlan[] = [liveBrew, edited, future];
  const err = validatePlanningDecisionChange({
    before, after, edited, previous: packed,
    settings: wheatSettings, tanks: [tank], sources: [source],
    actuals: [], today: "2026-10-22",
  });
  assert.ok(err, "editing week 45 must not silently invalidate committed week 46");
  assert.match(err, /מיכל|ריקון|בישול|מחזור/);
});

test("a metadata-only edit does not rewrite or revalidate historical completed brews", () => {
  const old = { ...emptyWeek("2026-10-18"), brews: [{
    id: "old", style: "IPA", tankId: "", date: "2026-10-19", liters: 1100,
  }] };
  const edited = { ...old, note: "Updated planner note" };
  assert.equal(validatePlanningDecisionChange({
    before: [old], after: [edited], edited, previous: old,
    settings, tanks: [], sources: [], actuals: [], today: "2026-10-23",
  }), null);
});

test("invalid weekly shipment quantities are blocked before Firestore save", () => {
  const bad = { ...twoTrips, deliveries: [{
    ...twoTrips.deliveries[0], quantity: -4,
  }] };
  assert.match(validatePlanningDecisionChange({
    before: [twoTrips], after: [bad], edited: bad, previous: twoTrips,
    settings, tanks: [], sources: [], actuals: [], today,
  }) ?? "", /משלוח|כמות/);
});

test("Gantt recommendation forecasts reserve specific tanks but remain hypothetical", () => {
  const projected = simulatedGanttBrews("2026-10-25", [
    { style: "IPA", liters: 3000, tankId: "tank-10", tankNumber: "10",
      sizeLabel: "משולש", availableDate: "2026-10-26" },
    { style: "IPA", liters: 3000, tankId: "tank-11", tankNumber: "11",
      sizeLabel: "משולש", availableDate: "2026-10-27" },
    { style: "IPA", liters: 3000, tankId: "tank-12", tankNumber: "12",
      sizeLabel: "משולש", availableDate: "2026-10-29" },
  ]);
  assert.equal(projected.length, 2, "no imaginary Thursday brewery shift");
  assert.deepEqual(projected.map((brew) => brew.date), ["2026-10-26", "2026-10-27"]);
  assert.deepEqual(projected.map((brew) => brew.tankId), ["tank-10", "tank-11"]);
  assert.ok(projected.every((brew) => brew.tankAssignmentStatus === "tentative"));
  const virtualTanks = futureTanks([], [{ ...emptyWeek("2026-10-25"), brews: projected }], settings);
  assert.ok(virtualTanks.some((tank) => tank.id === "planned:gantt-rec-brew:2026-10-25:0"));
  assert.ok(virtualTanks.some((tank) => tank.id === "planned:gantt-rec-brew:2026-10-25:1"));
});

test("one physical dispatch matches its best SKU trip even when another trip is listed first", () => {
  const another: Product = { ...ipa, id: "wheat-crates", sku: "wheat-crates", style: "חיטה" };
  const mixed = { ...twoTrips, deliveries: [
    { ...twoTrips.deliveries[0], productId: ipa.id },
    { ...twoTrips.deliveries[1], productId: another.id },
  ] };
  const actual = { ...oneActual, totals: [
    { itemType: "crates" as const, beerStyle: another.style, totalQuantity: 84 },
  ] };
  const matches = matchActualShipments(mixed.deliveries, [actual], [ipa, another]);
  assert.equal(matches.find((m) => m.planned.id === "truck-a")?.status, "pending");
  assert.equal(matches.find((m) => m.planned.id === "truck-b")?.status, "matched");
});

test("re-saving a full week cannot duplicate an already completed trip", () => {
  const merged = mergeCompletedDeliveriesBack(twoTrips, twoTrips, [oneActual], settings.products);
  assert.equal(merged.deliveries?.length, 2);
  assert.equal(merged.deliveries?.filter((d) => d.truckId === "truck-a").length, 1);
  assert.equal(merged.deliveries?.filter((d) => d.truckId === "truck-b").length, 1);
});

test("an unknown-SKU actual is not treated as an empty legacy manifest", () => {
  const unknown = { ...oneActual, totals: [
    { itemType: "crates" as const, beerStyle: "not-in-catalog", totalQuantity: 84 },
  ] };
  assert.ok(matchActualShipments([twoTrips.deliveries[0]], [unknown], settings.products)
    .every((m) => m.status === "pending"));
});


test("a canonical brew already in a physical tank contributes real packaging to the daily supply forecast", () => {
  const wheat: Product = { ...ipa, id: "wheat-kegs", sku: "wheat-kegs",
    style: "חיטה", type: "kegs", monthly: 300 };
  const wheatSettings = { ...defaultSettings(), products: [wheat] };
  const physical: Tank = {
    id: "tank-4", number: "4", style: "חיטה", batch: "1614",
    brewed: "2026-10-12", ready: "2026-11-02", liters: 1120, cold: true,
  };
  const brewWeek = { ...emptyWeek("2026-10-11"), brews: [{
    id: "brew-wheat-1614", tankId: physical.id, style: physical.style,
    date: physical.brewed, batchNumber: physical.batch, liters: 1100,
  }] };
  const packWeek = { ...emptyWeek("2026-11-01"), packaging: [{
    id: "pack-56", productId: wheat.id, quantity: 56, date: "2026-11-05",
    tankId: physical.id, batchNumber: physical.batch, brewId: "brew-wheat-1614",
  }] };
  const forecast = dailyForecast(wheatSettings, [], [physical], [brewWeek, packWeek],
    [], "2026-10-22");
  const packed = forecast.points.find((row) =>
    row.date === "2026-11-05" && row.productId === wheat.id);
  assert.ok(packed);
  assert.equal(packed.packed, 56);
  assert.ok(!forecast.warnings.some((warning) => warning.includes("חסרים") &&
    warning.includes("חיטה")), "the physical cycle is the canonical source, not a missing virtual tank");
});

test("recommended next IPA brew uses the IPA volume despite the tank's former Lager style", () => {
  const highDemand: Product = { ...ipa, monthly: 1000, tempo: 0,
    tempoDate: "2026-10-22" };
  const ipaSettings = { ...defaultSettings(), products: [highDemand] };
  const source = { id: "tank-6", tankNumber: 6, beerStyle: "לאגר", action: 4 };
  const model = buildWeeklyPlanningModel({
    settings: ipaSettings, pallets: [], tanks: [], plans: [], actuals: [],
    sources: [source], today: "2026-10-22", week: "2026-10-25",
    holidays: [], shipments: [],
  });
  const recommended = model.brewRecommendations.find((brew) =>
    brew.tankId === source.id && brew.style === "IPA");
  assert.ok(recommended, "free double tank must be available for IPA shortage");
  assert.equal(recommended.liters, 1960, "not the former Lager cycle's 2500 liters");
});

test("forecast FEFO prevails over production-date FIFO when expiry dates disagree", () => {
  const oldProduction = { ...pallet, id: "old-production",
    batchNumber: "older", expiryDateStr: "31/12/2026" };
  const soonToExpire = { ...pallet, id: "earlier-expiry",
    batchNumber: "newer", expiryDateStr: "31/10/2026" };
  const picked = selectTruck([ipa], [
    { pallet: oldProduction, quantity: 84, expiry: "2026-12-31" },
    { pallet: soonToExpire, quantity: 84, expiry: "2026-10-31" },
  ], new Map([[ipa.id, 84]]), new Map([[ipa.id, 1]]),
  new Map([["older:" + ipa.id, "2026-01-01"], ["newer:" + ipa.id, "2026-09-01"]]));
  assert.equal(picked.pallets[0]?.id, "earlier-expiry");
});


test("smaller planned dispatch releases surplus automatic marks, never manual marks", () => {
  const pallets = [
    { id: "auto-a", markedForShipment: true, autoReservationWeek: "2026-10-18", autoReservationTruckId: "truck-a" },
    { id: "auto-b", markedForShipment: true, autoReservationWeek: "2026-10-18", autoReservationTruckId: "truck-a" },
    { id: "manual", markedForShipment: true },
  ];
  const delta = automaticReservationDelta(pallets, new Set(["auto-a"]), "2026-10-18", "truck-a");
  assert.deepEqual(delta.releaseIds, ["auto-b"]);
  assert.deepEqual(delta.assignIds, []);
  assert.ok(!delta.releaseIds.includes("manual"));
  assert.equal(delta.originalAuto.get("auto-b")?.truckId, "truck-a");
  const second = automaticReservationDelta(pallets.filter((p) => p.id !== "auto-b"),
    new Set(["auto-a"]), "2026-10-18", "truck-a");
  assert.deepEqual(second.releaseIds, []);
  assert.deepEqual(second.assignIds, [], "unchanged desired marks require no Firestore writes");
});

test("the same pallet reassigned to another truck updates the tag instead of staying stale", () => {
  const marked = [{ id: "one", markedForShipment: true,
    autoReservationWeek: "2026-10-18", autoReservationTruckId: "truck-a" }];
  const delta = automaticReservationDelta(marked, new Set(["one"]), "2026-10-18", "truck-b");
  assert.deepEqual(delta.releaseIds, []);
  assert.deepEqual(delta.assignIds, ["one"]);
  assert.equal(delta.originalAuto.get("one")?.truckId, "truck-a");
});

test("planning forecasts the final displayed Gantt week all the way to Saturday", () => {
  const result = dailyForecast(settings, [], [], [], [], today);
  const lastDay = "2027-01-16"; // Saturday of the last +84-day week from 2026-10-18
  assert.ok(result.points.some((p) => p.date === lastDay),
    "the final displayed week cannot have a truncated six-day forecast");
});

test("weekly save collects all new violations even if earlier invalid history remains", () => {
  const week = "2026-10-25";
  const old = { ...emptyWeek(week), packaging: [
    { id: "a", productId: ipa.id, quantity: 252, tankId: "tank-a", date: "2026-10-26" },
  ] };
  const revised = { ...old, packaging: [...old.packaging,
    { id: "b", productId: ipa.id, quantity: 252, tankId: "tank-b", date: "2026-10-26" }] };
  const violations = planningWeekIssues(revised, settings, [revised], "2026-10-23");
  assert.ok(violations.some((x) => x.includes("2026-10-26") && x.includes("קיבולת")));
  const err = validatePlanningDecisionChange({
    before: [old], after: [revised], edited: revised, previous: old,
    settings, tanks: [], sources: [], actuals: [], today: "2026-10-23",
  });
  assert.ok(err?.includes("קיבולת"), "capacity is blocked by the shared save path");
});

test("changing only the weekly run limit re-evaluates already assigned packaging", () => {
  const old = { ...emptyWeek("2026-10-25"), maxRuns: 4, packaging: [
    { id: "day-a", productId: ipa.id, quantity: 84, tankId: "t", date: "2026-10-26" },
    { id: "day-b", productId: ipa.id, quantity: 84, tankId: "t", date: "2026-10-27" },
  ] };
  const revised = { ...old, maxRuns: 1 };
  const err = validatePlanningDecisionChange({
    before: [old], after: [revised], edited: revised, previous: old,
    settings, tanks: [], sources: [], actuals: [], today: "2026-10-23",
  });
  assert.match(err ?? "", /ימי האריזה/);
});

test("a third truck needs an explicit weekly exception", () => {
  const deliveries = ["a", "b", "c"].map((id, idx) => ({
    id, truckId: id, productId: ipa.id, quantity: 84,
    dispatchDate: "2026-10-26", arrivalDate: "2026-10-26", 
  }));
  const week = { ...emptyWeek("2026-10-25"), deliveries };
  assert.match(planningWeekIssues(week, settings, [week], "2026-10-23").join(" "), /עד 2 משלוחים/);
  assert.ok(!planningWeekIssues({ ...week, allowExceptions: true },
    { ...settings, maxWeeklyDeliveries: 2 }, [week], "2026-10-23")
    .some((issue) => issue.includes("עד 2 משלוחים")));
});

test("normal brewery shifts reject Sunday and Thursday but allow Monday–Wednesday", () => {
  const week = { ...emptyWeek("2026-10-25"), brews: [
    { id: "sunday", style: "IPA", tankId: "", liters: 1960, date: "2026-10-25" },
    { id: "thursday", style: "IPA", tankId: "", liters: 1960, date: "2026-10-29" },
  ] };
  assert.equal(planningWeekIssues(week, settings, [week], "2026-10-23")
    .filter((issue) => issue.includes("שני–רביעי")).length, 2);
  assert.equal(planningWeekIssues({ ...week, allowExceptions: true },
    settings, [week], "2026-10-23")
    .filter((issue) => issue.includes("שני–רביעי")).length, 0);
});

test("editing the Wednesday truck retains Wednesday dispatch, receipt date and unchanged pallet picks", () => {
  const selected = { ...pallet, id: "FEFO-A" };
  const existing = [{
    id: "stable-ipa", truckId: "wed-truck", productId: ipa.id,
    quantity: 84, dispatchDate: "2026-10-28", arrivalDate: "2026-10-29",
    pallets: [selected],
  }];
  const edited = replaceShipmentTrip({
    deliveries: existing, truckId: "wed-truck", defaultDate: "2026-10-26",
    products: [ipa], draft: { [ipa.id]: 84 },
    createId: () => "new",
  });
  assert.equal(edited.length, 1);
  assert.equal(edited[0].id, "stable-ipa");
  assert.equal(edited[0].dispatchDate, "2026-10-28");
  assert.equal(edited[0].arrivalDate, "2026-10-29");
  assert.deepEqual(edited[0].pallets, [selected]);
  const resized = replaceShipmentTrip({
    deliveries: edited, truckId: "wed-truck", defaultDate: "2026-10-26",
    products: [ipa], draft: { [ipa.id]: 168 },
    createId: () => "new",
  });
  assert.deepEqual(resized[0].pallets, [], "old physical picks cannot represent a larger quantity");
});

test("editing truck B never mutates truck A or its pallet selections", () => {
  const original = [
    { id: "a", truckId: "A", productId: ipa.id, quantity: 84,
      dispatchDate: "2026-10-26", arrivalDate: "2026-10-26", pallets: [{ ...pallet, id: "a-pallet" }] },
    { id: "b", truckId: "B", productId: ipa.id, quantity: 84,
      dispatchDate: "2026-10-28", arrivalDate: "2026-10-28" },
  ];
  const changed = replaceShipmentTrip({
    deliveries: original, truckId: "B", defaultDate: "2026-10-26",
    products: [ipa], draft: { [ipa.id]: 168 },
    createId: () => "new",
  });
  assert.deepEqual(changed.find((row) => row.truckId === "A"), original[0]);
  assert.equal(changed.find((row) => row.truckId === "B")?.dispatchDate, "2026-10-28");
});

test("legacy shipmentAdvice and future truck planning both use FEFO before FIFO", () => {
  const oldBrewLaterExpiry = { ...pallet, id: "older-batch",
    batchNumber: "10", expiryDateStr: "31/12/2026" };
  const newerBrewEarlierExpiry = { ...pallet, id: "newer-batch",
    batchNumber: "11", expiryDateStr: "31/10/2026" };
  const tanks: Tank[] = [
    { id: "a", number: "2", batch: "10", style: "IPA",
      brewed: "2026-08-01", ready: "2026-09-01", liters: 0, cold: true },
    { id: "b", number: "3", batch: "11", style: "IPA",
      brewed: "2026-09-01", ready: "2026-10-01", liters: 0, cold: true },
  ];
  const advice = shipmentAdvice(ipa, [oldBrewLaterExpiry, newerBrewEarlierExpiry],
    tanks, { ...settings, targetWeeks: 5 }, "2026-10-18");
  assert.equal(advice.picks[0]?.id, "newer-batch");
});

test("one stable truck identifier cannot silently describe two different departure dates", () => {
  const week = { ...emptyWeek("2026-10-25"), deliveries: [
    { id: "line-a", truckId: "repeat", productId: ipa.id, quantity: 84,
      dispatchDate: "2026-10-26", arrivalDate: "2026-10-26" },
    { id: "line-b", truckId: "repeat", productId: ipa.id, quantity: 84,
      dispatchDate: "2026-10-28", arrivalDate: "2026-10-28" },
  ] };
  assert.ok(planningWeekIssues(week, settings, [week], "2026-10-23")
    .some((issue) => issue.includes("שני תאריכי יציאה")));
});

test("brewery packaging capacity agrees between recommendations and hard save validation", () => {
  assert.equal(packagingLimit("2026-10-25", "kegs"), 100, "Sunday shorter shift");
  assert.equal(packagingLimit("2026-10-26", "kegs"), 150, "Monday production shift");
  assert.equal(packagingLimit("2026-10-27", "kegs"), 150, "Tuesday");
  assert.equal(packagingLimit("2026-10-28", "kegs"), 150, "Wednesday");
  assert.equal(packagingLimit("2026-10-29", "kegs"), 150, "Thursday");
  const kegs: Product = { ...ipa, id: "ipa-kegs", sku: "ipa-kegs", type: "kegs" };
  const kegSettings = { ...defaultSettings(), products: [kegs] };
  const make = (quantity: number, date: string) => ({
    ...emptyWeek("2026-10-25"), packaging: [{
      id: "keg-run", productId: kegs.id, quantity, date,
    }],
  });
  const exceeding = make(151, "2026-10-27");
  assert.ok(planningWeekIssues(exceeding, kegSettings, [exceeding], "2026-10-23")
    .some((x) => x.includes("קיבולת 150")));
  const sunday = make(101, "2026-10-25");
  assert.ok(planningWeekIssues(sunday, kegSettings, [sunday], "2026-10-23")
    .some((x) => x.includes("קיבולת 100")));
  const valid = make(150, "2026-10-27");
  assert.ok(!planningWeekIssues(valid, kegSettings, [valid], "2026-10-23")
    .some((x) => x.includes("קיבולת")));
  const exception = { ...exceeding, allowExceptions: true };
  assert.ok(!planningWeekIssues(exception, kegSettings, [exception], "2026-10-23")
    .some((x) => x.includes("קיבולת")), "explicit approved exceptions retain legacy freedom");
});

test("a new physical packaging error is not masked by a different legacy invalid tank", () => {
  const beforeWeek = { ...emptyWeek("2026-10-25"), packaging: [
    { id: "old-invalid", productId: ipa.id, tankId: "unknown-1",
      quantity: 20, date: "2026-10-26" },
  ] };
  const afterWeek = { ...beforeWeek, packaging: [
    ...beforeWeek.packaging,
    { id: "new-invalid", productId: ipa.id, tankId: "unknown-2",
      quantity: 20, date: "2026-10-27" },
  ] };
  const previous = validateProductionIssues([beforeWeek], settings, [], [], "2026-10-23");
  const after = validateProductionIssues([afterWeek], settings, [], [], "2026-10-23");
  assert.equal(previous.length, 1);
  assert.equal(after.length, 2, "collect errors on BOTH affected physical tanks");
  assert.equal(new Set(after.map((issue) => issue.key)).size, 2);
  assert.ok(validatePlanningDecisionChange({
    before: [beforeWeek], after: [afterWeek], previous: beforeWeek,
    edited: afterWeek, settings, tanks: [], sources: [], actuals: [],
    today: "2026-10-23",
  })?.includes("חסר מיכל מקור"), "the new error must block saving");
});

test("an old missing-capacity brew cannot mask another missing-capacity future brew", () => {
  const beforeWeek = { ...emptyWeek("2026-10-25"), brews: [
    { id: "old-brew", tankId: "unknown-1", style: "IPA", liters: 1100,
      date: "2026-10-26" },
  ] };
  const afterWeek = { ...beforeWeek, brews: [
    ...beforeWeek.brews,
    { id: "new-brew", tankId: "unknown-2", style: "IPA", liters: 1100,
      date: "2026-10-27" },
  ] };
  const beforeIssues = validateBrewReleaseIssues([], [], [beforeWeek],
    settings, [], "2026-10-23");
  const afterIssues = validateBrewReleaseIssues([], [], [afterWeek],
    settings, [], "2026-10-23");
  assert.equal(beforeIssues.length, 1);
  assert.equal(afterIssues.length, 2);
  assert.ok(validatePlanningDecisionChange({
    before: [beforeWeek], after: [afterWeek], previous: beforeWeek,
    edited: afterWeek, settings, tanks: [], sources: [], actuals: [],
    today: "2026-10-23",
  })?.includes("חסר נפח עבודה"));
});
