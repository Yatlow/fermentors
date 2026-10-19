import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultSettings, emptyWeek, type Tank, type WeekPlan,
} from "../src/SERVICES/planning/planningEngine";
import {
  tankReleases, validateBrewReleases, type TankSource,
} from "../src/SERVICES/planning/productionCycle";
import { projectTankSchedules } from "../src/SERVICES/planning/tankScheduleProjection";

const settings = {
  ...defaultSettings(),
  products: [
    { id: "pale-kegs", sku: "pale-kegs", style: "פייל", type: "kegs" as const,
      monthly: 100, tempo: 0, tempoDate: "2026-10-01", leadDays: 21 },
    { id: "wheat-kegs", sku: "wheat-kegs", style: "חיטה", type: "kegs" as const,
      monthly: 100, tempo: 0, tempoDate: "2026-10-01", leadDays: 21 },
    { id: "ipa-kegs", sku: "ipa-kegs", style: "IPA", type: "kegs" as const,
      monthly: 100, tempo: 0, tempoDate: "2026-10-01", leadDays: 21 },
  ],
};
const today = "2026-10-19";
const tank: Tank = {
  id: "tank-7", number: "7", batch: "1609", style: "פייל",
  brewed: "2026-10-05", ready: "2026-10-19", liters: 2340, cold: true,
};
const sources: TankSource[] = [
  { id: "tank-7", tankNumber: 7, batchNumber: "1609", brewDate: "05/10/2026",
    beerStyle: "פייל", beerVolume: 2340, action: 1, tankStatus: false },
  { id: "tank-12", tankNumber: 12, action: 4, tankStatus: true },
  { id: "tank-13", tankNumber: 13, action: 4, tankStatus: true },
];

function fixture(options?: { completeEmptying?: boolean; nextBrew?: boolean }): WeekPlan[] {
  const prior = {
    ...emptyWeek("2026-10-04"),
    brews: [{
      id: "old-pale", style: "פייל", tankId: "tank-7", date: "2026-10-05",
      liters: 2200, batchNumber: "1608", // stale forecast; physical batch is 1609
    }],
  };
  const pack = {
    ...emptyWeek("2026-10-18"),
    packaging: [{
      id: "pale-tank7-final", productId: "pale-kegs",
      quantity: options?.completeEmptying === false ? 80 : 117,
      tankId: "tank-7", tankNumber: "7", batchNumber: "1609",
      date: "2026-10-22", emptyTank: options?.completeEmptying !== false,
    }],
  };
  const next = {
    ...emptyWeek("2026-10-25"),
    brews: [
      { id: "brew-1610", style: "IPA", tankId: "tank-12", date: "2026-10-26", liters: 3000, batchNumber: "1610" },
      { id: "brew-1611", style: "פייל", tankId: "tank-13", date: "2026-10-27", liters: 3200, batchNumber: "1611" },
      { id: "brew-1612", style: "חיטה", tankId: "tank-7", date: "2026-10-28", liters: 2100, batchNumber: "1612" },
    ],
  };
  const weeks: WeekPlan[] = [prior, pack, next];
  if (options?.nextBrew) weeks.push({
    ...emptyWeek("2026-11-08"),
    brews: [{ id: "overlap-tank7", style: "פייל", tankId: "tank-7",
      date: "2026-11-09", liters: 2200, batchNumber: "1625" }],
  });
  return weeks;
}

test("tank 7 can host wheat after the proven physical Pale 1609 emptying, despite stale forecast batch 1608", () => {
  const plans = fixture();
  const release = tankReleases(sources, [tank], plans, settings, [], today)[0];
  assert.equal(release.emptyDate, "2026-10-22");
  assert.equal(release.date, "2026-10-26");
  // Strict identity projection intentionally cannot link physical #1609 packaging
  // to stale planned #1608. The validation reconciles only the physical release.
  assert.equal(projectTankSchedules(plans, settings).get("tank-7")?.[0].emptyDate, undefined);
  assert.equal(validateBrewReleases(sources, [tank], plans, settings, [], today, "2026-10-25"), null);
});

test("a partial Pale packaging without an emptying does not free tank 7", () => {
  const failure = validateBrewReleases(
    sources, [tank], fixture({ completeEmptying: false }), settings, [], today, "2026-10-25",
  );
  assert.match(failure ?? "", /מיכל 7/);
  assert.match(failure ?? "", /1608/);
  assert.match(failure ?? "", /ללא ריקון/);
});

test("a valid old release cannot conceal a later overlapping planned cycle", () => {
  const failure = validateBrewReleases(
    sources, [tank], fixture({ nextBrew: true }), settings, [], today, "2026-10-25",
  );
  assert.match(failure ?? "", /מיכל 7/);
  assert.match(failure ?? "", /1625/);
});

test("physical tank batch mismatch is not accepted as evidence for closing a different planned cycle", () => {
  const otherTank = { ...tank, batch: "9999" };
  const failure = validateBrewReleases(
    sources, [otherTank], fixture(), settings, [], today, "2026-10-25",
  );
  assert.match(failure ?? "", /מיכל 7/);
  assert.match(failure ?? "", /1608/);
});
