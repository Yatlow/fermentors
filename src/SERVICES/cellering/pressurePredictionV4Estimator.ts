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

  // History matters explicitly: identical age at different sustained pressure
  // is not the same physical state.
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
        // For this lightweight leave-one-out check, closeness in fitted k is
        // deliberately not used; only state similarity determines the model.
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
      pressureBar: args.pressureBar,
      temperatureC: temp,
      kPerHour: args.kPerHour,
      hours,
    });
    if (next === null) return null;
    carbonation = next;
  }

  return carbonation;
}

export function estimatePressureTargetV4(args: {
  // Legacy arrays remain in the model document during migration. The kinetic
  // calculator intentionally learns from full carbonation-to-carbonation
  // transitions instead.
  samples?: PressureV4Sample[];
  passiveSamples?: PressureV4PassiveSample[];
  transitions?: PressureV4TransitionSample[];
  state: PressureV4DecisionState;
  targetCarbonation: number;
  minPressure?: number;
  maxPressure?: number;
  step?: number;
  firstCarbonation?: boolean;
  equilibriumPressure?: number | null;
  coldReferenceTemperature?: number | null;
  horizonHours?: number;
}): PressureV4Estimate | null {
  const minPressure = finite(args.minPressure) ?? 0;
  const maxPressure = finite(args.maxPressure) ?? 1.9;
  const step = finite(args.step) ?? 0.05;
  const horizonHours = finite(args.horizonHours) ?? 48;
  const currentTemp = finite(args.state.currentTemp);

  if (
    currentTemp === null ||
    !Number.isFinite(args.state.carbonation) ||
    !Number.isFinite(args.state.currentPressure) ||
    !Number.isFinite(args.targetCarbonation) ||
    step <= 0 ||
    horizonHours <= 0 ||
    maxPressure < minPressure
  ) return null;

  const standardTargetEquilibrium = equilibriumPressureBar(
    currentTemp,
    args.targetCarbonation,
  );
  const learnedTargetEquilibrium = finite(args.equilibriumPressure);
  const equilibriumPressureOffset =
    learnedTargetEquilibrium !== null &&
    standardTargetEquilibrium !== null
      ? learnedTargetEquilibrium - standardTargetEquilibrium
      : 0;

  const rows = localTransitions(args.transitions ?? [], args.state);
  if (rows.length < 4) return null;

  const kPerHour = estimateK(rows);
  if (kPerHour === null) return null;

  const candidates: PressureV4Candidate[] = [];
  const count = Math.round((maxPressure - minPressure) / step);
  const effectiveWeight = rows.reduce((sum, row) => sum + row.weight, 0);

  for (let index = 0; index <= count; index += 1) {
    const targetPressure = Number((minPressure + index * step).toFixed(2));
    const predicted = simulateForward({
      carbonation: args.state.carbonation,
      pressureBar: targetPressure - equilibriumPressureOffset,
      state: args.state,
      coldReferenceTemperature: finite(args.coldReferenceTemperature),
      kPerHour,
      hours: horizonHours,
    });
    if (predicted === null) continue;

    candidates.push({
      targetPressure,
      predictedCarbonation: Number(predicted.toFixed(3)),
      predictedDelta: Number((predicted - args.state.carbonation).toFixed(3)),
      supportCount: rows.length,
      effectiveWeight,
    });
  }

  if (!candidates.length) return null;

  const noChange = simulateForward({
    carbonation: args.state.carbonation,
    pressureBar: args.state.currentPressure - equilibriumPressureOffset,
    state: args.state,
    coldReferenceTemperature: finite(args.coldReferenceTemperature),
    kPerHour,
    hours: horizonHours,
  });
  if (noChange === null) return null;

  const ranked = [...candidates].sort((a, b) => {
    const aError = Math.abs(a.predictedCarbonation - args.targetCarbonation);
    const bError = Math.abs(b.predictedCarbonation - args.targetCarbonation);
    if (Math.abs(aError - bError) > 0.002) return aError - bError;
    return (
      Math.abs(a.targetPressure - args.state.currentPressure) -
      Math.abs(b.targetPressure - args.state.currentPressure)
    );
  });

  const best = ranked[0];
  const error = Math.abs(best.predictedCarbonation - args.targetCarbonation);

  // Do not present an operational boundary as a precise recommendation when
  // the physical model still cannot reach the target over the requested horizon.
  if (error > 0.06) return null;

  const meanDistance =
    rows.reduce((sum, row) => sum + row.distance, 0) / rows.length;
  const k25 = weightedQuantile(rows, (row) => row.sample.kPerHour, 0.25);
  const k75 = weightedQuantile(rows, (row) => row.sample.kPerHour, 0.75);
  const spread =
    k25 !== null && k75 !== null && k25 > 0
      ? k75 / k25
      : Infinity;

  const confidence: PressureV4Estimate["confidence"] =
    rows.length >= 12 && meanDistance <= 2.5 && spread <= 2.5
      ? "high"
      : rows.length >= 6 && meanDistance <= 4 && spread <= 4
        ? "medium"
        : "low";

  return {
    targetPressure: best.targetPressure,
    predictedCarbonation: best.predictedCarbonation,
    predictedCarbonationWithoutChange: Number(noChange.toFixed(3)),
    targetCarbonation: args.targetCarbonation,
    error: Number(error.toFixed(3)),
    supportCount: rows.length,
    confidence,
    accuracyPercent: accuracyPercent(rows, kPerHour),
    candidates,
    kPerHour: Number(kPerHour.toFixed(5)),
    targetEquilibriumPressure:
      learnedTargetEquilibrium ?? standardTargetEquilibrium,
  };
}
