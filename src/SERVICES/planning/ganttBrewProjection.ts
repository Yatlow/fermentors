import { addDays, type BrewPlan } from "./planningEngine";
import type { WeeklyBrewRecommendation } from "./weeklyPlanningModel";

/**
 * A Gantt forecast assumes its recommendations are accepted, but those cycles
 * are never persisted. Attach the proposed physical tank ONLY to the
 * simulation, so later weeks see it occupied and stock appears after maturity.
 * Brewery brewing days are Monday–Wednesday (week start is Sunday).
 */
export function simulatedGanttBrews(
  week: string,
  recommendations: WeeklyBrewRecommendation[],
): BrewPlan[] {
  const productionDays = [1, 2, 3].map((offset) => addDays(week, offset));
  return recommendations.flatMap((recommendation, index) => {
    const date = productionDays.find((day) => day >= recommendation.availableDate);
    if (!date || !recommendation.tankId) return [];
    return [{
      id: `gantt-rec-brew:${week}:${index}`,
      style: recommendation.style,
      liters: recommendation.liters,
      tankId: recommendation.tankId,
      date,
      tankAssignmentStatus: "tentative" as const,
    }];
  });
}
