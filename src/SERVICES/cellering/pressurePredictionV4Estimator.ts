import type {
  PressureV4DecisionState,
  PressureV4Exposure,
  PressureV4PassiveSample,
  PressureV4Sample,
} from "./pressurePredictionV4";

export type { PressureV4DecisionState };

export type PressureV4Candidate = {
  targetPressure: number;
  predictedCarbonation: number;
  predictedDelta: number;
  supportCount: number;
  effectiveWeight: number;
};

export type PressureV4Estimate = {
  targetPressure: number;
  predictedCarbonation: number;
  predictedCarbonationWithoutChange: number;
  targetCarbonation: number;
  error: number;
  supportCount: number;
  confidence: "low" | "medium" | "high";
  accuracyPercent: number;
  candidates: PressureV4Candidate[];
};

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizedDifference(
  a: number | null,
  b: number | null,
  scale: number,
): number {
  if (a === null || b === null || !Number.isFinite(scale) || scale <= 0) return 0;
  return Math.abs(a - b) / scale;
}

function exposureRate(exposure: PressureV4Exposure): number | null {
  if (
    exposure.equilibriumDeltaBarHours === null ||
    exposure.hoursSinceT0 <= 0
  ) return null;
  return exposure.equilibriumDeltaBarHours / exposure.hoursSinceT0;
}

function sampleStateDistance(
  sample: PressureV4Sample | PressureV4PassiveSample,
  state: PressureV4DecisionState,
): number {
  let score = 0;

  // The pressure history matters at least as much as the clock. Two tanks that
  // have both been closed for 72h are not equivalent if one spent that time at
  // 1.5 bar and the other at 0.8 bar.
  score += normalizedDifference(sample.carbonationBefore, state.carbonation, 0.12) * 2.2;
  score += normalizedDifference(sample.currentPressure, state.currentPressure, 0.35) * 0.8;
  score += normalizedDifference(sample.currentTemp, state.currentTemp, 3) * 0.7;
  score += normalizedDifference(sample.hoursSinceT0, state.hoursSinceT0, 48) * 0.55;

  score += normalizedDifference(
    sample.exposure.pressureMean24h,
    state.exposure.pressureMean24h,
    0.3,
  ) * 1.45;
  score += normalizedDifference(
    sample.exposure.pressureMean48h,
    state.exposure.pressureMean48h,
    0.3,
  ) * 1.35;
  score += normalizedDifference(
    exposureRate(sample.exposure),
    exposureRate(state.exposure),
    0.2,
  ) * 1.9;

  if (sample.quality === "low") score += 1.5;
  else if (sample.quality === "medium") score += 0.35;

  return score;
}

type TrainingRow = {
  x: number; // pressure change; 0 means no intervention
  y: number; // observed two-day carbonation change
  stateDistance: number;
  quality: "low" | "medium" | "high";
};

function buildTrainingRows(args: {
  samples: PressureV4Sample[];
  passiveSamples: PressureV4PassiveSample[];
  state: PressureV4DecisionState;
}): TrainingRow[] {
  const actionRows: TrainingRow[] = args.samples
    .filter((sample) =>
      Number.isFinite(sample.carbonationBefore) &&
      Number.isFinite(sample.currentPressure) &&
      Number.isFinite(sample.targetPressure) &&
      Number.isFinite(sample.carbonationDelta) &&
      sample.primaryOutcome?.calendarDaysAfterAction === 2
    )
    .map((sample) => ({
      x: Number.isFinite(sample.actionPressureDelta)
        ? sample.actionPressureDelta
        : sample.targetPressure - sample.currentPressure,
      y: sample.carbonationDelta,
      stateDistance: sampleStateDistance(sample, args.state),
      quality: sample.quality,
    }));

  // A carbonation test followed by two clean days with no ordinary pressure
  // change and no bottom carbonation is simply action=0 in the same model.
  const noActionRows: TrainingRow[] = args.passiveSamples
    .filter((sample) =>
      Number.isFinite(sample.carbonationDelta) &&
      sample.primaryOutcome?.calendarDaysAfterAction === 2
    )
    .map((sample) => ({
      x: 0,
      y: sample.carbonationDelta,
      stateDistance: sampleStateDistance(sample, args.state),
      quality: sample.quality,
    }));

  return [...actionRows, ...noActionRows]
    .sort((a, b) => a.stateDistance - b.stateDistance)
    .slice(0, 40);
}

function fitLocalResponse(
  rows: TrainingRow[],
  candidateActionDelta?: number,
): {
  intercept: number;
  slope: number;
  supportCount: number;
  effectiveWeight: number;
  meanDistance: number;
} | null {
  if (rows.length < 5) return null;

  const weighted = rows.map((row) => {
    const actionDistance = candidateActionDelta === undefined
      ? 0
      : Math.abs(row.x - candidateActionDelta);
    const weight =
      1 /
      (0.2 + row.stateDistance * row.stateDistance + actionDistance * actionDistance * 4);
    return { ...row, weight };
  }).filter((row) => Number.isFinite(row.weight) && row.weight > 0);

  if (weighted.length < 5) return null;

  const weightSum = weighted.reduce((sum, row) => sum + row.weight, 0);
  if (weightSum <= 0) return null;

  const meanX = weighted.reduce((sum, row) => sum + row.x * row.weight, 0) / weightSum;
  const meanY = weighted.reduce((sum, row) => sum + row.y * row.weight, 0) / weightSum;
  const denominator = weighted.reduce(
    (sum, row) => sum + row.weight * (row.x - meanX) ** 2,
    0,
  );
  const numerator = weighted.reduce(
    (sum, row) => sum + row.weight * (row.x - meanX) * (row.y - meanY),
    0,
  );

  // More head pressure must not learn a negative causal response. If the local
  // action range is too narrow to identify a slope, keep only the local drift.
  const slope = denominator >= 0.002
    ? Math.max(0, numerator / denominator)
    : 0;
  const intercept = meanY - slope * meanX;
  const meanDistance = weighted.reduce(
    (sum, row) => sum + row.stateDistance,
    0,
  ) / weighted.length;

  return {
    intercept,
    slope,
    supportCount: weighted.length,
    effectiveWeight: weightSum,
    meanDistance,
  };
}

function historicalAccuracyPercent(
  rows: TrainingRow[],
  fit: { intercept: number; slope: number },
): number {
  if (rows.length < 5) return 0;

  const weighted = rows.map((row) => ({
    ...row,
    weight: 1 / (0.2 + row.stateDistance * row.stateDistance),
  }));
  const totalWeight = weighted.reduce((sum, row) => sum + row.weight, 0);
  if (totalWeight <= 0) return 0;

  const hitWeight = weighted.reduce((sum, row) => {
    const predicted = fit.intercept + fit.slope * row.x;
    const hit = Math.abs(predicted - row.y) <= 0.05;
    return sum + (hit ? row.weight : 0);
  }, 0);

  return Math.max(
    0,
    Math.min(100, Math.round((hitWeight / totalWeight) * 100)),
  );
}

export function estimatePressureTargetV4(args: {
  samples: PressureV4Sample[];
  passiveSamples?: PressureV4PassiveSample[];
  state: PressureV4DecisionState;
  targetCarbonation: number;
  minPressure?: number;
  maxPressure?: number;
  step?: number;
  // Kept for caller compatibility/debugging; first-carbonation behavior is
  // learned from state/exposure rather than a fixed prior.
  firstCarbonation?: boolean;
  equilibriumPressure?: number | null;
}): PressureV4Estimate | null {
  const minPressure = finite(args.minPressure) ?? 0;
  const maxPressure = finite(args.maxPressure) ?? 1.9;
  const step = finite(args.step) ?? 0.05;

  if (
    !Number.isFinite(args.state.carbonation) ||
    !Number.isFinite(args.state.currentPressure) ||
    !Number.isFinite(args.targetCarbonation) ||
    step <= 0 ||
    maxPressure < minPressure
  ) return null;

  const trainingRows = buildTrainingRows({
    samples: args.samples,
    passiveSamples: args.passiveSamples ?? [],
    state: args.state,
  });
  if (trainingRows.length < 5) return null;

  // No special first-carbonation constant: the no-action forecast comes from
  // the same local model, with pressure history/exposure carrying the context.
  const noActionFit = fitLocalResponse(trainingRows, 0);
  if (!noActionFit) return null;

  const candidates: PressureV4Candidate[] = [];
  const count = Math.round((maxPressure - minPressure) / step);

  for (let index = 0; index <= count; index += 1) {
    const targetPressure = Number((minPressure + index * step).toFixed(2));
    const actionDelta = targetPressure - args.state.currentPressure;
    const fit = fitLocalResponse(trainingRows, actionDelta);
    if (!fit) continue;

    const predictedDelta = fit.intercept + fit.slope * actionDelta;
    candidates.push({
      targetPressure,
      predictedCarbonation: Number(
        (args.state.carbonation + predictedDelta).toFixed(3),
      ),
      predictedDelta,
      supportCount: fit.supportCount,
      effectiveWeight: fit.effectiveWeight,
    });
  }

  if (!candidates.length) return null;

  const predictedCarbonationWithoutChange = Number(
    (args.state.carbonation + noActionFit.intercept).toFixed(3),
  );

  const ranked = [...candidates].sort((a, b) => {
    const aError = Math.abs(a.predictedCarbonation - args.targetCarbonation);
    const bError = Math.abs(b.predictedCarbonation - args.targetCarbonation);
    if (Math.abs(aError - bError) > 0.002) return aError - bError;

    // If two candidates predict effectively the same result, prefer the smaller
    // physical intervention from the pressure that exists now.
    return (
      Math.abs(a.targetPressure - args.state.currentPressure) -
      Math.abs(b.targetPressure - args.state.currentPressure)
    );
  });

  const best = ranked[0];
  const error = Math.abs(best.predictedCarbonation - args.targetCarbonation);

  const nearest = trainingRows.slice(0, 12);
  const highQualityCount = nearest.filter((row) => row.quality === "high").length;
  const meanDistance = nearest.reduce((sum, row) => sum + row.stateDistance, 0) /
    Math.max(1, nearest.length);

  const confidence: PressureV4Estimate["confidence"] =
    best.supportCount >= 12 && highQualityCount >= 5 && meanDistance <= 2.5
      ? "high"
      : best.supportCount >= 7 && meanDistance <= 4
        ? "medium"
        : "low";

  // Do not call an operational boundary a recommendation when the model itself
  // predicts that even its best candidate remains materially off target.
  if (error > 0.06) return null;

  const accuracyPercent = historicalAccuracyPercent(
    trainingRows,
    noActionFit,
  );

  return {
    targetPressure: best.targetPressure,
    predictedCarbonation: best.predictedCarbonation,
    predictedCarbonationWithoutChange,
    targetCarbonation: args.targetCarbonation,
    error: Number(error.toFixed(3)),
    supportCount: best.supportCount,
    confidence,
    accuracyPercent,
    candidates,
  };
}
