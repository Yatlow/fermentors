import {
  estimateEquilibriumPressureV4,
} from "./pressureEquilibriumV4";
import {
  buildPressureV4DecisionState,
} from "./pressurePredictionV4";
import {
  estimatePressureCausalCandidate,
  estimatePressureTargetV8,
} from "./pressurePredictionV8";
import {
  buildPressureDecisionOutcomes,
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

  return {
    selectorBatches: available.filter(
      (batch) =>
        stableBatchFold(
          normalizePressureBatchId(batch.batchId),
        ) === heldOutFold,
    ),
    evaluatorBatches: available.filter(
      (batch) =>
        stableBatchFold(
          normalizePressureBatchId(batch.batchId),
        ) !== heldOutFold,
    ),
  };
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

  return mean(
    Array.from(grouped.values())
      .map((values) => mean(values))
      .filter((value): value is number => value !== null),
  );
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

export function runPressureV8LeaveOneBatchOutBacktest(args: {
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
    .sort(
      (a, b) =>
        b.decisionDateTimeMs - a.decisionDateTimeMs ||
        a.batchId.localeCompare(b.batchId),
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

    if (
      selectorBatches.length < 8 ||
      evaluatorBatches.length < 8
    ) {
      failedPredictionCount += 1;
      continue;
    }

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

    const selectorEstimate = estimatePressureTargetV8({
      state,
      historicalBatches: selectorBatches,
      targetCarbonation: args.targetCarbonation,
      targetToleranceVol: args.targetToleranceVol,
      currentBatchId: heldOutBatchId,
    });

    if (
      !selectorEstimate ||
      selectorEstimate.targetPressure === null ||
      selectorEstimate.action === "insufficient_data"
    ) {
      failedPredictionCount += 1;
      continue;
    }

    const predictedPressure =
      selectorEstimate.targetPressure;
    const observedMatch =
      Math.abs(
        predictedPressure - decision.actionPressure,
      ) <= 0.05;

    let modelScore: number | null = null;
    let evaluatorSupported = false;
    let evaluatorSupportBatches = 0;
    let evaluatorEffectivePairs = 0;
    let evaluatorEffect: number | null = null;
    let evaluatorEffectLower80: number | null = null;
    let evaluationMode:
      | "observed"
      | "counterfactual" = "counterfactual";

    if (observedMatch) {
      modelScore = decision.outcomeSuccess ? 1 : 0;
      evaluatorSupported = true;
      evaluationMode = "observed";
    } else {
      const evaluatorEstimate =
        estimatePressureTargetV8({
          state,
          historicalBatches: evaluatorBatches,
          targetCarbonation: args.targetCarbonation,
          targetToleranceVol: args.targetToleranceVol,
          currentBatchId: heldOutBatchId,
        });

      const predictedDelta =
        predictedPressure - decision.startPressure;

      if (
        Math.abs(predictedDelta) < 0.05
      ) {
        if (
          evaluatorEstimate?.holdSuccessProbability !==
          null &&
          evaluatorEstimate?.holdSuccessProbability !==
          undefined
        ) {
          modelScore =
            evaluatorEstimate.holdSuccessProbability;
          evaluatorSupported = true;
          evaluatorSupportBatches =
            evaluatorEstimate.holdSupportBatches;
        }
      } else {
        const evaluatorOutcomes =
          buildPressureDecisionOutcomes({
            historicalBatches: evaluatorBatches,
            targetCarbonation: args.targetCarbonation,
            targetToleranceVol: args.targetToleranceVol,
          });

        const evaluatorCandidate =
          estimatePressureCausalCandidate({
            outcomes: evaluatorOutcomes,
            query: decision,
            targetCarbonation: args.targetCarbonation,
            treatmentDeltaBar: predictedDelta,
          });

        if (evaluatorCandidate) {
          modelScore =
            evaluatorCandidate.estimatedSuccessProbability;
          evaluatorSupported = true;
          evaluatorSupportBatches = Math.min(
            evaluatorCandidate.treatmentSupportBatches,
            evaluatorCandidate.holdSupportBatches,
          );
          evaluatorEffectivePairs =
            evaluatorCandidate.effectivePairs;
          evaluatorEffect =
            evaluatorCandidate.causalEffectVsHold;
          evaluatorEffectLower80 =
            evaluatorCandidate.effectLower80;
        }
      }
    }

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
        selectorEstimate.action === "raise"
          ? "raise"
          : selectorEstimate.action === "lower"
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
      modelExpectedAbsCarbonationErrorVol: null,

      counterfactualSupportBatches:
        evaluatorSupportBatches,
      counterfactualEffectiveSupport:
        evaluatorEffectivePairs,
      counterfactualSupported: evaluatorSupported,
      evaluationMode,
      selectorTrainingBatches:
        selectorBatches.length,
      evaluatorTrainingBatches:
        evaluatorBatches.length,
      causalEffectVsHold:
        evaluatorEffect ??
        selectorEstimate.causalEffectVsHold,
      causalEffectLower80:
        evaluatorEffectLower80 ??
        selectorEstimate.effectLower80,
      causalMatchedPairs:
        evaluatorEffectivePairs > 0
          ? Math.round(evaluatorEffectivePairs)
          : selectorEstimate.matchedPairs,

      imitationPressureErrorBar:
        Math.abs(
          predictedPressure - decision.actionPressure,
        ),
      supportBatches:
        selectorEstimate.treatmentSupportBatches +
        selectorEstimate.holdSupportBatches,
      confidence: selectorEstimate.confidence,
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
  const successProbabilities =
    perBatchBalancedValues(
      supportedCases,
      (item) => item.modelEstimatedSuccessProbability,
    );
  const successProbabilityP10 = quantile(
    successProbabilities,
    0.10,
  );
  const dangerousMissRate =
    perBatchBalancedMean(
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
  const successfulOutcomeCount =
    allOutcomes.filter(
      (item) => item.outcomeSuccess,
    ).length;
  const failedOutcomeCount =
    allOutcomes.length - successfulOutcomeCount;

  let readiness: PressureV6BacktestResult["readiness"];
  if (
    labeledOutcomeBatchCount < 12 ||
    supportedCases.length < 12 ||
    distinctBatchCount < 10
  ) {
    readiness = "insufficient_data";
  } else if (
    estimatedFirstShotSuccessRate !== null &&
    successProbabilityP10 !== null &&
    dangerousMissRate !== null &&
    estimatedFirstShotSuccessRate >= 0.85 &&
    successProbabilityP10 >= 0.65 &&
    dangerousMissRate <= 0.10 &&
    counterfactualCoverage >= 0.65 &&
    modelCoverage >= 0.45
  ) {
    readiness = "passes_gate";
  } else if (
    estimatedFirstShotSuccessRate !== null &&
    dangerousMissRate !== null &&
    estimatedFirstShotSuccessRate >= 0.75 &&
    dangerousMissRate <= 0.20 &&
    counterfactualCoverage >= 0.55
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
      actualHumanFirstShotSuccessRate === null
        ? null
        : Number(
            actualHumanFirstShotSuccessRate.toFixed(3),
          ),
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

    expectedAbsCarbonationErrorVol: null,
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
