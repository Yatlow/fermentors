import type {
  PressureV4DecisionState,
} from "./pressurePredictionV4";
import type {
  PressureV6HistoricalBatch,
} from "./pressurePredictionV6";
import {
  buildPressureDecisionOutcomes,
  type PressureDecisionOutcome,
} from "./pressurePredictionV6Backtest";

const MAX_OPERATIONAL_PRESSURE_BAR = 1.9;
const TREATMENT_STEP_BAR = 0.10;
const HOLD_BIN_BAR = 0;
const MIN_ARM_BATCHES = 4;
const MIN_MATCHED_PAIRS = 4;
const MAX_QUERY_DISTANCE = 2.75;
const MAX_PAIR_DISTANCE = 1.35;
const MIN_SUCCESS_TO_RECOMMEND = 0.55;
const MIN_CAUSAL_LIFT_TO_CHANGE = 0.08;
const Z80_ONE_SIDED = 1.2816;

export type PressureV8Confidence = "low" | "medium" | "high";

export type PressureV8CausalCandidate = {
  treatmentDeltaBar: number;
  pressure: number;
  estimatedSuccessProbability: number;
  causalEffectVsHold: number;
  effectLower80: number;
  effectStdError: number;
  matchedPairs: number;
  effectivePairs: number;
  treatmentSupportBatches: number;
  holdSupportBatches: number;
  nearestStateDistance: number;
};

export type PressureV8Estimate = {
  version: 8;
  currentCarbonation: number;
  currentPressure: number;
  currentTemperature: number;
  hoursSinceCooling: number | null;
  carbonationRatePerDay: number | null;
  temperatureRatePerDay: number | null;
  targetCarbonation: number;
  targetToleranceVol: number;

  targetPressure: number | null;
  action: "hold" | "raise" | "lower" | "insufficient_data";

  holdSuccessProbability: number | null;
  estimatedSuccessProbability: number | null;
  causalEffectVsHold: number | null;
  effectLower80: number | null;
  effectStdError: number | null;

  matchedPairs: number;
  effectivePairs: number;
  treatmentSupportBatches: number;
  holdSupportBatches: number;
  confidence: PressureV8Confidence;

  abstentionReason:
    | "no_hold_overlap"
    | "no_treatment_overlap"
    | "weak_causal_effect"
    | "weak_success_probability"
    | null;

  labeledOutcomeCount: number;
  labeledOutcomeBatchCount: number;
  evaluatedTreatmentCount: number;
  candidates: PressureV8CausalCandidate[];
};

type QueryState = {
  batchId: string;
  startCarbonation: number;
  startPressure: number;
  startTemperature: number;
  hoursSinceCooling: number | null;
  carbonationRatePerDay: number | null;
  temperatureRatePerDay: number | null;
  pressureRatePerDay: number | null;
};

type LocalOutcome = {
  outcome: PressureDecisionOutcome;
  queryDistance: number;
};

type HoldEstimate = {
  successProbability: number;
  supportBatches: number;
  effectiveSupport: number;
  nearestDistance: number;
};

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function treatmentBin(delta: number): number {
  if (Math.abs(delta) < 0.05) return HOLD_BIN_BAR;
  return Number(
    (Math.round(delta / TREATMENT_STEP_BAR) *
      TREATMENT_STEP_BAR).toFixed(2),
  );
}

function queryFromState(args: {
  state: PressureV4DecisionState;
  currentBatchId?: string;
}): QueryState | null {
  const carbonation = finite(args.state.carbonation);
  const pressure = finite(args.state.currentPressure);
  const temperature = finite(args.state.currentTemp);

  if (
    carbonation === null ||
    pressure === null ||
    temperature === null
  ) {
    return null;
  }

  return {
    batchId: String(args.currentBatchId ?? "current"),
    startCarbonation: carbonation,
    startPressure: pressure,
    startTemperature: temperature,
    hoursSinceCooling:
      finite(args.state.cooling?.hoursSinceCooling),
    carbonationRatePerDay:
      finite(args.state.carbonationTrend?.ratePerDay),
    temperatureRatePerDay:
      finite(args.state.cooling?.tempChange24h),
    pressureRatePerDay: null,
  };
}

function normalizedPart(
  a: number | null,
  b: number | null,
  scale: number,
): number | null {
  if (a === null || b === null) return null;
  return (a - b) / scale;
}

function stateDistance(
  a: QueryState | PressureDecisionOutcome,
  b: QueryState | PressureDecisionOutcome,
  targetCarbonation: number,
): number {
  const parts: number[] = [];

  parts.push(
    (
      (targetCarbonation - a.startCarbonation) -
      (targetCarbonation - b.startCarbonation)
    ) / 0.16,
  );
  parts.push(
    (a.startPressure - b.startPressure) / 0.35,
  );
  parts.push(
    (a.startTemperature - b.startTemperature) / 2.0,
  );

  const optionalParts = [
    normalizedPart(
      a.hoursSinceCooling,
      b.hoursSinceCooling,
      48,
    ),
    normalizedPart(
      a.carbonationRatePerDay,
      b.carbonationRatePerDay,
      0.08,
    ),
    normalizedPart(
      a.temperatureRatePerDay,
      b.temperatureRatePerDay,
      5,
    ),
    normalizedPart(
      a.pressureRatePerDay,
      b.pressureRatePerDay,
      0.30,
    ),
  ].filter((value): value is number => value !== null);

  parts.push(...optionalParts);

  const divisor = Math.max(3, parts.length);
  return Math.sqrt(
    parts.reduce((sum, value) => sum + value ** 2, 0) *
      (4 / divisor),
  );
}

function bestPerBatchForTreatment(args: {
  outcomes: PressureDecisionOutcome[];
  query: QueryState;
  targetCarbonation: number;
  treatmentDeltaBar: number;
}): LocalOutcome[] {
  const wantedBin = treatmentBin(args.treatmentDeltaBar);
  const best = new Map<string, LocalOutcome>();

  for (const outcome of args.outcomes) {
    if (treatmentBin(outcome.actionDelta) !== wantedBin) {
      continue;
    }

    const distance = stateDistance(
      args.query,
      outcome,
      args.targetCarbonation,
    );
    if (distance > MAX_QUERY_DISTANCE) continue;

    const current = best.get(outcome.batchId);
    if (!current || distance < current.queryDistance) {
      best.set(outcome.batchId, {
        outcome,
        queryDistance: distance,
      });
    }
  }

  return Array.from(best.values()).sort(
    (a, b) => a.queryDistance - b.queryDistance,
  );
}

function estimateHold(args: {
  outcomes: PressureDecisionOutcome[];
  query: QueryState;
  targetCarbonation: number;
}): HoldEstimate | null {
  const rows = bestPerBatchForTreatment({
    outcomes: args.outcomes,
    query: args.query,
    targetCarbonation: args.targetCarbonation,
    treatmentDeltaBar: HOLD_BIN_BAR,
  }).slice(0, 16);

  if (rows.length < MIN_ARM_BATCHES) return null;

  let weightSum = 0;
  let successWeight = 0;
  let squaredWeightSum = 0;

  for (const row of rows) {
    const weight = Math.exp(
      -0.5 * row.queryDistance ** 2,
    );
    if (weight < 0.01) continue;

    weightSum += weight;
    squaredWeightSum += weight ** 2;
    successWeight +=
      weight * (row.outcome.outcomeSuccess ? 1 : 0);
  }

  if (weightSum <= 0) return null;

  return {
    successProbability: successWeight / weightSum,
    supportBatches: rows.length,
    effectiveSupport:
      squaredWeightSum > 0
        ? (weightSum ** 2) / squaredWeightSum
        : 0,
    nearestDistance: rows[0].queryDistance,
  };
}

function weightedEffectStats(
  effects: { value: number; weight: number }[],
): {
  mean: number;
  standardError: number;
  effectiveN: number;
} | null {
  const clean = effects.filter(
    (item) =>
      Number.isFinite(item.value) &&
      Number.isFinite(item.weight) &&
      item.weight > 0,
  );
  if (!clean.length) return null;

  const weightSum = clean.reduce(
    (sum, item) => sum + item.weight,
    0,
  );
  const weightSquaredSum = clean.reduce(
    (sum, item) => sum + item.weight ** 2,
    0,
  );
  if (weightSum <= 0 || weightSquaredSum <= 0) {
    return null;
  }

  const meanValue =
    clean.reduce(
      (sum, item) => sum + item.value * item.weight,
      0,
    ) / weightSum;

  const effectiveN =
    (weightSum ** 2) / weightSquaredSum;

  const weightedVariance =
    clean.reduce(
      (sum, item) =>
        sum +
        item.weight * (item.value - meanValue) ** 2,
      0,
    ) / weightSum;

  const standardError = Math.sqrt(
    weightedVariance / Math.max(1, effectiveN),
  );

  return {
    mean: meanValue,
    standardError,
    effectiveN,
  };
}

export function estimatePressureCausalCandidate(args: {
  outcomes: PressureDecisionOutcome[];
  query: QueryState;
  targetCarbonation: number;
  treatmentDeltaBar: number;
  holdEstimate?: HoldEstimate | null;
}): PressureV8CausalCandidate | null {
  const treatment = treatmentBin(args.treatmentDeltaBar);
  if (treatment === HOLD_BIN_BAR) return null;

  const holdEstimate =
    args.holdEstimate ??
    estimateHold({
      outcomes: args.outcomes,
      query: args.query,
      targetCarbonation: args.targetCarbonation,
    });
  if (!holdEstimate) return null;

  const treated = bestPerBatchForTreatment({
    outcomes: args.outcomes,
    query: args.query,
    targetCarbonation: args.targetCarbonation,
    treatmentDeltaBar: treatment,
  });
  const controls = bestPerBatchForTreatment({
    outcomes: args.outcomes,
    query: args.query,
    targetCarbonation: args.targetCarbonation,
    treatmentDeltaBar: HOLD_BIN_BAR,
  });

  if (
    treated.length < MIN_ARM_BATCHES ||
    controls.length < MIN_ARM_BATCHES
  ) {
    return null;
  }

  const candidatePairs: {
    treatedIndex: number;
    controlIndex: number;
    pairDistance: number;
    weight: number;
  }[] = [];

  for (
    let treatedIndex = 0;
    treatedIndex < treated.length;
    treatedIndex += 1
  ) {
    for (
      let controlIndex = 0;
      controlIndex < controls.length;
      controlIndex += 1
    ) {
      const treatedRow = treated[treatedIndex];
      const controlRow = controls[controlIndex];

      if (
        treatedRow.outcome.batchId ===
        controlRow.outcome.batchId
      ) {
        continue;
      }

      const pairDistance = stateDistance(
        treatedRow.outcome,
        controlRow.outcome,
        args.targetCarbonation,
      );
      if (pairDistance > MAX_PAIR_DISTANCE) continue;

      const weight = Math.exp(
        -0.5 *
          (
            treatedRow.queryDistance ** 2 +
            controlRow.queryDistance ** 2 +
            pairDistance ** 2
          ),
      );

      candidatePairs.push({
        treatedIndex,
        controlIndex,
        pairDistance,
        weight,
      });
    }
  }

  candidatePairs.sort(
    (a, b) => a.pairDistance - b.pairDistance,
  );

  const usedTreated = new Set<number>();
  const usedControl = new Set<number>();
  const matched: {
    effect: number;
    weight: number;
  }[] = [];

  for (const pair of candidatePairs) {
    if (
      usedTreated.has(pair.treatedIndex) ||
      usedControl.has(pair.controlIndex)
    ) {
      continue;
    }

    usedTreated.add(pair.treatedIndex);
    usedControl.add(pair.controlIndex);

    const treatedSuccess =
      treated[pair.treatedIndex].outcome.outcomeSuccess
        ? 1
        : 0;
    const controlSuccess =
      controls[pair.controlIndex].outcome.outcomeSuccess
        ? 1
        : 0;

    matched.push({
      effect: treatedSuccess - controlSuccess,
      weight: pair.weight,
    });

    if (matched.length >= 16) break;
  }

  if (matched.length < MIN_MATCHED_PAIRS) return null;

  const stats = weightedEffectStats(
    matched.map((item) => ({
      value: item.effect,
      weight: item.weight,
    })),
  );
  if (!stats || stats.effectiveN < 2.5) return null;

  const effectLower80 =
    stats.mean -
    Z80_ONE_SIDED * stats.standardError;

  return {
    treatmentDeltaBar: treatment,
    pressure: Number(
      clamp(
        args.query.startPressure + treatment,
        0,
        MAX_OPERATIONAL_PRESSURE_BAR,
      ).toFixed(2),
    ),
    estimatedSuccessProbability: clamp(
      holdEstimate.successProbability + stats.mean,
      0,
      1,
    ),
    causalEffectVsHold: stats.mean,
    effectLower80,
    effectStdError: stats.standardError,
    matchedPairs: matched.length,
    effectivePairs: stats.effectiveN,
    treatmentSupportBatches: treated.length,
    holdSupportBatches: controls.length,
    nearestStateDistance: Math.min(
      treated[0]?.queryDistance ?? Infinity,
      controls[0]?.queryDistance ?? Infinity,
    ),
  };
}

function confidenceFor(
  candidate: PressureV8CausalCandidate,
): PressureV8Confidence {
  if (
    candidate.matchedPairs >= 8 &&
    candidate.effectivePairs >= 5 &&
    candidate.effectLower80 >= 0.04 &&
    candidate.treatmentSupportBatches >= 8 &&
    candidate.holdSupportBatches >= 8
  ) {
    return "high";
  }

  if (
    candidate.matchedPairs >= 5 &&
    candidate.effectivePairs >= 3 &&
    candidate.effectLower80 > 0 &&
    candidate.treatmentSupportBatches >= 5 &&
    candidate.holdSupportBatches >= 5
  ) {
    return "medium";
  }

  return "low";
}

export function estimatePressureTargetV8(args: {
  state: PressureV4DecisionState;
  historicalBatches: PressureV6HistoricalBatch[];
  targetCarbonation: number;
  targetToleranceVol: number;
  currentBatchId?: string;
}): PressureV8Estimate | null {
  const query = queryFromState({
    state: args.state,
    currentBatchId: args.currentBatchId,
  });
  if (!query) return null;

  const currentBatchId = String(
    args.currentBatchId ?? "",
  ).replace("#", "").trim();

  const trainingBatches = args.historicalBatches.filter(
    (batch) =>
      String(batch.batchId ?? "")
        .replace("#", "")
        .trim() !== currentBatchId,
  );

  const outcomes = buildPressureDecisionOutcomes({
    historicalBatches: trainingBatches,
    targetCarbonation: args.targetCarbonation,
    targetToleranceVol: args.targetToleranceVol,
  });

  const labeledOutcomeBatchCount = new Set(
    outcomes.map((outcome) => outcome.batchId),
  ).size;

  const holdEstimate = estimateHold({
    outcomes,
    query,
    targetCarbonation: args.targetCarbonation,
  });

  const common = {
    version: 8 as const,
    currentCarbonation: query.startCarbonation,
    currentPressure: query.startPressure,
    currentTemperature: query.startTemperature,
    hoursSinceCooling: query.hoursSinceCooling,
    carbonationRatePerDay: query.carbonationRatePerDay,
    temperatureRatePerDay: query.temperatureRatePerDay,
    targetCarbonation: args.targetCarbonation,
    targetToleranceVol: args.targetToleranceVol,
    labeledOutcomeCount: outcomes.length,
    labeledOutcomeBatchCount,
  };

  if (!holdEstimate) {
    return {
      ...common,
      targetPressure: null,
      action: "insufficient_data",
      holdSuccessProbability: null,
      estimatedSuccessProbability: null,
      causalEffectVsHold: null,
      effectLower80: null,
      effectStdError: null,
      matchedPairs: 0,
      effectivePairs: 0,
      treatmentSupportBatches: 0,
      holdSupportBatches: 0,
      confidence: "low",
      abstentionReason: "no_hold_overlap",
      evaluatedTreatmentCount: 0,
      candidates: [],
    };
  }

  const observedTreatmentBins = Array.from(
    new Set(
      outcomes
        .map((outcome) => treatmentBin(outcome.actionDelta))
        .filter((delta) => delta !== HOLD_BIN_BAR),
    ),
  ).filter((delta) => {
    const pressure = query.startPressure + delta;
    return (
      pressure >= 0 &&
      pressure <= MAX_OPERATIONAL_PRESSURE_BAR
    );
  });

  const candidates = observedTreatmentBins
    .map((delta) =>
      estimatePressureCausalCandidate({
        outcomes,
        query,
        targetCarbonation: args.targetCarbonation,
        treatmentDeltaBar: delta,
        holdEstimate,
      })
    )
    .filter(
      (
        candidate,
      ): candidate is PressureV8CausalCandidate =>
        candidate !== null,
    )
    .sort((a, b) => {
      if (
        Math.abs(
          b.estimatedSuccessProbability -
          a.estimatedSuccessProbability,
        ) > 0.01
      ) {
        return (
          b.estimatedSuccessProbability -
          a.estimatedSuccessProbability
        );
      }

      if (
        Math.abs(b.effectLower80 - a.effectLower80) >
        0.01
      ) {
        return b.effectLower80 - a.effectLower80;
      }

      return (
        Math.abs(a.treatmentDeltaBar) -
        Math.abs(b.treatmentDeltaBar)
      );
    });

  const supportedImprovement = candidates.find(
    (candidate) =>
      candidate.estimatedSuccessProbability >=
        MIN_SUCCESS_TO_RECOMMEND &&
      candidate.causalEffectVsHold >=
        MIN_CAUSAL_LIFT_TO_CHANGE &&
      candidate.effectLower80 > 0,
  );

  if (!supportedImprovement) {
    if (
      holdEstimate.successProbability >=
      MIN_SUCCESS_TO_RECOMMEND
    ) {
      return {
        ...common,
        targetPressure: query.startPressure,
        action: "hold",
        holdSuccessProbability:
          holdEstimate.successProbability,
        estimatedSuccessProbability:
          holdEstimate.successProbability,
        causalEffectVsHold: 0,
        effectLower80: 0,
        effectStdError: 0,
        matchedPairs: 0,
        effectivePairs: 0,
        treatmentSupportBatches: 0,
        holdSupportBatches:
          holdEstimate.supportBatches,
        confidence:
          holdEstimate.supportBatches >= 8 &&
          holdEstimate.effectiveSupport >= 4
            ? "medium"
            : "low",
        abstentionReason: null,
        evaluatedTreatmentCount: candidates.length,
        candidates: candidates.slice(0, 6),
      };
    }

    return {
      ...common,
      targetPressure: null,
      action: "insufficient_data",
      holdSuccessProbability:
        holdEstimate.successProbability,
      estimatedSuccessProbability:
        candidates[0]?.estimatedSuccessProbability ??
        holdEstimate.successProbability,
      causalEffectVsHold:
        candidates[0]?.causalEffectVsHold ?? null,
      effectLower80:
        candidates[0]?.effectLower80 ?? null,
      effectStdError:
        candidates[0]?.effectStdError ?? null,
      matchedPairs:
        candidates[0]?.matchedPairs ?? 0,
      effectivePairs:
        candidates[0]?.effectivePairs ?? 0,
      treatmentSupportBatches:
        candidates[0]?.treatmentSupportBatches ?? 0,
      holdSupportBatches:
        holdEstimate.supportBatches,
      confidence: "low",
      abstentionReason:
        candidates.length
          ? "weak_causal_effect"
          : "no_treatment_overlap",
      evaluatedTreatmentCount: candidates.length,
      candidates: candidates.slice(0, 6),
    };
  }

  const pressureDelta =
    supportedImprovement.pressure -
    query.startPressure;

  return {
    ...common,
    targetPressure: supportedImprovement.pressure,
    action:
      pressureDelta > 0
        ? "raise"
        : pressureDelta < 0
          ? "lower"
          : "hold",
    holdSuccessProbability:
      holdEstimate.successProbability,
    estimatedSuccessProbability:
      supportedImprovement.estimatedSuccessProbability,
    causalEffectVsHold:
      supportedImprovement.causalEffectVsHold,
    effectLower80:
      supportedImprovement.effectLower80,
    effectStdError:
      supportedImprovement.effectStdError,
    matchedPairs:
      supportedImprovement.matchedPairs,
    effectivePairs:
      supportedImprovement.effectivePairs,
    treatmentSupportBatches:
      supportedImprovement.treatmentSupportBatches,
    holdSupportBatches:
      supportedImprovement.holdSupportBatches,
    confidence: confidenceFor(supportedImprovement),
    abstentionReason: null,
    evaluatedTreatmentCount: candidates.length,
    candidates: candidates.slice(0, 6),
  };
}
