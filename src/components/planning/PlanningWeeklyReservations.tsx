import { useCallback, useEffect, useMemo, useRef, type ComponentProps } from "react";
import PlanningWeeklyRecommendationsEnhanced from "./PlanningWeeklyRecommendationsEnhanced";
import { brewSizeLabel, tankReleases } from "../../SERVICES/planning/productionCycle";
import { addDays, sameStyle, weekStart, type BrewPlan, type WeekPlan } from "../../SERVICES/planning/planningEngine";
import { shortDate } from "../../SERVICES/planning/dailyPlanner";
import { palletsForPlanningShipmentPicking } from "../../SERVICES/planning/planningShipmentReservations";
import { projectTankSchedules } from "../../SERVICES/planning/tankScheduleProjection";
import { tankCanHostCycle } from "../../SERVICES/planning/tankSchedule";

type Props = ComponentProps<typeof PlanningWeeklyRecommendationsEnhanced>;
type BrewWithAssignment = BrewPlan & {
  tankAssignmentStatus?: "tentative" | "confirmed";
};

/**
 * Planner adapter:
 * - cooler + pending + bottleRoom are one FEFO candidate pool;
 * - future unassigned brews receive a tentative tank before persistence;
 * - existing future plans are backfilled one week at a time after deployment.
 * - weekly planning opens one week ahead by default because the planner always works forward.
 *
 * Manual shipment marking deliberately lives in the physical pallet views,
 * not in the weekly planning screen.
 */
export default function PlanningWeeklyReservations(props: Props) {
  const defaultWeekApplied = useRef(false);

  const planningPallets = useMemo(
    () => palletsForPlanningShipmentPicking(props.pallets),
    [props.pallets],
  );

  const assignTentativeTankAssignments = useCallback((next: WeekPlan): WeekPlan => {
    // Include this week's packaging in release calculation. A tank that empties
    // during the week is a legitimate candidate for a later brew in that same
    // week, but never before its actual empty date.
    const otherPlans = props.plans.filter((plan) => plan.id !== next.id);
    const fixedBrews = next.brews.filter((brew) => !!brew.tankId || brew.date < props.today);
    let workingWeek: WeekPlan = { ...next, brews: [...fixedBrews] };

    const releasePlans = [...otherPlans, workingWeek];
    const weekEnd = addDays(next.id, 6);
    const releases = tankReleases(
      props.sources,
      props.tanks,
      releasePlans,
      props.settings,
      props.actuals,
      props.today,
    )
      .filter((release) => !!release.date && release.date <= weekEnd)
      .map((release) => ({
        release,
        source: props.sources.find((source) => source.id === release.tankId),
      }))
      .filter(({ source }) => !!source && Number(source.tankNumber) !== 1)
      .sort((a, b) =>
        (a.release.date ?? "9999-12-31").localeCompare(b.release.date ?? "9999-12-31") ||
        Number(a.source?.tankNumber ?? Infinity) - Number(b.source?.tankNumber ?? Infinity),
      );

    const assigned = new Map<string, BrewWithAssignment>(
      fixedBrews.map((brew) => [brew.id, brew as BrewWithAssignment]),
    );
    const pending = next.brews
      .filter((brew) => !brew.tankId && brew.date >= props.today)
      .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

    for (const brew of pending) {
      const size = brewSizeLabel(brew.liters);
      const leadDays = Math.max(
        ...props.settings.products
          .filter((product) => sameStyle(product.style, brew.style))
          .map((product) => product.leadDays),
        21,
      );
      const readyDate = addDays(brew.date, leadDays);

      // Re-project after every assignment. This makes the allocator sequential:
      // packaging can release a tank, and an earlier tentative brew immediately
      // reserves it before the next brew is considered.
      const schedules = projectTankSchedules([...otherPlans, workingWeek], props.settings);
      const option = releases.find(({ release, source }) =>
        !!release.date &&
        release.date < brew.date &&
        brewSizeLabel(0, source?.tankNumber) === size &&
        tankCanHostCycle(schedules.get(release.tankId) ?? [], brew.date, readyDate),
      );

      if (!option) {
        assigned.set(brew.id, brew as BrewWithAssignment);
        continue;
      }

      const enriched: BrewWithAssignment = {
        ...brew,
        tankId: option.release.tankId,
        tankAssignmentStatus: "tentative",
      };
      assigned.set(brew.id, enriched);
      workingWeek = { ...workingWeek, brews: [...workingWeek.brews, enriched] };
    }

    return {
      ...next,
      brews: next.brews.map((brew) => assigned.get(brew.id) ?? (brew as BrewWithAssignment)),
    };
  }, [
    props.actuals,
    props.plans,
    props.settings,
    props.sources,
    props.tanks,
    props.today,
  ]);

  async function saveWithTentativeTankAssignments(next: WeekPlan) {
    await props.saveWeek(assignTentativeTankAssignments(next));
  }

  useEffect(() => {
    if (defaultWeekApplied.current) return;
    defaultWeekApplied.current = true;

    const nextWeek = addDays(weekStart(props.today), 7);
    const targetLabel = shortDate(nextWeek);
    const buttons = document.querySelectorAll<HTMLButtonElement>(".brew-planning .bp-week-picker button");
    const target = Array.from(buttons).find(
      (button) => button.querySelector("small")?.textContent?.trim() === targetLabel,
    );
    target?.click();
  }, [props.today]);

  // Tentative tank assignments are derived and previewed, not persisted merely
  // because a planner opened the calendar. They are written only after an
  // explicit weekly decision save via saveWithTentativeTankAssignments.

  return (
    <PlanningWeeklyRecommendationsEnhanced
      {...props}
      pallets={planningPallets}
      saveWeek={saveWithTentativeTankAssignments}
    />
  );
}