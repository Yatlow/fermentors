import { equilibriumPressureBar } from "./pressureCarbonationPhysics";
import type {
  PressureV4DecisionState,
  PressureV4PassiveSample,
  PressureV4Sample,
} from "./pressurePredictionV4";

const DEFAULT_VOL_PER_BAR = 0.67;
const MIN_PRESSURE_DISTANCE_BAR = 0.10;

// Operational guardrail from brewery practice: roughly 0.1 vol for every
// 0.1-0.2 bar. History may refine inside this band, but values far outside it
// indicate that the historical window is contaminated by temperature/pressure
// changes and must not control the recommendation.
const OPERATIONAL_MIN_VOL_PER_BAR = 0.50;
const OPERATIONAL_MAX_VOL_PER_BAR = 1.00;
const RAW_MIN_VOL_PER_BAR = 0.05;
const RAW_MAX_VOL_PER_BAR = 2.0;
const MAX_OPERATIONAL_PRESSURE_BAR = 1.9;

type Quality = "low" | "medium" | "high";

type ResponseRow = {
  volPerBar: number;
  pressureDistanceBar: number;
  observedDeltaVol: number;
  source: "action" | "passive";
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
  responseSource: "learned" | "heuristic" | "guarded";
  rawLearnedVolPerBar: number | null;
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

  const addRow = (input: {
    source: "action" | "passive";
    carbonationBefore: number;
    pressureDuring: number;
    currentPressure: number;
    temp: number | null;
    hoursSinceT0: number;
    carbonationDelta: number;
    quality: Quality;
  }) => {
    if (
      input.temp === null ||
      !Number.isFinite(input.carbonationBefore) ||
      !Number.isFinite(input.pressureDuring) ||
      !Number.isFinite(input.carbonationDelta)
    ) return;

    const equilibriumPressure = equilibriumPressureBar(
      input.temp,
      input.carbonationBefore,
    );
    if (equilibriumPressure === null) return;

    const pressureDistance =
      input.pressureDuring - equilibriumPressure;

    if (Math.abs(pressureDistance) < MIN_PRESSURE_DISTANCE_BAR) {
      return;
    }

    // A sample is useful for this model only when CO2 actually moved in the
    // direction implied by the pressure distance from equilibrium.
    if (input.carbonationDelta * pressureDistance <= 0) {
      return;
    }

    const volPerBar =
      input.carbonationDelta / pressureDistance;
    if (
      !Number.isFinite(volPerBar) ||
      volPerBar < RAW_MIN_VOL_PER_BAR ||
      volPerBar > RAW_MAX_VOL_PER_BAR
    ) return;

    rows.push({
      volPerBar,
      pressureDistanceBar: pressureDistance,
      observedDeltaVol: input.carbonationDelta,
      source: input.source,
      quality: input.quality,
      distance: rowDistance({
        carbonation: input.carbonationBefore,
        pressure: input.currentPressure,
        temp: input.temp,
        hoursSinceT0: input.hoursSinceT0,
        state: args.state,
        quality: input.quality,
      }),
    });
  };

  for (const sample of args.samples ?? []) {
    if (
      sample.primaryOutcome?.calendarDaysAfterAction !== 2 ||
      !Number.isFinite(sample.carbonationDelta)
    ) continue;

    addRow({
      source: "action",
      carbonationBefore: sample.carbonationBefore,
      pressureDuring: sample.targetPressure,
      currentPressure: sample.currentPressure,
      temp: finite(sample.currentTemp),
      hoursSinceT0: sample.hoursSinceT0,
      carbonationDelta: sample.carbonationDelta,
      quality: sample.quality,
    });
  }

  for (const sample of args.passiveSamples ?? []) {
    if (
      sample.primaryOutcome?.calendarDaysAfterAction !== 2 ||
      !Number.isFinite(sample.carbonationDelta)
    ) continue;

    addRow({
      source: "passive",
      carbonationBefore: sample.carbonationBefore,
      pressureDuring: sample.currentPressure,
      currentPressure: sample.currentPressure,
      temp: finite(sample.currentTemp),
      hoursSinceT0: sample.hoursSinceT0,
      carbonationDelta: sample.carbonationDelta,
      quality: sample.quality,
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
  rawLearnedVolPerBar: number | null;
  source: "learned" | "heuristic" | "guarded";
  supportCount: number;
  confidence: "low" | "medium" | "high";
} {
  const rows = buildResponseRows(args);
  if (rows.length < 4) {
    return {
      volPerBar: DEFAULT_VOL_PER_BAR,
      rawLearnedVolPerBar: null,
      source: "heuristic",
      supportCount: rows.length,
      confidence: "low",
    };
  }

  const weighted = rows.map((row) => ({
    value: row.volPerBar,
    weight:
      qualityWeight(row.quality) /
      (0.35 + row.distance * row.distance),
  }));

  const rawMedian = weightedMedian(weighted);
  if (rawMedian === null) {
    return {
      volPerBar: DEFAULT_VOL_PER_BAR,
      rawLearnedVolPerBar: null,
      source: "heuristic",
      supportCount: rows.length,
      confidence: "low",
    };
  }

  const deviations = rows
    .map((row) => Math.abs(row.volPerBar - rawMedian))
    .sort((a, b) => a - b);
  const mad = deviations[Math.floor(deviations.length / 2)] ?? 0;
  const tolerance = Math.max(0.15, mad * 3.5);
  const robustRows = rows.filter(
    (row) => Math.abs(row.volPerBar - rawMedian) <= tolerance,
  );

  if (robustRows.length < 4) {
    return {
      volPerBar: DEFAULT_VOL_PER_BAR,
      rawLearnedVolPerBar: null,
      source: "heuristic",
      supportCount: robustRows.length,
      confidence: "low",
    };
  }

  const robustMedian =
    weightedMedian(
      robustRows.map((row) => ({
        value: row.volPerBar,
        weight:
          qualityWeight(row.quality) /
          (0.35 + row.distance * row.distance),
      })),
    ) ?? rawMedian;

  const confidence: "low" | "medium" | "high" =
    robustRows.length >= 12
      ? "high"
      : robustRows.length >= 6
        ? "medium"
        : "low";

  const rawLearnedVolPerBar = robustMedian;

  if (
    rawLearnedVolPerBar < OPERATIONAL_MIN_VOL_PER_BAR ||
    rawLearnedVolPerBar > OPERATIONAL_MAX_VOL_PER_BAR
  ) {
    return {
      volPerBar: DEFAULT_VOL_PER_BAR,
      rawLearnedVolPerBar: Number(rawLearnedVolPerBar.toFixed(3)),
      source: "guarded",
      supportCount: robustRows.length,
      confidence,
    };
  }

  // Keep the field calibration anchored to the operational prior while still
  // allowing real history to refine it. This prevents a noisy data set from
  // overpowering a rule that is already known to work on the floor.
  const refined =
    DEFAULT_VOL_PER_BAR * 0.35 +
    rawLearnedVolPerBar * 0.65;

  return {
    volPerBar: clamp(
      refined,
      OPERATIONAL_MIN_VOL_PER_BAR,
      OPERATIONAL_MAX_VOL_PER_BAR,
    ),
    rawLearnedVolPerBar: Number(rawLearnedVolPerBar.toFixed(3)),
    source: "learned",
    supportCount: robustRows.length,
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
  learnedTargetEquilibriumPressure?: number | null;
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

  const standardCurrentEquilibrium = equilibriumPressureBar(
    forecastTemperature,
    args.state.carbonation,
  );
  const standardTargetEquilibrium = equilibriumPressureBar(
    forecastTemperature,
    args.targetCarbonation,
  );
  if (
    standardCurrentEquilibrium === null ||
    standardTargetEquilibrium === null
  ) return null;

  const learnedTargetEquilibrium =
    finite(args.learnedTargetEquilibriumPressure);
  const equilibriumCalibration =
    learnedTargetEquilibrium === null
      ? 0
      : clamp(
          learnedTargetEquilibrium - standardTargetEquilibrium,
          -0.35,
          0.35,
        );

  const equilibriumPressure =
    standardCurrentEquilibrium + equilibriumCalibration;

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
    rawLearnedVolPerBar: learned.rawLearnedVolPerBar,
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
