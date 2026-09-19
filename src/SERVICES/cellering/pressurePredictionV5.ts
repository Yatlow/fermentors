import { equilibriumPressureBar } from "./pressureCarbonationPhysics";
import type {
  PressureV4DecisionState,
  PressureV4PassiveSample,
  PressureV4Sample,
} from "./pressurePredictionV4";

const DEFAULT_VOL_PER_BAR = 0.67;
const MIN_ACTION_DELTA_BAR = 0.08;
const MIN_VOL_PER_BAR = 0.05;
const MAX_VOL_PER_BAR = 2.0;
const MAX_OPERATIONAL_PRESSURE_BAR = 1.9;

type Quality = "low" | "medium" | "high";

type ResponseRow = {
  x: number; // pressure action delta; passive = 0
  y: number; // observed carbonation delta after 2 calendar days
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

  volPerBar: number;
  responseSource: "learned" | "heuristic";
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

function qualityWeight(quality: Quality): number {
  return quality === "high" ? 1 : quality === "medium" ? 0.7 : 0.35;
}

function weightedMedian(
  values: Array<{ value: number; weight: number }>,
): number | null {
  const rows = values
    .filter((row) =>
      Number.isFinite(row.value) &&
      Number.isFinite(row.weight) &&
      row.weight > 0
    )
    .slice()
    .sort((a, b) => a.value - b.value);

  if (!rows.length) return null;
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  if (total <= 0) return null;

  let running = 0;
  for (const row of rows) {
    running += row.weight;
    if (running >= total / 2) return row.value;
  }
  return rows[rows.length - 1].value;
}

function rowDistance(args: {
  carbonation: number;
  pressure: number;
  temp: number | null;
  hoursSinceT0: number;
  state: PressureV4DecisionState;
  quality: Quality;
}): number {
  let distance = 0;
  distance += Math.abs(args.carbonation - args.state.carbonation) / 0.25;
  distance += Math.abs(args.pressure - args.state.currentPressure) / 0.6;

  const stateTemp = finite(args.state.currentTemp);
  if (args.temp !== null && stateTemp !== null) {
    distance += Math.abs(args.temp - stateTemp) / 5;
  }

  distance +=
    Math.abs(args.hoursSinceT0 - args.state.hoursSinceT0) / 160;

  if (args.quality === "medium") distance += 0.25;
  if (args.quality === "low") distance += 0.8;
  return distance;
}

function buildResponseRows(args: {
  samples?: PressureV4Sample[];
  passiveSamples?: PressureV4PassiveSample[];
  state: PressureV4DecisionState;
}): ResponseRow[] {
  const rows: ResponseRow[] = [];

  for (const sample of args.samples ?? []) {
    if (
      sample.primaryOutcome?.calendarDaysAfterAction !== 2 ||
      !Number.isFinite(sample.actionPressureDelta) ||
      !Number.isFinite(sample.carbonationDelta)
    ) continue;

    rows.push({
      x: sample.actionPressureDelta,
      y: sample.carbonationDelta,
      quality: sample.quality,
      distance: rowDistance({
        carbonation: sample.carbonationBefore,
        pressure: sample.currentPressure,
        temp: finite(sample.currentTemp),
        hoursSinceT0: sample.hoursSinceT0,
        state: args.state,
        quality: sample.quality,
      }),
    });
  }

  for (const sample of args.passiveSamples ?? []) {
    if (
      sample.primaryOutcome?.calendarDaysAfterAction !== 2 ||
      !Number.isFinite(sample.carbonationDelta)
    ) continue;

    rows.push({
      x: 0,
      y: sample.carbonationDelta,
      quality: sample.quality,
      distance: rowDistance({
        carbonation: sample.carbonationBefore,
        pressure: sample.currentPressure,
        temp: finite(sample.currentTemp),
        hoursSinceT0: sample.hoursSinceT0,
        state: args.state,
        quality: sample.quality,
      }),
    });
  }

  return rows
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 32);
}

export function learnPressureResponseV5(args: {
  samples?: PressureV4Sample[];
  passiveSamples?: PressureV4PassiveSample[];
  state: PressureV4DecisionState;
}): {
  volPerBar: number;
  source: "learned" | "heuristic";
  supportCount: number;
  confidence: "low" | "medium" | "high";
} {
  const rows = buildResponseRows(args);
  const slopes: Array<{ value: number; weight: number }> = [];

  // Robust Theil-Sen style estimate. By differencing two historical rows,
  // passive drift / background carbonation cancels out. What remains is the
  // empirical effect of pressure change in vol/bar.
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const dx = rows[i].x - rows[j].x;
      if (Math.abs(dx) < MIN_ACTION_DELTA_BAR) continue;

      const slope = (rows[i].y - rows[j].y) / dx;
      if (
        !Number.isFinite(slope) ||
        slope < MIN_VOL_PER_BAR ||
        slope > MAX_VOL_PER_BAR
      ) continue;

      const weight =
        Math.sqrt(
          qualityWeight(rows[i].quality) *
          qualityWeight(rows[j].quality),
        ) /
        (0.4 + rows[i].distance + rows[j].distance);

      slopes.push({ value: slope, weight });
    }
  }

  const learned = weightedMedian(slopes);
  if (learned === null || slopes.length < 4) {
    return {
      volPerBar: DEFAULT_VOL_PER_BAR,
      source: "heuristic",
      supportCount: slopes.length,
      confidence: "low",
    };
  }

  const median = learned;
  const deviations = slopes
    .map((row) => Math.abs(row.value - median))
    .sort((a, b) => a - b);
  const mad = deviations[Math.floor(deviations.length / 2)] ?? 0;
  const tolerance = Math.max(0.12, mad * 3.5);
  const robust = slopes.filter(
    (row) => Math.abs(row.value - median) <= tolerance,
  );
  const robustMedian = weightedMedian(robust) ?? median;

  const confidence: "low" | "medium" | "high" =
    robust.length >= 20
      ? "high"
      : robust.length >= 8
        ? "medium"
        : "low";

  return {
    volPerBar: clamp(robustMedian, MIN_VOL_PER_BAR, MAX_VOL_PER_BAR),
    source: "learned",
    supportCount: robust.length,
    confidence,
  };
}

function roundPressure(pressure: number): number {
  return Math.round(pressure * 20) / 20;
}

export function estimatePressureTargetV5(args: {
  samples?: PressureV4Sample[];
  passiveSamples?: PressureV4PassiveSample[];
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

  const forecastTemperature =
    firstCoolingMode && coldReference !== null
      ? coldReference
      : currentTemp;

  const learned = learnPressureResponseV5({
    samples: args.samples,
    passiveSamples: args.passiveSamples,
    state: args.state,
  });

  const equilibriumPressure = equilibriumPressureBar(
    forecastTemperature,
    args.state.carbonation,
  );
  if (equilibriumPressure === null) return null;

  const pressureDistance =
    args.state.currentPressure - equilibriumPressure;
  const predictedWithoutChange =
    args.state.carbonation +
    learned.volPerBar * pressureDistance;

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
    targetCarbonation: args.targetCarbonation,
    currentCarbonation: args.state.carbonation,
    currentPressure: args.state.currentPressure,
    currentTemperature: currentTemp,
    forecastTemperature,
    volPerBar: Number(learned.volPerBar.toFixed(3)),
    responseSource: learned.source,
    supportCount: learned.supportCount,
    confidence: learned.confidence,
    equilibriumPressureForCurrentCarb:
      Number(equilibriumPressure.toFixed(2)),
    pressureDistanceFromEquilibrium:
      Number(pressureDistance.toFixed(2)),
    predictedWithoutChange:
      Number(predictedWithoutChange.toFixed(3)),
  };

  if (args.state.carbonation < 2.15) {
    return {
      ...base,
      rawTargetPressure: null,
      targetPressure: null,
      predictedAtTarget: null,
      action: "edge_case",
      edgeCase: "bottom_carbonation",
    };
  }

  const carbonationGap =
    args.targetCarbonation - args.state.carbonation;
  const rawTargetPressure =
    equilibriumPressure +
    carbonationGap / learned.volPerBar;

  if (rawTargetPressure < 0) {
    return {
      ...base,
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
      rawTargetPressure: Number(rawTargetPressure.toFixed(2)),
      targetPressure: null,
      predictedAtTarget: null,
      action: "edge_case",
      edgeCase: "head_pressure_insufficient",
    };
  }

  const targetPressure = roundPressure(rawTargetPressure);
  const predictedAtTarget =
    args.state.carbonation +
    learned.volPerBar *
      (targetPressure - equilibriumPressure);

  const pressureDelta =
    targetPressure - args.state.currentPressure;
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
