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
  estimatePressureTargetV6,
  type PressureV6HistoricalBatch,
} from "./pressurePredictionV6";

export type PressureV6BacktestModel = {
  style: string;
  samples: PressureV4Sample[];
  passiveSamples: PressureV4PassiveSample[];
  transitions: PressureV4TransitionSample[];
  equilibriumPoints: PressureEquilibriumV4Point[];
};

export type PressureV6BacktestDirection = "raise" | "hold" | "lower";

export type PressureDecisionOutcome = {
  batchId: string;
  decisionDateTimeMs: number;
  startCarbonation: number;
  startPressure: number;
  startTemperature: number;
  hoursSinceCooling: number | null;
  actionPressure: number;
  actionDelta: number;
  outcomeSuccess: boolean;
  outcomeCarbonation: number | null;
  hoursToOutcome: number;
  outcomeReason: "target_reached" | "overshoot" | "pressure_correction" | "bottom_carbonation";
};

export type CounterfactualOutcomeEstimate = {
  successProbability: number;
  expectedAbsCarbonationErrorVol: number | null;
  supportBatches: number;
  effectiveSupport: number;
  nearestDistance: number;
};

export type PressureV6BacktestCase = {
  batchId: string;
  decisionDateTimeMs: number;
  startCarbonation: number;
  startPressure: number;
  startTemperature: number;

  actualHumanPressure: number;
  humanActualSuccess: boolean;

  predictedPressure: number;
  predictedDirection: PressureV6BacktestDirection;

  modelEstimatedSuccessProbability: number | null;
  humanEstimatedSuccessProbability: number | null;
  estimatedSuccessLiftVsHuman: number | null;
  modelExpectedAbsCarbonationErrorVol: number | null;

  counterfactualSupportBatches: number;
  counterfactualEffectiveSupport: number;
  counterfactualSupported: boolean;

  imitationPressureErrorBar: number;
  supportBatches: number;
  confidence: "low" | "medium" | "high";
};

export type PressureV6BacktestResult = {
  eligibleCaseCount: number;
  predictedCaseCount: number;
  failedPredictionCount: number;
  distinctBatchCount: number;

  modelCoverage: number;
  counterfactualCoverage: number;

  estimatedFirstShotSuccessRate: number | null;
  estimatedHumanSuccessRate: number | null;
  actualHumanFirstShotSuccessRate: number | null;
  estimatedSuccessLiftVsHuman: number | null;

  expectedAbsCarbonationErrorVol: number | null;
  successProbabilityP10: number | null;
  dangerousMissRate: number | null;

  // Secondary diagnostic only: similarity to the human pressure choice.
  // This is intentionally NOT used to decide whether V6 is good.
  imitationPressureMaeBar: number | null;

  readiness:
    | "passes_gate"
    | "promising"
    | "not_ready"
    | "insufficient_data";

  labeledOutcomeCount: number;
  labeledOutcomeBatchCount: number;
  successfulOutcomeCount: number;
  failedOutcomeCount: number;

  cases: PressureV6BacktestCase[];
};

export function normalizePressureBatchId(value: unknown): string {
  return String(value ?? "").replace("#", "").trim();
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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

  const position = (clean.length - 1) * clamp(q, 0, 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return clean[lower];

  const fraction = position - lower;
  return clean[lower] * (1 - fraction) + clean[upper] * fraction;
}

export function pressureBacktestColdReferenceTemperature(
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

export function pressureDirectionForDelta(delta: number): PressureV6BacktestDirection {
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

function noteText(measurement: PressureV4Measurement): string {
  return String(measurement.notes ?? "");
}

function isCoolingStartNote(measurement: PressureV4Measurement): boolean {
  const note = noteText(measurement);
  if (!note.includes("קירור")) return false;
  if (/אחרי\s+קירור|לאחר\s+קירור/.test(note)) return false;
  return /(?:^|\||\s)קירור(?:$|\||\s|[-–—])/u.test(note);
}

function isBottomCarbonationNote(measurement: PressureV4Measurement): boolean {
  return noteText(measurement).includes("גיזוז מלמטה");
}

function pressureActionFromNote(
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
  const currentMs = measurementTimeMs(rows[index]);
  if (currentMs === null) return null;

  for (let cursor = index; cursor >= 0; cursor -= 1) {
    if (!isCoolingStartNote(rows[cursor])) continue;
    const coolingMs = measurementTimeMs(rows[cursor]);
    if (coolingMs === null) continue;
    return Math.max(0, (currentMs - coolingMs) / 3600000);
  }
  return null;
}

function actionPressureAtDecision(
  measurement: PressureV4Measurement,
  startPressure: number,
): number {
  const explicit = pressureActionFromNote(measurement);
  if (explicit !== null) return explicit;

  const afterYeast = yeastPressureAfterFromNote(measurement);
  if (afterYeast !== null) return afterYeast;

  return startPressure;
}

export function buildPressureDecisionOutcomes(args: {
  historicalBatches: PressureV6HistoricalBatch[];
  targetCarbonation: number;
  targetToleranceVol: number;
}): PressureDecisionOutcome[] {
  const successTolerance = Math.max(args.targetToleranceVol, 0.04);
  const outcomes: PressureDecisionOutcome[] = [];

  for (const batch of args.historicalBatches) {
    const batchId = normalizePressureBatchId(batch.batchId);
    if (!batchId) continue;

    const rows = batch.measurements
      .slice()
      .sort((a, b) =>
        (measurementTimeMs(a) ?? 0) -
        (measurementTimeMs(b) ?? 0)
      );

    for (let startIndex = 0; startIndex < rows.length; startIndex += 1) {
      const start = rows[startIndex];
      const startMs = measurementTimeMs(start);
      const startCarbonation = finite(start.carbonation);
      const startPressure = previousFiniteValue(rows, startIndex, "pressure");
      const startTemperature = previousFiniteValue(rows, startIndex, "temp");

      if (
        startMs === null ||
        startCarbonation === null ||
        startPressure === null ||
        startTemperature === null ||
        startTemperature > 9 ||
        isBottomCarbonationNote(start) ||
        Math.abs(startCarbonation - args.targetCarbonation) <= successTolerance
      ) continue;

      const startSide = Math.sign(
        args.targetCarbonation - startCarbonation,
      );
      const actionPressure = actionPressureAtDecision(
        start,
        startPressure,
      );

      let latestOutcomeCarbonation: number | null = null;
      let latestOutcomeHours = 0;
      let resolved = false;

      for (
        let endIndex = startIndex + 1;
        endIndex < rows.length;
        endIndex += 1
      ) {
        const row = rows[endIndex];
        const rowMs = measurementTimeMs(row);
        if (rowMs === null) continue;

        const elapsedHours = (rowMs - startMs) / 3600000;
        if (elapsedHours <= 0) continue;
        if (elapsedHours > 7 * 24) break;

        const rowCarbonation = finite(row.carbonation);
        if (rowCarbonation !== null) {
          latestOutcomeCarbonation = rowCarbonation;
          latestOutcomeHours = elapsedHours;

          const targetError =
            Math.abs(rowCarbonation - args.targetCarbonation);
          if (targetError <= successTolerance) {
            outcomes.push({
              batchId,
              decisionDateTimeMs: startMs,
              startCarbonation,
              startPressure,
              startTemperature,
              hoursSinceCooling:
                hoursSinceCoolingAt(rows, startIndex),
              actionPressure,
              actionDelta: actionPressure - startPressure,
              outcomeSuccess: true,
              outcomeCarbonation: rowCarbonation,
              hoursToOutcome: elapsedHours,
              outcomeReason: "target_reached",
            });
            resolved = true;
            break;
          }

          const rowSide = Math.sign(
            args.targetCarbonation - rowCarbonation,
          );
          if (
            startSide !== 0 &&
            rowSide !== 0 &&
            rowSide !== startSide
          ) {
            outcomes.push({
              batchId,
              decisionDateTimeMs: startMs,
              startCarbonation,
              startPressure,
              startTemperature,
              hoursSinceCooling:
                hoursSinceCoolingAt(rows, startIndex),
              actionPressure,
              actionDelta: actionPressure - startPressure,
              outcomeSuccess: false,
              outcomeCarbonation: rowCarbonation,
              hoursToOutcome: elapsedHours,
              outcomeReason: "overshoot",
            });
            resolved = true;
            break;
          }
        }

        if (isBottomCarbonationNote(row)) {
          outcomes.push({
            batchId,
            decisionDateTimeMs: startMs,
            startCarbonation,
            startPressure,
            startTemperature,
            hoursSinceCooling:
              hoursSinceCoolingAt(rows, startIndex),
            actionPressure,
            actionDelta: actionPressure - startPressure,
            outcomeSuccess: false,
            outcomeCarbonation: latestOutcomeCarbonation,
            hoursToOutcome:
              latestOutcomeHours || elapsedHours,
            outcomeReason: "bottom_carbonation",
          });
          resolved = true;
          break;
        }

        if (pressureActionFromNote(row) !== null) {
          outcomes.push({
            batchId,
            decisionDateTimeMs: startMs,
            startCarbonation,
            startPressure,
            startTemperature,
            hoursSinceCooling:
              hoursSinceCoolingAt(rows, startIndex),
            actionPressure,
            actionDelta: actionPressure - startPressure,
            outcomeSuccess: false,
            outcomeCarbonation: latestOutcomeCarbonation,
            hoursToOutcome:
              latestOutcomeHours || elapsedHours,
            outcomeReason: "pressure_correction",
          });
          resolved = true;
          break;
        }
      }

      // Unresolved/censored histories are deliberately excluded. Calling them
      // failures would punish slow but valid courses just because the archive
      // stopped measuring before the outcome became observable.
      void resolved;
    }
  }

  return outcomes;
}

function stripHeldOutDecisionNote(note: unknown): string | undefined {
  const parts = String(note ?? "")
    .split(/\s*\|\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) =>
      !/(?:העלאת|הורדת|שינוי)\s+לחץ\s+ל/i.test(part) &&
      !part.includes("גיזוז מלמטה") &&
      !/שמר(?:ים|י)/.test(part)
    );

  return parts.length ? parts.join(" | ") : undefined;
}

export function pressureMeasurementsAtDecision(
  batch: PressureV6HistoricalBatch,
  decision: PressureDecisionOutcome,
): PressureV4Measurement[] {
  return batch.measurements
    .filter((measurement) => {
      const time = measurementTimeMs(measurement);
      return time !== null && time <= decision.decisionDateTimeMs;
    })
    .map((measurement) => {
      const time = measurementTimeMs(measurement);
      if (time !== decision.decisionDateTimeMs) {
        return { ...measurement };
      }

      return {
        ...measurement,
        pressure: decision.startPressure,
        temp: decision.startTemperature,
        carbonation: decision.startCarbonation,
        notes: stripHeldOutDecisionNote(measurement.notes),
      };
    });
}

function outcomeDistance(args: {
  training: PressureDecisionOutcome;
  query: PressureDecisionOutcome;
  candidatePressure: number;
  targetCarbonation: number;
}): number {
  const trainingGap =
    args.targetCarbonation - args.training.startCarbonation;
  const queryGap =
    args.targetCarbonation - args.query.startCarbonation;

  const candidateDelta =
    args.candidatePressure - args.query.startPressure;

  const gapPart = (trainingGap - queryGap) / 0.16;
  const startPressurePart =
    (args.training.startPressure - args.query.startPressure) / 0.40;
  const temperaturePart =
    (args.training.startTemperature - args.query.startTemperature) / 2.5;
  const actionDeltaPart =
    (args.training.actionDelta - candidateDelta) / 0.14;
  const actionPressurePart =
    (args.training.actionPressure - args.candidatePressure) / 0.22;

  let coolingPart = 0;
  if (
    args.training.hoursSinceCooling !== null &&
    args.query.hoursSinceCooling !== null
  ) {
    coolingPart =
      (args.training.hoursSinceCooling - args.query.hoursSinceCooling) /
      72;
  }

  return Math.sqrt(
    gapPart ** 2 +
    startPressurePart ** 2 +
    temperaturePart ** 2 +
    actionDeltaPart ** 2 +
    actionPressurePart ** 2 +
    coolingPart ** 2
  );
}

export function estimatePressureCounterfactualOutcome(args: {
  training: PressureDecisionOutcome[];
  query: PressureDecisionOutcome;
  candidatePressure: number;
  targetCarbonation: number;
}): CounterfactualOutcomeEstimate | null {
  const bestPerBatch = new Map<
    string,
    { outcome: PressureDecisionOutcome; distance: number }
  >();

  for (const outcome of args.training) {
    const distance = outcomeDistance({
      training: outcome,
      query: args.query,
      candidatePressure: args.candidatePressure,
      targetCarbonation: args.targetCarbonation,
    });

    const existing = bestPerBatch.get(outcome.batchId);
    if (!existing || distance < existing.distance) {
      bestPerBatch.set(outcome.batchId, { outcome, distance });
    }
  }

  const neighbors = Array.from(bestPerBatch.values())
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 12);

  if (!neighbors.length) return null;

  let weightSum = 0;
  let successWeight = 0;
  let errorWeight = 0;
  let errorWeightSum = 0;
  let effectiveSupport = 0;

  for (const neighbor of neighbors) {
    const weight = Math.exp(-0.5 * neighbor.distance ** 2);
    if (weight < 0.015) continue;

    weightSum += weight;
    successWeight +=
      weight * (neighbor.outcome.outcomeSuccess ? 1 : 0);
    effectiveSupport += weight;

    if (neighbor.outcome.outcomeCarbonation !== null) {
      errorWeight +=
        weight *
        Math.abs(
          neighbor.outcome.outcomeCarbonation -
          args.targetCarbonation
        );
      errorWeightSum += weight;
    }
  }

  if (weightSum <= 0) return null;

  return {
    successProbability: successWeight / weightSum,
    expectedAbsCarbonationErrorVol:
      errorWeightSum > 0
        ? errorWeight / errorWeightSum
        : null,
    supportBatches: neighbors.filter(
      (neighbor) => neighbor.distance <= 3.0
    ).length,
    effectiveSupport,
    nearestDistance: neighbors[0].distance,
  };
}

export function isPressureCounterfactualSupported(
  estimate: CounterfactualOutcomeEstimate | null,
): estimate is CounterfactualOutcomeEstimate {
  return Boolean(
    estimate &&
    estimate.supportBatches >= 4 &&
    estimate.effectiveSupport >= 1.25 &&
    estimate.nearestDistance <= 2.5
  );
}

function perBatchBalancedMean(
  cases: PressureV6BacktestCase[],
  selector: (item: PressureV6BacktestCase) => number | null,
): number | null {
  const grouped = new Map<string, number[]>();
  for (const item of cases) {
    const value = selector(item);
    if (value === null || !Number.isFinite(value)) continue;
    const values = grouped.get(item.batchId) ?? [];
    values.push(value);
    grouped.set(item.batchId, values);
  }

  const batchMeans = Array.from(grouped.values())
    .map((values) => mean(values))
    .filter((value): value is number => value !== null);

  return mean(batchMeans);
}

function perBatchBalancedValues(
  cases: PressureV6BacktestCase[],
  selector: (item: PressureV6BacktestCase) => number | null,
): number[] {
  const grouped = new Map<string, number[]>();
  for (const item of cases) {
    const value = selector(item);
    if (value === null || !Number.isFinite(value)) continue;
    const values = grouped.get(item.batchId) ?? [];
    values.push(value);
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
  const allOutcomes = buildPressureDecisionOutcomes({
    historicalBatches: args.historicalBatches,
    targetCarbonation: args.targetCarbonation,
    targetToleranceVol: args.targetToleranceVol,
  });

  const testDecisions = allOutcomes
    .slice()
    .sort((a, b) =>
      b.decisionDateTimeMs - a.decisionDateTimeMs ||
      a.batchId.localeCompare(b.batchId)
    )
    .slice(0, Math.max(1, args.maxCases ?? 120));

  const batchMap = new Map(
    args.historicalBatches.map((batch) => [
      normalizePressureBatchId(batch.batchId),
      batch,
    ]),
  );

  const cases: PressureV6BacktestCase[] = [];
  let failedPredictionCount = 0;

  for (const decision of testDecisions) {
    const heldOutBatchId = normalizePressureBatchId(decision.batchId);
    const heldOutBatch = batchMap.get(heldOutBatchId);
    if (!heldOutBatch) {
      failedPredictionCount += 1;
      continue;
    }

    const trainingBatches = args.historicalBatches.filter(
      (batch) => normalizePressureBatchId(batch.batchId) !== heldOutBatchId,
    );
    const trainingOutcomes = allOutcomes.filter(
      (outcome) => outcome.batchId !== heldOutBatchId,
    );

    const samples = args.model.samples.filter(
      (sample) => normalizePressureBatchId(sample.batchId) !== heldOutBatchId,
    );
    const passiveSamples = args.model.passiveSamples.filter(
      (sample) => normalizePressureBatchId(sample.batchId) !== heldOutBatchId,
    );
    const transitions = args.model.transitions.filter(
      (sample) => normalizePressureBatchId(sample.batchId) !== heldOutBatchId,
    );
    const equilibriumPoints = args.model.equilibriumPoints.filter(
      (point) => normalizePressureBatchId(point.batchId) !== heldOutBatchId,
    );

    const decisionMeasurements = pressureMeasurementsAtDecision(
      heldOutBatch,
      decision,
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
        pressureBacktestColdReferenceTemperature(equilibriumPoints),
      currentBatchId: heldOutBatchId,
    });

    if (!estimate || estimate.targetPressure === null) {
      failedPredictionCount += 1;
      continue;
    }

    const predictedPressure = estimate.targetPressure;
    const modelOutcome = estimatePressureCounterfactualOutcome({
      training: trainingOutcomes,
      query: decision,
      candidatePressure: predictedPressure,
      targetCarbonation: args.targetCarbonation,
    });
    const humanOutcome = estimatePressureCounterfactualOutcome({
      training: trainingOutcomes,
      query: decision,
      candidatePressure: decision.actionPressure,
      targetCarbonation: args.targetCarbonation,
    });

    const modelSupported = isPressureCounterfactualSupported(modelOutcome);
    const humanSupported = isPressureCounterfactualSupported(humanOutcome);

    cases.push({
      batchId: heldOutBatchId,
      decisionDateTimeMs: decision.decisionDateTimeMs,
      startCarbonation: decision.startCarbonation,
      startPressure: decision.startPressure,
      startTemperature: decision.startTemperature,

      actualHumanPressure: decision.actionPressure,
      humanActualSuccess: decision.outcomeSuccess,

      predictedPressure,
      predictedDirection: pressureDirectionForDelta(
        predictedPressure - decision.startPressure,
      ),

      modelEstimatedSuccessProbability:
        modelSupported
          ? modelOutcome.successProbability
          : null,
      humanEstimatedSuccessProbability:
        humanSupported
          ? humanOutcome.successProbability
          : null,
      estimatedSuccessLiftVsHuman:
        modelSupported && humanSupported
          ? modelOutcome.successProbability -
            humanOutcome.successProbability
          : null,
      modelExpectedAbsCarbonationErrorVol:
        modelSupported
          ? modelOutcome.expectedAbsCarbonationErrorVol
          : null,

      counterfactualSupportBatches:
        modelOutcome?.supportBatches ?? 0,
      counterfactualEffectiveSupport:
        modelOutcome?.effectiveSupport ?? 0,
      counterfactualSupported: modelSupported,

      imitationPressureErrorBar:
        Math.abs(predictedPressure - decision.actionPressure),
      supportBatches: estimate.supportCount,
      confidence: estimate.confidence,
    });
  }

  const eligibleCaseCount = testDecisions.length;
  const predictedCaseCount = cases.length;
  const distinctBatchCount = new Set(
    cases.map((item) => item.batchId),
  ).size;

  const modelCoverage =
    eligibleCaseCount > 0
      ? predictedCaseCount / eligibleCaseCount
      : 0;
  const supportedCases = cases.filter(
    (item) => item.counterfactualSupported,
  );
  const counterfactualCoverage =
    predictedCaseCount > 0
      ? supportedCases.length / predictedCaseCount
      : 0;

  const estimatedFirstShotSuccessRate = perBatchBalancedMean(
    supportedCases,
    (item) => item.modelEstimatedSuccessProbability,
  );
  const estimatedHumanSuccessRate = perBatchBalancedMean(
    cases,
    (item) => item.humanEstimatedSuccessProbability,
  );
  const actualHumanFirstShotSuccessRate = perBatchBalancedMean(
    cases,
    (item) => item.humanActualSuccess ? 1 : 0,
  );
  const estimatedSuccessLiftVsHuman = perBatchBalancedMean(
    cases,
    (item) => item.estimatedSuccessLiftVsHuman,
  );
  const expectedAbsCarbonationErrorVol = perBatchBalancedMean(
    supportedCases,
    (item) => item.modelExpectedAbsCarbonationErrorVol,
  );
  const successProbabilities = perBatchBalancedValues(
    supportedCases,
    (item) => item.modelEstimatedSuccessProbability,
  );
  const successProbabilityP10 = quantile(
    successProbabilities,
    0.10,
  );
  const dangerousMissRate = perBatchBalancedMean(
    supportedCases,
    (item) =>
      item.modelEstimatedSuccessProbability !== null &&
      item.modelEstimatedSuccessProbability < 0.5
        ? 1
        : 0,
  );
  const imitationPressureMaeBar = perBatchBalancedMean(
    cases,
    (item) => item.imitationPressureErrorBar,
  );

  const labeledOutcomeBatchCount = new Set(
    allOutcomes.map((item) => item.batchId),
  ).size;
  const successfulOutcomeCount = allOutcomes.filter(
    (item) => item.outcomeSuccess,
  ).length;
  const failedOutcomeCount =
    allOutcomes.length - successfulOutcomeCount;

  let readiness: PressureV6BacktestResult["readiness"];
  if (
    labeledOutcomeBatchCount < 8 ||
    supportedCases.length < 12 ||
    distinctBatchCount < 8
  ) {
    readiness = "insufficient_data";
  } else if (
    estimatedFirstShotSuccessRate !== null &&
    successProbabilityP10 !== null &&
    dangerousMissRate !== null &&
    expectedAbsCarbonationErrorVol !== null &&
    estimatedFirstShotSuccessRate >= 0.85 &&
    successProbabilityP10 >= 0.60 &&
    dangerousMissRate <= 0.10 &&
    expectedAbsCarbonationErrorVol <= 0.06 &&
    counterfactualCoverage >= 0.75
  ) {
    readiness = "passes_gate";
  } else if (
    estimatedFirstShotSuccessRate !== null &&
    dangerousMissRate !== null &&
    estimatedFirstShotSuccessRate >= 0.75 &&
    dangerousMissRate <= 0.20 &&
    counterfactualCoverage >= 0.60
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

    modelCoverage,
    counterfactualCoverage,

    estimatedFirstShotSuccessRate:
      estimatedFirstShotSuccessRate === null
        ? null
        : Number(estimatedFirstShotSuccessRate.toFixed(3)),
    estimatedHumanSuccessRate:
      estimatedHumanSuccessRate === null
        ? null
        : Number(estimatedHumanSuccessRate.toFixed(3)),
    actualHumanFirstShotSuccessRate:
      actualHumanFirstShotSuccessRate === null
        ? null
        : Number(actualHumanFirstShotSuccessRate.toFixed(3)),
    estimatedSuccessLiftVsHuman:
      estimatedSuccessLiftVsHuman === null
        ? null
        : Number(estimatedSuccessLiftVsHuman.toFixed(3)),

    expectedAbsCarbonationErrorVol:
      expectedAbsCarbonationErrorVol === null
        ? null
        : Number(expectedAbsCarbonationErrorVol.toFixed(3)),
    successProbabilityP10:
      successProbabilityP10 === null
        ? null
        : Number(successProbabilityP10.toFixed(3)),
    dangerousMissRate:
      dangerousMissRate === null
        ? null
        : Number(dangerousMissRate.toFixed(3)),

    imitationPressureMaeBar:
      imitationPressureMaeBar === null
        ? null
        : Number(imitationPressureMaeBar.toFixed(3)),

    readiness,

    labeledOutcomeCount: allOutcomes.length,
    labeledOutcomeBatchCount,
    successfulOutcomeCount,
    failedOutcomeCount,

    cases,
  };
}
