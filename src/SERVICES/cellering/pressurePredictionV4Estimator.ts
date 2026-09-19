import type {
  PressureV4DecisionState,
  PressureV4Exposure,
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
  sample: PressureV4Sample,
  state: PressureV4DecisionState,
): number {
  let score = 0;

  // Current carbonation and the already accumulated pressure history are the
  // most important descriptors. Temperature and age since pressure-close matter
  // too, but less once exposure has already summarized the path.
  score += normalizedDifference(sample.carbonationBefore, state.carbonation, 0.12) * 2.2;
  score += normalizedDifference(sample.currentPressure, state.currentPressure, 0.35) * 0.8;
  score += normalizedDifference(sample.currentTemp, state.currentTemp, 3) * 0.7;
  score += normalizedDifference(sample.hoursSinceT0, state.hoursSinceT0, 48) * 0.8;

  score += normalizedDifference(
    sample.exposure.pressureMean24h,
    state.exposure.pressureMean24h,
    0.3,
  ) * 1.1;
  score += normalizedDifference(
    sample.exposure.pressureMean48h,
    state.exposure.pressureMean48h,
    0.3,
  ) * 1.0;
  score += normalizedDifference(
    exposureRate(sample.exposure),
    exposureRate(state.exposure),
    0.2,
  ) * 1.5;

  if (sample.quality === "low") score += 1.5;
  else if (sample.quality === "medium") score += 0.35;

  return score;
}

function weightedLinearPrediction(args: {
  rows: Array<{
    sample: PressureV4Sample;
    stateDistance: number;
  }>;
  candidatePressure: number;
  currentPressure: number;
}): PressureV4Candidate | null {
  const weighted = args.rows
    .map(({ sample, stateDistance }) => {
      // Learn the intervention relative to the pressure that already existed.
      // x=0 therefore means "do nothing". The intercept becomes the expected
      // two-day carbonation drift from CO2 already in process before the action.
      const sampleActionDelta = Number.isFinite(sample.actionPressureDelta)
        ? sample.actionPressureDelta
        : sample.targetPressure - sample.currentPressure;
      const candidateActionDelta = args.candidatePressure - args.currentPressure;
      const actionDistance = Math.abs(sampleActionDelta - candidateActionDelta);
      const weight =
        1 /
        (0.2 + stateDistance * stateDistance + actionDistance * actionDistance * 4);

      return {
        x: sampleActionDelta,
        y: sample.carbonationDelta,
        weight,
      };
    })
    .filter((row) =>
      Number.isFinite(row.x) &&
      Number.isFinite(row.y) &&
      Number.isFinite(row.weight) &&
      row.weight > 0
    );

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

  // Ordinary head-space pressure should not learn an inverse physical response.
  // When local data are too narrow/noisy to identify a positive slope, use the
  // local weighted mean delta rather than inventing a negative slope.
  const slope = denominator >= 0.002
    ? Math.max(0, numerator / denominator)
    : 0;
  const intercept = meanY - slope * meanX;
  const candidateActionDelta =
    args.candidatePressure - args.currentPressure;
  const predictedDelta =
    intercept + slope * candidateActionDelta;

  return {
    targetPressure: args.candidatePressure,
    predictedCarbonation: 0, // filled by caller with current carbonation
    predictedDelta,
    supportCount: weighted.length,
    effectiveWeight: weightSum,
  };
}

export function estimatePressureTargetV4(args: {
  samples: PressureV4Sample[];
  state: PressureV4DecisionState;
  targetCarbonation: number;
  minPressure?: number;
  maxPressure?: number;
  step?: number;
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

  const usable = args.samples
    .filter((sample) =>
      Number.isFinite(sample.carbonationBefore) &&
      Number.isFinite(sample.currentPressure) &&
      Number.isFinite(sample.targetPressure) &&
      Number.isFinite(sample.carbonationDelta) &&
      sample.primaryOutcome?.calendarDaysAfterAction === 2
    )
    .map((sample) => ({
      sample,
      stateDistance: sampleStateDistance(sample, args.state),
    }))
    .sort((a, b) => a.stateDistance - b.stateDistance)
    .slice(0, 30);

  if (usable.length < 5) return null;

  const candidates: PressureV4Candidate[] = [];
  const count = Math.round((maxPressure - minPressure) / step);

  for (let index = 0; index <= count; index += 1) {
    const targetPressure = Number((minPressure + index * step).toFixed(2));
    const predicted = weightedLinearPrediction({
      rows: usable,
      candidatePressure: targetPressure,
      currentPressure: args.state.currentPressure,
    });
    if (!predicted) continue;

    predicted.predictedCarbonation = Number(
      (args.state.carbonation + predicted.predictedDelta).toFixed(3),
    );
    candidates.push(predicted);
  }

  if (!candidates.length) return null;

  const noChangePrediction = weightedLinearPrediction({
    rows: usable,
    candidatePressure: args.state.currentPressure,
    currentPressure: args.state.currentPressure,
  });
  const predictedCarbonationWithoutChange = noChangePrediction
    ? Number((args.state.carbonation + noChangePrediction.predictedDelta).toFixed(3))
    : args.state.carbonation;

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

  const nearest = usable.slice(0, 12);
  const highQualityCount = nearest.filter(({ sample }) => sample.quality === "high").length;
  const meanDistance = nearest.reduce((sum, row) => sum + row.stateDistance, 0) /
    Math.max(1, nearest.length);

  const confidence: PressureV4Estimate["confidence"] =
    best.supportCount >= 12 && highQualityCount >= 5 && meanDistance <= 2.5
      ? "high"
      : best.supportCount >= 7 && meanDistance <= 4
        ? "medium"
        : "low";

  return {
    targetPressure: best.targetPressure,
    predictedCarbonation: best.predictedCarbonation,
    predictedCarbonationWithoutChange,
    targetCarbonation: args.targetCarbonation,
    error: Number(error.toFixed(3)),
    supportCount: best.supportCount,
    confidence,
    candidates,
  };
}
