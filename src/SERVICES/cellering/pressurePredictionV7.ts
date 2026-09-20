import type {
  PressureV4DecisionState,
} from "./pressurePredictionV4";
import type {
  PressureV6HistoricalBatch,
} from "./pressurePredictionV6";
import {
  buildPressureDecisionOutcomes,
  estimatePressureCounterfactualOutcome,
  isPressureCounterfactualSupported,
  type CounterfactualOutcomeEstimate,
  type PressureDecisionOutcome,
} from "./pressurePredictionV6Backtest";

const MAX_OPERATIONAL_PRESSURE_BAR = 1.9;
const CANDIDATE_STEP_BAR = 0.05;
const MIN_RECOMMENDATION_SUCCESS_PROBABILITY = 0.55;
const MIN_SUCCESS_LIFT_TO_CHANGE_PRESSURE = 0.07;
const MAX_NEAR_OPTIMAL_RANGE_WIDTH_BAR = 0.30;

export type PressureV7Confidence = "low" | "medium" | "high";

export type PressureV7Candidate = {
  pressure: number;
  successProbability: number;
  expectedAbsCarbonationErrorVol: number | null;
  supportBatches: number;
  effectiveSupport: number;
  nearestDistance: number;
};

export type PressureV7Estimate = {
  version: 7;
  currentCarbonation: number;
  currentPressure: number;
  currentTemperature: number;
  hoursSinceCooling: number | null;
  targetCarbonation: number;
  targetToleranceVol: number;

  targetPressure: number | null;
  targetPressureRangeLow: number | null;
  targetPressureRangeHigh: number | null;
  action: "hold" | "raise" | "lower" | "insufficient_data";

  estimatedSuccessProbability: number | null;
  expectedAbsCarbonationErrorVol: number | null;
  supportBatches: number;
  effectiveSupport: number;
  nearestDistance: number | null;
  confidence: PressureV7Confidence;

  currentPressureSuccessProbability: number | null;
  currentPressureSupported: boolean;
  bestSuccessProbability: number | null;
  successLiftVsHold: number | null;
  nearOptimalRangeWidthBar: number | null;
  abstentionReason:
    | "no_supported_candidates"
    | "weak_best_candidate"
    | "flat_response_surface"
    | null;
  candidateCount: number;
  labeledOutcomeCount: number;
  labeledOutcomeBatchCount: number;

  bestCandidates: PressureV7Candidate[];
};

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function confidenceFor(
  candidate: PressureV7Candidate,
): PressureV7Confidence {
  if (
    candidate.successProbability >= 0.85 &&
    candidate.supportBatches >= 8 &&
    candidate.effectiveSupport >= 3 &&
    candidate.nearestDistance <= 1.5
  ) {
    return "high";
  }

  if (
    candidate.successProbability >= 0.70 &&
    candidate.supportBatches >= 5 &&
    candidate.effectiveSupport >= 2 &&
    candidate.nearestDistance <= 2
  ) {
    return "medium";
  }

  return "low";
}

function queryFromState(args: {
  state: PressureV4DecisionState;
  currentBatchId?: string;
}): PressureDecisionOutcome | null {
  const carbonation = finite(args.state.carbonation);
  const pressure = finite(args.state.currentPressure);
  const temperature = finite(args.state.currentTemp);

  if (
    carbonation === null ||
    pressure === null ||
    temperature === null
  ) return null;

  return {
    batchId: String(args.currentBatchId ?? "current"),
    decisionDateTimeMs: Date.now(),
    startCarbonation: carbonation,
    startPressure: pressure,
    startTemperature: temperature,
    hoursSinceCooling:
      finite(args.state.cooling?.hoursSinceCooling),
    actionPressure: pressure,
    actionDelta: 0,
    outcomeSuccess: false,
    outcomeCarbonation: null,
    hoursToOutcome: 0,
    outcomeReason: "pressure_correction",
  };
}

function candidatePressures(currentPressure: number): number[] {
  const values = new Set<number>();

  for (
    let pressure = 0;
    pressure <= MAX_OPERATIONAL_PRESSURE_BAR + 1e-9;
    pressure += CANDIDATE_STEP_BAR
  ) {
    values.add(Number(pressure.toFixed(2)));
  }

  values.add(
    Number(
      clamp(
        currentPressure,
        0,
        MAX_OPERATIONAL_PRESSURE_BAR,
      ).toFixed(2),
    ),
  );

  return Array.from(values).sort((a, b) => a - b);
}

function asCandidate(
  pressure: number,
  estimate: CounterfactualOutcomeEstimate,
): PressureV7Candidate {
  return {
    pressure,
    successProbability: estimate.successProbability,
    expectedAbsCarbonationErrorVol:
      estimate.expectedAbsCarbonationErrorVol,
    supportBatches: estimate.supportBatches,
    effectiveSupport: estimate.effectiveSupport,
    nearestDistance: estimate.nearestDistance,
  };
}

function chooseCandidate(args: {
  supported: PressureV7Candidate[];
  currentPressure: number;
}): PressureV7Candidate {
  const bestSuccess = Math.max(
    ...args.supported.map((candidate) =>
      candidate.successProbability
    ),
  );

  const nearBest = args.supported.filter(
    (candidate) =>
      candidate.successProbability >= bestSuccess - 0.03,
  );

  const current = nearBest.find(
    (candidate) =>
      Math.abs(candidate.pressure - args.currentPressure) < 0.011,
  );
  if (current) return current;

  return nearBest
    .slice()
    .sort((a, b) => {
      const aError =
        a.expectedAbsCarbonationErrorVol ??
        Number.POSITIVE_INFINITY;
      const bError =
        b.expectedAbsCarbonationErrorVol ??
        Number.POSITIVE_INFINITY;

      if (Math.abs(aError - bError) > 0.01) {
        return aError - bError;
      }

      const aChange = Math.abs(
        a.pressure - args.currentPressure,
      );
      const bChange = Math.abs(
        b.pressure - args.currentPressure,
      );
      if (Math.abs(aChange - bChange) > 0.001) {
        return aChange - bChange;
      }

      if (a.supportBatches !== b.supportBatches) {
        return b.supportBatches - a.supportBatches;
      }

      return (
        b.successProbability - a.successProbability
      );
    })[0];
}

export function estimatePressureTargetV7(args: {
  state: PressureV4DecisionState;
  historicalBatches: PressureV6HistoricalBatch[];
  targetCarbonation: number;
  targetToleranceVol: number;
  currentBatchId?: string;
}): PressureV7Estimate | null {
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

  const evaluated: PressureV7Candidate[] = [];
  let currentPressureEstimate:
    | CounterfactualOutcomeEstimate
    | null = null;

  for (const pressure of candidatePressures(
    query.startPressure,
  )) {
    const estimate =
      estimatePressureCounterfactualOutcome({
        training: outcomes,
        query,
        candidatePressure: pressure,
        targetCarbonation: args.targetCarbonation,
      });

    if (
      Math.abs(pressure - query.startPressure) < 0.011
    ) {
      currentPressureEstimate = estimate;
    }

    if (!isPressureCounterfactualSupported(estimate)) {
      continue;
    }

    evaluated.push(asCandidate(pressure, estimate));
  }

  const common = {
    version: 7 as const,
    currentCarbonation: query.startCarbonation,
    currentPressure: query.startPressure,
    currentTemperature: query.startTemperature,
    hoursSinceCooling: query.hoursSinceCooling,
    targetCarbonation: args.targetCarbonation,
    targetToleranceVol: args.targetToleranceVol,
    currentPressureSuccessProbability:
      isPressureCounterfactualSupported(
        currentPressureEstimate,
      )
        ? currentPressureEstimate.successProbability
        : null,
    currentPressureSupported:
      isPressureCounterfactualSupported(
        currentPressureEstimate,
      ),
    candidateCount: evaluated.length,
    labeledOutcomeCount: outcomes.length,
    labeledOutcomeBatchCount,
  };

  if (!evaluated.length) {
    return {
      ...common,
      targetPressure: null,
      targetPressureRangeLow: null,
      targetPressureRangeHigh: null,
      action: "insufficient_data",
      estimatedSuccessProbability: null,
      expectedAbsCarbonationErrorVol: null,
      supportBatches: 0,
      effectiveSupport: 0,
      nearestDistance: null,
      confidence: "low",
      bestSuccessProbability: null,
      successLiftVsHold: null,
      nearOptimalRangeWidthBar: null,
      abstentionReason: "no_supported_candidates",
      bestCandidates: [],
    };
  }

  const bestSuccess = Math.max(
    ...evaluated.map((candidate) =>
      candidate.successProbability
    ),
  );

  const rawBest = chooseCandidate({
    supported: evaluated,
    currentPressure: query.startPressure,
  });

  const currentCandidate = evaluated.find(
    (candidate) =>
      Math.abs(candidate.pressure - query.startPressure) < 0.011,
  ) ?? null;

  const successLiftVsHold =
    currentCandidate === null
      ? null
      : bestSuccess - currentCandidate.successProbability;

  // First define the near-optimal region by outcome, not by pressure proximity.
  const acceptable = evaluated.filter(
    (candidate) =>
      candidate.successProbability >= bestSuccess - 0.05 &&
      (
        rawBest.expectedAbsCarbonationErrorVol === null ||
        candidate.expectedAbsCarbonationErrorVol === null ||
        candidate.expectedAbsCarbonationErrorVol <=
          rawBest.expectedAbsCarbonationErrorVol + 0.02
      ),
  );

  const rangeLow = Math.min(
    ...acceptable.map((candidate) => candidate.pressure),
  );
  const rangeHigh = Math.max(
    ...acceptable.map((candidate) => candidate.pressure),
  );
  const nearOptimalRangeWidthBar = rangeHigh - rangeLow;

  // A pressure change has to beat HOLD by a meaningful margin. Otherwise
  // intervention is not justified by the historical evidence.
  let chosen = rawBest;
  if (
    currentCandidate &&
    successLiftVsHold !== null &&
    successLiftVsHold < MIN_SUCCESS_LIFT_TO_CHANGE_PRESSURE
  ) {
    chosen = currentCandidate;
  }

  if (
    chosen.successProbability <
    MIN_RECOMMENDATION_SUCCESS_PROBABILITY
  ) {
    return {
      ...common,
      targetPressure: null,
      targetPressureRangeLow: rangeLow,
      targetPressureRangeHigh: rangeHigh,
      action: "insufficient_data",
      estimatedSuccessProbability:
        chosen.successProbability,
      expectedAbsCarbonationErrorVol:
        chosen.expectedAbsCarbonationErrorVol,
      supportBatches: chosen.supportBatches,
      effectiveSupport: chosen.effectiveSupport,
      nearestDistance: chosen.nearestDistance,
      confidence: "low",
      bestSuccessProbability: bestSuccess,
      successLiftVsHold,
      nearOptimalRangeWidthBar,
      abstentionReason: "weak_best_candidate",
      bestCandidates: evaluated
        .slice()
        .sort(
          (a, b) =>
            b.successProbability -
            a.successProbability,
        )
        .slice(0, 5),
    };
  }

  // If the response surface is essentially flat across a very wide pressure
  // range, the data says "this state usually does fine", not "this exact
  // pressure is correct". In that case HOLD is allowed only when it is already
  // near-best; otherwise abstain rather than invent precision.
  if (
    nearOptimalRangeWidthBar >
    MAX_NEAR_OPTIMAL_RANGE_WIDTH_BAR
  ) {
    if (
      currentCandidate &&
      successLiftVsHold !== null &&
      successLiftVsHold < MIN_SUCCESS_LIFT_TO_CHANGE_PRESSURE
    ) {
      chosen = currentCandidate;
    } else {
      return {
        ...common,
        targetPressure: null,
        targetPressureRangeLow: rangeLow,
        targetPressureRangeHigh: rangeHigh,
        action: "insufficient_data",
        estimatedSuccessProbability:
          rawBest.successProbability,
        expectedAbsCarbonationErrorVol:
          rawBest.expectedAbsCarbonationErrorVol,
        supportBatches: rawBest.supportBatches,
        effectiveSupport: rawBest.effectiveSupport,
        nearestDistance: rawBest.nearestDistance,
        confidence: "low",
        bestSuccessProbability: bestSuccess,
        successLiftVsHold,
        nearOptimalRangeWidthBar,
        abstentionReason: "flat_response_surface",
        bestCandidates: evaluated
          .slice()
          .sort(
            (a, b) =>
              b.successProbability -
              a.successProbability,
          )
          .slice(0, 5),
      };
    }
  }

  const pressureDelta =
    chosen.pressure - query.startPressure;
  const action: PressureV7Estimate["action"] =
    Math.abs(pressureDelta) < 0.04
      ? "hold"
      : pressureDelta > 0
        ? "raise"
        : "lower";

  return {
    ...common,
    targetPressure:
      action === "hold"
        ? query.startPressure
        : chosen.pressure,
    targetPressureRangeLow: rangeLow,
    targetPressureRangeHigh: rangeHigh,
    action,
    estimatedSuccessProbability:
      chosen.successProbability,
    expectedAbsCarbonationErrorVol:
      chosen.expectedAbsCarbonationErrorVol,
    supportBatches: chosen.supportBatches,
    effectiveSupport: chosen.effectiveSupport,
    nearestDistance: chosen.nearestDistance,
    confidence: confidenceFor(chosen),
    bestSuccessProbability: bestSuccess,
    successLiftVsHold,
    nearOptimalRangeWidthBar,
    abstentionReason: null,
    bestCandidates: evaluated
      .slice()
      .sort(
        (a, b) =>
          b.successProbability -
          a.successProbability ||
          Math.abs(
            a.pressure - query.startPressure,
          ) -
          Math.abs(
            b.pressure - query.startPressure,
          ),
      )
      .slice(0, 5),
  };
}
