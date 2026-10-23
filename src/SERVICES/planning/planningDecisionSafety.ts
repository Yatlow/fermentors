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

  // Only dated production is a physical commitment. Evaluating the full
  // future horizon catches a week-45 packaging edit that removes the release
  // required by a saved week-46 brew. Compare with the same original baseline
  // to avoid blocking unrelated edits due to legacy historical exceptions.
  const productionScope = (plans: WeekPlan[]) => plans.map((week) => ({
    ...week,
    packaging: week.packaging.filter((run) => !!run.date && run.date >= today),
  }));
  const productionError = (plans: WeekPlan[]) =>
    validateProduction(productionScope(plans), settings,
      futureTanks(tanks, plans, settings), actuals, today);
  const earlierProductionError = productionError(before);
  const newProductionError = productionError(after);
  if (newProductionError && newProductionError !== earlierProductionError)
    return newProductionError;

  const releaseError = (plans: WeekPlan[]) =>
    validateBrewReleases(sources, tanks, plans, settings, actuals, today);
  const earlierReleaseError = releaseError(before);
  const newReleaseError = releaseError(after);
  if (newReleaseError && newReleaseError !== earlierReleaseError)
    return newReleaseError;

  return null;
}
