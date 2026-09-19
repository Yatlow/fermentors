import {
  equilibriumCarbonationVolumes,
  equilibriumPressureBar,
} from "./pressureCarbonationPhysics";
import type {
  PressureV4DecisionState,
  PressureV4PassiveSample,
  PressureV4Sample,
  PressureV4TransitionSample,
} from "./pressurePredictionV4";

const OPERATIONAL_VOL_PER_BAR_48H = 0.67;
const MAX_OPERATIONAL_PRESSURE_BAR = 1.9;
const MIN_K_PER_HOUR = 0.002;
const MAX_K_PER_HOUR = 0.04;

export type PressureV5Estimate = {
  version: 5;
  mode: "stable" | "first_cooling";

  measuredCarbonation: number;
  estimatedCurrentCarbonation: number;
  hoursSinceCarbonationMeasurement: number;

  currentPressure: number;
  currentTemperature: number;
  forecastTemperature: number;
  targetCarbonation: number;

  kPerHour: number;
  kSource: "learned" | "heuristic" | "guarded";
  rawLearnedKPerHour: number | null;
  effectiveVolPerBar48h: number;
  supportCount: number;
  confidence: "low" | "medium" | "high";

  equilibriumPressureForCurrentCarb: number;
  pressureDistanceFromEquilibrium: number;
  predictedWithoutChange: number;

  rawTargetPressure: number | null;
  targetPressure: number | null;
  predictedAtTarget: number | null;

  action: "hold" | "raise" | "lower" | "edge_case";
  edgeCase:
    | null
    | "bottom_carbonation"
    | "venting_below_zero"
    | "head_pressure_insufficient";
};

function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function weightedMedian(
  rows: Array<{ value: number; weight: number }>,
): number | null {
  const sorted = rows
    .filter((row) =>
      Number.isFinite(row.value) &&
      Number.isFinite(row.weight) &&
      row.weight > 0
    )
    .slice()
    .sort((a, b) => a.value - b.value);

  if (!sorted.length) return null;

  const total = sorted.reduce((sum, row) => sum + row.weight, 0);
  if (total <= 0) return null;

  let running = 0;
  for (const row of sorted) {
    running += row.weight;
    if (running >= total / 2) return row.value;
  }
  return sorted[sorted.length - 1].value;
}

function qualityWeight(quality: "low" | "medium" | "high"): number {
  return quality === "high" ? 1 : quality === "medium" ? 0.7 : 0.3;
}

function calibrationOffset(args: {
  temperature: number;
  targetCarbonation: number;
  equilibriumPressureAtTemperature?: (
    temperature: number | null,
  ) => number | null;
}): number {
  if (!args.equilibriumPressureAtTemperature) return 0;

  const localTarget = finite(
    args.equilibriumPressureAtTemperature(args.temperature),
  );
  const standardTarget = equilibriumPressureBar(
    args.temperature,
    args.targetCarbonation,
  );
  if (localTarget === null || standardTarget === null) return 0;

  return clamp(localTarget - standardTarget, -0.35, 0.35);
}

function calibratedEquilibriumPressure(args: {
  temperature: number;
  carbonation: number;
  targetCarbonation: number;
  equilibriumPressureAtTemperature?: (
    temperature: number | null,
  ) => number | null;
}): number | null {
  const standard = equilibriumPressureBar(
    args.temperature,
    args.carbonation,
  );
  if (standard === null) return null;

  return (
    standard +
    calibrationOffset({
      temperature: args.temperature,
      targetCarbonation: args.targetCarbonation,
      equilibriumPressureAtTemperature:
        args.equilibriumPressureAtTemperature,
    })
  );
}

function calibratedEquilibriumCarbonation(args: {
  temperature: number;
  pressure: number;
  targetCarbonation: number;
  equilibriumPressureAtTemperature?: (
    temperature: number | null,
  ) => number | null;
}): number | null {
  const offset = calibrationOffset({
    temperature: args.temperature,
    targetCarbonation: args.targetCarbonation,
    equilibriumPressureAtTemperature:
      args.equilibriumPressureAtTemperature,
  });

  return equilibriumCarbonationVolumes(
    args.temperature,
    args.pressure - offset,
  );
}

function equilibriumSlopeVolPerBar(args: {
  temperature: number;
  targetCarbonation: number;
  equilibriumPressureAtTemperature?: (
    temperature: number | null,
  ) => number | null;
}): number {
  const equilibriumPressure = calibratedEquilibriumPressure({
    temperature: args.temperature,
    carbonation: args.targetCarbonation,
    targetCarbonation: args.targetCarbonation,
    equilibriumPressureAtTemperature:
      args.equilibriumPressureAtTemperature,
  });

  if (equilibriumPressure === null) return 1.5;

  const low = calibratedEquilibriumCarbonation({
    temperature: args.temperature,
    pressure: Math.max(0, equilibriumPressure - 0.1),
    targetCarbonation: args.targetCarbonation,
    equilibriumPressureAtTemperature:
      args.equilibriumPressureAtTemperature,
  });
  const high = calibratedEquilibriumCarbonation({
    temperature: args.temperature,
    pressure: equilibriumPressure + 0.1,
    targetCarbonation: args.targetCarbonation,
    equilibriumPressureAtTemperature:
      args.equilibriumPressureAtTemperature,
  });

  if (low === null || high === null) return 1.5;
  const slope = (high - low) / 0.2;
  return Number.isFinite(slope) && slope > 0 ? slope : 1.5;
}

function defaultKPerHour(args: {
  temperature: number;
  targetCarbonation: number;
  equilibriumPressureAtTemperature?: (
    temperature: number | null,
  ) => number | null;
}): number {
  const equilibriumSlope = equilibriumSlopeVolPerBar(args);

  // Translate the brewery's practical rule (~0.67 vol/bar over a normal
  // two-day response window) into a first-order fraction of equilibrium.
  const alpha48 = clamp(
    OPERATIONAL_VOL_PER_BAR_48H / equilibriumSlope,
    0.25,
    0.75,
  );
  return -Math.log(1 - alpha48) / 48;
}

function learnK(args: {
  transitions?: PressureV4TransitionSample[];
  state: PressureV4DecisionState;
  temperature: number;
  targetCarbonation: number;
  equilibriumPressureAtTemperature?: (
    temperature: number | null,
  ) => number | null;
}): {
  kPerHour: number;
  source: "learned" | "heuristic" | "guarded";
  rawLearnedKPerHour: number | null;
  supportCount: number;
  confidence: "low" | "medium" | "high";
} {
  const fallback = defaultKPerHour({
    temperature: args.temperature,
    targetCarbonation: args.targetCarbonation,
    equilibriumPressureAtTemperature:
      args.equilibriumPressureAtTemperature,
  });

  const candidates = (args.transitions ?? [])
    .filter((sample) =>
      sample.quality !== "low" &&
      Number.isFinite(sample.kPerHour) &&
      sample.kPerHour > 0
    )
    .map((sample) => {
      const temp = finite(
        sample.temperatureMeanDuring ?? sample.currentTemp,
      );
      const pressure = finite(
        sample.pressureMeanDuring ?? sample.currentPressure,
      );

      let distance = 0;
      distance +=
        Math.abs(
          sample.startCarbonation - args.state.carbonation,
        ) / 0.25;

      if (temp !== null) {
        distance += Math.abs(temp - args.temperature) / 4;
      }
      if (pressure !== null) {
        distance +=
          Math.abs(pressure - args.state.currentPressure) / 0.6;
      }

      return {
        value: sample.kPerHour,
        weight: qualityWeight(sample.quality) / (0.4 + distance),
      };
    })
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 24);

  if (candidates.length < 4) {
    return {
      kPerHour: fallback,
      source: "heuristic",
      rawLearnedKPerHour: null,
      supportCount: candidates.length,
      confidence: "low",
    };
  }

  const raw = weightedMedian(candidates);
  if (raw === null) {
    return {
      kPerHour: fallback,
      source: "heuristic",
      rawLearnedKPerHour: null,
      supportCount: candidates.length,
      confidence: "low",
    };
  }

  const confidence: "low" | "medium" | "high" =
    candidates.length >= 12
      ? "high"
      : candidates.length >= 6
        ? "medium"
        : "low";

  if (raw < MIN_K_PER_HOUR || raw > MAX_K_PER_HOUR) {
    return {
      kPerHour: fallback,
      source: "guarded",
      rawLearnedKPerHour: Number(raw.toFixed(6)),
      supportCount: candidates.length,
      confidence,
    };
  }

  const blended = clamp(
    fallback * 0.35 + raw * 0.65,
    MIN_K_PER_HOUR,
    MAX_K_PER_HOUR,
  );

  return {
    kPerHour: blended,
    source: "learned",
    rawLearnedKPerHour: Number(raw.toFixed(6)),
    supportCount: candidates.length,
    confidence,
  };
}

function simulateConstantState(args: {
  carbonation: number;
  pressure: number;
  temperature: number;
  hours: number;
  kPerHour: number;
  targetCarbonation: number;
  equilibriumPressureAtTemperature?: (
    temperature: number | null,
  ) => number | null;
}): number | null {
  const equilibrium = calibratedEquilibriumCarbonation({
    temperature: args.temperature,
    pressure: args.pressure,
    targetCarbonation: args.targetCarbonation,
    equilibriumPressureAtTemperature:
      args.equilibriumPressureAtTemperature,
  });
  if (equilibrium === null) return null;

  const decay = Math.exp(-args.kPerHour * Math.max(0, args.hours));
  return equilibrium - (equilibrium - args.carbonation) * decay;
}

function estimateCoolingHoursToReference(args: {
  state: PressureV4DecisionState;
  currentTemp: number;
  coldReference: number;
}): number {
  const remaining = Math.max(
    0,
    args.currentTemp - args.coldReference,
  );
  if (remaining <= 0.05) return 0;

  const change24 = finite(args.state.cooling?.tempChange24h);
  if (change24 !== null && change24 < -0.2) {
    return clamp(remaining / (Math.abs(change24) / 24), 4, 48);
  }

  const drop = finite(args.state.cooling?.tempDropSinceCooling);
  const hours = finite(args.state.cooling?.hoursSinceCooling);
  if (drop !== null && drop > 0.5 && hours !== null && hours > 1) {
    return clamp(remaining / (drop / hours), 4, 48);
  }

  return 24;
}

function simulateForward(args: {
  carbonation: number;
  pressure: number;
  currentTemp: number;
  coldReference: number | null;
  coolingHours: number;
  hours: number;
  kPerHour: number;
  targetCarbonation: number;
  equilibriumPressureAtTemperature?: (
    temperature: number | null,
  ) => number | null;
}): number | null {
  let carbonation = args.carbonation;
  const stepHours = 1;
  const decay = Math.exp(-args.kPerHour * stepHours);

  for (let hour = 0; hour < args.hours; hour += stepHours) {
    const progress =
      args.coldReference !== null && args.coolingHours > 0
        ? clamp((hour + 0.5) / args.coolingHours, 0, 1)
        : 0;

    const temperature =
      args.coldReference !== null
        ? args.currentTemp +
          (args.coldReference - args.currentTemp) * progress
        : args.currentTemp;

    const equilibrium = calibratedEquilibriumCarbonation({
      temperature,
      pressure: args.pressure,
      targetCarbonation: args.targetCarbonation,
      equilibriumPressureAtTemperature:
        args.equilibriumPressureAtTemperature,
    });
    if (equilibrium === null) return null;

    carbonation =
      equilibrium - (equilibrium - carbonation) * decay;
  }

  return carbonation;
}

function roundPressure(pressure: number): number {
  return Math.round(pressure * 20) / 20;
}

export function estimatePressureTargetV5(args: {
  samples?: PressureV4Sample[];
  passiveSamples?: PressureV4PassiveSample[];
  transitions?: PressureV4TransitionSample[];
  state: PressureV4DecisionState;
  targetCarbonation: number;
  coldReferenceTemperature?: number | null;
  firstCarbonation?: boolean;
  equilibriumPressureAtTemperature?: (
    temperature: number | null,
  ) => number | null;
}): PressureV5Estimate | null {
  const measuredCarbonation = finite(args.state.carbonation);
  const currentPressure = finite(args.state.currentPressure);
  const currentTemp = finite(args.state.currentTemp);

  if (
    measuredCarbonation === null ||
    currentPressure === null ||
    currentTemp === null ||
    !Number.isFinite(args.targetCarbonation)
  ) return null;

  const coldReference = finite(args.coldReferenceTemperature);
  const firstCoolingMode =
    args.firstCarbonation === true &&
    coldReference !== null &&
    coldReference < currentTemp - 0.05;

  const forecastTemperature =
    firstCoolingMode && coldReference !== null
      ? coldReference
      : currentTemp;

  const learned = learnK({
    transitions: args.transitions,
    state: args.state,
    temperature: forecastTemperature,
    targetCarbonation: args.targetCarbonation,
    equilibriumPressureAtTemperature:
      args.equilibriumPressureAtTemperature,
  });

  const ageHours = clamp(
    finite(args.state.hoursSinceCurrentCarbonation) ?? 0,
    0,
    120,
  );

  let estimatedCurrentCarbonation = measuredCarbonation;
  const postExposure = args.state.postCarbonationExposure;
  if (ageHours > 0.5 && postExposure) {
    const meanPressure =
      finite(postExposure.pressureMean) ?? currentPressure;
    const meanTemp =
      finite(postExposure.temperatureMean) ?? currentTemp;

    const projected = simulateConstantState({
      carbonation: measuredCarbonation,
      pressure: meanPressure,
      temperature: meanTemp,
      hours: ageHours,
      kPerHour: learned.kPerHour,
      targetCarbonation: args.targetCarbonation,
      equilibriumPressureAtTemperature:
        args.equilibriumPressureAtTemperature,
    });
    if (projected !== null) {
      estimatedCurrentCarbonation = projected;
    }
  }

  const equilibriumPressure = calibratedEquilibriumPressure({
    temperature: forecastTemperature,
    carbonation: estimatedCurrentCarbonation,
    targetCarbonation: args.targetCarbonation,
    equilibriumPressureAtTemperature:
      args.equilibriumPressureAtTemperature,
  });
  if (equilibriumPressure === null) return null;

  const coolingHours =
    firstCoolingMode && coldReference !== null
      ? estimateCoolingHoursToReference({
          state: args.state,
          currentTemp,
          coldReference,
        })
      : 0;

  const forecast = (pressure: number): number | null =>
    simulateForward({
      carbonation: estimatedCurrentCarbonation,
      pressure,
      currentTemp,
      coldReference:
        firstCoolingMode && coldReference !== null
          ? coldReference
          : null,
      coolingHours,
      hours: 48,
      kPerHour: learned.kPerHour,
      targetCarbonation: args.targetCarbonation,
      equilibriumPressureAtTemperature:
        args.equilibriumPressureAtTemperature,
    });

  const predictedWithoutChange = forecast(currentPressure);
  if (predictedWithoutChange === null) return null;

  const alpha48 = 1 - Math.exp(-learned.kPerHour * 48);
  const eqSlope = equilibriumSlopeVolPerBar({
    temperature: forecastTemperature,
    targetCarbonation: args.targetCarbonation,
    equilibriumPressureAtTemperature:
      args.equilibriumPressureAtTemperature,
  });
  const effectiveVolPerBar48h = alpha48 * eqSlope;

  const pressureDistance =
    currentPressure - equilibriumPressure;

  const base: Omit<
    PressureV5Estimate,
    | "rawTargetPressure"
    | "targetPressure"
    | "predictedAtTarget"
    | "action"
    | "edgeCase"
  > = {
    version: 5,
    mode: firstCoolingMode ? "first_cooling" : "stable",
    measuredCarbonation,
    estimatedCurrentCarbonation:
      Number(estimatedCurrentCarbonation.toFixed(3)),
    hoursSinceCarbonationMeasurement:
      Number(ageHours.toFixed(1)),
    currentPressure,
    currentTemperature: currentTemp,
    forecastTemperature,
    targetCarbonation: args.targetCarbonation,
    kPerHour: Number(learned.kPerHour.toFixed(6)),
    kSource: learned.source,
    rawLearnedKPerHour: learned.rawLearnedKPerHour,
    effectiveVolPerBar48h:
      Number(effectiveVolPerBar48h.toFixed(3)),
    supportCount: learned.supportCount,
    confidence: learned.confidence,
    equilibriumPressureForCurrentCarb:
      Number(equilibriumPressure.toFixed(2)),
    pressureDistanceFromEquilibrium:
      Number(pressureDistance.toFixed(2)),
    predictedWithoutChange:
      Number(predictedWithoutChange.toFixed(3)),
  };

  if (measuredCarbonation < 2.15) {
    return {
      ...base,
      rawTargetPressure: null,
      targetPressure: null,
      predictedAtTarget: null,
      action: "edge_case",
      edgeCase: "bottom_carbonation",
    };
  }

  const atZero = forecast(0);
  const atMax = forecast(MAX_OPERATIONAL_PRESSURE_BAR);
  if (atZero === null || atMax === null) return null;

  if (atZero > args.targetCarbonation) {
    return {
      ...base,
      rawTargetPressure: -0.01,
      targetPressure: null,
      predictedAtTarget: Number(atZero.toFixed(3)),
      action: "edge_case",
      edgeCase: "venting_below_zero",
    };
  }

  if (atMax < args.targetCarbonation) {
    return {
      ...base,
      rawTargetPressure: MAX_OPERATIONAL_PRESSURE_BAR + 0.01,
      targetPressure: null,
      predictedAtTarget: Number(atMax.toFixed(3)),
      action: "edge_case",
      edgeCase: "head_pressure_insufficient",
    };
  }

  let low = 0;
  let high = MAX_OPERATIONAL_PRESSURE_BAR;
  for (let i = 0; i < 45; i += 1) {
    const mid = (low + high) / 2;
    const predicted = forecast(mid);
    if (predicted === null) return null;
    if (predicted < args.targetCarbonation) {
      low = mid;
    } else {
      high = mid;
    }
  }

  const rawTargetPressure = (low + high) / 2;
  const targetPressure = roundPressure(rawTargetPressure);
  const predictedAtTarget = forecast(targetPressure);
  if (predictedAtTarget === null) return null;

  const pressureDelta = targetPressure - currentPressure;
  const action: PressureV5Estimate["action"] =
    Math.abs(pressureDelta) < 0.075
      ? "hold"
      : pressureDelta > 0
        ? "raise"
        : "lower";

  return {
    ...base,
    rawTargetPressure: Number(rawTargetPressure.toFixed(2)),
    targetPressure,
    predictedAtTarget: Number(predictedAtTarget.toFixed(3)),
    action,
    edgeCase: null,
  };
}
