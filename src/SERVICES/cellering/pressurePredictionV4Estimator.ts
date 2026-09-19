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

function passiveDriftPrediction(
  samples: PressureV4PassiveSample[],
  state: PressureV4DecisionState,
): { delta: number; supportCount: number; effectiveWeight: number; meanDistance: number } | null {
  const rows = samples
    .filter((sample) =>
      sample.primaryOutcome?.calendarDaysAfterAction === 2 &&
      Number.isFinite(sample.carbonationDelta)
    )
    .map((sample) => ({
      sample,
      stateDistance: sampleStateDistance(sample as unknown as PressureV4Sample, state),
    }))
    .sort((a, b) => a.stateDistance - b.stateDistance)
    .slice(0, 30);

  if (rows.length < 5) return null;

  const weighted = rows.map(({ sample, stateDistance }) => {
    const weight = 1 / (0.2 + stateDistance * stateDistance);
    return { delta: sample.carbonationDelta, weight, stateDistance };
  });
  const weightSum = weighted.reduce((sum, row) => sum + row.weight, 0);
  if (weightSum <= 0) return null;

  const delta = weighted.reduce(
    (sum, row) => sum + row.delta * row.weight,
    0,
  ) / weightSum;
  const meanDistance = weighted.reduce(
    (sum, row) => sum + row.stateDistance,
    0,
  ) / Math.max(1, weighted.length);

  return {
    delta,
    supportCount: weighted.length,
    effectiveWeight: weightSum,
    meanDistance,
  };
}

function weightedLinearPrediction(args: {
  rows: Array<{
    sample: PressureV4Sample;
    stateDistance: number;
  }>;
  candidatePressure: number;
  currentPressure: number;
  baselineDelta: number;
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

  // Passive samples teach the no-action 48h drift. Ordinary-pressure
  // samples only teach the *additional* effect of changing head pressure.
  // Fit that intervention effect through the passive baseline so x=0 always
  // means "do nothing" rather than inventing a second intercept.
  const denominator = weighted.reduce(
    (sum, row) => sum + row.weight * row.x ** 2,
    0,
  );
  const numerator = weighted.reduce(
    (sum, row) =>
      sum + row.weight * row.x * (row.y - args.baselineDelta),
    0,
  );

  const slope = denominator >= 0.002
    ? Math.max(0, numerator / denominator)
    : 0;
  const candidateActionDelta =
    args.candidatePressure - args.currentPressure;
  const predictedDelta =
    args.baselineDelta + slope * candidateActionDelta;

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
  passiveSamples?: PressureV4PassiveSample[];
  state: PressureV4DecisionState;
  targetCarbonation: number;
  minPressure?: number;
  maxPressure?: number;
  step?: number;
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

  const learnedPassive = passiveDriftPrediction(
    args.passiveSamples ?? [],
    args.state,
  );

  const equilibriumPressure = finite(args.equilibriumPressure);
  const firstCarbonationHighPressure =
    args.firstCarbonation === true &&
    equilibriumPressure !== null &&
    args.state.currentPressure >= equilibriumPressure + 0.15;

  // Operational prior from the first carbonation test: while head pressure is
  // still materially above equilibrium, a meaningful amount of CO2 is already
  // in the process of dissolving. Until enough passive-history exists, use the
  // brewery's observed ~0.35 vol two-day rise as the conservative baseline.
  const passive = learnedPassive ?? (
    firstCarbonationHighPressure
      ? {
          delta: 0.35,
          supportCount: 0,
          effectiveWeight: 0,
          meanDistance: 0,
        }
      : null
  );
  if (!passive) return null;

  const baselineDelta =
    firstCarbonationHighPressure
      ? Math.max(passive.delta, 0.35)
      : passive.delta;

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

  const effectiveMaxPressure =
    firstCarbonationHighPressure
      ? Math.min(maxPressure, args.state.currentPressure)
      : maxPressure;

  const candidates: PressureV4Candidate[] = [];
  const count = Math.round((effectiveMaxPressure - minPressure) / step);

  for (let index = 0; index <= count; index += 1) {
    const targetPressure = Number((minPressure + index * step).toFixed(2));
    const predicted = weightedLinearPrediction({
      rows: usable,
      candidatePressure: targetPressure,
      currentPressure: args.state.currentPressure,
      baselineDelta,
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
    baselineDelta,
  });
  const predictedCarbonationWithoutChange = Number(
    (args.state.carbonation + baselineDelta).toFixed(3),
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

  const nearest = usable.slice(0, 12);
  const highQualityCount = nearest.filter(({ sample }) => sample.quality === "high").length;
  const meanDistance = nearest.reduce((sum, row) => sum + row.stateDistance, 0) /
    Math.max(1, nearest.length);

  const confidence: PressureV4Estimate["confidence"] =
    best.supportCount >= 12 &&
    (passive.supportCount >= 10 || firstCarbonationHighPressure) &&
    highQualityCount >= 5 &&
    meanDistance <= 2.5 &&
    (passive.supportCount === 0 || passive.meanDistance <= 2.5)
      ? "high"
      : best.supportCount >= 7 &&
        (passive.supportCount >= 5 || firstCarbonationHighPressure) &&
        meanDistance <= 4 &&
        (passive.supportCount === 0 || passive.meanDistance <= 4)
        ? "medium"
        : "low";

  // Do not call an operational boundary a recommendation when the model itself
  // predicts that even its best candidate remains materially off target.
  if (error > 0.06) return null;

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
