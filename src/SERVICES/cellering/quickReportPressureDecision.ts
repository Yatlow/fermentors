import type { PressureChangeDirection } from "./scheduledCellarRecommendations";

/** An exact scheduled decision, not an inferred value from a free-text note. */
export type QuickReportPressureDecision = {
  tankNumber: string;
  batchNumber: string;
  recommendationId: string;
  pressureDirection?: PressureChangeDirection;
  targetPressure?: number;
};

export type QuickReportPressurePrefill = {
  direction: "העלאת" | "הורדת";
  pressure: string;
};

/**
 * The selected instruction must still belong to the currently displayed tank
 * and batch. Invalid/legacy instructions never silently fill the report.
 * Direction follows the *decision*, not an inferred current-pressure delta.
 */
export function pressurePrefillFromScheduledDecision(
  decision: QuickReportPressureDecision | null | undefined,
  tankNumber: string | number | null | undefined,
  batchNumber: string | number | null | undefined,
): QuickReportPressurePrefill | null {
  if (!decision?.recommendationId?.startsWith("scheduled-")) return null;
  const normalizedBatch = (value: string | number | null | undefined) =>
    String(value ?? "").replace(/^#/, "").trim();
  if (!normalizedBatch(batchNumber) ||
      normalizedBatch(decision.batchNumber) !== normalizedBatch(batchNumber) ||
      String(decision.tankNumber).trim() !== String(tankNumber ?? "").trim()) return null;
  if (decision.pressureDirection !== "raise" && decision.pressureDirection !== "lower") return null;
  if (typeof decision.targetPressure !== "number" ||
      !Number.isFinite(decision.targetPressure) ||
      decision.targetPressure < 0 || decision.targetPressure > 5) return null;

  return {
    direction: decision.pressureDirection === "raise" ? "העלאת" : "הורדת",
    pressure: String(decision.targetPressure),
  };
}
