import {
  equilibriumCarbonationVolumes,
  equilibriumPressureBar,
} from "./pressureCarbonationPhysics";
import type {
  PressureV4DecisionState,
  PressureV4Measurement,
  PressureV4PassiveSample,
  PressureV4Sample,
  PressureV4TransitionSample,
} from "./pressurePredictionV4";

const MAX_OPERATIONAL_PRESSURE_BAR = 1.9;
const MIN_K_PER_HOUR = 0.0001;
const MAX_K_PER_HOUR = 0.08;
const MAX_FORECAST_HOURS = 14 * 24;
const DEFAULT_YEAST_DROP_LOSS_BAR = 0.15;

type Confidence = "low" | "medium" | "high";

type HistoricalCoursePrior = {
  pressure: number;
  progressFraction48h: number | null;
  supportBatches: number;
  supportSamples: number;
  confidence: Confidence;
};

type KEstimate = {
  kPerHour: number;
  historicalKPerHour: number | null;
  currentBatchKPerHour: number | null;
  historicalBatches: number;
  currentBatchIntervals: number;
  source: "current_batch" | "blended" | "historical" | "fallback";
  confidence: Confidence;
};

type FutureLossEstimate = {
  totalBar: number;
  eventCount: number;
  source:
    | "historical_one_action_courses"
    | "observed_yeast_drops"
    | "yeast_drop_fallback"
    | "none";
  observedDropMedianBar: number | null;
  observedDropCount: number;
};

type CandidateForecast = {
  setPressure: number;
  checkpoint48: number;
  checkpoint72: number;
  checkpoint96: number;
  finalPressure: number;
  terminalEquilibriumCarbonation: number;
  carbonationAtHorizon: number;
  maxCarbonation: number;
  minCarbonation: number;
  hoursToTargetBand: number | null;
  score: number;
};

export type PressureV6HistoricalBatch = {
  batchId: string;
  measurements: PressureV4Measurement[];
};

export type PressureV6OneActionCourse = {
  batchId: string;
  startDateTimeMs: number;
  startCarbonation: number;
  startPressure: number;
  startTemperature: number;
  startHoursSinceCooling: number | null;
  actionPressure: number;
  actionPressureDelta: number;
  outcomeCarbonation: number;
  outcomePressure: number | null;
  hoursToTarget: number;
  yeastLossBar: number;
};

export type PressureV6Estimate = {
  version: 6;
  mode: "trajectory";

  measuredCarbonation: number;
  estimatedCurrentCarbonation: number;
  hoursSinceCarbonationMeasurement: number;

  currentPressure: number;
  currentTemperature: number;
  forecastTemperature: number;
  targetCarbonation: number;
  targetToleranceVol: number;

  kPerHour: number;
  kSource: KEstimate["source"];
  historicalKPerHour: number | null;
  currentBatchKPerHour: number | null;
  kHistoricalBatchCount: number;
  kCurrentBatchIntervalCount: number;

  supportCount: number;
  supportSampleCount: number;
  confidence: Confidence;
  historicalPressurePrior: number | null;
  historicalProgressFraction48h: number | null;

  targetEquilibriumPressure: number;
  equilibriumPressureForCurrentCarb: number;
  pressureDistanceFromEquilibrium: number;

  expectedOperationalPressureLossBar: number;
  expectedPressureLossEvents: number;
  operationalLossSource: FutureLossEstimate["source"];
  observedYeastDropMedianBar: number | null;
  observedYeastDropCount: number;

  coolingHoursRemaining: number;

  predictedWithoutChange: number;
  predictedAtTarget: number | null;
  terminalCarbonationWithoutChange: number;
  terminalCarbonationAtTarget: number | null;
  terminalPressureWithoutChange: number;
  terminalPressureAtTarget: number | null;
  terminalHoursAtTarget: number | null;

  effectiveVolPerBar48h: number;

  rawTargetPressure: number | null;
  targetPressure: number | null;
  targetPressureRangeLow: number | null;
  targetPressureRangeHigh: number | null;

  action: "hold" | "raise" | "lower" | "edge_case";
  holdReason: "trajectory_on_course" | "already_in_tolerance" | null;
  recommendationVisibility: "global" | "tank_only";
  edgeCase: null | "head_pressure_insufficient" | "venting_below_zero";
};

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function median(values: number[]): number | null {
  const sorted = values
    .filter(Number.isFinite)
    .slice()
    .sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
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
  return quality === "high" ? 1 : quality === "medium" ? 0.65 : 0.25;
}

export function selectV6HistoricalBatchIds(args: {
  samples?: PressureV4Sample[];
  passiveSamples?: PressureV4PassiveSample[];
  state: PressureV4DecisionState;
  currentBatchId?: string;
  limit?: number;
}): string[] {
  const currentCarbonation = finite(args.state.carbonation);
  const currentPressure = finite(args.state.currentPressure);
  const currentTemp = finite(args.state.currentTemp);
  const currentHours = finite(args.state.hoursSinceT0);
  if (
    currentCarbonation === null ||
    currentPressure === null
  ) return [];

  const scores = new Map<string, number>();

  const consider = (input: {
    batchId?: string;
    carbonation: number;
    pressure: number;
    temp: number | null;
    hoursSinceT0: number;
  }) => {
    const batchId = String(input.batchId ?? "").replace("#", "").trim();
    if (!batchId || batchId === String(args.currentBatchId ?? "").replace("#", "").trim()) {
      return;
    }

    let distance = 0;
    distance += Math.abs(input.carbonation - currentCarbonation) / 0.18;
    distance += Math.abs(input.pressure - currentPressure) / 0.45;
    if (currentTemp !== null && input.temp !== null) {
      distance += Math.abs(input.temp - currentTemp) / 3;
    }
    if (currentHours !== null && Number.isFinite(input.hoursSinceT0)) {
      distance += Math.abs(input.hoursSinceT0 - currentHours) / 120;
    }

    const previous = scores.get(batchId);
    if (previous === undefined || distance < previous) {
      scores.set(batchId, distance);
    }
  };

  for (const sample of args.samples ?? []) {
    if (
      Number.isFinite(sample.carbonationBefore) &&
      Number.isFinite(sample.currentPressure)
    ) {
      consider({
        batchId: sample.batchId,
        carbonation: sample.carbonationBefore,
        pressure: sample.currentPressure,
        temp: finite(sample.currentTemp),
        hoursSinceT0: sample.hoursSinceT0,
      });
    }
  }

  for (const sample of args.passiveSamples ?? []) {
    if (
      Number.isFinite(sample.carbonationBefore) &&
      Number.isFinite(sample.currentPressure)
    ) {
      consider({
        batchId: sample.batchId,
        carbonation: sample.carbonationBefore,
        pressure: sample.currentPressure,
        temp: finite(sample.currentTemp),
        hoursSinceT0: sample.hoursSinceT0,
      });
    }
  }

  return Array.from(scores.entries())
    .sort((a, b) => a[1] - b[1])
    .slice(0, clamp(args.limit ?? 24, 1, 40))
    .map(([batchId]) => batchId);
}

function measurementDateTimeMs(
  measurement: PressureV4Measurement,
): number | null {
  const id = String(measurement.id ?? "");
  const match = id.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:_(\d{2})(\d{2}))?/,
  );
  if (!match) return null;

  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    match[4] ? Number(match[4]) : 12,
    match[5] ? Number(match[5]) : 0,
    0,
    0,
  ).getTime();
}

function noteText(measurement: PressureV4Measurement): string {
  return String(measurement.notes ?? "");
}

function isBottomCarbonationNote(measurement: PressureV4Measurement): boolean {
  return noteText(measurement).includes("גיזוז מלמטה");
}

function isCoolingStartNote(measurement: PressureV4Measurement): boolean {
  const note = noteText(measurement);
  if (!note.includes("קירור")) return false;
  if (/אחרי\s+קירור|לאחר\s+קירור/.test(note)) return false;
  return /(?:^|\||\s)קירור(?:$|\||\s|[-–—])/u.test(note);
}

function actionPressureFromNote(
  measurement: PressureV4Measurement,
): number | null {
  if (isBottomCarbonationNote(measurement)) return null;
  const matches = Array.from(
    noteText(measurement).matchAll(
      /(?:העלאת|הורדת|שינוי)\s+לחץ\s+ל\s*:?-?\s*(\d+(?:[.,]\d+)?)/gi,
    ),
  );
  const match = matches[matches.length - 1];
  return match ? finite(match[1]) : null;
}

function yeastPressureAfterFromNote(
  measurement: PressureV4Measurement,
): number | null {
  const note = noteText(measurement);
  if (!/שמר(?:ים|י)/.test(note)) return null;
  const match = note.match(
    /לחץ\s+אחרי\s*:?-?\s*(\d+(?:[.,]\d+)?)\s*(?:bar|באר)?/i,
  );
  return match ? finite(match[1]) : null;
}

function effectivePressureAfterRow(
  measurement: PressureV4Measurement,
  previousPressure: number | null,
): number | null {
  const actionTarget = actionPressureFromNote(measurement);
  if (actionTarget !== null) return actionTarget;

  const yeastAfter = yeastPressureAfterFromNote(measurement);
  if (yeastAfter !== null) return yeastAfter;

  return finite(measurement.pressure) ?? previousPressure;
}

type PathSegment = {
  hours: number;
  pressure: number;
  temperature: number;
};

function buildPathSegments(args: {
  measurements: PressureV4Measurement[];
  startMs: number;
  endMs: number;
}): PathSegment[] | null {
  const rows = args.measurements
    .map((measurement) => ({
      measurement,
      time: measurementDateTimeMs(measurement),
    }))
    .filter((row): row is {
      measurement: PressureV4Measurement;
      time: number;
    } => row.time !== null && row.time <= args.endMs)
    .sort((a, b) => a.time - b.time);

  let pressure: number | null = null;
  let temperature: number | null = null;

  for (const row of rows) {
    if (row.time > args.startMs) break;
    const rowTemp = finite(row.measurement.temp);
    if (rowTemp !== null) temperature = rowTemp;
    pressure = effectivePressureAfterRow(row.measurement, pressure);
  }

  if (pressure === null || temperature === null) return null;

  const segments: PathSegment[] = [];
  let cursor = args.startMs;

  const consume = (until: number) => {
    const hours = Math.max(0, (until - cursor) / 3600000);
    if (hours > 0 && pressure !== null && temperature !== null) {
      segments.push({
        hours,
        pressure,
        temperature,
      });
    }
    cursor = until;
  };

  for (const row of rows) {
    if (row.time <= args.startMs || row.time > args.endMs) continue;
    consume(row.time);

    const rowTemp = finite(row.measurement.temp);
    if (rowTemp !== null) temperature = rowTemp;
    pressure = effectivePressureAfterRow(row.measurement, pressure);
  }

  consume(args.endMs);
  return segments.length ? segments : null;
}

function simulateSegments(
  startCarbonation: number,
  segments: PathSegment[],
  kPerHour: number,
): number | null {
  let carbonation = startCarbonation;

  for (const segment of segments) {
    const equilibrium = equilibriumCarbonationVolumes(
      segment.temperature,
      segment.pressure,
    );
    if (equilibrium === null) return null;

    const decay = Math.exp(-kPerHour * segment.hours);
    carbonation =
      equilibrium - (equilibrium - carbonation) * decay;
  }

  return carbonation;
}

function fitKForInterval(args: {
  startCarbonation: number;
  endCarbonation: number;
  segments: PathSegment[];
}): { kPerHour: number; error: number } | null {
  let bestK: number | null = null;
  let bestError = Number.POSITIVE_INFINITY;

  const logMin = Math.log10(MIN_K_PER_HOUR);
  const logMax = Math.log10(MAX_K_PER_HOUR);

  for (let index = 0; index <= 150; index += 1) {
    const logK =
      logMin + (logMax - logMin) * index / 150;
    const k = Math.pow(10, logK);
    const predicted = simulateSegments(
      args.startCarbonation,
      args.segments,
      k,
    );
    if (predicted === null) continue;

    const error = Math.abs(predicted - args.endCarbonation);
    if (error < bestError) {
      bestError = error;
      bestK = k;
    }
  }

  if (bestK === null) return null;
  return { kPerHour: bestK, error: bestError };
}

function coolingStartMs(
  measurements: PressureV4Measurement[],
): number | null {
  const row = measurements
    .map((measurement) => ({
      measurement,
      time: measurementDateTimeMs(measurement),
    }))
    .filter((item): item is {
      measurement: PressureV4Measurement;
      time: number;
    } => item.time !== null && isCoolingStartNote(item.measurement))
    .sort((a, b) => a.time - b.time)[0];

  return row?.time ?? null;
}

function fitCurrentBatchK(
  measurements: PressureV4Measurement[],
): {
  kPerHour: number | null;
  intervalCount: number;
} {
  const startCooling = coolingStartMs(measurements);

  const checks = measurements
    .map((measurement) => ({
      measurement,
      time: measurementDateTimeMs(measurement),
      carbonation: finite(measurement.carbonation),
    }))
    .filter((row): row is {
      measurement: PressureV4Measurement;
      time: number;
      carbonation: number;
    } =>
      row.time !== null &&
      row.carbonation !== null &&
      (startCooling === null || row.time >= startCooling)
    )
    .sort((a, b) => a.time - b.time);

  const fits: number[] = [];

  for (let index = 0; index < checks.length - 1; index += 1) {
    const start = checks[index];
    const end = checks[index + 1];
    const hours = (end.time - start.time) / 3600000;
    if (hours < 8 || hours > 120) continue;

    const contaminated = measurements.some((measurement) => {
      const time = measurementDateTimeMs(measurement);
      return (
        time !== null &&
        time > start.time &&
        time <= end.time &&
        isBottomCarbonationNote(measurement)
      );
    });
    if (contaminated) continue;

    const segments = buildPathSegments({
      measurements,
      startMs: start.time,
      endMs: end.time,
    });
    if (!segments) continue;
    if (segments.some((segment) => segment.temperature > 9)) continue;

    const fit = fitKForInterval({
      startCarbonation: start.carbonation,
      endCarbonation: end.carbonation,
      segments,
    });
    if (!fit || fit.error > 0.05) continue;

    fits.push(fit.kPerHour);
  }

  return {
    kPerHour: median(fits),
    intervalCount: fits.length,
  };
}

function historicalKPrior(args: {
  transitions: PressureV4TransitionSample[];
  state: PressureV4DecisionState;
  currentBatchId?: string;
}): {
  kPerHour: number | null;
  batchCount: number;
} {
  const currentTemp = finite(args.state.currentTemp);
  const currentPressure = finite(args.state.currentPressure);
  const currentHours = finite(args.state.hoursSinceT0);

  const rows = args.transitions
    .filter((sample) =>
      sample.quality !== "low" &&
      Number.isFinite(sample.kPerHour) &&
      sample.kPerHour >= MIN_K_PER_HOUR &&
      sample.kPerHour <= MAX_K_PER_HOUR &&
      (!args.currentBatchId ||
        String(sample.batchId ?? "") !== String(args.currentBatchId))
    )
    .map((sample) => {
      const sampleTemp = finite(
        sample.temperatureMeanDuring ?? sample.currentTemp,
      );
      const samplePressure = finite(
        sample.pressureMeanDuring ?? sample.currentPressure,
      );
      let distance = 0;

      if (currentTemp !== null && sampleTemp !== null) {
        distance += Math.abs(currentTemp - sampleTemp) / 4;
      }
      if (currentPressure !== null && samplePressure !== null) {
        distance += Math.abs(currentPressure - samplePressure) / 0.6;
      }
      if (currentHours !== null && Number.isFinite(sample.hoursSinceT0)) {
        distance += Math.abs(currentHours - sample.hoursSinceT0) / 144;
      }

      return {
        batchId: String(sample.batchId ?? ""),
        value: sample.kPerHour,
        weight: qualityWeight(sample.quality) / (0.45 + distance),
      };
    })
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 60);

  const grouped = new Map<
    string,
    Array<{ value: number; weight: number }>
  >();

  for (const row of rows) {
    const key = row.batchId || `anonymous-${grouped.size}`;
    const list = grouped.get(key) ?? [];
    list.push({ value: row.value, weight: row.weight });
    grouped.set(key, list);
  }

  const batchRows: Array<{ value: number; weight: number }> = [];
  for (const list of grouped.values()) {
    const value = weightedMedian(list);
    if (value === null) continue;
    batchRows.push({
      value,
      weight: Math.max(...list.map((row) => row.weight)),
    });
  }

  return {
    kPerHour: weightedMedian(batchRows),
    batchCount: batchRows.length,
  };
}

function chooseK(args: {
  transitions: PressureV4TransitionSample[];
  state: PressureV4DecisionState;
  measurements: PressureV4Measurement[];
  currentBatchId?: string;
}): KEstimate {
  const historical = historicalKPrior({
    transitions: args.transitions,
    state: args.state,
    currentBatchId: args.currentBatchId,
  });
  const current = fitCurrentBatchK(args.measurements);

  if (
    current.kPerHour !== null &&
    historical.kPerHour !== null
  ) {
    const currentWeight =
      current.intervalCount >= 2 ? 0.85 : 0.70;
    const historicalWeight = 1 - currentWeight;
    const blended = Math.exp(
      Math.log(current.kPerHour) * currentWeight +
      Math.log(historical.kPerHour) * historicalWeight,
    );

    return {
      kPerHour: clamp(blended, MIN_K_PER_HOUR, MAX_K_PER_HOUR),
      historicalKPerHour: historical.kPerHour,
      currentBatchKPerHour: current.kPerHour,
      historicalBatches: historical.batchCount,
      currentBatchIntervals: current.intervalCount,
      source: "blended",
      confidence:
        current.intervalCount >= 2 && historical.batchCount >= 4
          ? "high"
          : "medium",
    };
  }

  if (current.kPerHour !== null) {
    return {
      kPerHour: current.kPerHour,
      historicalKPerHour: historical.kPerHour,
      currentBatchKPerHour: current.kPerHour,
      historicalBatches: historical.batchCount,
      currentBatchIntervals: current.intervalCount,
      source: "current_batch",
      confidence: current.intervalCount >= 2 ? "high" : "medium",
    };
  }

  if (historical.kPerHour !== null) {
    return {
      kPerHour: historical.kPerHour,
      historicalKPerHour: historical.kPerHour,
      currentBatchKPerHour: null,
      historicalBatches: historical.batchCount,
      currentBatchIntervals: 0,
      source: "historical",
      confidence:
        historical.batchCount >= 8
          ? "high"
          : historical.batchCount >= 4
            ? "medium"
            : "low",
    };
  }

  return {
    kPerHour: 0.002,
    historicalKPerHour: null,
    currentBatchKPerHour: null,
    historicalBatches: 0,
    currentBatchIntervals: 0,
    source: "fallback",
    confidence: "low",
  };
}

function previousFiniteValue(
  rows: PressureV4Measurement[],
  index: number,
  field: "pressure" | "temp",
): number | null {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const value = finite(rows[cursor]?.[field]);
    if (value !== null) return value;
  }
  return null;
}

function hoursSinceCoolingAt(
  rows: PressureV4Measurement[],
  index: number,
): number | null {
  const currentMs = measurementDateTimeMs(rows[index]);
  if (currentMs === null) return null;

  for (let cursor = index; cursor >= 0; cursor -= 1) {
    if (!isCoolingStartNote(rows[cursor])) continue;
    const coolingMs = measurementDateTimeMs(rows[cursor]);
    if (coolingMs === null) continue;
    return Math.max(0, (currentMs - coolingMs) / 3600000);
  }
  return null;
}

export function buildV6OneActionCourses(args: {
  historicalBatches: PressureV6HistoricalBatch[];
  targetCarbonation: number;
  targetToleranceVol: number;
}): PressureV6OneActionCourse[] {
  const successTolerance = Math.max(args.targetToleranceVol, 0.05);
  const courses: PressureV6OneActionCourse[] = [];

  for (const batch of args.historicalBatches) {
    const rows = batch.measurements
      .slice()
      .sort((a, b) =>
        (measurementDateTimeMs(a) ?? 0) -
        (measurementDateTimeMs(b) ?? 0)
      );

    for (let startIndex = 0; startIndex < rows.length; startIndex += 1) {
      const start = rows[startIndex];
      const startMs = measurementDateTimeMs(start);
      const startCarbonation = finite(start.carbonation);
      const startPressure = previousFiniteValue(rows, startIndex, "pressure");
      const startTemperature = previousFiniteValue(rows, startIndex, "temp");

      if (
        startMs === null ||
        startCarbonation === null ||
        startPressure === null ||
        startTemperature === null ||
        startTemperature > 9 ||
        Math.abs(startCarbonation - args.targetCarbonation) <= successTolerance
      ) continue;

      const initialDirection = Math.sign(
        args.targetCarbonation - startCarbonation,
      );
      const actionPressure =
        actionPressureFromNote(start) ?? startPressure;

      let yeastLossBar = 0;
      let previousPressure: number | null = startPressure;
      let invalidated = false;

      for (
        let endIndex = startIndex + 1;
        endIndex < rows.length;
        endIndex += 1
      ) {
        const row = rows[endIndex];
        const rowMs = measurementDateTimeMs(row);
        if (rowMs === null) continue;

        const elapsedHours = (rowMs - startMs) / 3600000;
        if (elapsedHours <= 0) continue;
        if (elapsedHours > 7 * 24) break;

        if (isBottomCarbonationNote(row)) {
          invalidated = true;
          break;
        }

        // A second deliberate pressure setpoint means the first action did NOT
        // put the tank on a one-action course, so it is not a V6 training case.
        if (actionPressureFromNote(row) !== null) {
          invalidated = true;
          break;
        }

        const rowPressure = finite(row.pressure);
        const afterYeast = yeastPressureAfterFromNote(row);
        if (afterYeast !== null) {
          const beforeYeast = rowPressure ?? previousPressure;
          if (beforeYeast !== null) {
            const loss = beforeYeast - afterYeast;
            if (loss >= 0.02 && loss <= 0.6) {
              yeastLossBar += loss;
            }
          }
        }

        previousPressure = effectivePressureAfterRow(
          row,
          rowPressure ?? previousPressure,
        );

        const outcomeCarbonation = finite(row.carbonation);
        if (outcomeCarbonation === null) continue;

        const outcomeDirection = Math.sign(
          args.targetCarbonation - outcomeCarbonation,
        );
        const reachedTarget =
          Math.abs(outcomeCarbonation - args.targetCarbonation) <=
          successTolerance;
        const crossedTarget =
          initialDirection !== 0 &&
          outcomeDirection !== initialDirection &&
          Math.abs(outcomeCarbonation - args.targetCarbonation) <= 0.08;

        if (!reachedTarget && !crossedTarget) continue;

        courses.push({
          batchId: String(batch.batchId),
          startDateTimeMs: startMs,
          startCarbonation,
          startPressure,
          startTemperature,
          startHoursSinceCooling: hoursSinceCoolingAt(rows, startIndex),
          actionPressure,
          actionPressureDelta: actionPressure - startPressure,
          outcomeCarbonation,
          outcomePressure:
            rowPressure ?? previousPressure,
          hoursToTarget: elapsedHours,
          yeastLossBar,
        });
        break;
      }

      if (invalidated) continue;
    }
  }

  return courses;
}

export function countV6SuccessfulOneActionBatches(args: {
  historicalBatches: PressureV6HistoricalBatch[];
  targetCarbonation: number;
  targetToleranceVol: number;
}): number {
  const courses = buildV6OneActionCourses(args);
  return new Set(
    courses
      .map((course) => String(course.batchId || "").trim())
      .filter(Boolean),
  ).size;
}

function oneActionCourseEstimate(args: {
  courses: PressureV6OneActionCourse[];
  state: PressureV4DecisionState;
  targetCarbonation: number;
}): {
  pressure: number;
  hoursToTarget: number;
  yeastLossBar: number;
  outcomePressure: number | null;
  supportBatches: number;
  supportCourses: number;
  confidence: Confidence;
} | null {
  const currentCarbonation = finite(args.state.carbonation);
  const currentPressure = finite(args.state.currentPressure);
  const currentTemp = finite(args.state.currentTemp);
  const currentCoolingHours = finite(args.state.cooling?.hoursSinceCooling);

  if (
    currentCarbonation === null ||
    currentPressure === null ||
    currentTemp === null
  ) return null;

  const currentGap = args.targetCarbonation - currentCarbonation;

  const ranked = args.courses
    .map((course) => {
      const courseGap =
        args.targetCarbonation - course.startCarbonation;
      if (
        Math.sign(courseGap) !== Math.sign(currentGap) &&
        Math.abs(currentGap) > 0.03
      ) {
        return null;
      }

      let distance = 0;
      distance += Math.abs(courseGap - currentGap) / 0.16;
      distance += Math.abs(course.startPressure - currentPressure) / 0.45;
      distance += Math.abs(course.startTemperature - currentTemp) / 2.5;

      if (
        currentCoolingHours !== null &&
        course.startHoursSinceCooling !== null
      ) {
        distance +=
          Math.abs(course.startHoursSinceCooling - currentCoolingHours) /
          72;
      }

      return {
        course,
        weight: 1 / (0.35 + distance),
      };
    })
    .filter((row): row is {
      course: PressureV6OneActionCourse;
      weight: number;
    } => row !== null)
    .sort((a, b) => b.weight - a.weight);

  if (!ranked.length) return null;

  const bestPerBatch = new Map<
    string,
    { course: PressureV6OneActionCourse; weight: number }
  >();
  for (const row of ranked) {
    if (!bestPerBatch.has(row.course.batchId)) {
      bestPerBatch.set(row.course.batchId, row);
    }
  }

  const selected = Array.from(bestPerBatch.values())
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 12);

  const pressureDelta = weightedMedian(
    selected.map((row) => ({
      value: row.course.actionPressureDelta,
      weight: row.weight,
    })),
  );
  const pressure =
    pressureDelta === null
      ? null
      : clamp(
          currentPressure + pressureDelta,
          0,
          MAX_OPERATIONAL_PRESSURE_BAR,
        );
  const hoursToTarget = weightedMedian(
    selected.map((row) => ({
      value: row.course.hoursToTarget,
      weight: row.weight,
    })),
  );
  const yeastLossBar = weightedMedian(
    selected.map((row) => ({
      value: row.course.yeastLossBar,
      weight: row.weight,
    })),
  );
  const outcomePressureRows = selected
    .filter((row) => row.course.outcomePressure !== null)
    .map((row) => ({
      value: row.course.outcomePressure!,
      weight: row.weight,
    }));
  const outcomePressure = weightedMedian(outcomePressureRows);

  if (
    pressure === null ||
    hoursToTarget === null ||
    yeastLossBar === null
  ) return null;

  return {
    pressure,
    hoursToTarget: clamp(hoursToTarget, 24, 7 * 24),
    yeastLossBar: clamp(yeastLossBar, 0, 0.8),
    outcomePressure,
    supportBatches: selected.length,
    supportCourses: ranked.length,
    confidence:
      selected.length >= 8
        ? "high"
        : selected.length >= 4
          ? "medium"
          : "low",
  };
}

function reliableCurrentTrend(args: {
  state: PressureV4DecisionState;
  currentCarbonation: number;
  targetCarbonation: number;
  targetToleranceVol: number;
  historicalHoursToTarget: number | null;
}): {
  onCourse: boolean;
  projected48: number | null;
  hoursToTarget: number | null;
} {
  const trend = args.state.carbonationTrend;
  const rate = finite(trend?.ratePerDay);
  const hoursBetween = finite(trend?.hoursSincePrevious);
  const checks = finite(trend?.checksInPhase) ?? 0;

  if (
    rate === null ||
    hoursBetween === null ||
    checks < 2 ||
    hoursBetween < 12 ||
    hoursBetween > 96 ||
    Math.abs(rate) < 0.005
  ) {
    return {
      onCourse: false,
      projected48: null,
      hoursToTarget: null,
    };
  }

  const gap = args.targetCarbonation - args.currentCarbonation;
  if (Math.sign(rate) !== Math.sign(gap)) {
    return {
      onCourse: false,
      projected48: args.currentCarbonation + rate * 2,
      hoursToTarget: null,
    };
  }

  const daysToTarget = gap / rate;
  const hoursToTarget = daysToTarget * 24;
  const projected48 = args.currentCarbonation + rate * 2;
  const allowedHorizon =
    args.historicalHoursToTarget === null
      ? 96
      : clamp(args.historicalHoursToTarget * 1.5, 48, 120);

  const noDangerousOvershoot =
    gap > 0
      ? projected48 <=
        args.targetCarbonation + args.targetToleranceVol + 0.04
      : projected48 >=
        args.targetCarbonation - args.targetToleranceVol - 0.04;

  return {
    onCourse:
      hoursToTarget >= 8 &&
      hoursToTarget <= allowedHorizon &&
      noDangerousOvershoot,
    projected48,
    hoursToTarget,
  };
}

type CourseCandidate = {
  batchId: string;
  pressure: number;
  progressFraction48h: number | null;
  weight: number;
};

function historicalCoursePrior(args: {
  samples: PressureV4Sample[];
  passiveSamples: PressureV4PassiveSample[];
  state: PressureV4DecisionState;
  targetCarbonation: number;
  targetToleranceVol: number;
  currentBatchId?: string;
}): HistoricalCoursePrior | null {
  const currentCarbonation = finite(args.state.carbonation);
  const currentPressure = finite(args.state.currentPressure);
  const currentTemp = finite(args.state.currentTemp);
  const currentHours = finite(args.state.hoursSinceT0);
  if (currentCarbonation === null || currentPressure === null) return null;

  const currentGap = args.targetCarbonation - currentCarbonation;
  const rows: CourseCandidate[] = [];

  const addCandidate = (input: {
    batchId?: string;
    before: number;
    outcome: number;
    proposalPressure: number;
    statePressure: number;
    temp: number | null;
    hoursSinceT0: number;
    quality: "low" | "medium" | "high";
  }) => {
    if (
      args.currentBatchId &&
      String(input.batchId ?? "") === String(args.currentBatchId)
    ) return;

    const beforeError =
      Math.abs(args.targetCarbonation - input.before);
    const outcomeError =
      Math.abs(args.targetCarbonation - input.outcome);

    if (
      outcomeError >
      beforeError + Math.max(0.08, args.targetToleranceVol * 2)
    ) return;

    let distance = 0;
    const sampleGap = args.targetCarbonation - input.before;
    distance += Math.abs(sampleGap - currentGap) / 0.20;
    distance += Math.abs(input.statePressure - currentPressure) / 0.60;

    if (currentTemp !== null && input.temp !== null) {
      distance += Math.abs(input.temp - currentTemp) / 4;
    }
    if (currentHours !== null && Number.isFinite(input.hoursSinceT0)) {
      distance += Math.abs(input.hoursSinceT0 - currentHours) / 144;
    }

    const improvement = beforeError - outcomeError;
    const outcomeWeight = clamp(
      0.35 + improvement / 0.12,
      0.15,
      1.5,
    );

    const denominator = args.targetCarbonation - input.before;
    const progressFraction48h =
      Math.abs(denominator) >= 0.03
        ? clamp((input.outcome - input.before) / denominator, -0.5, 1.5)
        : null;

    rows.push({
      batchId: String(input.batchId ?? ""),
      pressure: input.proposalPressure,
      progressFraction48h,
      weight:
        qualityWeight(input.quality) *
        outcomeWeight /
        (0.5 + distance),
    });
  };

  for (const sample of args.samples) {
    if (
      !Number.isFinite(sample.carbonationBefore) ||
      !Number.isFinite(sample.primaryOutcome?.carbonation) ||
      !Number.isFinite(sample.targetPressure) ||
      !Number.isFinite(sample.currentPressure)
    ) continue;

    addCandidate({
      batchId: sample.batchId,
      before: sample.carbonationBefore,
      outcome: sample.primaryOutcome.carbonation,
      proposalPressure: sample.targetPressure,
      statePressure: sample.currentPressure,
      temp: finite(sample.currentTemp),
      hoursSinceT0: sample.hoursSinceT0,
      quality: sample.quality,
    });
  }

  for (const sample of args.passiveSamples) {
    if (
      !Number.isFinite(sample.carbonationBefore) ||
      !Number.isFinite(sample.primaryOutcome?.carbonation) ||
      !Number.isFinite(sample.currentPressure)
    ) continue;

    addCandidate({
      batchId: sample.batchId,
      before: sample.carbonationBefore,
      outcome: sample.primaryOutcome.carbonation,
      proposalPressure: sample.currentPressure,
      statePressure: sample.currentPressure,
      temp: finite(sample.currentTemp),
      hoursSinceT0: sample.hoursSinceT0,
      quality: sample.quality,
    });
  }

  if (!rows.length) return null;

  const bestByBatch = new Map<string, CourseCandidate>();
  rows
    .sort((a, b) => b.weight - a.weight)
    .forEach((row, index) => {
      const key = row.batchId || `anonymous-${index}`;
      const existing = bestByBatch.get(key);
      if (!existing || row.weight > existing.weight) {
        bestByBatch.set(key, row);
      }
    });

  const batches = Array.from(bestByBatch.values())
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 16);

  const pressure = weightedMedian(
    batches.map((row) => ({
      value: row.pressure,
      weight: row.weight,
    })),
  );
  if (pressure === null) return null;

  const progressRows = batches
    .filter((row) => row.progressFraction48h !== null)
    .map((row) => ({
      value: row.progressFraction48h!,
      weight: row.weight,
    }));

  return {
    pressure,
    progressFraction48h: weightedMedian(progressRows),
    supportBatches: batches.length,
    supportSamples: rows.length,
    confidence:
      batches.length >= 8
        ? "high"
        : batches.length >= 4
          ? "medium"
          : "low",
  };
}

function yeastDropHistory(
  measurements: PressureV4Measurement[],
): {
  losses: number[];
  coldDropCount: number;
} {
  const rows = measurements
    .map((measurement) => ({
      measurement,
      time: measurementDateTimeMs(measurement),
    }))
    .filter((row): row is {
      measurement: PressureV4Measurement;
      time: number;
    } => row.time !== null)
    .sort((a, b) => a.time - b.time);

  const losses: number[] = [];
  let coldDropCount = 0;
  let lastPressure: number | null = null;

  for (const { measurement } of rows) {
    const note = noteText(measurement);
    const rowPressure = finite(measurement.pressure);
    const isYeast = /שמר(?:ים|י)/.test(note);

    if (isYeast) {
      const temp = finite(measurement.temp);
      if (temp !== null && temp <= 9) coldDropCount += 1;

      const after = yeastPressureAfterFromNote(measurement);
      const before = rowPressure ?? lastPressure;
      if (before !== null && after !== null) {
        const loss = before - after;
        if (loss >= 0.02 && loss <= 0.6) {
          losses.push(loss);
        }
      }
    }

    lastPressure = effectivePressureAfterRow(
      measurement,
      rowPressure ?? lastPressure,
    );
  }

  return { losses, coldDropCount };
}

function expectedRemainingColdYeastDrops(args: {
  state: PressureV4DecisionState;
  measurements: PressureV4Measurement[];
  coldDropCount: number;
}): number {
  // A normal cold-cellar course has one deliberate yeast drop after cooling.
  // Do NOT infer extra future losses from the current pressure or from historical
  // pressure setpoints: those are controller choices, not operational losses.
  //
  // Weekly/exceptional extra drops can be modelled later from an explicit
  // historical yeast-drop event model. Until then, only schedule the one
  // identifiable post-cooling drop when it has not happened yet.
  if (args.coldDropCount > 0) return 0;

  const coolingStarted = args.measurements.some(isCoolingStartNote);
  if (!coolingStarted && !args.state.cooling) return 0;

  return 1;
}

function estimateFutureOperationalLoss(args: {
  measurements: PressureV4Measurement[];
  state: PressureV4DecisionState;
}): FutureLossEstimate {
  const yeast = yeastDropHistory(args.measurements);
  const observedMedian = median(yeast.losses);
  const remainingDrops = expectedRemainingColdYeastDrops({
    state: args.state,
    measurements: args.measurements,
    coldDropCount: yeast.coldDropCount,
  });

  if (remainingDrops <= 0) {
    return {
      totalBar: 0,
      eventCount: 0,
      source: "none",
      observedDropMedianBar:
        observedMedian === null
          ? null
          : Number(observedMedian.toFixed(3)),
      observedDropCount: yeast.losses.length,
    };
  }

  const lossPerDrop =
    observedMedian !== null
      ? clamp(observedMedian, 0.04, 0.35)
      : DEFAULT_YEAST_DROP_LOSS_BAR;

  return {
    totalBar: Number(
      clamp(lossPerDrop * remainingDrops, 0, 0.7).toFixed(3),
    ),
    eventCount: remainingDrops,
    source:
      observedMedian !== null
        ? "observed_yeast_drops"
        : "yeast_drop_fallback",
    observedDropMedianBar:
      observedMedian === null
        ? null
        : Number(observedMedian.toFixed(3)),
    observedDropCount: yeast.losses.length,
  };
}

function estimateCoolingHours(args: {
  state: PressureV4DecisionState;
  currentTemperature: number;
  coldReferenceTemperature: number;
}): number {
  const remaining =
    args.currentTemperature - args.coldReferenceTemperature;
  if (remaining <= 0.15) return 0;

  const change24 = finite(args.state.cooling?.tempChange24h);
  if (change24 !== null && change24 < -0.2) {
    return clamp(
      remaining / (Math.abs(change24) / 24),
      4,
      72,
    );
  }

  const totalDrop = finite(args.state.cooling?.tempDropSinceCooling);
  const totalHours = finite(args.state.cooling?.hoursSinceCooling);
  if (
    totalDrop !== null &&
    totalHours !== null &&
    totalDrop > 0.5 &&
    totalHours > 2
  ) {
    return clamp(
      remaining / (totalDrop / totalHours),
      4,
      72,
    );
  }

  return 30;
}

function projectCurrentCarbonation(args: {
  measurements: PressureV4Measurement[];
  measuredCarbonation: number;
  kPerHour: number;
}): {
  carbonation: number;
  hoursSinceMeasurement: number;
} {
  const rows = args.measurements
    .map((measurement) => ({
      measurement,
      time: measurementDateTimeMs(measurement),
      carbonation: finite(measurement.carbonation),
    }))
    .filter((row): row is {
      measurement: PressureV4Measurement;
      time: number;
      carbonation: number | null;
    } => row.time !== null)
    .sort((a, b) => a.time - b.time);

  let lastCarbonationIndex = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index].carbonation !== null) {
      lastCarbonationIndex = index;
      break;
    }
  }
  if (lastCarbonationIndex < 0) {
    return {
      carbonation: args.measuredCarbonation,
      hoursSinceMeasurement: 0,
    };
  }

  const start = rows[lastCarbonationIndex];
  const end = rows[rows.length - 1];
  if (end.time <= start.time) {
    return {
      carbonation: start.carbonation ?? args.measuredCarbonation,
      hoursSinceMeasurement: 0,
    };
  }

  const segments = buildPathSegments({
    measurements: args.measurements,
    startMs: start.time,
    endMs: end.time,
  });
  if (!segments) {
    return {
      carbonation: start.carbonation ?? args.measuredCarbonation,
      hoursSinceMeasurement:
        (end.time - start.time) / 3600000,
    };
  }

  const projected = simulateSegments(
    start.carbonation ?? args.measuredCarbonation,
    segments,
    args.kPerHour,
  );

  return {
    carbonation:
      projected ?? start.carbonation ?? args.measuredCarbonation,
    hoursSinceMeasurement:
      Math.max(0, (end.time - start.time) / 3600000),
  };
}

function simulateCandidate(args: {
  setPressure: number;
  currentCarbonation: number;
  currentTemperature: number;
  coldReferenceTemperature: number;
  coolingHours: number;
  kPerHour: number;
  futurePressureLossBar: number;
  futurePressureLossEvents: number;
  targetCarbonation: number;
  targetToleranceVol: number;
  expectedProgressFraction48h: number | null;
  historicalPressurePrior: number | null;
  currentPressure: number;
}): CandidateForecast | null {
  const eventCount = args.futurePressureLossEvents;
  const lossPerEvent =
    eventCount > 0
      ? args.futurePressureLossBar / eventCount
      : 0;

  const eventHours = Array.from(
    { length: eventCount },
    (_, index) => 48 + index * 48,
  );

  let pressure = clamp(
    args.setPressure,
    0,
    MAX_OPERATIONAL_PRESSURE_BAR,
  );
  let carbonation = args.currentCarbonation;
  let checkpoint48 = carbonation;
  let checkpoint72 = carbonation;
  let checkpoint96 = carbonation;
  let maxCarbonation = carbonation;
  let minCarbonation = carbonation;
  let hoursToTargetBand: number | null = null;
  let eventIndex = 0;

  for (let hour = 1; hour <= MAX_FORECAST_HOURS; hour += 1) {
    while (
      eventIndex < eventHours.length &&
      hour >= eventHours[eventIndex]
    ) {
      pressure = Math.max(0, pressure - lossPerEvent);
      eventIndex += 1;
    }

    const coolingProgress =
      args.coolingHours > 0
        ? clamp(hour / args.coolingHours, 0, 1)
        : 1;
    const temperature =
      args.currentTemperature +
      (
        args.coldReferenceTemperature -
        args.currentTemperature
      ) * coolingProgress;

    const equilibrium = equilibriumCarbonationVolumes(
      temperature,
      pressure,
    );
    if (equilibrium === null) return null;

    const decay = Math.exp(-args.kPerHour);
    carbonation =
      equilibrium - (equilibrium - carbonation) * decay;

    maxCarbonation = Math.max(maxCarbonation, carbonation);
    minCarbonation = Math.min(minCarbonation, carbonation);

    if (hour === 48) checkpoint48 = carbonation;
    if (hour === 72) checkpoint72 = carbonation;
    if (hour === 96) checkpoint96 = carbonation;

    if (
      hoursToTargetBand === null &&
      Math.abs(carbonation - args.targetCarbonation) <=
        args.targetToleranceVol
    ) {
      hoursToTargetBand = hour;
    }
  }

  const finalPressure = Math.max(
    0,
    args.setPressure - args.futurePressureLossBar,
  );
  const terminalEquilibrium = equilibriumCarbonationVolumes(
    args.coldReferenceTemperature,
    finalPressure,
  );
  if (terminalEquilibrium === null) return null;

  // Fallback scoring is intentionally COURSE based. A fixed setpoint is not
  // a valid model of the terminal tank pressure because headspace pressure is
  // consumed while CO2 dissolves and is also changed by cellar operations.
  // Therefore the static terminal equilibrium is diagnostic only and must not
  // force every recommendation down to P_eq + one guessed pressure loss.
  const courseError72 = Math.abs(
    checkpoint72 - args.targetCarbonation,
  );

  const courseValues = [
    checkpoint48,
    checkpoint72,
    checkpoint96,
  ];
  let courseOvershoot = 0;
  if (args.currentCarbonation < args.targetCarbonation) {
    courseOvershoot = Math.max(
      0,
      Math.max(...courseValues) -
        args.targetCarbonation -
        args.targetToleranceVol,
    );
  } else if (args.currentCarbonation > args.targetCarbonation) {
    courseOvershoot = Math.max(
      0,
      args.targetCarbonation -
        Math.min(...courseValues) -
        args.targetToleranceVol,
    );
  }

  let checkpointError = 0;
  if (args.expectedProgressFraction48h !== null) {
    const expected48 =
      args.currentCarbonation +
      (
        args.targetCarbonation -
        args.currentCarbonation
      ) * args.expectedProgressFraction48h;
    checkpointError = Math.abs(checkpoint48 - expected48);
  }

  const historicalPressurePenalty =
    args.historicalPressurePrior === null
      ? 0
      : Math.abs(
          args.setPressure - args.historicalPressurePrior
        );

  const interventionPenalty =
    Math.abs(args.setPressure - args.currentPressure);

  const score =
    courseError72 * 10 +
    courseOvershoot * 8 +
    checkpointError * 1.5 +
    historicalPressurePenalty * 0.40 +
    interventionPenalty * 0.05;

  return {
    setPressure: args.setPressure,
    checkpoint48,
    checkpoint72,
    checkpoint96,
    finalPressure,
    terminalEquilibriumCarbonation: terminalEquilibrium,
    carbonationAtHorizon: carbonation,
    maxCarbonation,
    minCarbonation,
    hoursToTargetBand,
    score,
  };
}

export function estimatePressureTargetV6(args: {
  samples?: PressureV4Sample[];
  passiveSamples?: PressureV4PassiveSample[];
  transitions?: PressureV4TransitionSample[];
  state: PressureV4DecisionState;
  measurements: PressureV4Measurement[];
  targetCarbonation: number;
  targetToleranceVol?: number;
  coldReferenceTemperature?: number | null;
  currentBatchId?: string;
  historicalBatches?: PressureV6HistoricalBatch[];
}): PressureV6Estimate | null {
  const measuredCarbonation = finite(args.state.carbonation);
  const currentPressure = finite(args.state.currentPressure);
  const currentTemperature = finite(args.state.currentTemp);
  if (
    measuredCarbonation === null ||
    currentPressure === null ||
    currentTemperature === null ||
    !Number.isFinite(args.targetCarbonation)
  ) return null;

  const targetToleranceVol = clamp(
    finite(args.targetToleranceVol) ?? 0.04,
    0.005,
    0.25,
  );

  const coldReferenceTemperature =
    finite(args.coldReferenceTemperature) ??
    Math.min(currentTemperature, 1);

  const k = chooseK({
    transitions: args.transitions ?? [],
    state: args.state,
    measurements: args.measurements,
    currentBatchId: args.currentBatchId,
  });

  const currentProjection = projectCurrentCarbonation({
    measurements: args.measurements,
    measuredCarbonation,
    kPerHour: k.kPerHour,
  });
  const estimatedCurrentCarbonation =
    currentProjection.carbonation;

  const targetEquilibriumPressure = equilibriumPressureBar(
    coldReferenceTemperature,
    args.targetCarbonation,
  );
  const currentEquilibriumPressure = equilibriumPressureBar(
    currentTemperature,
    estimatedCurrentCarbonation,
  );
  if (
    targetEquilibriumPressure === null ||
    currentEquilibriumPressure === null
  ) return null;


  const oneActionCourses = buildV6OneActionCourses({
    historicalBatches: args.historicalBatches ?? [],
    targetCarbonation: args.targetCarbonation,
    targetToleranceVol,
  });
  const oneActionHistory = oneActionCourseEstimate({
    courses: oneActionCourses,
    state: {
      ...args.state,
      carbonation: estimatedCurrentCarbonation,
    },
    targetCarbonation: args.targetCarbonation,
  });

  const summarizedHistoricalPrior = historicalCoursePrior({
    samples: args.samples ?? [],
    passiveSamples: args.passiveSamples ?? [],
    state: {
      ...args.state,
      carbonation: estimatedCurrentCarbonation,
    },
    targetCarbonation: args.targetCarbonation,
    targetToleranceVol,
    currentBatchId: args.currentBatchId,
  });

  // Raw one-action histories are stronger evidence than the legacy +48h
  // summaries, but they are a PRIOR only. They must not directly dictate the
  // answer or fabricate a forecast that is independent of the chosen pressure.
  const historicalPrior: HistoricalCoursePrior | null =
    oneActionHistory
      ? {
          pressure: oneActionHistory.pressure,
          progressFraction48h: clamp(
            48 / oneActionHistory.hoursToTarget,
            0,
            1,
          ),
          supportBatches: oneActionHistory.supportBatches,
          supportSamples: oneActionHistory.supportCourses,
          confidence: oneActionHistory.confidence,
        }
      : summarizedHistoricalPrior;

  const futureLoss: FutureLossEstimate =
    oneActionHistory
      ? {
          totalBar: Number(
            clamp(oneActionHistory.yeastLossBar, 0, 0.7).toFixed(3),
          ),
          eventCount:
            oneActionHistory.yeastLossBar >= 0.03 ? 1 : 0,
          source:
            oneActionHistory.yeastLossBar >= 0.03
              ? "historical_one_action_courses"
              : "none",
          observedDropMedianBar:
            Number(oneActionHistory.yeastLossBar.toFixed(3)),
          observedDropCount:
            oneActionHistory.yeastLossBar >= 0.03 ? 1 : 0,
        }
      : estimateFutureOperationalLoss({
          measurements: args.measurements,
          state: args.state,
        });

  const coolingHours = estimateCoolingHours({
    state: args.state,
    currentTemperature,
    coldReferenceTemperature,
  });

  const historicalProgress =
    historicalPrior?.progressFraction48h ?? null;

  const candidateRows: CandidateForecast[] = [];
  for (
    let pressure = 0;
    pressure <= MAX_OPERATIONAL_PRESSURE_BAR + 1e-9;
    pressure += 0.01
  ) {
    const candidate = simulateCandidate({
      setPressure: Number(pressure.toFixed(2)),
      currentCarbonation: estimatedCurrentCarbonation,
      currentTemperature,
      coldReferenceTemperature,
      coolingHours,
      kPerHour: k.kPerHour,
      futurePressureLossBar: futureLoss.totalBar,
      futurePressureLossEvents: futureLoss.eventCount,
      targetCarbonation: args.targetCarbonation,
      targetToleranceVol,
      expectedProgressFraction48h: historicalProgress,
      historicalPressurePrior:
        historicalPrior?.pressure ?? null,
      currentPressure,
    });
    if (candidate) candidateRows.push(candidate);
  }
  if (!candidateRows.length) return null;

  candidateRows.sort((a, b) => a.score - b.score);
  let best = candidateRows[0];

  const currentForecast = simulateCandidate({
    setPressure: currentPressure,
    currentCarbonation: estimatedCurrentCarbonation,
    currentTemperature,
    coldReferenceTemperature,
    coolingHours,
    kPerHour: k.kPerHour,
    futurePressureLossBar: futureLoss.totalBar,
    futurePressureLossEvents: futureLoss.eventCount,
    targetCarbonation: args.targetCarbonation,
    targetToleranceVol,
    expectedProgressFraction48h: historicalProgress,
    historicalPressurePrior:
      historicalPrior?.pressure ?? null,
    currentPressure,
  });
  if (!currentForecast) return null;

  const fallbackTrend = reliableCurrentTrend({
    state: args.state,
    currentCarbonation: estimatedCurrentCarbonation,
    targetCarbonation: args.targetCarbonation,
    targetToleranceVol,
    historicalHoursToTarget:
      oneActionHistory?.hoursToTarget ?? null,
  });
  if (fallbackTrend.onCourse) {
    best = currentForecast;
  }

  const currentTerminalOnTarget =
    Math.abs(
      currentForecast.terminalEquilibriumCarbonation -
      args.targetCarbonation,
    ) <= targetToleranceVol;

  const currentCourseSafe =
    estimatedCurrentCarbonation <= args.targetCarbonation
      ? currentForecast.maxCarbonation <=
        args.targetCarbonation + targetToleranceVol + 0.03
      : currentForecast.minCarbonation >=
        args.targetCarbonation - targetToleranceVol - 0.03;

  if (
    !fallbackTrend.onCourse &&
    currentTerminalOnTarget &&
    currentCourseSafe &&
    currentForecast.score <= best.score + 0.08
  ) {
    best = currentForecast;
  }

  const idealTerminalSetpoint =
    targetEquilibriumPressure + futureLoss.totalBar;

  if (
    idealTerminalSetpoint >
    MAX_OPERATIONAL_PRESSURE_BAR + 0.01
  ) {
    return {
      version: 6,
      mode: "trajectory",
      measuredCarbonation,
      estimatedCurrentCarbonation:
        Number(estimatedCurrentCarbonation.toFixed(3)),
      hoursSinceCarbonationMeasurement:
        Number(currentProjection.hoursSinceMeasurement.toFixed(1)),
      currentPressure,
      currentTemperature,
      forecastTemperature: coldReferenceTemperature,
      targetCarbonation: args.targetCarbonation,
      targetToleranceVol,
      kPerHour: Number(k.kPerHour.toFixed(6)),
      kSource: k.source,
      historicalKPerHour:
        k.historicalKPerHour === null
          ? null
          : Number(k.historicalKPerHour.toFixed(6)),
      currentBatchKPerHour:
        k.currentBatchKPerHour === null
          ? null
          : Number(k.currentBatchKPerHour.toFixed(6)),
      kHistoricalBatchCount: k.historicalBatches,
      kCurrentBatchIntervalCount: k.currentBatchIntervals,
      supportCount: historicalPrior?.supportBatches ?? 0,
      supportSampleCount: historicalPrior?.supportSamples ?? 0,
      confidence: historicalPrior?.confidence ?? k.confidence,
      historicalPressurePrior:
        historicalPrior
          ? Number(historicalPrior.pressure.toFixed(2))
          : null,
      historicalProgressFraction48h:
        historicalProgress === null
          ? null
          : Number(historicalProgress.toFixed(3)),
      targetEquilibriumPressure:
        Number(targetEquilibriumPressure.toFixed(2)),
      equilibriumPressureForCurrentCarb:
        Number(currentEquilibriumPressure.toFixed(2)),
      pressureDistanceFromEquilibrium:
        Number(
          (currentPressure - currentEquilibriumPressure).toFixed(2),
        ),
      expectedOperationalPressureLossBar:
        Number(futureLoss.totalBar.toFixed(2)),
      expectedPressureLossEvents: futureLoss.eventCount,
      operationalLossSource: futureLoss.source,
      observedYeastDropMedianBar:
        futureLoss.observedDropMedianBar,
      observedYeastDropCount: futureLoss.observedDropCount,
      coolingHoursRemaining: Number(coolingHours.toFixed(1)),
      predictedWithoutChange:
        Number(currentForecast.checkpoint48.toFixed(3)),
      predictedAtTarget: null,
      terminalCarbonationWithoutChange:
        Number(
          currentForecast.terminalEquilibriumCarbonation.toFixed(3),
        ),
      terminalCarbonationAtTarget: null,
      terminalPressureWithoutChange:
        Number(currentForecast.finalPressure.toFixed(2)),
      terminalPressureAtTarget: null,
      terminalHoursAtTarget: null,
      effectiveVolPerBar48h: 0,
      rawTargetPressure:
        Number(idealTerminalSetpoint.toFixed(2)),
      targetPressure: null,
      targetPressureRangeLow: null,
      targetPressureRangeHigh: null,
      action: "edge_case",
      holdReason: null,
      recommendationVisibility: "global",
      edgeCase: "head_pressure_insufficient",
    };
  }

  let targetPressure = fallbackTrend.onCourse
    ? currentPressure
    : best.setPressure;
  if (fallbackTrend.onCourse) {
    best = currentForecast;
  }
  const rawTargetPressure = targetPressure;
  const delta = targetPressure - currentPressure;

  if (Math.abs(delta) < 0.025) {
    targetPressure = currentPressure;
    best = currentForecast;
  } else if (Math.abs(delta) < 0.05) {
    targetPressure = Number(
      (
        currentPressure +
        (delta > 0 ? 0.05 : -0.05)
      ).toFixed(2),
    );
    const stepped = simulateCandidate({
      setPressure: clamp(
        targetPressure,
        0,
        MAX_OPERATIONAL_PRESSURE_BAR,
      ),
      currentCarbonation: estimatedCurrentCarbonation,
      currentTemperature,
      coldReferenceTemperature,
      coolingHours,
      kPerHour: k.kPerHour,
      futurePressureLossBar: futureLoss.totalBar,
      futurePressureLossEvents: futureLoss.eventCount,
      targetCarbonation: args.targetCarbonation,
      targetToleranceVol,
      expectedProgressFraction48h: historicalProgress,
      historicalPressurePrior:
        historicalPrior?.pressure ?? null,
      currentPressure,
    });
    if (stepped) best = stepped;
  }

  const pressureDelta = targetPressure - currentPressure;
  const action: PressureV6Estimate["action"] =
    Math.abs(pressureDelta) < 0.025
      ? "hold"
      : pressureDelta > 0
        ? "raise"
        : "lower";

  const measuredInTolerance =
    Math.abs(
      estimatedCurrentCarbonation -
      args.targetCarbonation,
    ) <= targetToleranceVol;

  const holdReason: PressureV6Estimate["holdReason"] =
    action !== "hold"
      ? null
      : measuredInTolerance
        ? "already_in_tolerance"
        : "trajectory_on_course";

  const bestScore = candidateRows[0].score;
  const nearOptimal = candidateRows.filter(
    (candidate) => candidate.score <= bestScore + 0.12,
  );
  const rangeLow = nearOptimal.length
    ? Math.min(...nearOptimal.map((candidate) => candidate.setPressure))
    : targetPressure;
  const rangeHigh = nearOptimal.length
    ? Math.max(...nearOptimal.map((candidate) => candidate.setPressure))
    : targetPressure;

  const lowSensitivity = simulateCandidate({
    setPressure: clamp(targetPressure - 0.05, 0, MAX_OPERATIONAL_PRESSURE_BAR),
    currentCarbonation: estimatedCurrentCarbonation,
    currentTemperature,
    coldReferenceTemperature,
    coolingHours,
    kPerHour: k.kPerHour,
    futurePressureLossBar: futureLoss.totalBar,
    futurePressureLossEvents: futureLoss.eventCount,
    targetCarbonation: args.targetCarbonation,
    targetToleranceVol,
    expectedProgressFraction48h: historicalProgress,
    historicalPressurePrior:
      historicalPrior?.pressure ?? null,
    currentPressure,
  });
  const highSensitivity = simulateCandidate({
    setPressure: clamp(targetPressure + 0.05, 0, MAX_OPERATIONAL_PRESSURE_BAR),
    currentCarbonation: estimatedCurrentCarbonation,
    currentTemperature,
    coldReferenceTemperature,
    coolingHours,
    kPerHour: k.kPerHour,
    futurePressureLossBar: futureLoss.totalBar,
    futurePressureLossEvents: futureLoss.eventCount,
    targetCarbonation: args.targetCarbonation,
    targetToleranceVol,
    expectedProgressFraction48h: historicalProgress,
    historicalPressurePrior:
      historicalPrior?.pressure ?? null,
    currentPressure,
  });
  const effectiveVolPerBar48h =
    lowSensitivity && highSensitivity
      ? Math.abs(
          highSensitivity.checkpoint48 -
          lowSensitivity.checkpoint48
        ) / 0.1
      : 0;

  return {
    version: 6,
    mode: "trajectory",
    measuredCarbonation,
    estimatedCurrentCarbonation:
      Number(estimatedCurrentCarbonation.toFixed(3)),
    hoursSinceCarbonationMeasurement:
      Number(currentProjection.hoursSinceMeasurement.toFixed(1)),
    currentPressure,
    currentTemperature,
    forecastTemperature: coldReferenceTemperature,
    targetCarbonation: args.targetCarbonation,
    targetToleranceVol,

    kPerHour: Number(k.kPerHour.toFixed(6)),
    kSource: k.source,
    historicalKPerHour:
      k.historicalKPerHour === null
        ? null
        : Number(k.historicalKPerHour.toFixed(6)),
    currentBatchKPerHour:
      k.currentBatchKPerHour === null
        ? null
        : Number(k.currentBatchKPerHour.toFixed(6)),
    kHistoricalBatchCount: k.historicalBatches,
    kCurrentBatchIntervalCount: k.currentBatchIntervals,

    supportCount: historicalPrior?.supportBatches ?? 0,
    supportSampleCount: historicalPrior?.supportSamples ?? 0,
    confidence: historicalPrior?.confidence ?? k.confidence,
    historicalPressurePrior:
      historicalPrior
        ? Number(historicalPrior.pressure.toFixed(2))
        : null,
    historicalProgressFraction48h:
      historicalProgress === null
        ? null
        : Number(historicalProgress.toFixed(3)),

    targetEquilibriumPressure:
      Number(targetEquilibriumPressure.toFixed(2)),
    equilibriumPressureForCurrentCarb:
      Number(currentEquilibriumPressure.toFixed(2)),
    pressureDistanceFromEquilibrium:
      Number(
        (currentPressure - currentEquilibriumPressure).toFixed(2),
      ),

    expectedOperationalPressureLossBar:
      Number(futureLoss.totalBar.toFixed(2)),
    expectedPressureLossEvents: futureLoss.eventCount,
    operationalLossSource: futureLoss.source,
    observedYeastDropMedianBar:
      futureLoss.observedDropMedianBar,
    observedYeastDropCount: futureLoss.observedDropCount,

    coolingHoursRemaining: Number(coolingHours.toFixed(1)),

    predictedWithoutChange:
      Number(currentForecast.checkpoint48.toFixed(3)),
    predictedAtTarget:
      Number(best.checkpoint48.toFixed(3)),
    terminalCarbonationWithoutChange:
      Number(
        currentForecast.terminalEquilibriumCarbonation.toFixed(3),
      ),
    terminalCarbonationAtTarget:
      Number(best.terminalEquilibriumCarbonation.toFixed(3)),
    terminalPressureWithoutChange:
      Number(currentForecast.finalPressure.toFixed(2)),
    terminalPressureAtTarget:
      Number(best.finalPressure.toFixed(2)),
    terminalHoursAtTarget: best.hoursToTargetBand,

    effectiveVolPerBar48h:
      Number(effectiveVolPerBar48h.toFixed(3)),

    rawTargetPressure: Number(rawTargetPressure.toFixed(2)),
    targetPressure: Number(targetPressure.toFixed(2)),
    targetPressureRangeLow: Number(rangeLow.toFixed(2)),
    targetPressureRangeHigh: Number(rangeHigh.toFixed(2)),

    action,
    holdReason,
    recommendationVisibility:
      action === "hold" ? "tank_only" : "global",
    edgeCase: null,
  };
}
