import { type Actual, type Settings, type Tank, type WeekPlan } from "./planningEngine";
import { futureTanks } from "./dailyPlanner";
import { planningWeekIssues } from "./planningValidation";
import { validateBrewReleases, validateProduction, type TankSource } from "./productionCycle";

/**
 * The weekly planner, Gantt editor and daily board must not have different
 * integrity guarantees. Run this gate for every persisted weekly decision.
 *
 * Old reported work and old invalid legacy decisions are retained verbatim.
 * This gate rejects newly introduced errors; it never edits historical rows.
 * Undated packaging and unassigned brewing remain valid weekly *drafts*.
 */
export function validatePlanningDecisionChange(args: {
  before: WeekPlan[];
  after: WeekPlan[];
  edited: WeekPlan;
  previous?: WeekPlan;
  settings: Settings;
  tanks: Tank[];
  sources: TankSource[];
  actuals: Actual[];
  today: string;
}): string | null {
  const { before, after, edited, previous, settings, tanks, sources, actuals, today } = args;
  const changed = (key: "deliveries" | "packaging" | "brews") =>
    JSON.stringify(previous?.[key] ?? []) !== JSON.stringify(edited[key] ?? []);
  const commitmentsChanged = changed("deliveries") || changed("packaging") || changed("brews");
  const limitsChanged = edited.maxRuns !== previous?.maxRuns ||
    edited.allowExceptions !== previous?.allowExceptions;
  if (!commitmentsChanged && !limitsChanged) return null;

  const older = new Map((previous?.brews ?? []).map((brew) => [brew.id, brew]));
  for (const brew of edited.brews) {
    if (brew.date < today && JSON.stringify(older.get(brew.id)) !== JSON.stringify(brew))
      return "לא ניתן ליצור או לשנות בישול שתאריכו כבר עבר";
  }

  // Old recorded brews can occur earlier in the *current* week. The weekly
  // validator should not reject an unrelated future shipment because they
  // exist. The old brews are still included in production cycle projections.
  const activeEdited = {
    ...edited,
    brews: edited.brews.filter((brew) => brew.date >= today),
  };
  // Compare the entire violation set. A historical failure on Monday must
  // not hide a new violation on Tuesday when both share a common validator.
  const beforeWeek = previous ? {
    ...previous,
    brews: previous.brews.filter((brew) => brew.date >= today),
  } : { ...edited, deliveries: [], packaging: [], brews: [],
    allowExceptions: false, maxRuns: settings.preferredRuns };
  const existingErrors = new Set(planningWeekIssues(beforeWeek, settings, before, today));
  const introduced = planningWeekIssues(activeEdited, settings, after, today)
    .find((error) => !existingErrors.has(error));
  if (introduced) return introduced;

  // Pure shipment changes should not repeatedly validate a historically
  // completed physical batch or expensive tank schedules.
  if (!changed("packaging") && !changed("brews")) return null;

  // Only dated production is a physical commitment. Preserve the whole
  // schedule for capacity/release simulation, but inspect the impacted tank
  // separately too: an old error on tank A must not hide a new one on tank B.
  const productionScope = (plans: WeekPlan[], touchedTank?: string) =>
    plans.map((week) => ({
      ...week,
      packaging: week.packaging.filter((run) => !!run.date && run.date >= today &&
        (!touchedTank || run.tankId === touchedTank ||
         String(run.tankNumber ?? "") === touchedTank)),
    }));
  const productionError = (plans: WeekPlan[], touchedTank?: string) =>
    validateProduction(productionScope(plans, touchedTank), settings,
      futureTanks(tanks, plans, settings), actuals, today);
  const earlierProductionError = productionError(before);
  const newProductionError = productionError(after);
  if (newProductionError && newProductionError !== earlierProductionError)
    return newProductionError;

  if (changed("packaging")) {
    const oldRuns = new Map((previous?.packaging ?? []).map((run) => [run.id, run]));
    const newRuns = new Map(edited.packaging.map((run) => [run.id, run]));
    const changedRuns = [
      ...(previous?.packaging ?? []).filter((run) =>
        JSON.stringify(run) !== JSON.stringify(newRuns.get(run.id))),
      ...edited.packaging.filter((run) =>
        JSON.stringify(run) !== JSON.stringify(oldRuns.get(run.id))),
    ];
    const touchedTanks = new Set(changedRuns.flatMap((run) =>
      [run.tankId, run.tankNumber != null ? String(run.tankNumber) : ""]
        .filter((value): value is string => !!value)));
    for (const tankId of touchedTanks) {
      const earlier = productionError(before, tankId);
      const now = productionError(after, tankId);
      if (now && now !== earlier) return now;
    }
  }

  // One error in an unrelated historical week must not hide newly invalid
  // future brewing on the same or another tank. Inspect every future week with
  // assigned brews independently while retaining all dependency schedules.
  const releaseError = (plans: WeekPlan[], weekId?: string) =>
    validateBrewReleases(sources, tanks, plans, settings, actuals, today, weekId);
  const earlierReleaseError = releaseError(before);
  const newReleaseError = releaseError(after);
  if (newReleaseError && newReleaseError !== earlierReleaseError)
    return newReleaseError;
  const futureWeeks = [...new Set(after.filter((week) =>
    week.id >= edited.id && week.brews.some((brew) => brew.date >= today && !!brew.tankId))
    .map((week) => week.id))];
  for (const weekId of futureWeeks) {
    const earlier = releaseError(before, weekId);
    const now = releaseError(after, weekId);
    if (now && now !== earlier) return now;
  }

  return null;
}
