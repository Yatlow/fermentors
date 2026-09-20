import {
  estimateEquilibriumPressureV4,
} from "./pressureEquilibriumV4";
import {
  buildPressureV4DecisionState,
} from "./pressurePredictionV4";
import {
  estimatePressureTargetV7,
} from "./pressurePredictionV7";
import {
  buildPressureDecisionOutcomes,
  estimatePressureCounterfactualOutcome,
  isPressureCounterfactualSupported,
  normalizePressureBatchId,
  pressureMeasurementsAtDecision,
  type PressureV6BacktestCase,
  type PressureV6BacktestModel,
  type PressureV6BacktestResult,
} from "./pressurePredictionV6Backtest";
import type {
  PressureV6HistoricalBatch,
} from "./pressurePredictionV6";

function mean(values: number[]): number | null {
  const clean = values.filter(Number.isFinite);
  if (!clean.length) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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

function stableBatchFold(batchId: string): 0 | 1 {
  let hash = 2166136261;
  for (const char of batchId) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (Math.abs(hash) % 2) as 0 | 1;
}

function splitCrossFitBatches(args: {
  batches: PressureV6HistoricalBatch[];
  heldOutBatchId: string;
}): {
  selectorBatches: PressureV6HistoricalBatch[];
  evaluatorBatches: PressureV6HistoricalBatch[];
} {
  const heldOutFold = stableBatchFold(args.heldOutBatchId);

  const available = args.batches.filter(
    (batch) =>
      normalizePressureBatchId(batch.batchId) !==
      args.heldOutBatchId,
  );

  // Alternate which half selects versus evaluates according to the held-out
  // batch. Across the full backtest, both folds serve both roles, but never
  // for the same held-out decision.
  const selectorBatches = available.filter(
    (batch) =>
      stableBatchFold(
        normalizePressureBatchId(batch.batchId),
      ) === heldOutFold,
  );
  const evaluatorBatches = available.filter(
    (batch) =>
      stableBatchFold(
        normalizePressureBatchId(batch.batchId),
      ) !== heldOutFold,
  );

  return { selectorBatches, evaluatorBatches };
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

export function runPressureV7LeaveOneBatchOutBacktest(args: {
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
    const heldOutBatchId = normalizePressureBatchId(
      decision.batchId,
    );
    const heldOutBatch = batchMap.get(heldOutBatchId);
    if (!heldOutBatch) {
      failedPredictionCount += 1;
      continue;
    }

    const {
      selectorBatches,
      evaluatorBatches,
    } = splitCrossFitBatches({
      batches: args.historicalBatches,
      heldOutBatchId,
    });

    // The selector and evaluator must never learn from the same batches for
    // this decision. Otherwise V7 would choose a pressure with one outcome
    // surface and then let that same surface grade its own maximum.
    if (
      selectorBatches.length < 4 ||
      evaluatorBatches.length < 4
    ) {
      failedPredictionCount += 1;
      continue;
    }

    const evaluatorOutcomes = buildPressureDecisionOutcomes({
      historicalBatches: evaluatorBatches,
      targetCarbonation: args.targetCarbonation,
      targetToleranceVol: args.targetToleranceVol,
    });

    const equilibriumPoints =
      args.model.equilibriumPoints.filter(
        (point) =>
          normalizePressureBatchId(point.batchId) !==
          heldOutBatchId,
      );

    const decisionMeasurements =
      pressureMeasurementsAtDecision(
        heldOutBatch,
        decision,
      );
    if (!decisionMeasurements.length) {
      failedPredictionCount += 1;
      continue;
    }

    const equilibriumPressure = (
      temperature: number | null,
    ) =>
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

    const estimate = estimatePressureTargetV7({
      state,
      historicalBatches: selectorBatches,
      targetCarbonation: args.targetCarbonation,
      targetToleranceVol: args.targetToleranceVol,
      currentBatchId: heldOutBatchId,
    });

    if (
      !estimate ||
      estimate.targetPressure === null ||
      estimate.action === "insufficient_data"
    ) {
      failedPredictionCount += 1;
      continue;
    }

    const predictedPressure = estimate.targetPressure;
    const observedMatch =
      Math.abs(
        predictedPressure - decision.actionPressure,
      ) <= 0.05;

    // When V7 independently lands on essentially the same pressure that was
    // actually used, we do not need a counterfactual model at all: the held-out
    // batch gives us the real outcome.
    const evaluatorOutcome = observedMatch
      ? null
      : estimatePressureCounterfactualOutcome({
          training: evaluatorOutcomes,
          query: decision,
          candidatePressure: predictedPressure,
          targetCarbonation: args.targetCarbonation,
        });

    const evaluatorSupported =
      observedMatch ||
      isPressureCounterfactualSupported(
        evaluatorOutcome,
      );

    const modelScore = observedMatch
      ? (decision.outcomeSuccess ? 1 : 0)
      : isPressureCounterfactualSupported(
          evaluatorOutcome,
        )
        ? evaluatorOutcome.successProbability
        : null;

    const modelError = observedMatch
      ? (
          decision.outcomeCarbonation === null
            ? null
            : Math.abs(
                decision.outcomeCarbonation -
                args.targetCarbonation,
              )
        )
      : isPressureCounterfactualSupported(
          evaluatorOutcome,
        )
        ? evaluatorOutcome.expectedAbsCarbonationErrorVol
        : null;

    cases.push({
      batchId: heldOutBatchId,
      decisionDateTimeMs: decision.decisionDateTimeMs,
      startCarbonation: decision.startCarbonation,
      startPressure: decision.startPressure,
      startTemperature: decision.startTemperature,

      actualHumanPressure: decision.actionPressure,
      humanActualSuccess: decision.outcomeSuccess,

      predictedPressure,
      predictedDirection:
        estimate.action === "raise"
          ? "raise"
          : estimate.action === "lower"
            ? "lower"
            : "hold",

      modelEstimatedSuccessProbability: modelScore,
      humanEstimatedSuccessProbability:
        decision.outcomeSuccess ? 1 : 0,
      estimatedSuccessLiftVsHuman:
        modelScore === null
          ? null
          : modelScore -
            (decision.outcomeSuccess ? 1 : 0),
      modelExpectedAbsCarbonationErrorVol:
        modelError,

      counterfactualSupportBatches:
        observedMatch
          ? 0
          : evaluatorOutcome?.supportBatches ?? 0,
      counterfactualEffectiveSupport:
        observedMatch
          ? 0
          : evaluatorOutcome?.effectiveSupport ?? 0,
      counterfactualSupported: evaluatorSupported,
      evaluationMode:
        observedMatch
          ? "observed"
          : "counterfactual",
      selectorTrainingBatches:
        selectorBatches.length,
      evaluatorTrainingBatches:
        evaluatorBatches.length,

      imitationPressureErrorBar:
        Math.abs(
          predictedPressure - decision.actionPressure
        ),
      supportBatches: estimate.supportBatches,
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
  const observedEvaluationRate =
    predictedCaseCount > 0
      ? cases.filter(
          (item) => item.evaluationMode === "observed",
        ).length / predictedCaseCount
      : 0;
  const counterfactualEvaluationRate =
    predictedCaseCount > 0
      ? cases.filter(
          (item) =>
            item.evaluationMode === "counterfactual" &&
            item.counterfactualSupported,
        ).length / predictedCaseCount
      : 0;

  const estimatedFirstShotSuccessRate =
    perBatchBalancedMean(
      supportedCases,
      (item) => item.modelEstimatedSuccessProbability,
    );
  const estimatedHumanSuccessRate =
    perBatchBalancedMean(
      cases,
      (item) => item.humanEstimatedSuccessProbability,
    );
  const actualHumanFirstShotSuccessRate =
    perBatchBalancedMean(
      cases,
      (item) => item.humanActualSuccess ? 1 : 0,
    );
  const estimatedSuccessLiftVsHuman =
    perBatchBalancedMean(
      cases,
      (item) => item.estimatedSuccessLiftVsHuman,
    );
  const expectedAbsCarbonationErrorVol =
    perBatchBalancedMean(
      supportedCases,
      (item) => item.modelExpectedAbsCarbonationErrorVol,
    );
  const successProbabilities =
    perBatchBalancedValues(
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
  const imitationPressureMaeBar =
    perBatchBalancedMean(
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
    observedEvaluationRate:
      Number(observedEvaluationRate.toFixed(3)),
    counterfactualEvaluationRate:
      Number(counterfactualEvaluationRate.toFixed(3)),

    estimatedFirstShotSuccessRate:
      estimatedFirstShotSuccessRate === null
        ? null
        : Number(
            estimatedFirstShotSuccessRate.toFixed(3),
          ),
    estimatedHumanSuccessRate:
      estimatedHumanSuccessRate === null
        ? null
        : Number(estimatedHumanSuccessRate.toFixed(3)),
    actualHumanFirstShotSuccessRate:
      actualHumanFirstShotSuccessRate === null
        ? null
        : Number(
            actualHumanFirstShotSuccessRate.toFixed(3),
          ),
    estimatedSuccessLiftVsHuman:
      estimatedSuccessLiftVsHuman === null
        ? null
        : Number(
            estimatedSuccessLiftVsHuman.toFixed(3),
          ),

    expectedAbsCarbonationErrorVol:
      expectedAbsCarbonationErrorVol === null
        ? null
        : Number(
            expectedAbsCarbonationErrorVol.toFixed(3),
          ),
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
