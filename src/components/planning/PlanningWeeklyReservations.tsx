import { useMemo, type ComponentProps } from "react";
import PlanningWeeklyRecommendationsEnhanced from "./PlanningWeeklyRecommendationsEnhanced";
import { buildWeeklyPlanningModel } from "../../SERVICES/planning/weeklyPlanningModel";
import { brewSizeLabel } from "../../SERVICES/planning/productionCycle";
import type { BrewPlan, WeekPlan } from "../../SERVICES/planning/planningEngine";
import { palletsForPlanningShipmentPicking } from "../../SERVICES/planning/planningShipmentReservations";

type Props = ComponentProps<typeof PlanningWeeklyRecommendationsEnhanced>;
type BrewWithAssignment = BrewPlan & {
  tankAssignmentStatus?: "tentative" | "confirmed";
};

/**
 * Planner adapter:
 * 1. cooler + pending + bottleRoom are one FEFO candidate pool;
 * 2. every unassigned brew decision gets a tentative tank before persistence.
 *
 * The work board can later keep or change that tank and confirm the assignment.
 */
export default function PlanningWeeklyReservations(props: Props) {
  const planningPallets = useMemo(
    () => palletsForPlanningShipmentPicking(props.pallets),
    [props.pallets],
  );

  async function saveWithTentativeTankAssignments(next: WeekPlan) {
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
      if (brew.tankId) return existing;

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
        liters: option.workLiters,
        tankAssignmentStatus: "tentative",
      };
    });

    await props.saveWeek({ ...next, brews });
  }

  return (
    <PlanningWeeklyRecommendationsEnhanced
      {...props}
      pallets={planningPallets}
      saveWeek={saveWithTentativeTankAssignments}
    />
  );
}
