import {
  estimateEquilibriumPressureV4,
  type PressureEquilibriumV4Point,
} from "./pressureEquilibriumV4";
import {
  buildPressureV4DecisionState,
  type PressureV4Measurement,
  type PressureV4PassiveSample,
  type PressureV4Sample,
  type PressureV4TransitionSample,
} from "./pressurePredictionV4";
import {
  buildV6OneActionCourses,
  estimatePressureTargetV6,
  type PressureV6HistoricalBatch,
  type PressureV6OneActionCourse,
} from "./pressurePredictionV6";

export type PressureV6BacktestModel = {
  style: string;
  samples: PressureV4Sample[];
  passiveSamples: PressureV4PassiveSample[];
  transitions: PressureV4TransitionSample[];
  equilibriumPoints: PressureEquilibriumV4Point[];
};

export type PressureV6BacktestDirection = "raise" | "hold" | "lower";

export type PressureV6BacktestCase = {
  batchId: string;
  startDateTimeMs: number;
  startCarbonation: number;
  startPressure: number;
  startTemperature: number;
  actualPressure: number;
  predictedPressure: number;
  pressureErrorBar: number;
  actualDirection: PressureV6BacktestDirection;
  predictedDirection: PressureV6BacktestDirection;
  directionCorrect: boolean;
  supportBatches: number;
  confidence: "low" | "medium" | "high";
};

export type PressureV6BacktestResult = {
  eligibleCaseCount: number;
  predictedCaseCount: number;
  failedPredictionCount: number;
  distinctBatchCount: number;
  coverage: number;

  pressureMaeBar: number | null;
  pressureMedianAbsErrorBar: number | null;
  pressureP80AbsErrorBar: number | null;
  pressureP90AbsErrorBar: number | null;
  directionAccuracy: number | null;
  within010Bar: number | null;
  within015Bar: number | null;
  within020Bar: number | null;

  readiness:
    | "passes_gate"
    | "promising"
    | "not_ready"
    | "insufficient_data";

  cases: PressureV6BacktestCase[];
};

function normalizeBatchId(value: unknown): string {
  return String(value ?? "").replace("#", "").trim();
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

function mean(values: number[]): number | null {
  const clean = values.filter(Number.isFinite);
  if (!clean.length) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function quantile(values: number[], q: number): number | null {
  const clean = values
    .filter(Number.isFinite)
    .slice()
    .sort((a, b) => a - b);
  if (!clean.length) return null;
  if (clean.length === 1) return clean[0];

  const position = (clean.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return clean[lower];

  const fraction = position - lower;
  return clean[lower] * (1 - fraction) + clean[upper] * fraction;
}

function coldReferenceTemperature(
  points: PressureEquilibriumV4Point[],
): number | null {
  const values = points
    .map((point) => finite(point.temperature))
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  if (!values.length) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2
    ? values[middle]
    : (values[middle - 1] + values[middle]) / 2;
}

function directionForDelta(delta: number): PressureV6BacktestDirection {
  if (Math.abs(delta) < 0.05) return "hold";
  return delta > 0 ? "raise" : "lower";
}

function measurementTimeMs(measurement: PressureV4Measurement): number | null {
  const text = String(measurement.id ?? "");
  const match = text.match(
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

function stripHeldOutActionNote(note: unknown): string | undefined {
  const parts = String(note ?? "")
    .split(/\s*\|\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) =>
      !/(?:העלאת|הורדת|שינוי)\s+לחץ\s+ל/i.test(part) &&
      !part.includes("גיזוז מלמטה")
    );

  return parts.length ? parts.join(" | ") : undefined;
}

function measurementsAtDecision(
  batch: PressureV6HistoricalBatch,
  course: PressureV6OneActionCourse,
): PressureV4Measurement[] {
  return batch.measurements
    .filter((measurement) => {
      const time = measurementTimeMs(measurement);
      return time !== null && time <= course.startDateTimeMs;
    })
    .map((measurement) => {
      const time = measurementTimeMs(measurement);
      if (time !== course.startDateTimeMs) return { ...measurement };

      return {
        ...measurement,
        pressure: course.startPressure,
        temp: course.startTemperature,
        carbonation: course.startCarbonation,
        notes: stripHeldOutActionNote(measurement.notes),
      };
    });
}

function perBatchBalancedMean(
  cases: PressureV6BacktestCase[],
  selector: (item: PressureV6BacktestCase) => number,
): number | null {
  const grouped = new Map<string, number[]>();
  for (const item of cases) {
    const values = grouped.get(item.batchId) ?? [];
    values.push(selector(item));
    grouped.set(item.batchId, values);
  }

  const batchMeans = Array.from(grouped.values())
    .map((values) => mean(values))
    .filter((value): value is number => value !== null);

  return mean(batchMeans);
}

function perBatchMeanErrors(
  cases: PressureV6BacktestCase[],
): number[] {
  const grouped = new Map<string, number[]>();
  for (const item of cases) {
    const values = grouped.get(item.batchId) ?? [];
    values.push(item.pressureErrorBar);
    grouped.set(item.batchId, values);
  }

  return Array.from(grouped.values())
    .map((values) => mean(values))
    .filter((value): value is number => value !== null);
}

export function runPressureV6LeaveOneBatchOutBacktest(args: {
  model: PressureV6BacktestModel;
  historicalBatches: PressureV6HistoricalBatch[];
  targetCarbonation: number;
  targetToleranceVol: number;
  maxCases?: number;
}): PressureV6BacktestResult {
  const allCourses = buildV6OneActionCourses({
    historicalBatches: args.historicalBatches,
    targetCarbonation: args.targetCarbonation,
    targetToleranceVol: args.targetToleranceVol,
  });

  // Keep all useful decision points but cap runtime deterministically.
  const testCourses = allCourses
    .slice()
    .sort((a, b) =>
      a.startDateTimeMs - b.startDateTimeMs ||
      a.batchId.localeCompare(b.batchId)
    )
    .slice(0, Math.max(1, args.maxCases ?? 120));

  const batchMap = new Map(
    args.historicalBatches.map((batch) => [
      normalizeBatchId(batch.batchId),
      batch,
    ]),
  );

  const cases: PressureV6BacktestCase[] = [];
  let failedPredictionCount = 0;

  for (const course of testCourses) {
    const heldOutBatchId = normalizeBatchId(course.batchId);
    const heldOutBatch = batchMap.get(heldOutBatchId);
    if (!heldOutBatch) {
      failedPredictionCount += 1;
      continue;
    }

    const trainingBatches = args.historicalBatches.filter(
      (batch) => normalizeBatchId(batch.batchId) !== heldOutBatchId,
    );

    const samples = args.model.samples.filter(
      (sample) => normalizeBatchId(sample.batchId) !== heldOutBatchId,
    );
    const passiveSamples = args.model.passiveSamples.filter(
      (sample) => normalizeBatchId(sample.batchId) !== heldOutBatchId,
    );
    const transitions = args.model.transitions.filter(
      (sample) => normalizeBatchId(sample.batchId) !== heldOutBatchId,
    );
    const equilibriumPoints = args.model.equilibriumPoints.filter(
      (point) => normalizeBatchId(point.batchId) !== heldOutBatchId,
    );

    const decisionMeasurements = measurementsAtDecision(
      heldOutBatch,
      course,
    );
    if (!decisionMeasurements.length) {
      failedPredictionCount += 1;
      continue;
    }

    const equilibriumPressure = (temperature: number | null) =>
      estimateEquilibriumPressureV4(
        {
          style: args.model.style,
          points: equilibriumPoints,
        },
        temperature,
      );

    const state = buildPressureV4DecisionState({
      measurements: decisionMeasurements,
      equilibriumPressure,
    });
    if (!state) {
      failedPredictionCount += 1;
      continue;
    }

    const estimate = estimatePressureTargetV6({
      samples,
      passiveSamples,
      transitions,
      state,
      measurements: decisionMeasurements,
      historicalBatches: trainingBatches,
      targetCarbonation: args.targetCarbonation,
      targetToleranceVol: args.targetToleranceVol,
      coldReferenceTemperature:
        coldReferenceTemperature(equilibriumPoints),
      currentBatchId: heldOutBatchId,
    });

    if (!estimate || estimate.targetPressure === null) {
      failedPredictionCount += 1;
      continue;
    }

    const predictedPressure = estimate.targetPressure;
    const actualPressure = course.actionPressure;
    const actualDelta = actualPressure - course.startPressure;
    const predictedDelta = predictedPressure - course.startPressure;
    const actualDirection = directionForDelta(actualDelta);
    const predictedDirection = directionForDelta(predictedDelta);

    cases.push({
      batchId: heldOutBatchId,
      startDateTimeMs: course.startDateTimeMs,
      startCarbonation: course.startCarbonation,
      startPressure: course.startPressure,
      startTemperature: course.startTemperature,
      actualPressure,
      predictedPressure,
      pressureErrorBar:
        Math.abs(predictedPressure - actualPressure),
      actualDirection,
      predictedDirection,
      directionCorrect:
        actualDirection === predictedDirection,
      supportBatches: estimate.supportCount,
      confidence: estimate.confidence,
    });
  }

  const eligibleCaseCount = testCourses.length;
  const predictedCaseCount = cases.length;
  const distinctBatchCount = new Set(
    cases.map((item) => item.batchId),
  ).size;
  const coverage =
    eligibleCaseCount > 0
      ? predictedCaseCount / eligibleCaseCount
      : 0;

  const batchErrors = perBatchMeanErrors(cases);
  const pressureMaeBar = mean(batchErrors);
  const directionAccuracy = perBatchBalancedMean(
    cases,
    (item) => item.directionCorrect ? 1 : 0,
  );
  const within010Bar = perBatchBalancedMean(
    cases,
    (item) => item.pressureErrorBar <= 0.10 ? 1 : 0,
  );
  const within015Bar = perBatchBalancedMean(
    cases,
    (item) => item.pressureErrorBar <= 0.15 ? 1 : 0,
  );
  const within020Bar = perBatchBalancedMean(
    cases,
    (item) => item.pressureErrorBar <= 0.20 ? 1 : 0,
  );

  let readiness: PressureV6BacktestResult["readiness"];
  if (distinctBatchCount < 8 || predictedCaseCount < 8) {
    readiness = "insufficient_data";
  } else if (
    pressureMaeBar !== null &&
    directionAccuracy !== null &&
    quantile(batchErrors, 0.9) !== null &&
    pressureMaeBar <= 0.10 &&
    quantile(batchErrors, 0.9)! <= 0.20 &&
    directionAccuracy >= 0.85 &&
    coverage >= 0.8
  ) {
    readiness = "passes_gate";
  } else if (
    pressureMaeBar !== null &&
    directionAccuracy !== null &&
    quantile(batchErrors, 0.9) !== null &&
    pressureMaeBar <= 0.15 &&
    quantile(batchErrors, 0.9)! <= 0.30 &&
    directionAccuracy >= 0.75 &&
    coverage >= 0.7
  ) {
    readiness = "promising";
  } else {
    readiness = "not_ready";
  }

  return {
    eligibleCaseCount,
    predictedCaseCount,
    failedPredictionCount,
    distinctBatchCount,
    coverage,

    pressureMaeBar:
      pressureMaeBar === null
        ? null
        : Number(pressureMaeBar.toFixed(3)),
    pressureMedianAbsErrorBar:
      quantile(batchErrors, 0.5) === null
        ? null
        : Number(quantile(batchErrors, 0.5)!.toFixed(3)),
    pressureP80AbsErrorBar:
      quantile(batchErrors, 0.8) === null
        ? null
        : Number(quantile(batchErrors, 0.8)!.toFixed(3)),
    pressureP90AbsErrorBar:
      quantile(batchErrors, 0.9) === null
        ? null
        : Number(quantile(batchErrors, 0.9)!.toFixed(3)),
    directionAccuracy:
      directionAccuracy === null
        ? null
        : Number(directionAccuracy.toFixed(3)),
    within010Bar:
      within010Bar === null
        ? null
        : Number(within010Bar.toFixed(3)),
    within015Bar:
      within015Bar === null
        ? null
        : Number(within015Bar.toFixed(3)),
    within020Bar:
      within020Bar === null
        ? null
        : Number(within020Bar.toFixed(3)),

    readiness,
    cases,
  };
}
