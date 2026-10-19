import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultSettings, emptyWeek, type BrewPlan, type Tank } from "../src/SERVICES/planning/planningEngine";
import { assignAvailableTanks, mayReorderInitialBrews } from "../src/SERVICES/planning/brewAssignmentDraft";
import { validateBrewReleases, type Release } from "../src/SERVICES/planning/productionCycle";
import { withTentativeFiveWeekTanks } from "../src/SERVICES/planning/tentativePackaging";

const tanks = [
  { id: "tank-7", tankNumber: 7 },
  { id: "tank-12", tankNumber: 12 },
];
const releases: Release[] = tanks.map((tank) => ({
  tankId: tank.id, date: "2026-10-19", emptyDate: null,
  remaining: 0, workLiters: tank.tankNumber === 7 ? 2200 : 3000,
  reason: "available",
}));

const brew = (id: string, style: string, date: string, liters: number, tankId = ""): BrewPlan =>
  ({ id, style, tankId, date, liters });

test("saved IPA assignment on tank 12 is preserved without a persisted batch number", () => {
  const ipa = brew("ipa", "IPA", "2026-10-26", 3000, "tank-12");
  const wheat = brew("wheat", "חיטה", "2026-10-27", 2100);
  assert.equal(mayReorderInitialBrews([ipa, wheat]), false);

  const proposed = assignAvailableTanks([ipa, wheat], tanks, releases, "2026-10-31");
  assert.equal(proposed[0].tankId, "tank-12");
  assert.equal(proposed[0].tankAssignmentStatus, undefined);
  assert.equal(proposed[0].date, "2026-10-26");
  assert.equal(proposed[1].tankId, "tank-7");
  assert.equal(proposed[1].tankAssignmentStatus, "tentative");
});

test("saved slots later in the brew order are reserved before filling empty slots", () => {
  const wheat = brew("wheat", "חיטה", "2026-10-26", 2100);
  const pale = brew("pale", "פייל", "2026-10-27", 3200, "tank-12");
  const proposed = assignAvailableTanks([wheat, pale], tanks, releases, "2026-10-31");
  assert.deepEqual(proposed.map((item) => item.tankId), ["tank-7", "tank-12"]);
});

test("unassigned IPA can only be suggested a triple tank, not tank 7", () => {
  const ipa = brew("ipa", "IPA", "2026-11-02", 3000);
  assert.equal(mayReorderInitialBrews([ipa]), true);
  const proposed = assignAvailableTanks([ipa], tanks, releases, "2026-11-07");
  assert.equal(proposed[0].tankId, "tank-12");
});

test("display-only five-week tank guesses cause a phantom inter-week overlap if promoted to saved assignments", () => {
  const settings = defaultSettings();
  const week25 = {
    ...emptyWeek("2026-10-25"),
    brews: [brew("wheat-1612", "חיטה", "2026-10-26", 2100)],
  };
  const week1 = {
    ...emptyWeek("2026-11-01"),
    brews: [brew("ipa-future", "IPA", "2026-11-02", 3000)],
  };
  const raw = [week25, week1];
  const physicalTanks: Tank[] = tanks.map((tank) => ({
    id: tank.id, number: String(tank.tankNumber),
    style: "פייל", batch: "", brewed: "", ready: "2026-10-19",
    liters: 0, cold: false,
  }));

  // The five-week display can propose tank 7 for BOTH weeks (and even
  // propose an undersized double tank for a 3000L IPA). These are never
  // persisted decisions and must NOT enter the daily editor validation inputs.
  const displayOnly = withTentativeFiveWeekTanks(raw, physicalTanks, settings);
  assert.equal((displayOnly[0].brews[0] as BrewPlan & { tentativeTankId?: string }).tentativeTankId, "tank-7");
  assert.equal((displayOnly[1].brews[0] as BrewPlan & { tentativeTankId?: string }).tentativeTankId, "tank-7");
  assert.equal(raw[1].brews[0].tankId, "");

  const committedWeek25 = {
    ...week25, brews: [brew("wheat-1612", "חיטה", "2026-10-26", 2100, "tank-7")],
  };
  const phantomFuture = {
    ...week1,
    brews: [{ ...week1.brews[0], tankId: "tank-7", tankAssignmentStatus: "tentative" as const }],
  };
  const sources = tanks.map((tank) => ({
    ...tank, action: 4, tankStatus: true,
  }));
  assert.match(validateBrewReleases(
    sources, physicalTanks, [committedWeek25, phantomFuture], settings, [],
    "2026-10-19", committedWeek25.id,
  ) ?? "", /מתנגש/);

  // The canonical plan is still unassigned in week 1/11. It must not block
  // saving the confirmed 25/10 Wheat brew on tank 7.
  assert.equal(validateBrewReleases(
    sources, physicalTanks, [committedWeek25, week1], settings, [],
    "2026-10-19", committedWeek25.id,
  ), null);
});
