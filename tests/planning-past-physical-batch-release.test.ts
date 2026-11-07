import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultSettings, emptyWeek, type Actual, type Product, type Tank, type WeekPlan,
} from "../src/SERVICES/planning/planningEngine";
import {
  assignableTankReleasesForWeek, tankReleases, validateBrewReleases,
  type TankSource,
} from "../src/SERVICES/planning/productionCycle";
import { projectTankSchedules } from "../src/SERVICES/planning/tankScheduleProjection";
import { validatePlanningDecisionChange } from "../src/SERVICES/planning/planningDecisionSafety";

const today = "2026-11-08";
const ipa: Product = {
  id: "ipa-kegs", sku: "ipa-kegs", style: "IPA", type: "kegs",
  monthly: 100, tempo: 0, tempoDate: today, leadDays: 21,
};
const wheat: Product = {
  id: "wheat-crates", sku: "wheat-crates", style: "חיטה", type: "crates",
  monthly: 100, tempo: 0, tempoDate: today, leadDays: 21,
};
const pale: Product = {
  id: "pale-crates", sku: "pale-crates", style: "פייל", type: "crates",
  monthly: 100, tempo: 0, tempoDate: today, leadDays: 21,
};
const settings = { ...defaultSettings(), products: [ipa, wheat, pale] };
const prior: WeekPlan = {
  ...emptyWeek("2026-10-04"),
  brews: [{
    id: "ipa-1603", tankId: "tank-11", style: "IPA",
    date: "2026-10-05", liters: 3000, batchNumber: "1603",
  }],
};
const current: WeekPlan = {
  ...emptyWeek("2026-11-08"),
  brews: [{
    id: "new-ipa-1611", tankId: "tank-11", style: "IPA",
    date: "2026-11-09", liters: 3000, batchNumber: "1611",
  }],
  packaging: [
    { id: "pack-8", tankId: "tank-8", tankNumber: "8", batchNumber: "1605",
      productId: wheat.id, date: "2026-11-09", quantity: 80 },
    { id: "pack-14", tankId: "tank-14", tankNumber: "14", batchNumber: "1609",
      productId: pale.id, date: "2026-11-10", quantity: 90 },
  ],
};
const source: TankSource = {
  id: "tank-11", tankNumber: 11, batchNumber: "1611", brewDate: "09/11/2026",
  beerStyle: "IPA", action: 0, tankStatus: false,
};
const verifiedPackaging: Actual = {
  id: "report-1603", date: "2026-11-03", tankNumber: 11,
  batchNumber: "1603", beerStyle: "IPA", packagingType: "kegs", quantity: 151,
};
const plans = [prior, current];

test("a staged 9 Nov brew recognizes 1603's actual 3 Nov emptying, despite the old 5/6 Oct brew-date drift", () => {
  const releases = tankReleases([source], [], plans, settings, [verifiedPackaging], today);
  assert.equal(releases[0].emptyDate, "2026-11-03");
  assert.equal(releases[0].date, "2026-11-09");
  assert.deepEqual(releases[0].completedPhysicalCycles, [
    { cycleId: "ipa-1603", emptyDate: "2026-11-03" },
  ]);
  const original = projectTankSchedules(plans, settings).get("tank-11")!;
  assert.equal(original[0].emptyDate, undefined, "historical planning is not mutated");
  assert.equal(validateBrewReleases(
    [source], [], plans, settings, [verifiedPackaging], today,
  ), null);
  const available = assignableTankReleasesForWeek(
    releases, projectTankSchedules(plans, settings), [source], [],
    today, "2026-11-08", new Set(["new-ipa-1611"]),
  );
  assert.deepEqual(available.map((item) => item.tankId), ["tank-11"]);
});

test("no actual packaging record means no fabricated historical emptying", () => {
  const release = tankReleases([source], [], plans, settings, [], today)[0];
  assert.equal(release.completedPhysicalCycles, undefined);
  assert.match(validateBrewReleases([source], [], plans, settings, [], today) ?? "", /1603.*ללא ריקון/);
});

test("a report from another tank or batch cannot close cycle 1603", () => {
  for (const bad of [
    { ...verifiedPackaging, tankNumber: 12 },
    { ...verifiedPackaging, batchNumber: "1602" },
    { ...verifiedPackaging, beerStyle: "חיטה" },
  ]) {
    assert.match(validateBrewReleases([source], [], plans, settings, [bad], today) ?? "",
      /1603.*ללא ריקון/);
  }
});

test("a packaging report alone never frees a still-active tank", () => {
  const busy = { ...source, action: 1, tankStatus: false, batchNumber: "1603",
    brewDate: "06/10/2026" };
  const tank: Tank = {
    id: "tank-11", number: "11", style: "IPA", batch: "1603",
    brewed: "2026-10-06", ready: "2026-10-28", liters: 370, cold: true,
  };
  assert.match(validateBrewReleases(
    [busy], [tank], plans, settings, [verifiedPackaging], today,
  ) ?? "", /1603.*ללא ריקון/);
});

test("reassigning only the packaging days of tanks 8 and 14 cannot be blocked by historical 1603", () => {
  const physical: Tank[] = [
    { id: "tank-8", number: "8", style: "חיטה", batch: "1605",
      brewed: "2026-10-06", ready: "2026-10-27", liters: 2100, cold: true },
    { id: "tank-14", number: "14", style: "פייל", batch: "1609",
      brewed: "2026-10-07", ready: "2026-10-28", liters: 3200, cold: true },
  ];
  const sources: TankSource[] = [
    source,
    { id: "tank-8", tankNumber: 8, batchNumber: "1605", beerStyle: "חיטה",
      brewDate: "06/10/2026", beerVolume: 2100, action: 1 },
    { id: "tank-14", tankNumber: 14, batchNumber: "1609", beerStyle: "פייל",
      brewDate: "07/10/2026", beerVolume: 3200, action: 1 },
  ];
  const changed = {
    ...current,
    packaging: current.packaging.map((run) => ({
      ...run, date: run.id === "pack-8" ? "2026-11-10" : "2026-11-09",
    })),
  };
  assert.equal(validatePlanningDecisionChange({
    before: [prior, current], after: [prior, changed],
    edited: changed, previous: current, settings, tanks: physical,
    sources, actuals: [verifiedPackaging], today,
  }), null);
});
