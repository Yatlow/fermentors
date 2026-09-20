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
  pressureBacktestColdReferenceTemperature,
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

    const trainingBatches = args.historicalBatches.filter(
      (batch) =>
        normalizePressureBatchId(batch.batchId) !==
        heldOutBatchId,
    );
    const trainingOutcomes = allOutcomes.filter(
      (outcome) => outcome.batchId !== heldOutBatchId,
    );

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
      historicalBatches: trainingBatches,
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

    const modelOutcome =
      estimatePressureCounterfactualOutcome({
        training: trainingOutcomes,
        query: decision,
        candidatePressure: predictedPressure,
        targetCarbonation: args.targetCarbonation,
      });
    const humanOutcome =
      estimatePressureCounterfactualOutcome({
        training: trainingOutcomes,
        query: decision,
        candidatePressure: decision.actionPressure,
        targetCarbonation: args.targetCarbonation,
      });

    const modelSupported =
      isPressureCounterfactualSupported(modelOutcome);
    const humanSupported =
      isPressureCounterfactualSupported(humanOutcome);

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
