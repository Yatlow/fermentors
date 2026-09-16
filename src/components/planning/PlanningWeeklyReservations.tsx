import { useCallback, useEffect, useMemo, useRef, type ComponentProps } from "react";
import PlanningWeeklyRecommendationsEnhanced from "./PlanningWeeklyRecommendationsEnhanced";
import { buildWeeklyPlanningModel } from "../../SERVICES/planning/weeklyPlanningModel";
import { brewSizeLabel } from "../../SERVICES/planning/productionCycle";
import { addDays, weekStart, type BrewPlan, type WeekPlan } from "../../SERVICES/planning/planningEngine";
import { shortDate } from "../../SERVICES/planning/dailyPlanner";
import { palletsForPlanningShipmentPicking } from "../../SERVICES/planning/planningShipmentReservations";

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
  const backfillInFlight = useRef(false);
  const backfillAttempted = useRef(new Set<string>());
  const defaultWeekApplied = useRef(false);

  const planningPallets = useMemo(
    () => palletsForPlanningShipmentPicking(props.pallets),
    [props.pallets],
  );

  const assignTentativeTankAssignments = useCallback((next: WeekPlan): WeekPlan => {
    const model = buildWeeklyPlanningModel({
      settings: props.settings,
      pallets: planningPallets,
      tanks: props.tanks,
      plans: props.plans,
      actuals: props.actuals,
      sources: props.sources,
      today: props.today,
      week: next.id,
      holidays: props.holidays,
      shipments: props.shipments,
    });

    const usedTankIds = new Set(
      next.brews.filter((brew) => !!brew.tankId).map((brew) => brew.tankId),
    );

    const brews: BrewWithAssignment[] = next.brews.map((brew) => {
      const existing = brew as BrewWithAssignment;
      if (brew.tankId || brew.date < props.today) return existing;

      const size = brewSizeLabel(brew.liters);
      const option = model.brewTankOptions.find((candidate) =>
        !usedTankIds.has(candidate.tankId) &&
        candidate.availableDate <= brew.date &&
        candidate.sizeLabel === size,
      ) ?? model.brewTankOptions.find((candidate) =>
        !usedTankIds.has(candidate.tankId) &&
        candidate.availableDate <= brew.date &&
        candidate.workLiters >= brew.liters,
      );

      if (!option) return existing;
      usedTankIds.add(option.tankId);
      return {
        ...brew,
        tankId: option.tankId,
        tankAssignmentStatus: "tentative",
      };
    });

    return { ...next, brews };
  }, [
    planningPallets,
    props.actuals,
    props.holidays,
    props.plans,
    props.settings,
    props.shipments,
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

  useEffect(() => {
    if (props.disabled || backfillInFlight.current) return;

    const currentWeek = weekStart(props.today);
    const candidate = [...props.plans]
      .filter((plan) =>
        plan.id >= currentWeek &&
        plan.brews.some((brew) => !brew.tankId && brew.date >= props.today),
      )
      .sort((a, b) => a.id.localeCompare(b.id))[0];

    if (!candidate) return;

    const attemptKey = `${candidate.id}:${candidate.brews
      .filter((brew) => !brew.tankId && brew.date >= props.today)
      .map((brew) => brew.id)
      .sort()
      .join(",")}`;
    if (backfillAttempted.current.has(attemptKey)) return;
    backfillAttempted.current.add(attemptKey);

    const enriched = assignTentativeTankAssignments(candidate);
    const assignedSomething = enriched.brews.some((brew, index) =>
      !candidate.brews[index]?.tankId && !!brew.tankId,
    );
    if (!assignedSomething) return;

    backfillInFlight.current = true;
    void props.saveWeek(enriched)
      .catch((error) => {
        console.error("Failed backfilling tentative brew tanks", error);
        backfillAttempted.current.delete(attemptKey);
      })
      .finally(() => {
        backfillInFlight.current = false;
      });
  }, [
    assignTentativeTankAssignments,
    props.disabled,
    props.plans,
    props.saveWeek,
    props.today,
  ]);

  return (
    <PlanningWeeklyRecommendationsEnhanced
      {...props}
      pallets={planningPallets}
      saveWeek={saveWithTentativeTankAssignments}
    />
  );
}
