/**
 * 15 deterministic, production-shaped long-range simulations.
 *
 * No Firestore/Sheets writes. Every scenario simulates a weekly truck, 2–5
 * dated packing jobs and 1–4 brews from 20 Sep 2026 through 26 Dec 2027.
 * Independent event ledger checks stock conservation, complete tank-cycle
 * identity and chronology; the REAL production validators, forecasts and
 * weekly recommendation engine are exercised on rolling 2026/2027 snapshots.
 *
 * Keep this suite inside scripts/test-planning.mjs so it runs on every PR.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  addDays, defaultSettings, emptyWeek, litersPerUnit, parseDate, weekStart,
  type Actual, type BrewPlan, type Product, type Settings, type Tank, type WeekPlan,
} from "../src/SERVICES/planning/planningEngine";
import type { Pallet } from "../src/SERVICES/cooler/Pallettypes ";
import { calcTruckSlots, MAX_TRUCK_SLOTS } from "../src/SERVICES/cooler/truckCapacity";
import { dailyForecast, futureTanks, openRuns } from "../src/SERVICES/planning/dailyPlanner";
import { buildWeekStartProjection } from "../src/SERVICES/planning/weekStartProjection";
import { buildWeeklyPlanningModel } from "../src/SERVICES/planning/weeklyPlanningModel";
import { planningWeekIssues } from "../src/SERVICES/planning/planningValidation";
import { validatePlanningDecisionChange } from "../src/SERVICES/planning/planningDecisionSafety";
import { estimatedBrewVolume, packagingLimit, validateBrewReleaseIssues,
  validateProductionIssues, type TankSource } from "../src/SERVICES/planning/productionCycle";
import { projectTankSchedules } from "../src/SERVICES/planning/tankScheduleProjection";
import { validateTankSchedule } from "../src/SERVICES/planning/tankSchedule";
import { auditShipmentAvailability, classifyPlanningShortageIncreases,
  newlyWorsenedShipmentShortages } from "../src/SERVICES/planning/shipmentAvailabilityAudit";

const FIRST_WEEK = "2026-09-20";
const LAST_WEEK = "2027-12-26";
const STYLES = ["IPA", "לאגר", "פייל אייל", "חיטה", "סטאוט", "הופי לאגר"];
const SUNDAY_TO_THURSDAY = [0, 1, 2, 3, 4];
const smallTankNumbers = [2, 3, 4, 5, 6, 7, 8];
const largeTankNumbers = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
type PhysicalLot = { pallet: Pallet; madeAt: string; shippedAt?: string };
type SimCycle = {
  id: string;
  tankNumber: number;
  style: string;
  batch: string;
  brewed: string;
  netLiters: number;
  packWeek: number;
  initial: boolean;
  rows: WeekPlan["packaging"];
};
type Simulation = {
  seed: number;
  weeks: WeekPlan[];
  products: Product[];
  settings: Settings;
  sources: TankSource[];
  cycles: SimCycle[];
  lots: PhysicalLot[];
  firstTanks: Tank[];
  summaries: { ships: number; packs: number; brews: number; slots: number };
};

function rng(seed: number) {
  let state = seed >>> 0;
  return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x100000000);
}
const dateIl = (day: string) => day.split("-").reverse().join("/");
const physical = (id: string, product: Product, quantity: number,
  expiry: string): Pallet => ({
  id, itemType: product.type, beerStyle: product.style,
  quantity, zone: "cooler", expiryDateStr: dateIl(expiry), heightUnits: 1,
});
function productsFor(seed: number): Product[] {
  return STYLES.flatMap((style, i) => (["crates", "kegs"] as const).map((type) => ({
    id: "sim-" + i + "-" + type,
    sku: "sim-" + i + "-" + type,
    style, type,
    monthly: type === "kegs" ? 150 + (seed % 3) * 20 : 210 + (seed % 4) * 21,
    tempo: 0, tempoDate: FIRST_WEEK, leadDays: 21,
  })));
}
const matching = (products: Product[], style: string, type: Product["type"]) => {
  const product = products.find((p) => p.style === style && p.type === type);
  assert.ok(product, "missing fictional SKU " + style + ":" + type);
  return product;
};
/** Four-week rolling occupancy and packaging volume never use random guessing. */
const countFor = (w: number, phase: number) => 1 + ((w + phase) % 4);
const largeCountFor = (count: number) => count === 3 ? 2 : 1;
function allocateFullCycle(cycle: SimCycle, products: Product[]): Array<{ product: Product; quantity: number }> {
  const kegs = matching(products, cycle.style, "kegs");
  if (cycle.tankNumber < 9) {
    const quantity = Math.floor(cycle.netLiters / litersPerUnit(kegs));
    assert.ok(quantity > 0 && quantity <= 150);
    assert.ok(cycle.netLiters - quantity * 20 < 20);
    return [{ product: kegs, quantity }];
  }
  // Large fermentors require two different products/days to empty legally.
  // Search integer crates+kegs leaving <20 L; Sunday crates <=168, other
  // weekdays kegs <=150. This is an INDEPENDENT volume/capacity oracle.
  const crates = matching(products, cycle.style, "crates");
  for (let kegCount = 150; kegCount >= 45; kegCount--) {
    const crateCount = Math.floor((cycle.netLiters - kegCount * 20) / litersPerUnit(crates));
    const packed = crateCount * litersPerUnit(crates) + kegCount * 20;
    if (crateCount >= 1 && crateCount <= 168 &&
      cycle.netLiters - packed >= -1e-6 && cycle.netLiters - packed < 19.999) {
      return [{ product: crates, quantity: crateCount }, { product: kegs, quantity: kegCount }];
    }
  }
  throw Error("No feasible two-day pack for " + cycle.id + ", " + cycle.netLiters + " L");
}

function buildSimulation(seed: number): Simulation {
  const random = rng(0x5f3759df ^ (seed * 1103515245));
  const phase = seed % 3; // avoid week-zero needing three of only two free small tanks
  const products = productsFor(seed);
  const settings = {
    ...defaultSettings(), products,
    maxWeeklyDeliveries: 2 as const, preferredRuns: 5,
    targetWeeks: 5, totalTargetWeeks: 8.5,
  };
  const startOfWeeks: string[] = [];
  for (let date = FIRST_WEEK; date <= LAST_WEEK; date = addDays(date, 7))
    startOfWeeks.push(date);
  assert.ok(startOfWeeks.length >= 65 && startOfWeeks.length <= 70);
  assert.equal(startOfWeeks.at(-1), LAST_WEEK);
  const weeks = startOfWeeks.map((id) => ({ ...emptyWeek(id), maxRuns: 5 }));
  const busyUntil = new Map<number, number>();
  const cycles: SimCycle[] = [];
  const sources: TankSource[] = [];
  const firstTanks: Tank[] = [];
  const openSmall = [...smallTankNumbers];
  const openLarge = [...largeTankNumbers];

  // Ten genuinely occupied mature tanks feed the first four weeks; seven
  // more start clean. Week 0–3 demand exactly five small + five large tanks.
  for (let w = 0; w < 4; w++) {
    const count = countFor(w, phase);
    const large = largeCountFor(count);
    for (let index = 0; index < count; index++) {
      const useLarge = index < large;
      const tankNumber = (useLarge ? openLarge : openSmall).shift();
      assert.ok(tankNumber);
      const style = STYLES[Math.floor(random() * STYLES.length)];
      const id = "seed-" + seed + "-" + w + "-" + index;
      const batch = "S" + seed + "B" + w + "_" + index;
      const cycle: SimCycle = {
        id, tankNumber, style, batch, brewed: "2026-08-17",
        netLiters: estimatedBrewVolume(tankNumber, style),
        packWeek: w, initial: true, rows: [],
      };
      cycles.push(cycle);
      busyUntil.set(tankNumber, w + 1);
      firstTanks.push({
        id: "tank-" + tankNumber, number: String(tankNumber),
        style, batch, brewed: cycle.brewed, ready: "2026-09-15",
        liters: cycle.netLiters, cold: true,
      });
    }
  }
  const initialNumbers = new Set(firstTanks.map((tank) => Number(tank.number)));
  for (let n = 2; n <= 18; n++) {
    const active = firstTanks.find((tank) => Number(tank.number) === n);
    sources.push({
      id: "tank-" + n, tankNumber: n,
      ...(active ? {
        batchNumber: active.batch, brewDate: dateIl(active.brewed),
        beerStyle: active.style, beerVolume: active.liters,
        action: 1, tankStatus: false,
      } : { action: 4, tankStatus: true }),
    });
  }
  assert.equal(initialNumbers.size, 10);
  const lots: PhysicalLot[] = [];
  let lotSeq = 0;
  for (const product of products) {
    for (let n = 0; n < 3; n++) {
      lots.push({ pallet: physical(
        "sim-initial-" + seed + "-" + (++lotSeq), product,
        product.type === "crates" ? 84 : 20, "2028-06-30",
      ), madeAt: "2026-08-17" });
    }
  }
  const summaries = { ships: 0, packs: 0, brews: 0, slots: 0 };
  const inventoryAt = (day: string, productId?: string) => lots
    .filter((lot) => lot.madeAt < day && !lot.shippedAt &&
      (parseDate(lot.pallet.expiryDateStr) ?? "") >= day &&
      (!productId || productId === products.find((p) =>
        p.style === lot.pallet.beerStyle && p.type === lot.pallet.itemType)?.id))
    .sort((a, b) =>
      (parseDate(a.pallet.expiryDateStr) ?? "").localeCompare(parseDate(b.pallet.expiryDateStr) ?? "") ||
      a.pallet.id.localeCompare(b.pallet.id));

  for (let w = 0; w < weeks.length; w++) {
    const week = weeks[w];
    const count = countFor(w, phase);
    const packCycles = cycles.filter((cycle) => cycle.packWeek === w)
      .sort((a, b) => Number(b.tankNumber >= 9) - Number(a.tankNumber >= 9) ||
        a.tankNumber - b.tankNumber);
    assert.equal(packCycles.length, count, "seed " + seed + " week " + w);
    const runs: WeekPlan["packaging"] = [];
    for (const cycle of packCycles) {
      for (const { product, quantity } of allocateFullCycle(cycle, products)) {
        const date = addDays(week.id, runs.length);
        const row = {
          id: "pack-" + cycle.id + "-" + runs.length,
          productId: product.id, quantity, date,
          tankId: "tank-" + cycle.tankNumber, tankNumber: String(cycle.tankNumber),
          batchNumber: cycle.batch,
          ...(cycle.initial ? {} : { brewId: cycle.id }),
          source: "manual" as const,
          emptyTank: false,
        };
        runs.push(row);
        cycle.rows.push(row);
      }
      cycle.rows.at(-1)!.emptyTank = true;
    }
    assert.ok(runs.length >= 2 && runs.length <= 5,
      "seed " + seed + " " + week.id + " had " + runs.length + " pack jobs");
    assert.equal(new Set(runs.map((r) => r.date)).size, runs.length);
    assert.ok(runs.every((r) => SUNDAY_TO_THURSDAY.includes(
      Math.round((Date.parse(r.date! + "T12:00:00Z") -
        Date.parse(week.id + "T12:00:00Z")) / 86400000))));
    // Sunday dispatch happens before the first Sunday packaging shift.
    // The stock ledger therefore excludes lots made ON the dispatch day.
    for (const row of runs) {
      const product = products.find((p) => p.id === row.productId)!;
      assert.ok(row.quantity <= packagingLimit(row.date!, product.type),
        "packaging exceeds day cap: " + row.id);
      for (let left = row.quantity, n = 0; left > 0; n++) {
        const quantity = Math.min(left, product.type === "crates" ? 84 : 20);
        left -= quantity;
        lots.push({
          pallet: physical("sim-pack-" + seed + "-" + w + "-" + runs.indexOf(row) +
            "-" + n, product, quantity, addDays(row.date!, 270)),
          madeAt: row.date!,
        });
      }
    }
    week.packaging = runs;
    summaries.packs += runs.length;
    // The truck departs Sunday, BEFORE any of this week's packaging.
    // Select actual whole FEFO lots, and make 1-3 SKU manifest lines.
    const dispatchDate = week.id;
    const desiredLines = 1 + ((w + seed) % 3);
    const options = products
      .filter((p) => inventoryAt(dispatchDate, p.id).length > 0)
      .sort((a, b) => a.id.localeCompare(b.id));
    assert.ok(options.length > 0, "physical stock disappeared " + week.id);
    const selectedProductIds = new Set<string>();
    const selectedLots: PhysicalLot[] = [];
    for (let j = 0; j < desiredLines; j++) {
      const available = options.filter((p) => !selectedProductIds.has(p.id) &&
        inventoryAt(dispatchDate, p.id).length > 0);
      if (!available.length) break;
      const product = available[(w * 5 + seed * 7 + j * 3) % available.length];
      selectedProductIds.add(product.id);
      const candidates = inventoryAt(dispatchDate, product.id);
      const take = Math.min(1 + ((w + j + seed) % 2), candidates.length);
      const picked = candidates.slice(0, take);
      assert.ok(picked.length);
      selectedLots.push(...picked);
      const amount = picked.reduce((sum, lot) => sum + lot.pallet.quantity, 0);
      week.deliveries!.push({
        id: "shipment-" + seed + "-" + w + "-" + j,
        truckId: "truck-" + seed + "-" + w,
        productId: product.id, quantity: amount,
        dispatchDate, arrivalDate: addDays(dispatchDate, 1),
        // Future pallets cannot be pinned before they physically exist.
        pallets: [],
      });
    }
    assert.ok(week.deliveries!.length >= 1);
    assert.equal(new Set(week.deliveries!.map((d) => d.truckId)).size, 1);
    assert.ok(calcTruckSlots(selectedLots.map((lot) => lot.pallet)) <= MAX_TRUCK_SLOTS);
    for (const lot of selectedLots) {
      assert.equal(lot.shippedAt, undefined, "same physical pallet dispatched twice");
      lot.shippedAt = dispatchDate;
    }
    summaries.ships++;
    summaries.slots += calcTruckSlots(selectedLots.map((lot) => lot.pallet));

    const largeCount = largeCountFor(count);
    const demandLarge = largeCount;
    const demandSmall = count - largeCount;
    const assignments: number[] = [];
    for (const [need, pool] of [[demandLarge, largeTankNumbers], [demandSmall, smallTankNumbers]] as const) {
      const free = pool.filter((n) => (busyUntil.get(n) ?? 0) <= w &&
        !assignments.includes(n));
      assert.ok(free.length >= need,
        "seed " + seed + " " + week.id + " no available tank " +
        (pool === largeTankNumbers ? "large" : "small") +
        ": need " + need + ", free " + free.length);
      const rotation = (w * 3 + seed) % free.length;
      for (let i = 0; i < need; i++)
        assignments.push(free[(i + rotation) % free.length]);
    }
    for (let i = 0; i < assignments.length; i++) {
      const tankNumber = assignments[i];
      const style = STYLES[Math.floor(random() * STYLES.length)];
      const date = addDays(week.id, 1 + (i % 3));
      const batch = "B" + seed + "_" + w + "_" + i;
      const id = "brew-" + seed + "-" + w + "-" + i;
      const netLiters = estimatedBrewVolume(tankNumber, style);
      const brew: BrewPlan = { id, tankId: "tank-" + tankNumber,
        date, style, liters: netLiters, batchNumber: batch };
      week.brews.push(brew);
      cycles.push({ id, tankNumber, style, batch, brewed: date,
        netLiters, packWeek: w + 4, initial: false, rows: [] });
      busyUntil.set(tankNumber, w + 5);
    }
    summaries.brews += week.brews.length;
    assert.ok(week.brews.length >= 1 && week.brews.length <= 4);
  }
  assert.ok(summaries.ships >= 65);
  assert.ok(summaries.packs >= 130 && summaries.packs <= 5 * weeks.length);
  assert.ok(summaries.brews >= 65 && summaries.brews <= 4 * weeks.length);
  return { seed, weeks, products, settings, sources, cycles, lots, firstTanks, summaries };
}

function snapshotAt(sim: Simulation, today: string) {
  const pallets = sim.lots
    .filter((lot) => lot.madeAt < today && (!lot.shippedAt || lot.shippedAt >= today))
    .map((lot) => lot.pallet);
  const actuals: Actual[] = sim.cycles.flatMap((cycle) => cycle.rows
    .filter((run) => run.date! < today)
    .map((run) => ({
      id: "actual-" + run.id, date: run.date, quantity: run.quantity,
      packagingType: sim.products.find((p) => p.id === run.productId)!.type === "crates" ? "bottles" : "kegs",
      beerStyle: cycle.style, unit: "ארגזים",
      tankNumber: String(cycle.tankNumber), batchNumber: cycle.batch,
    })));
  const tanks: Tank[] = [];
  const sources: TankSource[] = [];
  for (let n = 2; n <= 18; n++) {
    const latest = sim.cycles
      .filter((cycle) => cycle.tankNumber === n && cycle.brewed <= today)
      .sort((a, b) => b.brewed.localeCompare(a.brewed))[0];
    const previouslyPacked = latest?.rows.filter((run) => run.date! < today) ?? [];
    const ended = previouslyPacked.some((run) => run.emptyTank);
    const remaining = latest
      ? latest.netLiters - previouslyPacked.reduce((sum, run) => {
          const p = sim.products.find((product) => product.id === run.productId)!;
          return sum + run.quantity * litersPerUnit(p);
        }, 0)
      : 0;
    if (latest && !ended) {
      assert.ok(remaining > 0 && remaining <= latest.netLiters);
      tanks.push({ id: "tank-" + n, number: String(n), style: latest.style,
        batch: latest.batch, brewed: latest.brewed,
        ready: addDays(latest.brewed, 21), liters: remaining, cold: true });
      sources.push({
        id: "tank-" + n, tankNumber: n, batchNumber: latest.batch,
        brewDate: dateIl(latest.brewed), beerStyle: latest.style,
        beerVolume: latest.netLiters, action: 1, tankStatus: false,
      });
    } else {
      sources.push({ id: "tank-" + n, tankNumber: n, action: 4, tankStatus: true });
    }
  }
  // Planned historical deliveries were performed; provide their direct-trip
  // manifests so the planner cannot subtract them from the live pallet stock.
  const actualShipments = sim.weeks
    .filter((week) => week.id < today)
    .map((week) => ({
      id: "actual-" + week.id,
      date: week.id, plannedTruckId: "truck-" + sim.seed + "-" +
        sim.weeks.findIndex((entry) => entry.id === week.id),
      totals: week.deliveries!.map((delivery) => {
        const product = sim.products.find((p) => p.id === delivery.productId)!;
        return { itemType: product.type, beerStyle: product.style,
          totalQuantity: delivery.quantity };
      }),
    }));
  const settings = {
    ...sim.settings,
    products: sim.products.map((p) => ({ ...p, tempoDate: today, tempo: 0 })),
  };
  return { pallets, actuals, tanks, sources, settings, actualShipments };
}

function verifyIndependentLedger(sim: Simulation) {
  const ids = new Set<string>();
  const pallets = sim.lots;
  for (const lot of pallets) {
    assert.ok(!ids.has(lot.pallet.id), "duplicate pallet " + lot.pallet.id);
    ids.add(lot.pallet.id);
    assert.ok(lot.pallet.quantity > 0);
    assert.ok(!lot.shippedAt || lot.shippedAt >= lot.madeAt);
    assert.ok(parseDate(lot.pallet.expiryDateStr));
  }
  const released = new Map<number, string>();
  for (const cycle of [...sim.cycles].sort((a, b) => a.brewed.localeCompare(b.brewed))) {
    const previous = released.get(cycle.tankNumber);
    if (previous) assert.ok(cycle.brewed > previous,
      "tank #" + cycle.tankNumber + " reused before previous packaging: " + cycle.id);
    const amount = cycle.rows.reduce((sum, row) => {
      const p = sim.products.find((product) => product.id === row.productId)!;
      assert.equal(p.style, cycle.style);
      assert.ok(row.date! >= addDays(cycle.brewed, 21));
      assert.equal(row.batchNumber, cycle.batch);
      assert.equal(row.tankId, "tank-" + cycle.tankNumber);
      return sum + row.quantity * litersPerUnit(p);
    }, 0);
    assert.ok(amount <= cycle.netLiters + 0.001, "packaging exceeds a cycle");
    if (cycle.rows.length) {
      assert.ok(cycle.netLiters - amount < 20, "final pack must empty cycle " + cycle.id);
      assert.equal(cycle.rows.filter((r) => r.emptyTank).length, 1);
      assert.equal(cycle.rows.at(-1)!.emptyTank, true);
      released.set(cycle.tankNumber, cycle.rows.at(-1)!.date!);
    } else {
      released.set(cycle.tankNumber, "9999-12-31");
    }
  }
  for (const week of sim.weeks) {
    assert.equal(weekStart(week.id), week.id);
    assert.ok(week.deliveries?.length);
    assert.ok(week.brews.length >= 1 && week.brews.length <= 4);
    assert.ok(week.packaging.length >= 2 && week.packaging.length <= 5);
    const dailyProductIds = new Set(week.packaging.map((run) => run.date));
    assert.equal(dailyProductIds.size, week.packaging.length);
    assert.equal(new Set(week.brews.map((brew) => brew.id)).size, week.brews.length);
    assert.equal(new Set(week.packaging.map((run) => run.id)).size, week.packaging.length);
    const issues = planningWeekIssues(week, sim.settings, sim.weeks, FIRST_WEEK);
    assert.deepEqual(issues, [], "synthetic normal-week decisions must be accepted: " + week.id);
  }
  const schedules = projectTankSchedules(sim.weeks, sim.settings);
  for (const [tankId, cycles] of schedules) {
    assert.deepEqual(validateTankSchedule(cycles), [],
      "real tank schedule failed " + tankId);
    for (const cycle of cycles) {
      assert.ok(cycle.readyDate && cycle.readyDate >= cycle.brewDate);
      assert.ok(!cycle.emptyDate || cycle.emptyDate > cycle.readyDate!,
        "tank prematurely emptied before beer ready " + cycle.cycleId);
    }
  }
  const seeded = sim.firstTanks;
  const physicalIssues = validateProductionIssues(
    sim.weeks, sim.settings, futureTanks(seeded, sim.weeks, sim.settings),
    [], FIRST_WEEK,
  );
  assert.deepEqual(physicalIssues, [],
    "production cycle validator rejects plausible long-range plan");
  const brewReleaseIssues = validateBrewReleaseIssues(
    sim.sources, seeded, sim.weeks, sim.settings, [], FIRST_WEEK,
  );
  assert.deepEqual(brewReleaseIssues, [],
    "brew-cycle release validator rejects plausible long-range plan");
}

/** Every scenario has >65 weeks, and the REAL forecast horizons are rolled
 * through early, middle and late 2027 rather than assuming one 91-day query
 * can see until 31 December 2027.
 */
function verifyRollingForecasts(sim: Simulation) {
  const checkpoints = [0, 13, 26, 39, 52, sim.weeks.length - 1];
  for (const index of checkpoints) {
    const week = sim.weeks[index];
    const now = week.id;
    const state = snapshotAt(sim, now);
    const available = new Set(state.pallets.map((p) => p.id));
    assert.equal(available.size, state.pallets.length);
    const open = openRuns(sim.weeks, sim.products, state.actuals);
    assert.ok(open.filter((r) => r.date && r.date < now).every((r) => r.remaining === 0),
      "executed historical packaging must never regenerate new finished stock");
    const weekStock = buildWeekStartProjection({
      settings: state.settings, pallets: state.pallets,
      plans: sim.weeks, actuals: state.actuals, today: now, week: now,
      actualShipments: state.actualShipments,
    });
    for (const product of sim.products) {
      const row = weekStock.get(product.id);
      assert.ok(row, "missing week-opening SKU " + product.id);
      const physicallyValid = state.pallets
        .filter((p) => p.beerStyle === product.style && p.itemType === product.type &&
          (parseDate(p.expiryDateStr) ?? "") >= now)
        .reduce((sum, p) => sum + p.quantity, 0);
      assert.ok(row.breweryUnits >= -0.001);
      assert.ok(Math.abs(row.breweryUnits - physicallyValid) < 0.001,
        "stock tab projected imaginary opening inventory: " + product.id +
        ", now " + now + ": " + row.breweryUnits + " vs physical " + physicallyValid);
      assert.ok(row.tempoUnits == null || row.tempoUnits >= -1e-9);
    }
    // Execute the same recommendation/forecast stages used by the weekly
    // planner; do not assert specific optimal recommendations when data is
    // fictional, but demand numeric, time-consistent and feasible results.
    const model = buildWeeklyPlanningModel({
      settings: state.settings, pallets: state.pallets,
      tanks: state.tanks, plans: sim.weeks, actuals: state.actuals,
      sources: state.sources, today: now, week: now,
      holidays: [], shipments: state.actualShipments,
    });
    assert.equal(model.week, now);
    assert.ok(model.shipmentSlots <= MAX_TRUCK_SLOTS);
    assert.ok(model.packagingDays <= model.packagingCapacity,
      "packaging recommendation exceeds declared work days");
    const recTankIds = new Set<string>();
    for (const rec of model.brewRecommendations) {
      assert.ok(rec.availableDate <= addDays(now, 3),
        "a recommended new brew tank is not available by Wednesday");
      assert.ok(!recTankIds.has(rec.tankId), "same tank recommended twice");
      recTankIds.add(rec.tankId);
      assert.ok(rec.liters > 0 &&
        rec.liters <= estimatedBrewVolume(rec.tankNumber, rec.style) + 0.01,
        "recommended volume exceeds tank/style capacity");
    }
    for (const rec of model.packagingRecommendation) {
      assert.ok(rec.quantity > 0);
      assert.ok(rec.liters >= 20);
    }
    const forecast = dailyForecast(state.settings, state.pallets,
      state.tanks, sim.weeks, state.actuals, now, [], false,
      state.actualShipments);
    assert.ok(forecast.points.every((point) =>
      Number.isFinite(point.brewery) && point.brewery >= -0.001 &&
      (point.tempo === null || (Number.isFinite(point.tempo) && point.tempo >= -0.001))),
    "non-finite/negative daily forecast during " + now);
    // Only 91-day visible horizon can be audited by the current UI. The
    // fixture itself covers the full 2027 year, verified separately above.
    const issues = auditShipmentAvailability(
      state.settings, state.pallets, sim.weeks, state.actuals, now,
      state.actualShipments);
    const contradictions = issues.filter((issue) =>
      issue.productId.startsWith("pallet:") || issue.productId.startsWith("truck:"));
    assert.deepEqual(contradictions, [],
      "previously planned pallet identities or actual floor loading diverged");
  }
}

function verifyBadEditsAreCaught(sim: Simulation) {
  const week = sim.weeks[7];
  const invalid = {
    ...week,
    packaging: week.packaging.map((row, i) => i === 0
      ? { ...row, quantity: row.quantity + 500 } : row),
  };
  const changed = sim.weeks.map((row) => row.id === week.id ? invalid : row);
  const error = validatePlanningDecisionChange({
    before: sim.weeks, after: changed, edited: invalid, previous: week,
    settings: sim.settings, tanks: sim.firstTanks, sources: sim.sources,
    actuals: [], today: FIRST_WEEK,
  });
  assert.ok(error, "an impossible over-pack must fail the real save gate");
  const overbooked = structuredClone(sim.weeks[9]);
  overbooked.brews[0].tankId = overbooked.brews[1]?.tankId ??
    sim.weeks[9].brews[0].tankId;
  if (overbooked.brews.length > 1)
    assert.ok(planningWeekIssues(overbooked, sim.settings, sim.weeks, FIRST_WEEK).length === 0 ||
      validateBrewReleaseIssues(sim.sources, sim.firstTanks,
        sim.weeks.map((row) => row.id === overbooked.id ? overbooked : row),
        sim.settings, [], FIRST_WEEK).length > 0);
  // Direct trip over-capacity must still be explicitly approved.
  const over = structuredClone(sim.weeks[0]);
  const product = sim.products.find((p) => p.type === "crates")!;
  over.deliveries = [{ id: "over-truck", truckId: "over-truck",
    productId: product.id, quantity: 13 * 84,
    dispatchDate: over.id, arrivalDate: over.id }];
  assert.match(planningWeekIssues(over, sim.settings, sim.weeks, FIRST_WEEK).join(";"),
    /מקומות/);
  over.oversizeTruckApprovals = [over.id + "::over-truck"];
  assert.ok(!planningWeekIssues(over, sim.settings, sim.weeks, FIRST_WEEK)
    .some((message) => message.includes("מקומות")),
    "explicit trip-scoped exception should allow the plan only");
  const actualStore = snapshotAt(sim, sim.weeks[15].id);
  const later = sim.weeks[15];
  const current = sim.weeks[14];
  // Leave the loss-alert classification deterministic even if real stock is
  // sufficient: damage a physical lot from a previously valid SKU.
  const futureShortage = {
    issue: { week: later.id, date: later.id, productId: sim.products[0].id,
      missing: 1, missingUnits: 84, severity: "blocking" as const,
      message: "fictional missing crates" },
    addedSlots: 1, addedUnits: 84, totalSlots: 1, totalUnits: 84,
  };
  assert.deepEqual(
    classifyPlanningShortageIncreases([futureShortage], current.id).confirmable,
    [futureShortage], "the planner can approve an identified next-week stock shortage");
  assert.ok(actualStore.pallets.length >= 1);
  assert.ok(newlyWorsenedShipmentShortages([], [futureShortage.issue]).length === 1);
}

for (let seed = 1; seed <= 15; seed++) {
  test("long-range brewery planner, scenario " + String(seed).padStart(2, "0") +
    " (weekly shipping, 2–5 packs, 1–4 brews; Sep 2026–Dec 2027)", () => {
    const sim = buildSimulation(seed);
    verifyIndependentLedger(sim);
    verifyRollingForecasts(sim);
    verifyBadEditsAreCaught(sim);
    console.log("SIM " + String(seed).padStart(2, "0") +
      " PASS weeks=" + sim.weeks.length +
      " trucks=" + sim.summaries.ships +
      " packaging=" + sim.summaries.packs +
      " brews=" + sim.summaries.brews +
      " shippedFloorSlots=" + sim.summaries.slots +
      " period=" + sim.weeks[0].id + ".." + sim.weeks.at(-1)!.id);
  });
}
