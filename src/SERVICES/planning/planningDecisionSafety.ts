import { type Actual, type Settings, type Tank, type WeekPlan } from "./planningEngine";
import { futureTanks } from "./dailyPlanner";
import { planningWeekIssues } from "./planningValidation";
import { validateBrewReleaseIssues, validateProductionIssues, type TankSource, type PlanningValidationIssue } from "./productionCycle";

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

  // Both validators report ALL independent violations with stable row keys.
  // A historic failure on tank A may remain unchanged while an edit introduces
  // a different error on tank B or a different future brew in the same week.
  // Comparing only the first error string, or re-running the same first-error
  // validator per week, was not sufficient to protect the complete horizon.
  const productionScope = (plans: WeekPlan[]) => plans.map((week) => ({
    ...week,
    packaging: week.packaging.filter((run) => !!run.date && run.date >= today),
  }));
  const newViolations = (
    oldIssues: PlanningValidationIssue[], newIssues: PlanningValidationIssue[],
  ): PlanningValidationIssue | undefined => {
    const oldByKey = new Map(oldIssues.map((issue) => [issue.key, issue.message]));
    return newIssues.find((issue) => oldByKey.get(issue.key) !== issue.message);
  };
  if (changed("packaging")) {
    const earlierProduction = validateProductionIssues(
      productionScope(before), settings,
      futureTanks(tanks, before, settings), actuals, today,
    );
    const afterProduction = validateProductionIssues(
      productionScope(after), settings,
      futureTanks(tanks, after, settings), actuals, today,
    );
    const introducedProduction = newViolations(earlierProduction, afterProduction);
    if (introducedProduction) return introducedProduction.message;
    // Do not allow an already-invalid packaging row to be made worse merely
    // because its original error string is unchanged.
    const oldRuns = new Map((previous?.packaging ?? []).map((run) => [run.id, run]));
    for (const run of edited.packaging) {
      const old = oldRuns.get(run.id);
      if (!old || JSON.stringify(run) === JSON.stringify(old)) continue;
      const key = `pack:${edited.id}:${run.id}`;
      if (afterProduction.some((issue) => issue.key === key) &&
          earlierProduction.some((issue) => issue.key === key) &&
          (run.quantity > old.quantity ||
            (!!run.date && !!old.date && run.date < old.date)))
        return afterProduction.find((issue) => issue.key === key)!.message;
    }
  }

  // An unrelated old brew-release failure can no longer hide a new future
  // conflict on the same tank or a different tank.
  const oldRelease = validateBrewReleaseIssues(
    sources, tanks, before, settings, actuals, today,
  );
  const afterRelease = validateBrewReleaseIssues(
    sources, tanks, after, settings, actuals, today,
  );
  const introducedRelease = newViolations(oldRelease, afterRelease);
  if (introducedRelease) return introducedRelease.message;

  return null;
}
