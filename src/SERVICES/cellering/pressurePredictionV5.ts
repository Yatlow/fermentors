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

const DEFAULT_ALPHA_48H = 0.45;
const MIN_DRIVING_GAP_VOL = 0.04;
const MAX_OPERATIONAL_PRESSURE_BAR = 1.9;

type Quality = "low" | "medium" | "high";

export type PressureV5TrainingPoint = {
  source: "action" | "passive" | "transition";
  batchId?: string;
  alpha48: number;
  startCarbonation: number;
  pressureBar: number;
  temperatureC: number;
  drivingGapVol: number;
  observedDeltaVol: number;
  durationHours: number;
  quality: Quality;
  distance: number;
};

export type PressureV5Estimate = {
  version: 5;
  mode: "stable" | "first_cooling";
  targetCarbonation: number;
  currentCarbonation: number;
  currentPressure: number;
  currentTemperature: number;
  forecastTemperature: number;
  alpha48: number;
  alphaSource: "learned" | "heuristic";
  supportCount: number;
  confidence: "low" | "medium" | "high";
  currentEquilibriumCarbonation: number;
  drivingForceVol: number;
  predictedWithoutChange: number;
  targetEquilibriumCarbonation: number | null;
  rawTargetPressure: number | null;
  targetPressure: number | null;
  predictedAtTarget: number | null;
  action: "hold" | "raise" | "lower" | "edge_case";
  edgeCase:
    | null
    | "bottom_carbonation"
    | "venting_below_zero"
    | "head_pressure_insufficient";
  trainingPoints: PressureV5TrainingPoint[];
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

function qualityWeight(quality: Quality): number {
  return quality === "high" ? 1 : quality === "medium" ? 0.7 : 0.35;
}

function toAlpha48(
  observedDelta: number,
  drivingGap: number,
  durationHours: number,
): number | null {
  if (
    !Number.isFinite(observedDelta) ||
    !Number.isFinite(drivingGap) ||
    !Number.isFinite(durationHours) ||
    durationHours <= 0 ||
    Math.abs(drivingGap) < MIN_DRIVING_GAP_VOL
  ) return null;

  // The observed CO2 change must move toward equilibrium, not away from it.
  if (observedDelta * drivingGap <= 0) return null;

  const alphaDuration = observedDelta / drivingGap;
  if (!Number.isFinite(alphaDuration) || alphaDuration <= 0 || alphaDuration > 1.05) {
    return null;
  }

  // Samples/passive outcomes are normally exactly two calendar days. For
  // transitions of another duration, convert the same first-order approach to
  // its equivalent 48h fraction.
  const bounded = clamp(alphaDuration, 0.001, 0.98);
  const kPerHour = -Math.log(1 - bounded) / durationHours;
  const alpha48 = 1 - Math.exp(-kPerHour * 48);
  return Number.isFinite(alpha48) ? clamp(alpha48, 0.02, 0.98) : null;
}

function pointDistance(args: {
  sampleCarbonation: number;
  samplePressure: number;
  sampleTemp: number;
  currentCarbonation: number;
  currentPressure: number;
  currentTemp: number;
  quality: Quality;
}): number {
  let distance = 0;
  distance += Math.abs(args.sampleCarbonation - args.currentCarbonation) / 0.18;
  distance += Math.abs(args.samplePressure - args.currentPressure) / 0.45;
  distance += Math.abs(args.sampleTemp - args.currentTemp) / 3;
  if (args.quality === "medium") distance += 0.25;
  if (args.quality === "low") distance += 0.9;
  return distance;
}

function pointFromOutcome(args: {
  source: "action" | "passive";
  batchId?: string;
  startCarbonation: number;
  pressureBar: number;
  temperatureC: number | null;
  observedDelta: number;
  quality: Quality;
  state: PressureV4DecisionState;
}): PressureV5TrainingPoint | null {
  if (args.temperatureC === null || !Number.isFinite(args.temperatureC)) return null;

  const equilibrium = equilibriumCarbonationVolumes(
    args.temperatureC,
    args.pressureBar,
  );
  if (equilibrium === null) return null;

  const drivingGap = equilibrium - args.startCarbonation;
  const alpha48 = toAlpha48(args.observedDelta, drivingGap, 48);
  if (alpha48 === null) return null;

  return {
    source: args.source,
    batchId: args.batchId,
    alpha48,
    startCarbonation: args.startCarbonation,
    pressureBar: args.pressureBar,
    temperatureC: args.temperatureC,
    drivingGapVol: drivingGap,
    observedDeltaVol: args.observedDelta,
    durationHours: 48,
    quality: args.quality,
    distance: pointDistance({
      sampleCarbonation: args.startCarbonation,
      samplePressure: args.pressureBar,
      sampleTemp: args.temperatureC,
      currentCarbonation: args.state.carbonation,
      currentPressure: args.state.currentPressure,
      currentTemp: args.state.currentTemp ?? args.temperatureC,
      quality: args.quality,
    }),
  };
}

function pointFromTransition(
  sample: PressureV4TransitionSample,
  state: PressureV4DecisionState,
): PressureV5TrainingPoint | null {
  const pressure = finite(sample.pressureMeanDuring) ?? finite(sample.currentPressure);
  const observedTemp = finite(sample.currentTemp) ?? finite(sample.temperatureMeanDuring);
  // Training must use the temperature the beer actually experienced during
  // the historical transition. Using the future cold endpoint here makes the
  // historical driving gap artificially huge and therefore alpha artificially tiny.
  const equilibriumTemp =
    finite(sample.temperatureMeanDuring) ??
    observedTemp;
  if (pressure === null || observedTemp === null || equilibriumTemp === null) return null;

  const equilibrium = equilibriumCarbonationVolumes(
    equilibriumTemp,
    pressure,
  );
  if (equilibrium === null) return null;

  const observedDelta = sample.endCarbonation - sample.startCarbonation;
  const drivingGap = equilibrium - sample.startCarbonation;
  const alpha48 = toAlpha48(
    observedDelta,
    drivingGap,
    sample.durationHours,
  );
  if (alpha48 === null) return null;

  return {
    source: "transition",
    batchId: sample.batchId,
    alpha48,
    startCarbonation: sample.startCarbonation,
    pressureBar: pressure,
    temperatureC: equilibriumTemp,
    drivingGapVol: drivingGap,
    observedDeltaVol: observedDelta,
    durationHours: sample.durationHours,
    quality: sample.quality,
    distance: pointDistance({
      sampleCarbonation: sample.startCarbonation,
      samplePressure: pressure,
      sampleTemp: observedTemp,
      currentCarbonation: state.carbonation,
      currentPressure: state.currentPressure,
      currentTemp: state.currentTemp ?? observedTemp,
      quality: sample.quality,
    }),
  };
}

export function buildPressureV5TrainingPoints(args: {
  samples?: PressureV4Sample[];
  passiveSamples?: PressureV4PassiveSample[];
  transitions?: PressureV4TransitionSample[];
  state: PressureV4DecisionState;
  firstCarbonation?: boolean;
  coldReferenceTemperature?: number | null;
}): PressureV5TrainingPoint[] {
  const points: PressureV5TrainingPoint[] = [];

  if (args.firstCarbonation) {
    const coldReference = finite(args.coldReferenceTemperature);
    const earlyCoolingTransitions = (args.transitions ?? []).filter((sample) => {
      const cooling = sample.cooling;
      if (!cooling) return false;
      if (cooling.stillCooling) return true;
      if (cooling.hoursSinceCooling <= 120) return true;
      const sampleTemp = finite(sample.currentTemp);
      return (
        coldReference !== null &&
        sampleTemp !== null &&
        sampleTemp >= coldReference + 1.5
      );
    });

    for (const sample of earlyCoolingTransitions) {
      const point = pointFromTransition(
        sample,
        args.state,
      );
      if (point) points.push(point);
    }

    return points
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 24);
  }

  for (const sample of args.samples ?? []) {
    const point = pointFromOutcome({
      source: "action",
      batchId: sample.batchId,
      startCarbonation: sample.carbonationBefore,
      pressureBar: sample.targetPressure,
      temperatureC: sample.currentTemp,
      observedDelta: sample.carbonationDelta,
      quality: sample.quality,
      state: args.state,
    });
    if (point) points.push(point);
  }

  for (const sample of args.passiveSamples ?? []) {
    const point = pointFromOutcome({
      source: "passive",
      batchId: sample.batchId,
      startCarbonation: sample.carbonationBefore,
      pressureBar: sample.currentPressure,
      temperatureC: sample.currentTemp,
      observedDelta: sample.carbonationDelta,
      quality: sample.quality,
      state: args.state,
    });
    if (point) points.push(point);
  }

  // Action/passive samples are closest to the exact 48h decision problem.
  // Only supplement with transitions when there are too few valid 48h points.
  if (points.length < 6) {
    for (const sample of args.transitions ?? []) {
      const point = pointFromTransition(sample, args.state);
      if (point) points.push(point);
    }
  }

  return points
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 24);
}

export function learnPressureV5Alpha(
  points: PressureV5TrainingPoint[],
): {
  alpha48: number;
  source: "learned" | "heuristic";
  supportCount: number;
  confidence: "low" | "medium" | "high";
  retainedPoints: PressureV5TrainingPoint[];
} {
  if (points.length < 4) {
    return {
      alpha48: DEFAULT_ALPHA_48H,
      source: "heuristic",
      supportCount: points.length,
      confidence: "low",
      retainedPoints: points,
    };
  }

  const rawMedian = weightedMedian(
    points.map((point) => ({
      value: point.alpha48,
      weight: qualityWeight(point.quality) / (0.3 + point.distance ** 2),
    })),
  );

  if (rawMedian === null) {
    return {
      alpha48: DEFAULT_ALPHA_48H,
      source: "heuristic",
      supportCount: points.length,
      confidence: "low",
      retainedPoints: points,
    };
  }

  const deviations = points
    .map((point) => Math.abs(point.alpha48 - rawMedian))
    .sort((a, b) => a - b);
  const mad = deviations[Math.floor(deviations.length / 2)] ?? 0;
  const tolerance = Math.max(0.12, mad * 3.5);
  const retained = points.filter(
    (point) => Math.abs(point.alpha48 - rawMedian) <= tolerance,
  );

  if (retained.length < 4) {
    return {
      alpha48: DEFAULT_ALPHA_48H,
      source: "heuristic",
      supportCount: retained.length,
      confidence: "low",
      retainedPoints: retained,
    };
  }

  const learned = weightedMedian(
    retained.map((point) => ({
      value: point.alpha48,
      weight: qualityWeight(point.quality) / (0.3 + point.distance ** 2),
    })),
  );

  if (learned === null) {
    return {
      alpha48: DEFAULT_ALPHA_48H,
      source: "heuristic",
      supportCount: retained.length,
      confidence: "low",
      retainedPoints: retained,
    };
  }

  const meanDistance =
    retained.reduce((sum, point) => sum + point.distance, 0) /
    retained.length;
  const confidence: "low" | "medium" | "high" =
    retained.length >= 12 && meanDistance <= 2.5
      ? "high"
      : retained.length >= 6 && meanDistance <= 4
        ? "medium"
        : "low";

  return {
    alpha48: clamp(learned, 0.08, 0.9),
    source: "learned",
    supportCount: retained.length,
    confidence,
    retainedPoints: retained,
  };
}

function alpha48ToKPerHour(alpha48: number): number {
  const bounded = clamp(alpha48, 0.001, 0.98);
  return -Math.log(1 - bounded) / 48;
}

function estimateCoolingHoursToReference(args: {
  state: PressureV4DecisionState;
  currentTemp: number;
  coldReference: number;
}): number {
  const remainingDrop = Math.max(
    0,
    args.currentTemp - args.coldReference,
  );
  if (remainingDrop <= 0.05) return 0;

  const recentDrop24h = finite(args.state.cooling?.tempChange24h);
  if (recentDrop24h !== null && recentDrop24h < -0.2) {
    const ratePerHour = Math.abs(recentDrop24h) / 24;
    return clamp(remainingDrop / ratePerHour, 4, 48);
  }

  const totalDrop = finite(args.state.cooling?.tempDropSinceCooling);
  const hoursSinceCooling = finite(args.state.cooling?.hoursSinceCooling);
  if (
    totalDrop !== null &&
    totalDrop > 0.5 &&
    hoursSinceCooling !== null &&
    hoursSinceCooling > 1
  ) {
    const ratePerHour = totalDrop / hoursSinceCooling;
    return clamp(remainingDrop / ratePerHour, 4, 48);
  }

  // When the trajectory is missing, assume the remaining cooling occupies
  // roughly the next day rather than pretending the beer is instantly cold.
  return 24;
}

function forecastThroughCooling(args: {
  carbonation: number;
  pressureBar: number;
  currentTemp: number;
  coldReference: number;
  alpha48: number;
  coolingHours: number;
  horizonHours?: number;
}): number | null {
  const horizonHours = args.horizonHours ?? 48;
  const kPerHour = alpha48ToKPerHour(args.alpha48);
  let carbonation = args.carbonation;

  for (let hour = 0; hour < horizonHours; hour += 1) {
    const midpoint = hour + 0.5;
    const progress =
      args.coolingHours <= 0
        ? 1
        : clamp(midpoint / args.coolingHours, 0, 1);
    const temp =
      args.currentTemp +
      (args.coldReference - args.currentTemp) * progress;
    const equilibrium = equilibriumCarbonationVolumes(
      temp,
      args.pressureBar,
    );
    if (equilibrium === null) return null;

    const fractionThisHour = 1 - Math.exp(-kPerHour);
    carbonation +=
      fractionThisHour * (equilibrium - carbonation);
  }

  return carbonation;
}

function solvePressureForCoolingTarget(args: {
  carbonation: number;
  targetCarbonation: number;
  currentTemp: number;
  coldReference: number;
  alpha48: number;
  coolingHours: number;
}): {
  edgeCase: null | "venting_below_zero" | "head_pressure_insufficient";
  rawPressure: number | null;
  targetPressure: number | null;
  predicted: number | null;
} {
  const forecast = (pressureBar: number) =>
    forecastThroughCooling({
      carbonation: args.carbonation,
      pressureBar,
      currentTemp: args.currentTemp,
      coldReference: args.coldReference,
      alpha48: args.alpha48,
      coolingHours: args.coolingHours,
    });

  const atZero = forecast(0);
  const atMax = forecast(MAX_OPERATIONAL_PRESSURE_BAR);
  if (atZero === null || atMax === null) {
    return {
      edgeCase: null,
      rawPressure: null,
      targetPressure: null,
      predicted: null,
    };
  }

  if (atZero > args.targetCarbonation) {
    return {
      edgeCase: "venting_below_zero",
      rawPressure: -0.01,
      targetPressure: null,
      predicted: atZero,
    };
  }

  if (atMax < args.targetCarbonation) {
    return {
      edgeCase: "head_pressure_insufficient",
      rawPressure: MAX_OPERATIONAL_PRESSURE_BAR + 0.01,
      targetPressure: null,
      predicted: atMax,
    };
  }

  let low = 0;
  let high = MAX_OPERATIONAL_PRESSURE_BAR;
  for (let i = 0; i < 40; i += 1) {
    const mid = (low + high) / 2;
    const predicted = forecast(mid);
    if (predicted === null) break;
    if (predicted < args.targetCarbonation) {
      low = mid;
    } else {
      high = mid;
    }
  }

  const rawPressure = (low + high) / 2;
  const targetPressure = Math.round(rawPressure * 20) / 20;
  const predicted = forecast(targetPressure);
  return {
    edgeCase: null,
    rawPressure,
    targetPressure,
    predicted,
  };
}

export function estimatePressureTargetV5(args: {
  samples?: PressureV4Sample[];
  passiveSamples?: PressureV4PassiveSample[];
  transitions?: PressureV4TransitionSample[];
  state: PressureV4DecisionState;
  targetCarbonation: number;
  coldReferenceTemperature?: number | null;
  firstCarbonation?: boolean;
}): PressureV5Estimate | null {
  const currentTemp = finite(args.state.currentTemp);
  if (
    currentTemp === null ||
    !Number.isFinite(args.state.carbonation) ||
    !Number.isFinite(args.state.currentPressure) ||
    !Number.isFinite(args.targetCarbonation)
  ) return null;

  const coldReference = finite(args.coldReferenceTemperature);
  const firstCoolingMode =
    args.firstCarbonation === true &&
    coldReference !== null &&
    coldReference < currentTemp - 0.05;
  const forecastTemperature = firstCoolingMode
    ? coldReference
    : currentTemp;

  const points = buildPressureV5TrainingPoints({
    samples: args.samples,
    passiveSamples: args.passiveSamples,
    transitions: args.transitions,
    state: args.state,
    firstCarbonation: args.firstCarbonation,
    coldReferenceTemperature: coldReference,
  });
  const learned = learnPressureV5Alpha(points);
  const alpha = learned.alpha48;

  const coolingHours =
    firstCoolingMode && coldReference !== null
      ? estimateCoolingHoursToReference({
          state: args.state,
          currentTemp,
          coldReference,
        })
      : 0;

  const currentEquilibrium = equilibriumCarbonationVolumes(
    forecastTemperature,
    args.state.currentPressure,
  );
  if (currentEquilibrium === null) return null;

  const predictedWithoutChange = firstCoolingMode && coldReference !== null
    ? forecastThroughCooling({
        carbonation: args.state.carbonation,
        pressureBar: args.state.currentPressure,
        currentTemp,
        coldReference,
        alpha48: alpha,
        coolingHours,
      })
    : args.state.carbonation +
      alpha * (currentEquilibrium - args.state.carbonation);
  if (predictedWithoutChange === null) return null;

  const base: Omit<
    PressureV5Estimate,
    | "targetEquilibriumCarbonation"
    | "rawTargetPressure"
    | "targetPressure"
    | "predictedAtTarget"
    | "action"
    | "edgeCase"
  > = {
    version: 5,
    mode: firstCoolingMode ? "first_cooling" : "stable",
    targetCarbonation: args.targetCarbonation,
    currentCarbonation: args.state.carbonation,
    currentPressure: args.state.currentPressure,
    currentTemperature: currentTemp,
    forecastTemperature,
    alpha48: Number(alpha.toFixed(3)),
    alphaSource: learned.source,
    supportCount: learned.supportCount,
    confidence: learned.confidence,
    currentEquilibriumCarbonation: Number(currentEquilibrium.toFixed(3)),
    drivingForceVol: Number(
      (currentEquilibrium - args.state.carbonation).toFixed(3),
    ),
    predictedWithoutChange: Number(predictedWithoutChange.toFixed(3)),
    trainingPoints: learned.retainedPoints,
  };

  if (args.state.carbonation < 2.15) {
    return {
      ...base,
      targetEquilibriumCarbonation: null,
      rawTargetPressure: null,
      targetPressure: null,
      predictedAtTarget: null,
      action: "edge_case",
      edgeCase: "bottom_carbonation",
    };
  }

  if (firstCoolingMode && coldReference !== null) {
    const solved = solvePressureForCoolingTarget({
      carbonation: args.state.carbonation,
      targetCarbonation: args.targetCarbonation,
      currentTemp,
      coldReference,
      alpha48: alpha,
      coolingHours,
    });

    const targetEquilibrium =
      solved.targetPressure === null
        ? null
        : equilibriumCarbonationVolumes(
            coldReference,
            solved.targetPressure,
          );

    if (solved.edgeCase) {
      return {
        ...base,
        targetEquilibriumCarbonation:
          targetEquilibrium === null
            ? null
            : Number(targetEquilibrium.toFixed(3)),
        rawTargetPressure:
          solved.rawPressure === null
            ? null
            : Number(solved.rawPressure.toFixed(2)),
        targetPressure: null,
        predictedAtTarget:
          solved.predicted === null
            ? null
            : Number(solved.predicted.toFixed(3)),
        action: "edge_case",
        edgeCase: solved.edgeCase,
      };
    }

    if (
      solved.targetPressure === null ||
      solved.predicted === null ||
      solved.rawPressure === null
    ) return null;

    const deltaPressure =
      solved.targetPressure - args.state.currentPressure;
    const action: PressureV5Estimate["action"] =
      Math.abs(deltaPressure) < 0.075
        ? "hold"
        : deltaPressure > 0
          ? "raise"
          : "lower";

    return {
      ...base,
      targetEquilibriumCarbonation:
        targetEquilibrium === null
          ? null
          : Number(targetEquilibrium.toFixed(3)),
      rawTargetPressure: Number(solved.rawPressure.toFixed(2)),
      targetPressure: solved.targetPressure,
      predictedAtTarget: Number(solved.predicted.toFixed(3)),
      action,
      edgeCase: null,
    };
  }

  const targetEquilibrium =
    args.state.carbonation +
    (args.targetCarbonation - args.state.carbonation) / alpha;
  const rawTargetPressure = equilibriumPressureBar(
    forecastTemperature,
    targetEquilibrium,
  );

  if (rawTargetPressure === null) return null;

  if (rawTargetPressure < 0) {
    return {
      ...base,
      targetEquilibriumCarbonation: Number(targetEquilibrium.toFixed(3)),
      rawTargetPressure: Number(rawTargetPressure.toFixed(2)),
      targetPressure: null,
      predictedAtTarget: null,
      action: "edge_case",
      edgeCase: "venting_below_zero",
    };
  }

  if (rawTargetPressure > MAX_OPERATIONAL_PRESSURE_BAR) {
    return {
      ...base,
      targetEquilibriumCarbonation: Number(targetEquilibrium.toFixed(3)),
      rawTargetPressure: Number(rawTargetPressure.toFixed(2)),
      targetPressure: null,
      predictedAtTarget: null,
      action: "edge_case",
      edgeCase: "head_pressure_insufficient",
    };
  }

  const targetPressure = Math.round(rawTargetPressure * 20) / 20;
  const targetEqRounded = equilibriumCarbonationVolumes(
    forecastTemperature,
    targetPressure,
  );
  const predictedAtTarget =
    targetEqRounded === null
      ? null
      : args.state.carbonation +
        alpha * (targetEqRounded - args.state.carbonation);

  const deltaPressure = targetPressure - args.state.currentPressure;
  const action: PressureV5Estimate["action"] =
    Math.abs(deltaPressure) < 0.075
      ? "hold"
      : deltaPressure > 0
        ? "raise"
        : "lower";

  return {
    ...base,
    targetEquilibriumCarbonation: Number(targetEquilibrium.toFixed(3)),
    rawTargetPressure: Number(rawTargetPressure.toFixed(2)),
    targetPressure,
    predictedAtTarget:
      predictedAtTarget === null
        ? null
        : Number(predictedAtTarget.toFixed(3)),
    action,
    edgeCase: null,
  };
}
