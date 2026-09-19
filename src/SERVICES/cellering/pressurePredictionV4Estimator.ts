import type {
  PressureV4DecisionState,
  PressureV4Exposure,
  PressureV4PassiveSample,
  PressureV4Sample,
  PressureV4TransitionSample,
} from "./pressurePredictionV4";
import {
  equilibriumPressureBar,
  evolveCarbonation,
} from "./pressureCarbonationPhysics";

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
  kPerHour: number;
  targetEquilibriumPressure: number | null;
  referenceTemperature: number | null;
  equilibriumSource: "local_stable" | "learned_curve" | "physics";
  headroomBar: number;
  headroomSupport: number;
  action: "hold" | "raise" | "lower";
  pressureOnlyLikelyInsufficient: boolean;
};

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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

function coolingExposureRate(
  cooling: PressureV4DecisionState["cooling"],
): number | null {
  if (
    !cooling ||
    cooling.equilibriumDeltaBarHoursSinceCooling === null ||
    cooling.hoursSinceCooling <= 0
  ) return null;
  return (
    cooling.equilibriumDeltaBarHoursSinceCooling /
    cooling.hoursSinceCooling
  );
}

function transitionDistance(
  sample: PressureV4TransitionSample,
  state: PressureV4DecisionState,
): number {
  let score = 0;

  score += normalizedDifference(sample.startCarbonation, state.carbonation, 0.15) * 2.0;
  score += normalizedDifference(sample.currentTemp, state.currentTemp, 2.5) * 0.9;
  score += normalizedDifference(sample.hoursSinceT0, state.hoursSinceT0, 72) * 0.9;

  score += normalizedDifference(
    sample.exposure.pressureMean24h,
    state.exposure.pressureMean24h,
    0.25,
  ) * 1.6;
  score += normalizedDifference(
    sample.exposure.pressureMean48h,
    state.exposure.pressureMean48h,
    0.3,
  ) * 1.4;
  score += normalizedDifference(
    exposureRate(sample.exposure),
    exposureRate(state.exposure),
    0.2,
  ) * 1.8;

  if (sample.cooling && state.cooling) {
    score += normalizedDifference(
      sample.cooling.hoursSinceCooling,
      state.cooling.hoursSinceCooling,
      36,
    ) * 1.8;
    score += normalizedDifference(
      sample.cooling.tempDropSinceCooling,
      state.cooling.tempDropSinceCooling,
      4,
    ) * 1.1;
    score += normalizedDifference(
      sample.cooling.tempChange24h,
      state.cooling.tempChange24h,
      2,
    ) * 1.8;
    score += normalizedDifference(
      sample.cooling.pressureMeanSinceCooling,
      state.cooling.pressureMeanSinceCooling,
      0.3,
    ) * 1.7;
    score += normalizedDifference(
      coolingExposureRate(sample.cooling),
      coolingExposureRate(state.cooling),
      0.2,
    ) * 1.8;
    if (sample.cooling.stillCooling !== state.cooling.stillCooling) {
      score += 1.5;
    }
  } else if (Boolean(sample.cooling) !== Boolean(state.cooling)) {
    score += 2.5;
  }

  if (sample.quality === "low") score += 1.25;
  else if (sample.quality === "medium") score += 0.25;

  return score;
}

type WeightedTransition = {
  sample: PressureV4TransitionSample;
  distance: number;
  weight: number;
};

function weightedQuantile(
  rows: WeightedTransition[],
  value: (row: WeightedTransition) => number,
  q: number,
): number | null {
  const sorted = rows
    .filter((row) => Number.isFinite(value(row)) && row.weight > 0)
    .slice()
    .sort((a, b) => value(a) - value(b));
  const total = sorted.reduce((sum, row) => sum + row.weight, 0);
  if (!sorted.length || total <= 0) return null;

  const target = total * q;
  let running = 0;
  for (const row of sorted) {
    running += row.weight;
    if (running >= target) return value(row);
  }
  return value(sorted[sorted.length - 1]);
}

function localTransitions(
  transitions: PressureV4TransitionSample[],
  state: PressureV4DecisionState,
): WeightedTransition[] {
  return transitions
    .filter((sample) =>
      Number.isFinite(sample.kPerHour) &&
      sample.kPerHour > 0 &&
      sample.kPerHour < 1 &&
      Number.isFinite(sample.startCarbonation) &&
      Number.isFinite(sample.endCarbonation) &&
      Number.isFinite(sample.durationHours) &&
      sample.durationHours > 0
    )
    .map((sample) => {
      const distance = transitionDistance(sample, state);
      return {
        sample,
        distance,
        weight: 1 / (0.25 + distance * distance),
      };
    })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 30);
}

function directionalTransitions(
  rows: WeightedTransition[],
  carbonationError: number,
): WeightedTransition[] {
  if (Math.abs(carbonationError) <= 0.04) return rows;

  const direction = Math.sign(carbonationError);
  const matching = rows.filter((row) => {
    const delta =
      row.sample.endCarbonation - row.sample.startCarbonation;
    return Math.sign(delta) === direction && Math.abs(delta) >= 0.01;
  });

  // Prefer kinetics from transitions that actually moved CO2 in the direction
  // we now need. Fall back to the broader local set only when history is thin.
  return matching.length >= 4 ? matching : rows;
}

function estimateK(rows: WeightedTransition[]): number | null {
  return weightedQuantile(rows, (row) => row.sample.kPerHour, 0.5);
}

function accuracyPercent(
  rows: WeightedTransition[],
  fallbackK: number,
): number {
  if (rows.length < 4) return 0;

  let hitWeight = 0;
  let totalWeight = 0;

  rows.slice(0, 16).forEach((row, index) => {
    const others = rows
      .filter((_, otherIndex) => otherIndex !== index)
      .map((other) => ({
        ...other,
        weight: 1 / (0.25 + other.distance * other.distance),
      }));
    const k = estimateK(others) ?? fallbackK;
    const pressure = finite(row.sample.pressureMeanDuring);
    const temp = finite(row.sample.temperatureMeanDuring);
    if (pressure === null || temp === null) return;

    const predicted = evolveCarbonation({
      carbonation: row.sample.startCarbonation,
      pressureBar: pressure,
      temperatureC: temp,
      kPerHour: k,
      hours: row.sample.durationHours,
    });
    if (predicted === null) return;

    totalWeight += row.weight;
    if (Math.abs(predicted - row.sample.endCarbonation) <= 0.05) {
      hitWeight += row.weight;
    }
  });

  if (totalWeight <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(hitWeight / totalWeight * 100)));
}

function forecastTemperatureAtHour(args: {
  state: PressureV4DecisionState;
  coldReferenceTemperature: number | null;
  hour: number;
}): number | null {
  const currentTemp = finite(args.state.currentTemp);
  if (currentTemp === null) return null;

  const cooling = args.state.cooling;
  const floor = finite(args.coldReferenceTemperature);
  if (
    !cooling ||
    !cooling.stillCooling ||
    floor === null ||
    cooling.startTemp === null ||
    cooling.hoursSinceCooling <= 0 ||
    cooling.startTemp <= floor + 0.2 ||
    currentTemp <= floor + 0.2
  ) {
    return currentTemp;
  }

  const startGap = cooling.startTemp - floor;
  const currentGap = Math.max(0.05, currentTemp - floor);
  if (startGap <= currentGap) return currentTemp;

  const lambda =
    -Math.log(currentGap / startGap) / cooling.hoursSinceCooling;
  if (!Number.isFinite(lambda) || lambda <= 0) return currentTemp;

  return floor + currentGap * Math.exp(-lambda * args.hour);
}

function simulateForward(args: {
  carbonation: number;
  pressureBar: number;
  pressureCalibrationOffset: number;
  state: PressureV4DecisionState;
  coldReferenceTemperature: number | null;
  kPerHour: number;
  hours: number;
}): number | null {
  let carbonation = args.carbonation;
  const stepHours = 6;

  for (let elapsed = 0; elapsed < args.hours; elapsed += stepHours) {
    const hours = Math.min(stepHours, args.hours - elapsed);
    const midpoint = elapsed + hours / 2;
    const temp = forecastTemperatureAtHour({
      state: args.state,
      coldReferenceTemperature: args.coldReferenceTemperature,
      hour: midpoint,
    });
    if (temp === null) return null;

    const next = evolveCarbonation({
      carbonation,
      pressureBar: args.pressureBar - args.pressureCalibrationOffset,
      temperatureC: temp,
      kPerHour: args.kPerHour,
      hours,
    });
    if (next === null) return null;
    carbonation = next;
  }

  return carbonation;
}

function isEffectivelyStillCooling(
  state: PressureV4DecisionState,
  coldReferenceTemperature: number | null,
): boolean {
  const currentTemp = finite(state.currentTemp);
  const cold = finite(coldReferenceTemperature);
  const cooling = state.cooling;
  if (!cooling || currentTemp === null || cold === null) return false;

  if (cooling.stillCooling) return true;

  // Sparse temperature logging can miss the falling 24h slope. During the
  // first four days after cooling, a beer still several degrees above its
  // learned cold floor should still be treated as cooling toward that floor.
  return (
    cooling.hoursSinceCooling <= 96 &&
    currentTemp >= cold + 1.5
  );
}

function referenceTemperature(
  state: PressureV4DecisionState,
  coldReferenceTemperature: number | null,
): number | null {
  const currentTemp = finite(state.currentTemp);
  if (currentTemp === null) return null;

  const cold = finite(coldReferenceTemperature);
  if (
    isEffectivelyStillCooling(state, cold) &&
    cold !== null &&
    cold < currentTemp
  ) {
    return cold;
  }

  return currentTemp;
}

function localStableTargetEquilibrium(args: {
  state: PressureV4DecisionState;
  targetCarbonation: number;
}): number | null {
  const trend = args.state.carbonationTrend;
  const previousTemp = finite(trend?.previousTemp);
  const previousPressure = finite(trend?.previousPressure);
  const previousCarbonation = finite(trend?.previousCarbonation);
  const previousHistoricalRate =
    finite(trend?.previousHistoricalRatePerDay);
  const hoursBetweenPreviousChecks =
    finite(trend?.hoursBetweenPreviousChecks);

  if (
    !trend ||
    previousTemp === null ||
    previousPressure === null ||
    previousCarbonation === null ||
    previousHistoricalRate === null ||
    hoursBetweenPreviousChecks === null ||
    previousTemp > 5 ||
    hoursBetweenPreviousChecks < 18 ||
    Math.abs(previousHistoricalRate) > 0.015 ||
    Math.abs(previousCarbonation - args.targetCarbonation) > 0.15
  ) {
    return null;
  }

  const physicalPrevious = equilibriumPressureBar(
    previousTemp,
    previousCarbonation,
  );
  const physicalTarget = equilibriumPressureBar(
    previousTemp,
    args.targetCarbonation,
  );
  if (physicalPrevious === null || physicalTarget === null) return null;

  // Crucially, this anchor comes only from historical readings that precede
  // the simulated/current test. Changing the hypothetical carbonation input
  // therefore cannot move the equilibrium baseline.
  return previousPressure + (physicalTarget - physicalPrevious);
}

function headroomPrior(args: {
  carbonationError: number;
  state: PressureV4DecisionState;
  coldReferenceTemperature: number | null;
  hasLocalEquilibrium: boolean;
}): number {
  if (Math.abs(args.carbonationError) <= 0.04) return 0;

  if (args.carbonationError > 0) {
    let headroom = clamp(
      0.10 + 1.1 * args.carbonationError,
      0.15,
      0.35,
    );

    if (args.hasLocalEquilibrium) {
      headroom = Math.max(0.12, headroom - 0.05);
    }

    const currentTemp = finite(args.state.currentTemp);
    const coldTemp = finite(args.coldReferenceTemperature);
    if (
      isEffectivelyStillCooling(
        args.state,
        args.coldReferenceTemperature,
      ) &&
      currentTemp !== null &&
      coldTemp !== null &&
      currentTemp > coldTemp + 1
    ) {
      const gapFactor = clamp((currentTemp - coldTemp) / 6, 0, 1);
      headroom += 0.14 + 0.04 * gapFactor;
    } else if (
      args.state.cooling &&
      !args.state.cooling.stillCooling &&
      args.state.cooling.hoursSinceCooling > 120 &&
      !args.hasLocalEquilibrium
    ) {
      headroom += Math.min(
        0.10,
        (args.state.cooling.hoursSinceCooling - 120) / 240 * 0.10,
      );
    }

    return clamp(headroom, 0.12, 0.50);
  }

  const excess = Math.abs(args.carbonationError);
  return -clamp(0.12 + 4.5 * excess, 0.15, 0.55);
}

function learnedHeadroom(args: {
  rows: WeightedTransition[];
  targetCarbonation: number;
  carbonationError: number;
  coldReferenceTemperature: number | null;
  equilibriumPressureAtTemperature?: (temperature: number | null) => number | null;
}): { value: number; support: number } | null {
  const equilibriumForTemperature =
    args.equilibriumPressureAtTemperature;

  if (
    !equilibriumForTemperature ||
    Math.abs(args.carbonationError) <= 0.04
  ) {
    return null;
  }

  const sameDirection = args.rows
    .map((row) => {
      const sampleError =
        args.targetCarbonation - row.sample.startCarbonation;
      if (
        Math.abs(sampleError) <= 0.04 ||
        Math.sign(sampleError) !== Math.sign(args.carbonationError) ||
        Math.abs(row.sample.endCarbonation - args.targetCarbonation) > 0.06
      ) {
        return null;
      }

      const pressure = finite(row.sample.pressureMeanDuring);
      const sampleTemp = finite(row.sample.currentTemp);
      const referenceTemp =
        row.sample.cooling?.stillCooling &&
        args.coldReferenceTemperature !== null
          ? args.coldReferenceTemperature
          : sampleTemp;
      const equilibrium =
        equilibriumForTemperature(referenceTemp);
      if (pressure === null || equilibrium === null) return null;

      const deficitDistance =
        Math.abs(sampleError - args.carbonationError) / 0.08;
      const weight =
        row.weight / (1 + deficitDistance * deficitDistance);

      return {
        headroom: pressure - equilibrium,
        weight,
      };
    })
    .filter((row): row is { headroom: number; weight: number } =>
      row !== null &&
      Number.isFinite(row.headroom) &&
      Number.isFinite(row.weight) &&
      row.weight > 0
    )
    .sort((a, b) => a.headroom - b.headroom);

  if (sameDirection.length < 4) return null;

  const totalWeight = sameDirection.reduce((sum, row) => sum + row.weight, 0);
  if (totalWeight <= 0) return null;

  let running = 0;
  const targetWeight = totalWeight / 2;
  let median = sameDirection[sameDirection.length - 1].headroom;
  for (const row of sameDirection) {
    running += row.weight;
    if (running >= targetWeight) {
      median = row.headroom;
      break;
    }
  }

  return {
    value: median,
    support: sameDirection.length,
  };
}

function blendHeadroom(
  prior: number,
  learned: { value: number; support: number } | null,
): { value: number; support: number } {
  if (!learned) return { value: prior, support: 0 };
  if (Math.sign(learned.value) !== Math.sign(prior)) {
    return { value: prior, support: learned.support };
  }

  const learnedWeight =
    learned.support >= 12
      ? 0.50
      : learned.support >= 8
        ? 0.40
        : 0.25;

  const blended =
    prior * (1 - learnedWeight) +
    learned.value * learnedWeight;

  return {
    value: clamp(blended, prior - 0.12, prior + 0.12),
    support: learned.support,
  };
}

function refinePressureWithForecast(args: {
  baselinePressure: number;
  state: PressureV4DecisionState;
  targetCarbonation: number;
  pressureCalibrationOffset: number;
  coldReferenceTemperature: number | null;
  kPerHour: number;
  horizonHours: number;
  minPressure: number;
  maxPressure: number;
  step: number;
}): number {
  // On the first/early cold check, if the operational calculation already
  // says to vent from a high closing pressure, do not let a slow fitted k undo
  // that decision. The stored head pressure plus continuing cooling are the
  // dominant information in this phase.
  if (
    isEffectivelyStillCooling(
      args.state,
      args.coldReferenceTemperature,
    ) &&
    args.state.carbonation < args.targetCarbonation &&
    args.baselinePressure < args.state.currentPressure
  ) {
    return args.baselinePressure;
  }

  const currentAtBaseline = simulateForward({
    carbonation: args.state.carbonation,
    pressureBar: args.baselinePressure,
    pressureCalibrationOffset: args.pressureCalibrationOffset,
    state: args.state,
    coldReferenceTemperature: args.coldReferenceTemperature,
    kPerHour: args.kPerHour,
    hours: args.horizonHours,
  });
  if (currentAtBaseline === null) return args.baselinePressure;

  const baselineError =
    Math.abs(currentAtBaseline - args.targetCarbonation);
  if (baselineError <= 0.025) return args.baselinePressure;

  // k is a bounded fine-tuner, not the primary decision-maker. The allowed
  // correction grows with the actual carbonation deficit/excess: tiny misses
  // get a tiny pressure trim, while a 0.12-0.15 vol deficit may justify roughly
  // another 0.4-0.5 bar. This keeps pressure changes monotonic without returning
  // to the old "slow k => 1.9 bar" failure mode.
  const direction =
    currentAtBaseline < args.targetCarbonation ? 1 : -1;
  const currentCarbError = Math.abs(
    args.targetCarbonation - args.state.carbonation,
  );
  const maxRefinement = clamp(
    0.12 +
      1.6 * currentCarbError +
      6 * Math.max(0, currentCarbError - 0.10),
    0.15,
    0.50,
  );
  let bestPressure = args.baselinePressure;
  let bestError = baselineError;

  for (
    let delta = args.step;
    delta <= maxRefinement + 0.001;
    delta += args.step
  ) {
    const candidate = snapPressure(
      args.baselinePressure + direction * delta,
      args.minPressure,
      args.maxPressure,
      args.step,
    );
    const predicted = simulateForward({
      carbonation: args.state.carbonation,
      pressureBar: candidate,
      pressureCalibrationOffset: args.pressureCalibrationOffset,
      state: args.state,
      coldReferenceTemperature: args.coldReferenceTemperature,
      kPerHour: args.kPerHour,
      hours: args.horizonHours,
    });
    if (predicted === null) continue;

    const error = Math.abs(predicted - args.targetCarbonation);
    if (error + 0.003 < bestError) {
      bestError = error;
      bestPressure = candidate;
    }
  }

  return bestPressure;
}

function snapPressure(
  pressure: number,
  minPressure: number,
  maxPressure: number,
  step: number,
): number {
  const clamped = clamp(pressure, minPressure, maxPressure);
  return Number(
    (Math.round(clamped / step) * step).toFixed(2),
  );
}

export function estimatePressureTargetV4(args: {
  samples?: PressureV4Sample[];
  passiveSamples?: PressureV4PassiveSample[];
  transitions?: PressureV4TransitionSample[];
  state: PressureV4DecisionState;
  targetCarbonation: number;
  minPressure?: number;
  maxPressure?: number;
  step?: number;
  equilibriumPressure?: number | null;
  equilibriumPressureAtTemperature?: (temperature: number | null) => number | null;
  coldReferenceTemperature?: number | null;
  horizonHours?: number;
}): PressureV4Estimate | null {
  const minPressure = finite(args.minPressure) ?? 0;
  const maxPressure = finite(args.maxPressure) ?? 1.9;
  const step = finite(args.step) ?? 0.05;
  const horizonHours = finite(args.horizonHours) ?? 48;
  const currentTemp = finite(args.state.currentTemp);
  const coldReferenceTemperature = finite(args.coldReferenceTemperature);

  if (
    currentTemp === null ||
    currentTemp > 9 ||
    !Number.isFinite(args.state.carbonation) ||
    !Number.isFinite(args.state.currentPressure) ||
    !Number.isFinite(args.targetCarbonation) ||
    step <= 0 ||
    horizonHours <= 0 ||
    maxPressure < minPressure
  ) return null;

  const rows = localTransitions(args.transitions ?? [], args.state);
  if (rows.length < 4) return null;

  const carbonationError =
    args.targetCarbonation - args.state.carbonation;
  const kineticRows = directionalTransitions(rows, carbonationError);
  const kPerHour = estimateK(kineticRows);
  if (kPerHour === null) return null;

  const refTemp = referenceTemperature(
    args.state,
    coldReferenceTemperature,
  );
  if (refTemp === null) return null;

  const standardTargetEquilibrium = equilibriumPressureBar(
    refTemp,
    args.targetCarbonation,
  );
  if (standardTargetEquilibrium === null) return null;

  const localEquilibrium = localStableTargetEquilibrium({
    state: args.state,
    targetCarbonation: args.targetCarbonation,
  });
  const learnedEquilibrium = finite(args.equilibriumPressure);

  // The target equilibrium may be anchored by a genuinely stable historical
  // pair that predates the simulated/current reading. Otherwise use the style
  // curve, then physics as fallback.
  let targetEquilibriumPressure = standardTargetEquilibrium;
  let equilibriumSource: PressureV4Estimate["equilibriumSource"] = "physics";

  if (localEquilibrium !== null) {
    targetEquilibriumPressure = localEquilibrium;
    equilibriumSource = "local_stable";
  } else if (learnedEquilibrium !== null) {
    targetEquilibriumPressure = learnedEquilibrium;
    equilibriumSource = "learned_curve";
  }

  // Keep historical calibration physically plausible. It may correct local
  // gauge/system bias, but it must not turn a cold equilibrium curve into an
  // arbitrary extrapolation several tenths of a bar away.
  targetEquilibriumPressure = clamp(
    targetEquilibriumPressure,
    Math.max(minPressure, standardTargetEquilibrium - 0.35),
    Math.min(maxPressure, standardTargetEquilibrium + 0.35),
  );

  const pressureCalibrationOffset =
    targetEquilibriumPressure - standardTargetEquilibrium;

  const predictedCarbonationWithoutChangeRaw = simulateForward({
    carbonation: args.state.carbonation,
    pressureBar: args.state.currentPressure,
    pressureCalibrationOffset,
    state: args.state,
    coldReferenceTemperature,
    kPerHour,
    hours: horizonHours,
  });
  if (predictedCarbonationWithoutChangeRaw === null) return null;

  const withinTargetNow = Math.abs(carbonationError) <= 0.04;
  const staysWithinTarget =
    Math.abs(
      predictedCarbonationWithoutChangeRaw - args.targetCarbonation,
    ) <= 0.04;

  let headroomBar = 0;
  let headroomSupport = 0;
  let targetPressure = args.state.currentPressure;

  if (!(withinTargetNow && staysWithinTarget)) {
    const prior = headroomPrior({
      carbonationError,
      state: args.state,
      coldReferenceTemperature,
      hasLocalEquilibrium: localEquilibrium !== null,
    });
    const learned = learnedHeadroom({
      rows,
      targetCarbonation: args.targetCarbonation,
      carbonationError,
      coldReferenceTemperature,
      equilibriumPressureAtTemperature:
        args.equilibriumPressureAtTemperature,
    });
    const blended = blendHeadroom(prior, learned);
    headroomBar = blended.value;
    headroomSupport = blended.support;

    targetPressure = snapPressure(
      targetEquilibriumPressure + headroomBar,
      minPressure,
      maxPressure,
      step,
    );

    // Avoid meaningless 0.05-bar oscillations. If the newly calculated target
    // is practically the current setting, leave the regulator alone.
    if (
      Math.abs(targetPressure - args.state.currentPressure) < 0.075 &&
      staysWithinTarget
    ) {
      targetPressure = args.state.currentPressure;
    }

    targetPressure = refinePressureWithForecast({
      baselinePressure: targetPressure,
      state: args.state,
      targetCarbonation: args.targetCarbonation,
      pressureCalibrationOffset,
      coldReferenceTemperature,
      kPerHour,
      horizonHours,
      minPressure,
      maxPressure,
      step,
    });
  }

  const action: PressureV4Estimate["action"] =
    Math.abs(targetPressure - args.state.currentPressure) < 0.025
      ? "hold"
      : targetPressure > args.state.currentPressure
        ? "raise"
        : "lower";

  const predictedRaw = simulateForward({
    carbonation: args.state.carbonation,
    pressureBar: targetPressure,
    pressureCalibrationOffset,
    state: args.state,
    coldReferenceTemperature,
    kPerHour,
    hours: horizonHours,
  });
  if (predictedRaw === null) return null;

  const candidates: PressureV4Candidate[] = [];
  const count = Math.round((maxPressure - minPressure) / step);
  const effectiveWeight = kineticRows.reduce(
    (sum, row) => sum + row.weight,
    0,
  );

  for (let index = 0; index <= count; index += 1) {
    const pressure = Number((minPressure + index * step).toFixed(2));
    const predicted = simulateForward({
      carbonation: args.state.carbonation,
      pressureBar: pressure,
      pressureCalibrationOffset,
      state: args.state,
      coldReferenceTemperature,
      kPerHour,
      hours: horizonHours,
    });
    if (predicted === null) continue;

    candidates.push({
      targetPressure: pressure,
      predictedCarbonation: Number(predicted.toFixed(3)),
      predictedDelta: Number(
        (predicted - args.state.carbonation).toFixed(3),
      ),
      supportCount: kineticRows.length,
      effectiveWeight,
    });
  }

  const meanDistance =
    kineticRows.reduce((sum, row) => sum + row.distance, 0) /
    kineticRows.length;
  const k25 = weightedQuantile(
    kineticRows,
    (row) => row.sample.kPerHour,
    0.25,
  );
  const k75 = weightedQuantile(
    kineticRows,
    (row) => row.sample.kPerHour,
    0.75,
  );
  const spread =
    k25 !== null && k75 !== null && k25 > 0
      ? k75 / k25
      : Infinity;

  const confidence: PressureV4Estimate["confidence"] =
    kineticRows.length >= 12 && meanDistance <= 2.5 && spread <= 2.5
      ? "high"
      : kineticRows.length >= 6 && meanDistance <= 4 && spread <= 4
        ? "medium"
        : "low";

  const pressureOnlyLikelyInsufficient =
    carbonationError > 0.15 &&
    Boolean(args.state.cooling) &&
    args.state.cooling!.stillCooling === false &&
    args.state.cooling!.hoursSinceCooling >= 120 &&
    kPerHour < 0.003;

  return {
    targetPressure: Number(targetPressure.toFixed(2)),
    predictedCarbonation: Number(predictedRaw.toFixed(3)),
    predictedCarbonationWithoutChange: Number(
      predictedCarbonationWithoutChangeRaw.toFixed(3),
    ),
    targetCarbonation: args.targetCarbonation,
    error: Number(
      Math.abs(predictedRaw - args.targetCarbonation).toFixed(3),
    ),
    supportCount: kineticRows.length,
    confidence,
    accuracyPercent: accuracyPercent(kineticRows, kPerHour),
    candidates,
    kPerHour: Number(kPerHour.toFixed(5)),
    targetEquilibriumPressure: Number(
      targetEquilibriumPressure.toFixed(2),
    ),
    referenceTemperature: Number(refTemp.toFixed(1)),
    equilibriumSource,
    headroomBar: Number(headroomBar.toFixed(2)),
    headroomSupport,
    action,
    pressureOnlyLikelyInsufficient,
  };
}
