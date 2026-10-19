import type { BrewPlan } from "./planningEngine";
import { brewSizeLabel, type Release } from "./productionCycle";

type AssignmentTank = {
  id: string;
  tankNumber?: string | number | null;
};

/** A planned tank or a real batch is a saved decision, not a reorderable suggestion. */
export function mayReorderInitialBrews(brews: BrewPlan[]): boolean {
  return brews.every((brew) =>
    !brew.tankId && !String(brew.batchNumber ?? "").replace("#", "").trim());
}

/**
 * Suggest a tank ONLY for brews that are genuinely unassigned.
 *
 * A tankId already saved in planningWeeks is a planner decision, even if the
 * forecast batchNumber has not been assigned yet. Never silently replace it
 * when opening the daily brew editor.
 */
export function assignAvailableTanks(
  brews: BrewPlan[],
  sources: AssignmentTank[],
  releases: Release[],
  weekEnd: string,
): BrewPlan[] {
  const available = releases
    .filter((release): release is Release & { date: string } =>
      typeof release.date === "string" && release.date.length > 0 && release.date <= weekEnd)
    .map((release) => ({ release, tank: sources.find((source) => source.id === release.tankId) }))
    .filter((entry): entry is { release: Release & { date: string }; tank: AssignmentTank } =>
      !!entry.tank && Number(entry.tank.tankNumber) !== 1)
    .filter((entry, index, all) => all.findIndex((candidate) => candidate.tank.id === entry.tank.id) === index)
    .sort((a, b) =>
      a.release.date.localeCompare(b.release.date) || Number(a.tank.tankNumber) - Number(b.tank.tankNumber));

  // Reserve all saved assignments before suggesting anything, including those
  // that appear later in the brew order. This prevents hidden reassignment.
  const used = new Set(brews.map((brew) => brew.tankId).filter(Boolean));

  return brews.map((brew) => {
    if (brew.tankId) return brew;

    const requiredSize = brewSizeLabel(Number(brew.liters) || 0);
    const match = available.find(({ tank }) =>
      !used.has(tank.id) &&
      brewSizeLabel(Number(brew.liters) || 0, tank.tankNumber) === requiredSize);
    if (!match) return brew;

    used.add(match.tank.id);
    return {
      ...brew,
      tankId: match.tank.id,
      date: match.release.date > brew.date ? match.release.date : brew.date,
      tankAssignmentStatus: "tentative" as const,
      availabilityOverride: false,
    };
  });
}
