export const PRESSURE_V9_MODEL_VERSION = "9.1-shadow-geometry-guard-2026-09-21";

// Frozen from the chronological out-of-time run:
// train through 2026-03-29, validation through 2026-07-05,
// newest 29 batches held out as test.
export const PRESSURE_V9_K_PER_HOUR = 0.000699;

export const PRESSURE_V9_HISTORICAL_REFERENCE = {
  testBatchCount: 29,
  allWindowsMaeVol: 0.040,
  allWindowsP90Vol: 0.086,
  closedConsistentMaeVol: 0.028,
  closedConsistentP90Vol: 0.055,
  closedConsistentImprovementVsPersistence: 0.26,
  validatedAt: "2026-09-21",
} as const;

// Prospective checkpoints are evidence counters for the admin monitor only.
export const PRESSURE_V9_SHADOW_INITIAL_CHECKPOINT = 10;
export const PRESSURE_V9_SHADOW_STRONGER_CHECKPOINT = 15;

// If a ±10% vessel-volume uncertainty changes the recommended pressure by
// more than this amount, the recommendation is not operationally actionable.
// We still expose the raw physics result in the private monitor for diagnosis.
export const PRESSURE_V9_MAX_GEOMETRY_SENSITIVITY_BAR = 0.30;

export function pressureV9GeometryIsActionable(
  sensitivityWidthBar: number | null | undefined,
): boolean {
  return (
    sensitivityWidthBar === null ||
    sensitivityWidthBar === undefined ||
    (
      Number.isFinite(sensitivityWidthBar) &&
      sensitivityWidthBar <=
        PRESSURE_V9_MAX_GEOMETRY_SENSITIVITY_BAR
    )
  );
}
