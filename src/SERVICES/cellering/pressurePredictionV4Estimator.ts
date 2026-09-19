import type {
  PressureV4DecisionState,
  PressureV4Exposure,
  PressureV4PassiveSample,
  PressureV4Sample,
  PressureV4TransitionSample,
} from "./pressurePredictionV4";
import {
  equilibriumPressureBar,
  evolveCarbonation,
} from "./pressureCarbonationPhysics";

export type { PressureV4DecisionState };

const TARGET_TOLERANCE_VOL = 0.02;

export type PressureV4Candidate = {
  targetPressure: number;
  predictedCarbonation: number;
  predictedDelta: number;
  supportCount: number;
  effectiveWeight: number;
};

export type PressureV4Estimate = {
  targetPressure: number;
  predictedCarbonation: number;
  predictedCarbonationWithoutChange: number;
  targetCarbonation: number;
  error: number;
  supportCount: number;
  confidence: "low" | "medium" | "high";
  accuracyPercent: number;
  candidates: PressureV4Candidate[];
  kPerHour: number;
  targetEquilibriumPressure: number | null;
  referenceTemperature: number | null;
  equilibriumSource: "local_stable" | "learned_curve" | "physics";
  headroomBar: number;
  headroomSupport: number;
  empiricalCorrectionVol: number;
  empiricalSupport: number;
  empiricalSlopeVolPerBar: number;
  empiricalDriftVol48h: number;
  empiricalActionSupport: number;
  empiricalPassiveSupport: number;
  empiricalModelUsed: boolean;
  pressureActionEffectVol: number;
  pressureGapClosedFraction: number;
  action: "hold" | "raise" | "lower";
  pressureOnlyLikelyInsufficient: boolean;
  requiresAtmosphericVenting: boolean;
  forecastInTargetWindow: boolean;
  decisionStatus:
    | "within_window"
    | "early_cooling_exception"
    | "pressure_adjust_and_recheck"
    | "insufficient_response_evidence"
    | "pressure_only_insufficient";
  targetWindowMin: number;
  targetWindowMax: number;
};

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizedDifference(
  a: number | null,
  b: number | null,
  scale: number,
): number {
  if (a === null || b === null || !Number.isFinite(scale) || scale <= 0) return 0;
  return Math.abs(a - b) / scale;
}

function exposureRate(exposure: PressureV4Exposure): number | null {
  if (
    exposure.equilibriumDeltaBarHours === null ||
    exposure.hoursSinceT0 <= 0
  ) return null;
  return exposure.equilibriumDeltaBarHours / exposure.hoursSinceT0;
}

function coolingExposureRate(
  cooling: PressureV4DecisionState["cooling"],
): number | null {
  if (
    !cooling ||
    cooling.equilibriumDeltaBarHoursSinceCooling === null ||
    cooling.hoursSinceCooling <= 0
  ) return null;
  return (
    cooling.equilibriumDeltaBarHoursSinceCooling /
    cooling.hoursSinceCooling
  );
}

function transitionDistance(
  sample: PressureV4TransitionSample,
  state: PressureV4DecisionState,
): number {
  let score = 0;

  score += normalizedDifference(sample.startCarbonation, state.carbonation, 0.15) * 2.0;
  score += normalizedDifference(sample.currentTemp, state.currentTemp, 2.5) * 0.9;
  score += normalizedDifference(sample.hoursSinceT0, state.hoursSinceT0, 72) * 0.9;

  score += normalizedDifference(
    sample.exposure.pressureMean24h,
    state.exposure.pressureMean24h,
    0.25,
  ) * 1.6;
  score += normalizedDifference(
    sample.exposure.pressureMean48h,
    state.exposure.pressureMean48h,
    0.3,
  ) * 1.4;
  score += normalizedDifference(
    exposureRate(sample.exposure),
    exposureRate(state.exposure),
    0.2,
  ) * 1.8;

  if (sample.cooling && state.cooling) {
    score += normalizedDifference(
      sample.cooling.hoursSinceCooling,
      state.cooling.hoursSinceCooling,
      36,
    ) * 1.8;
    score += normalizedDifference(
      sample.cooling.tempDropSinceCooling,
      state.cooling.tempDropSinceCooling,
      4,
    ) * 1.1;
    score += normalizedDifference(
      sample.cooling.tempChange24h,
      state.cooling.tempChange24h,
      2,
    ) * 1.8;
    score += normalizedDifference(
      sample.cooling.pressureMeanSinceCooling,
      state.cooling.pressureMeanSinceCooling,
      0.3,
    ) * 1.7;
    score += normalizedDifference(
      coolingExposureRate(sample.cooling),
      coolingExposureRate(state.cooling),
      0.2,
    ) * 1.8;
    if (sample.cooling.stillCooling !== state.cooling.stillCooling) {
      score += 1.5;
    }
  } else if (Boolean(sample.cooling) !== Boolean(state.cooling)) {
    score += 2.5;
  }

  if (sample.quality === "low") score += 1.25;
  else if (sample.quality === "medium") score += 0.25;

  return score;
}

type WeightedTransition = {
  sample: PressureV4TransitionSample;
  distance: number;
  weight: number;
};

function weightedQuantile(
  rows: WeightedTransition[],
  value: (row: WeightedTransition) => number,
  q: number,
): number | null {
  const sorted = rows
    .filter((row) => Number.isFinite(value(row)) && row.weight > 0)
    .slice()
    .sort((a, b) => value(a) - value(b));
  const total = sorted.reduce((sum, row) => sum + row.weight, 0);
  if (!sorted.length || total <= 0) return null;

  const target = total * q;
  let running = 0;
  for (const row of sorted) {
    running += row.weight;
    if (running >= target) return value(row);
  }
  return value(sorted[sorted.length - 1]);
}

function localTransitions(
  transitions: PressureV4TransitionSample[],
  state: PressureV4DecisionState,
): WeightedTransition[] {
  return transitions
    .filter((sample) =>
      Number.isFinite(sample.kPerHour) &&
      sample.kPerHour > 0 &&
      sample.kPerHour < 1 &&
      Number.isFinite(sample.startCarbonation) &&
      Number.isFinite(sample.endCarbonation) &&
      Number.isFinite(sample.durationHours) &&
      sample.durationHours > 0
    )
    .map((sample) => {
      const distance = transitionDistance(sample, state);
      return {
        sample,
        distance,
        weight: 1 / (0.25 + distance * distance),
      };
    })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 30);
}

function directionalTransitions(
  rows: WeightedTransition[],
  carbonationError: number,
): WeightedTransition[] {
  if (Math.abs(carbonationError) <= TARGET_TOLERANCE_VOL) return rows;

  const direction = Math.sign(carbonationError);
  const matching = rows.filter((row) => {
    const delta =
      row.sample.endCarbonation - row.sample.startCarbonation;
    return Math.sign(delta) === direction && Math.abs(delta) >= 0.01;
  });

  // Prefer kinetics from transitions that actually moved CO2 in the direction
  // we now need. Fall back to the broader local set only when history is thin.
  return matching.length >= 4 ? matching : rows;
}

function estimateK(rows: WeightedTransition[]): number | null {
  return weightedQuantile(rows, (row) => row.sample.kPerHour, 0.5);
}

function accuracyPercent(
  rows: WeightedTransition[],
  fallbackK: number,
): number {
  if (rows.length < 4) return 0;

  let hitWeight = 0;
  let totalWeight = 0;

  rows.slice(0, 16).forEach((row, index) => {
    const others = rows
      .filter((_, otherIndex) => otherIndex !== index)
      .map((other) => ({
        ...other,
        weight: 1 / (0.25 + other.distance * other.distance),
      }));
    const k = estimateK(others) ?? fallbackK;
    const pressure = finite(row.sample.pressureMeanDuring);
    const temp = finite(row.sample.temperatureMeanDuring);
    if (pressure === null || temp === null) return;

    const predicted = evolveCarbonation({
      carbonation: row.sample.startCarbonation,
      pressureBar: pressure,
      temperatureC: temp,
      kPerHour: k,
      hours: row.sample.durationHours,
    });
    if (predicted === null) return;

    totalWeight += row.weight;
    if (Math.abs(predicted - row.sample.endCarbonation) <= 0.05) {
      hitWeight += row.weight;
    }
  });

  if (totalWeight <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(hitWeight / totalWeight * 100)));
}

function forecastTemperatureAtHour(args: {
  state: PressureV4DecisionState;
  coldReferenceTemperature: number | null;
  hour: number;
}): number | null {
  const currentTemp = finite(args.state.currentTemp);
  if (currentTemp === null) return null;

  const cooling = args.state.cooling;
  const floor = finite(args.coldReferenceTemperature);
  if (
    !cooling ||
    !cooling.stillCooling ||
    floor === null ||
    cooling.startTemp === null ||
    cooling.hoursSinceCooling <= 0 ||
    cooling.startTemp <= floor + 0.2 ||
    currentTemp <= floor + 0.2
  ) {
    return currentTemp;
  }

  const startGap = cooling.startTemp - floor;
  const currentGap = Math.max(0.05, currentTemp - floor);
  if (startGap <= currentGap) return currentTemp;

  const lambda =
    -Math.log(currentGap / startGap) / cooling.hoursSinceCooling;
  if (!Number.isFinite(lambda) || lambda <= 0) return currentTemp;

  return floor + currentGap * Math.exp(-lambda * args.hour);
}

function simulateForward(args: {
  carbonation: number;
  pressureBar: number;
  pressureCalibrationOffset: number;
  state: PressureV4DecisionState;
  coldReferenceTemperature: number | null;
  kPerHour: number;
  hours: number;
}): number | null {
  let carbonation = args.carbonation;
  const stepHours = 6;

  for (let elapsed = 0; elapsed < args.hours; elapsed += stepHours) {
    const hours = Math.min(stepHours, args.hours - elapsed);
    const midpoint = elapsed + hours / 2;
    const temp = forecastTemperatureAtHour({
      state: args.state,
      coldReferenceTemperature: args.coldReferenceTemperature,
      hour: midpoint,
    });
    if (temp === null) return null;

    const next = evolveCarbonation({
      carbonation,
      pressureBar: args.pressureBar - args.pressureCalibrationOffset,
      temperatureC: temp,
      kPerHour: args.kPerHour,
      hours,
    });
    if (next === null) return null;
    carbonation = next;
  }

  return carbonation;
}

function isEffectivelyStillCooling(
  state: PressureV4DecisionState,
  coldReferenceTemperature: number | null,
): boolean {
  const currentTemp = finite(state.currentTemp);
  const cold = finite(coldReferenceTemperature);
  const cooling = state.cooling;
  if (!cooling || currentTemp === null || cold === null) return false;

  if (cooling.stillCooling) return true;

  // Sparse temperature logging can miss the falling 24h slope. During the
  // first four days after cooling, a beer still several degrees above its
  // learned cold floor should still be treated as cooling toward that floor.
  return (
    cooling.hoursSinceCooling <= 96 &&
    currentTemp >= cold + 1.5
  );
}

function referenceTemperature(
  state: PressureV4DecisionState,
  coldReferenceTemperature: number | null,
): number | null {
  const currentTemp = finite(state.currentTemp);
  if (currentTemp === null) return null;

  const cold = finite(coldReferenceTemperature);
  if (
    isEffectivelyStillCooling(state, cold) &&
    cold !== null &&
    cold < currentTemp
  ) {
    return cold;
  }

  return currentTemp;
}

function localStableTargetEquilibrium(args: {
  state: PressureV4DecisionState;
  targetCarbonation: number;
}): number | null {
  const trend = args.state.carbonationTrend;
  const previousTemp = finite(trend?.previousTemp);
  const previousPressure = finite(trend?.previousPressure);
  const previousCarbonation = finite(trend?.previousCarbonation);
  const previousHistoricalRate =
    finite(trend?.previousHistoricalRatePerDay);
  const hoursBetweenPreviousChecks =
    finite(trend?.hoursBetweenPreviousChecks);

  if (
    !trend ||
    previousTemp === null ||
    previousPressure === null ||
    previousCarbonation === null ||
    previousHistoricalRate === null ||
    hoursBetweenPreviousChecks === null ||
    previousTemp > 5 ||
    hoursBetweenPreviousChecks < 18 ||
    Math.abs(previousHistoricalRate) > 0.015 ||
    Math.abs(previousCarbonation - args.targetCarbonation) > 0.15
  ) {
    return null;
  }

  const physicalPrevious = equilibriumPressureBar(
    previousTemp,
    previousCarbonation,
  );
  const physicalTarget = equilibriumPressureBar(
    previousTemp,
    args.targetCarbonation,
  );
  if (physicalPrevious === null || physicalTarget === null) return null;

  // Crucially, this anchor comes only from historical readings that precede
  // the simulated/current test. Changing the hypothetical carbonation input
  // therefore cannot move the equilibrium baseline.
  return previousPressure + (physicalTarget - physicalPrevious);
}

function headroomPrior(args: {
  carbonationError: number;
  state: PressureV4DecisionState;
  coldReferenceTemperature: number | null;
  hasLocalEquilibrium: boolean;
}): number {
  if (Math.abs(args.carbonationError) <= TARGET_TOLERANCE_VOL) return 0;

  if (args.carbonationError > 0) {
    let headroom = clamp(
      0.10 + 1.1 * args.carbonationError,
      0.15,
      0.35,
    );

    if (args.hasLocalEquilibrium) {
      headroom = Math.max(0.12, headroom - 0.05);
    }

    const currentTemp = finite(args.state.currentTemp);
    const coldTemp = finite(args.coldReferenceTemperature);
    if (
      isEffectivelyStillCooling(
        args.state,
        args.coldReferenceTemperature,
      ) &&
      currentTemp !== null &&
      coldTemp !== null &&
      currentTemp > coldTemp + 1
    ) {
      const gapFactor = clamp((currentTemp - coldTemp) / 6, 0, 1);
      headroom += 0.14 + 0.04 * gapFactor;
    } else if (
      args.state.cooling &&
      !args.state.cooling.stillCooling &&
      args.state.cooling.hoursSinceCooling > 120 &&
      !args.hasLocalEquilibrium
    ) {
      headroom += Math.min(
        0.10,
        (args.state.cooling.hoursSinceCooling - 120) / 240 * 0.10,
      );
    }

    return clamp(headroom, 0.12, 0.50);
  }

  const excess = Math.abs(args.carbonationError);

  // A small over-carbonation should first be corrected by moving the regulator
  // toward the equilibrium pressure, not by treating it like an emergency vent.
  // Example: 2.45 vs 2.40 at ~1°C should land near the ~0.5 bar equilibrium area.
  if (excess <= 0.055) {
    return -clamp((excess - TARGET_TOLERANCE_VOL) * 0.6, 0, 0.03);
  }

  // Once the excess is materially larger, venting pressure can fall much more
  // sharply. This preserves the aggressive response for genuinely high CO2.
  return -clamp(
    0.15 + 15 * (excess - 0.055),
    0.15,
    0.55,
  );
}

function learnedHeadroom(args: {
  rows: WeightedTransition[];
  targetCarbonation: number;
  carbonationError: number;
  coldReferenceTemperature: number | null;
  equilibriumPressureAtTemperature?: (temperature: number | null) => number | null;
}): { value: number; support: number } | null {
  const equilibriumForTemperature =
    args.equilibriumPressureAtTemperature;

  if (
    !equilibriumForTemperature ||
    Math.abs(args.carbonationError) <= TARGET_TOLERANCE_VOL
  ) {
    return null;
  }

  const sameDirection = args.rows
    .map((row) => {
      const sampleError =
        args.targetCarbonation - row.sample.startCarbonation;
      if (
        Math.abs(sampleError) <= TARGET_TOLERANCE_VOL ||
        Math.sign(sampleError) !== Math.sign(args.carbonationError) ||
        Math.abs(row.sample.endCarbonation - args.targetCarbonation) > 0.06
      ) {
        return null;
      }

      const pressure = finite(row.sample.pressureMeanDuring);
      const sampleTemp = finite(row.sample.currentTemp);
      const referenceTemp =
        row.sample.cooling?.stillCooling &&
        args.coldReferenceTemperature !== null
          ? args.coldReferenceTemperature
          : sampleTemp;
      const equilibrium =
        equilibriumForTemperature(referenceTemp);
      if (pressure === null || equilibrium === null) return null;

      const deficitDistance =
        Math.abs(sampleError - args.carbonationError) / 0.08;
      const weight =
        row.weight / (1 + deficitDistance * deficitDistance);

      return {
        headroom: pressure - equilibrium,
        weight,
      };
    })
    .filter((row): row is { headroom: number; weight: number } =>
      row !== null &&
      Number.isFinite(row.headroom) &&
      Number.isFinite(row.weight) &&
      row.weight > 0
    )
    .sort((a, b) => a.headroom - b.headroom);

  if (sameDirection.length < 4) return null;

  const totalWeight = sameDirection.reduce((sum, row) => sum + row.weight, 0);
  if (totalWeight <= 0) return null;

  let running = 0;
  const targetWeight = totalWeight / 2;
  let median = sameDirection[sameDirection.length - 1].headroom;
  for (const row of sameDirection) {
    running += row.weight;
    if (running >= targetWeight) {
      median = row.headroom;
      break;
    }
  }

  return {
    value: median,
    support: sameDirection.length,
  };
}

function blendHeadroom(
  prior: number,
  learned: { value: number; support: number } | null,
): { value: number; support: number } {
  if (!learned) return { value: prior, support: 0 };
  if (Math.sign(learned.value) !== Math.sign(prior)) {
    return { value: prior, support: learned.support };
  }

  const learnedWeight =
    learned.support >= 12
      ? 0.50
      : learned.support >= 8
        ? 0.40
        : 0.25;

  const blended =
    prior * (1 - learnedWeight) +
    learned.value * learnedWeight;

  return {
    value: clamp(blended, prior - 0.12, prior + 0.12),
    support: learned.support,
  };
}


type EmpiricalTrainingRow = {
  x: number; // pressure change in bar; 0 = passive/no intervention
  y: number; // observed carbonation change after two calendar days
  stateDistance: number;
  quality: "low" | "medium" | "high";
  kind: "action" | "passive";
};

type EmpiricalResponse = {
  intercept: number;
  slope: number;
  predictedDelta: number;
  support: number;
  actionSupport: number;
  passiveSupport: number;
  effectiveWeight: number;
  meanDistance: number;
  slopeIdentified: boolean;
  actionMin: number;
  actionMax: number;
};

type PassiveDriftEstimate = {
  delta: number;
  support: number;
  meanDistance: number;
};

type PressureSlopeEstimate = {
  slope: number;
  support: number;
  meanDistance: number;
  actionMin: number;
  actionMax: number;
};

function calibrationStateDistance(
  sample: PressureV4Sample | PressureV4PassiveSample,
  state: PressureV4DecisionState,
): number {
  let score = 0;
  score += normalizedDifference(sample.carbonationBefore, state.carbonation, 0.15) * 2.0;
  score += normalizedDifference(sample.currentPressure, state.currentPressure, 0.35) * 0.8;
  score += normalizedDifference(sample.currentTemp, state.currentTemp, 3) * 0.8;
  score += normalizedDifference(sample.hoursSinceT0, state.hoursSinceT0, 72) * 0.6;
  score += normalizedDifference(
    sample.exposure.pressureMean24h,
    state.exposure.pressureMean24h,
    0.3,
  ) * 1.4;
  score += normalizedDifference(
    sample.exposure.pressureMean48h,
    state.exposure.pressureMean48h,
    0.35,
  ) * 1.2;
  score += normalizedDifference(
    exposureRate(sample.exposure),
    exposureRate(state.exposure),
    0.2,
  ) * 1.5;

  if (sample.quality === "low") score += 1.25;
  else if (sample.quality === "medium") score += 0.25;
  return score;
}

function empiricalRowWeight(row: EmpiricalTrainingRow): number {
  const qualityWeight =
    row.quality === "high" ? 1 : row.quality === "medium" ? 0.7 : 0.35;
  return qualityWeight / (0.25 + row.stateDistance * row.stateDistance);
}

function weightedMedianNumber(
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
  const total = sorted.reduce((sum, row) => sum + row.weight, 0);
  if (!sorted.length || total <= 0) return null;

  let running = 0;
  for (const row of sorted) {
    running += row.weight;
    if (running >= total / 2) return row.value;
  }
  return sorted[sorted.length - 1].value;
}

function buildEmpiricalTrainingRows(args: {
  samples: PressureV4Sample[];
  passiveSamples: PressureV4PassiveSample[];
  state: PressureV4DecisionState;
}): EmpiricalTrainingRow[] {
  const actions: EmpiricalTrainingRow[] = args.samples
    .filter((sample) =>
      Number.isFinite(sample.carbonationDelta) &&
      Number.isFinite(sample.currentPressure) &&
      Number.isFinite(sample.targetPressure) &&
      sample.primaryOutcome?.calendarDaysAfterAction === 2
    )
    .map((sample) => ({
      x: Number.isFinite(sample.actionPressureDelta)
        ? sample.actionPressureDelta
        : sample.targetPressure - sample.currentPressure,
      y: sample.carbonationDelta,
      stateDistance: calibrationStateDistance(sample, args.state),
      quality: sample.quality,
      kind: "action" as const,
    }));

  const passive: EmpiricalTrainingRow[] = args.passiveSamples
    .filter((sample) =>
      Number.isFinite(sample.carbonationDelta) &&
      sample.primaryOutcome?.calendarDaysAfterAction === 2
    )
    .map((sample) => ({
      x: 0,
      y: sample.carbonationDelta,
      stateDistance: calibrationStateDistance(sample, args.state),
      quality: sample.quality,
      kind: "passive" as const,
    }));

  return [...actions, ...passive]
    .sort((a, b) => a.stateDistance - b.stateDistance)
    .slice(0, 40);
}

function estimatePassiveDrift(
  rows: EmpiricalTrainingRow[],
): PassiveDriftEstimate | null {
  const passive = rows
    .filter((row) => row.kind === "passive")
    .slice(0, 24);

  if (passive.length < 5) return null;

  const median = weightedMedianNumber(
    passive.map((row) => ({
      value: row.y,
      weight: empiricalRowWeight(row),
    })),
  );
  if (median === null) return null;

  // A second robust pass removes rows that are extreme relative to the local
  // passive median. This prevents one corrupted two-day outcome from moving the
  // no-action baseline by whole volumes of CO2.
  const deviations = passive
    .map((row) => Math.abs(row.y - median))
    .sort((a, b) => a - b);
  const mad = deviations[Math.floor(deviations.length / 2)] ?? 0;
  const tolerance = Math.max(0.03, mad * 4);
  const robust = passive.filter(
    (row) => Math.abs(row.y - median) <= tolerance,
  );
  if (robust.length < 5) return null;

  const robustMedian = weightedMedianNumber(
    robust.map((row) => ({
      value: row.y,
      weight: empiricalRowWeight(row),
    })),
  );
  if (robustMedian === null) return null;

  return {
    delta: robustMedian,
    support: robust.length,
    meanDistance:
      robust.reduce((sum, row) => sum + row.stateDistance, 0) /
      robust.length,
  };
}

function estimatePressureSlope(
  rows: EmpiricalTrainingRow[],
  passive: PassiveDriftEstimate | null,
): PressureSlopeEstimate | null {
  const actions = rows
    .filter((row) => row.kind === "action" && Math.abs(row.x) >= 0.08)
    .slice(0, 24);

  if (actions.length < 3) return null;

  let slopeRows: Array<{ value: number; weight: number }> = [];

  if (passive) {
    slopeRows = actions
      .map((row) => ({
        value: (row.y - passive.delta) / row.x,
        weight: empiricalRowWeight(row),
      }))
      .filter((row) =>
        Number.isFinite(row.value) &&
        row.value > 0 &&
        row.value <= 1
      );
  } else {
    // Without passive baseline, use pairwise action differences so the unknown
    // intercept cancels out. This avoids extrapolating a regression intercept
    // from pressure actions back to action=0.
    for (let i = 0; i < actions.length; i += 1) {
      for (let j = i + 1; j < actions.length; j += 1) {
        const dx = actions[i].x - actions[j].x;
        if (Math.abs(dx) < 0.08) continue;
        const slope = (actions[i].y - actions[j].y) / dx;
        if (!Number.isFinite(slope) || slope <= 0 || slope > 1) continue;
        slopeRows.push({
          value: slope,
          weight:
            Math.sqrt(
              empiricalRowWeight(actions[i]) *
              empiricalRowWeight(actions[j]),
            ),
        });
      }
    }
  }

  if (slopeRows.length < 3) return null;

  const slope = weightedMedianNumber(slopeRows);
  if (slope === null || slope <= 0) return null;

  const actionValues = actions.map((row) => row.x);
  return {
    slope,
    support: actions.length,
    meanDistance:
      actions.reduce((sum, row) => sum + row.stateDistance, 0) /
      actions.length,
    actionMin: Math.min(...actionValues),
    actionMax: Math.max(...actionValues),
  };
}

function buildEmpiricalResponse(args: {
  rows: EmpiricalTrainingRow[];
  candidateActionDelta: number;
  physicalNoChangeDelta: number;
  activeCooling: boolean;
}): EmpiricalResponse | null {
  if (args.activeCooling) return null;

  const passive = estimatePassiveDrift(args.rows);
  const slope = estimatePressureSlope(args.rows, passive);
  if (!passive && !slope) return null;

  const intercept = passive?.delta ?? args.physicalNoChangeDelta;
  const learnedSlope = slope?.slope ?? 0;
  const predictedDelta =
    intercept + learnedSlope * args.candidateActionDelta;

  return {
    intercept,
    slope: learnedSlope,
    predictedDelta,
    support: Math.max(passive?.support ?? 0, slope?.support ?? 0),
    actionSupport: slope?.support ?? 0,
    passiveSupport: passive?.support ?? 0,
    effectiveWeight: args.rows.reduce(
      (sum, row) => sum + empiricalRowWeight(row),
      0,
    ),
    meanDistance:
      slope?.meanDistance ??
      passive?.meanDistance ??
      Infinity,
    slopeIdentified: Boolean(slope),
    actionMin: slope?.actionMin ?? 0,
    actionMax: slope?.actionMax ?? 0,
  };
}

function refinePressureWithForecast(args: {
  baselinePressure: number;
  state: PressureV4DecisionState;
  targetCarbonation: number;
  forecastAtPressure: (pressure: number) => number | null;
  coldReferenceTemperature: number | null;
  minPressure: number;
  maxPressure: number;
  step: number;
}): number {
  const earlyCoolingVent =
    isEffectivelyStillCooling(
      args.state,
      args.coldReferenceTemperature,
    ) &&
    args.state.carbonation < args.targetCarbonation &&
    args.baselinePressure < args.state.currentPressure;

  const currentAtBaseline =
    args.forecastAtPressure(args.baselinePressure);
  if (currentAtBaseline === null) return args.baselinePressure;

  const baselineError =
    Math.abs(currentAtBaseline - args.targetCarbonation);
  if (baselineError <= TARGET_TOLERANCE_VOL) return args.baselinePressure;

  if (earlyCoolingVent) {
    const lowerTargetBound =
      args.targetCarbonation - TARGET_TOLERANCE_VOL;
    const upperTargetBound =
      args.targetCarbonation + TARGET_TOLERANCE_VOL;

    // First try to hit the same ±0.02 target used by stable beer. During active
    // cooling we only search between the operational vent baseline and the
    // pressure already stored in the tank: we may vent less aggressively, but
    // we never add more pressure than is already present just to satisfy a
    // noisy early-cooling forecast.
    const earlyCandidates: Array<{
      pressure: number;
      predicted: number;
      error: number;
    }> = [];
    const start = Math.min(
      args.baselinePressure,
      args.state.currentPressure,
    );
    const end = Math.max(
      args.baselinePressure,
      args.state.currentPressure,
    );

    for (
      let pressure = start;
      pressure <= end + 0.001;
      pressure += args.step
    ) {
      const candidate = snapPressure(
        pressure,
        args.minPressure,
        args.maxPressure,
        args.step,
      );
      const predicted = args.forecastAtPressure(candidate);
      if (predicted === null) continue;

      if (
        predicted >= lowerTargetBound &&
        predicted <= upperTargetBound
      ) {
        earlyCandidates.push({
          pressure: candidate,
          predicted,
          error: Math.abs(
            predicted - args.targetCarbonation,
          ),
        });
      }
    }

    if (earlyCandidates.length) {
      earlyCandidates.sort((a, b) => {
        if (Math.abs(a.error - b.error) > 0.001) {
          return a.error - b.error;
        }
        // With equal forecast quality, prefer the lower pressure so we still
        // respect the operational goal of releasing excess stored head pressure.
        return a.pressure - b.pressure;
      });
      return earlyCandidates[0].pressure;
    }

    // If no pressure between the operational baseline and current pressure can
    // hit the 48h window, keep a conservative physical safety floor. This is
    // the only case where active cooling is allowed to return a forecast outside
    // ±0.02, and the estimate is explicitly labelled as an early-cooling exception.
    if (currentAtBaseline < lowerTargetBound) {
      const referenceTemp =
        finite(args.coldReferenceTemperature) ??
        finite(args.state.currentTemp);
      const physicalTargetEquilibrium =
        referenceTemp === null
          ? null
          : equilibriumPressureBar(
              referenceTemp,
              args.targetCarbonation,
            );

      if (physicalTargetEquilibrium !== null) {
        const carbonationDeficit = Math.max(
          0,
          args.targetCarbonation - args.state.carbonation,
        );
        const safetyHeadroom = clamp(
          0.35 + 0.8 * carbonationDeficit,
          0.40,
          0.50,
        );
        const safetyFloor =
          physicalTargetEquilibrium + safetyHeadroom;

        return snapPressure(
          Math.min(
            args.state.currentPressure,
            Math.max(args.baselinePressure, safetyFloor),
          ),
          args.minPressure,
          args.maxPressure,
          args.step,
        );
      }
    }

    return args.baselinePressure;
  }

  // k is a bounded fine-tuner, not the primary decision-maker. The allowed
  // correction grows with the actual carbonation deficit/excess: tiny misses
  // get a tiny pressure trim, while a 0.12-0.15 vol deficit may justify roughly
  // another 0.4-0.5 bar. This keeps pressure changes monotonic without returning
  // to the old "slow k => 1.9 bar" failure mode.
  const direction =
    currentAtBaseline < args.targetCarbonation ? 1 : -1;

  if (
    args.state.carbonation > args.targetCarbonation &&
    currentAtBaseline > args.targetCarbonation + TARGET_TOLERANCE_VOL
  ) {
    return args.baselinePressure;
  }

  const currentCarbError = Math.abs(
    args.targetCarbonation - args.state.carbonation,
  );
  const maxRaiseFromCurrent = clamp(
    0.15 + 4 * currentCarbError,
    0.25,
    0.75,
  );
  const maxOperationalPressure =
    direction > 0
      ? Math.min(
          args.maxPressure,
          args.state.currentPressure + maxRaiseFromCurrent,
        )
      : args.maxPressure;
  const maxRefinement =
    direction > 0
      ? Math.max(
          0,
          maxOperationalPressure - args.baselinePressure,
        )
      : 0;

  let bestPressure = args.baselinePressure;
  let bestError = baselineError;

  for (
    let delta = args.step;
    delta <= maxRefinement + 0.001;
    delta += args.step
  ) {
    const candidate = snapPressure(
      args.baselinePressure + direction * delta,
      args.minPressure,
      args.maxPressure,
      args.step,
    );
    const predicted = args.forecastAtPressure(candidate);
    if (predicted === null) continue;

    const error = Math.abs(predicted - args.targetCarbonation);

    if (
      direction > 0 &&
      predicted >=
        args.targetCarbonation - TARGET_TOLERANCE_VOL / 2 &&
      predicted <= args.targetCarbonation + TARGET_TOLERANCE_VOL
    ) {
      // For under-carbonation, choose the first (lowest) pressure that actually
      // enters the requested window rather than continuing to chase the exact
      // midpoint with unnecessary pressure.
      return candidate;
    }

    if (error + 0.0001 < bestError) {
      bestError = error;
      bestPressure = candidate;
    }
  }

  return bestPressure;
}

function snapPressure(
  pressure: number,
  minPressure: number,
  maxPressure: number,
  step: number,
): number {
  const clamped = clamp(pressure, minPressure, maxPressure);
  return Number(
    (Math.round(clamped / step) * step).toFixed(2),
  );
}

export function estimatePressureTargetV4(args: {
  samples?: PressureV4Sample[];
  passiveSamples?: PressureV4PassiveSample[];
  transitions?: PressureV4TransitionSample[];
  state: PressureV4DecisionState;
  targetCarbonation: number;
  minPressure?: number;
  maxPressure?: number;
  step?: number;
  equilibriumPressure?: number | null;
  equilibriumPressureAtTemperature?: (temperature: number | null) => number | null;
  coldReferenceTemperature?: number | null;
  horizonHours?: number;
}): PressureV4Estimate | null {
  const minPressure = finite(args.minPressure) ?? 0;
  const maxPressure = finite(args.maxPressure) ?? 1.9;
  const step = finite(args.step) ?? 0.05;
  const horizonHours = finite(args.horizonHours) ?? 48;
  const currentTemp = finite(args.state.currentTemp);
  const coldReferenceTemperature = finite(args.coldReferenceTemperature);

  if (
    currentTemp === null ||
    currentTemp > 9 ||
    !Number.isFinite(args.state.carbonation) ||
    !Number.isFinite(args.state.currentPressure) ||
    !Number.isFinite(args.targetCarbonation) ||
    step <= 0 ||
    horizonHours <= 0 ||
    maxPressure < minPressure
  ) return null;

  const rows = localTransitions(args.transitions ?? [], args.state);
  if (rows.length < 4) return null;

  const carbonationError =
    args.targetCarbonation - args.state.carbonation;
  const kineticRows = directionalTransitions(rows, carbonationError);
  const kPerHour = estimateK(kineticRows);
  if (kPerHour === null) return null;

  const refTemp = referenceTemperature(
    args.state,
    coldReferenceTemperature,
  );
  if (refTemp === null) return null;

  const standardTargetEquilibrium = equilibriumPressureBar(
    refTemp,
    args.targetCarbonation,
  );
  if (standardTargetEquilibrium === null) return null;

  const localEquilibrium = localStableTargetEquilibrium({
    state: args.state,
    targetCarbonation: args.targetCarbonation,
  });
  const learnedEquilibrium = finite(args.equilibriumPressure);

  // The target equilibrium may be anchored by a genuinely stable historical
  // pair that predates the simulated/current reading. Otherwise use the style
  // curve, then physics as fallback.
  let targetEquilibriumPressure = standardTargetEquilibrium;
  let equilibriumSource: PressureV4Estimate["equilibriumSource"] = "physics";

  if (localEquilibrium !== null) {
    targetEquilibriumPressure = localEquilibrium;
    equilibriumSource = "local_stable";
  } else if (learnedEquilibrium !== null) {
    targetEquilibriumPressure = learnedEquilibrium;
    equilibriumSource = "learned_curve";
  }

  // Keep historical calibration physically plausible. It may correct local
  // gauge/system bias, but it must not turn a cold equilibrium curve into an
  // arbitrary extrapolation several tenths of a bar away.
  targetEquilibriumPressure = clamp(
    targetEquilibriumPressure,
    Math.max(minPressure, standardTargetEquilibrium - 0.35),
    Math.min(maxPressure, standardTargetEquilibrium + 0.35),
  );

  // k was fitted against the actual gauge pressure history using the same
  // physical equilibrium equation. Applying the learned equilibrium offset
  // again inside the kinetic simulation would double-calibrate the forecast.
  // The learned/local equilibrium remains the operational setpoint anchor only.
  const activeCooling = isEffectivelyStillCooling(
    args.state,
    coldReferenceTemperature,
  );
  const empiricalRows = buildEmpiricalTrainingRows({
    samples: args.samples ?? [],
    passiveSamples: args.passiveSamples ?? [],
    state: args.state,
  });

  const physicalNoChange = simulateForward({
    carbonation: args.state.carbonation,
    pressureBar: args.state.currentPressure,
    pressureCalibrationOffset: 0,
    state: args.state,
    coldReferenceTemperature,
    kPerHour,
    hours: horizonHours,
  });
  if (physicalNoChange === null) return null;
  const physicalNoChangeDelta =
    physicalNoChange - args.state.carbonation;

  const forecastAtPressure = (pressureBar: number): {
    predicted: number;
    physicalPredicted: number;
    empiricalPredicted: number | null;
    response: EmpiricalResponse | null;
    empiricalWeight: number;
  } | null => {
    const physicalPredicted = simulateForward({
      carbonation: args.state.carbonation,
      pressureBar,
      pressureCalibrationOffset: 0,
      state: args.state,
      coldReferenceTemperature,
      kPerHour,
      hours: horizonHours,
    });
    if (physicalPredicted === null) return null;

    const candidateActionDelta =
      pressureBar - args.state.currentPressure;
    const response =
      Math.abs(horizonHours - 48) <= 12
        ? buildEmpiricalResponse({
            rows: empiricalRows,
            candidateActionDelta,
            physicalNoChangeDelta,
            activeCooling,
          })
        : null;

    if (!response) {
      return {
        predicted: physicalPredicted,
        physicalPredicted,
        empiricalPredicted: null,
        response: null,
        empiricalWeight: 0,
      };
    }

    const empiricalNoChange =
      args.state.carbonation + response.intercept;
    const physicalActionEffect =
      physicalPredicted - physicalNoChange;
    const actionEffect = response.slopeIdentified
      ? response.slope * candidateActionDelta
      : physicalActionEffect;
    const predicted =
      empiricalNoChange + actionEffect;

    return {
      predicted,
      physicalPredicted,
      empiricalPredicted: predicted,
      response,
      empiricalWeight:
        response.slopeIdentified || response.passiveSupport >= 5
          ? 1
          : 0,
    };
  };

  const noChangeForecast =
    forecastAtPressure(args.state.currentPressure);
  if (!noChangeForecast) return null;
  const predictedCarbonationWithoutChangeRaw =
    noChangeForecast.predicted;

  const withinTargetNow = Math.abs(carbonationError) <= TARGET_TOLERANCE_VOL;
  const staysWithinTarget =
    Math.abs(
      predictedCarbonationWithoutChangeRaw - args.targetCarbonation,
    ) <= TARGET_TOLERANCE_VOL;

  let headroomBar = 0;
  let headroomSupport = 0;
  let targetPressure = args.state.currentPressure;

  if (!(withinTargetNow && staysWithinTarget)) {
    const prior = headroomPrior({
      carbonationError,
      state: args.state,
      coldReferenceTemperature,
      hasLocalEquilibrium: localEquilibrium !== null,
    });
    const learned = learnedHeadroom({
      rows,
      targetCarbonation: args.targetCarbonation,
      carbonationError,
      coldReferenceTemperature,
      equilibriumPressureAtTemperature:
        args.equilibriumPressureAtTemperature,
    });
    const blended = blendHeadroom(prior, learned);
    headroomBar = blended.value;
    headroomSupport = blended.support;

    targetPressure = snapPressure(
      targetEquilibriumPressure + headroomBar,
      minPressure,
      maxPressure,
      step,
    );

    // Avoid meaningless 0.05-bar oscillations. If the newly calculated target
    // is practically the current setting, leave the regulator alone.
    if (
      Math.abs(targetPressure - args.state.currentPressure) < 0.075 &&
      staysWithinTarget
    ) {
      targetPressure = args.state.currentPressure;
    }

    targetPressure = refinePressureWithForecast({
      baselinePressure: targetPressure,
      state: args.state,
      targetCarbonation: args.targetCarbonation,
      forecastAtPressure: (pressure) =>
        forecastAtPressure(pressure)?.predicted ?? null,
      coldReferenceTemperature,
      minPressure,
      maxPressure,
      step,
    });
  }

  const action: PressureV4Estimate["action"] =
    Math.abs(targetPressure - args.state.currentPressure) < 0.025
      ? "hold"
      : targetPressure > args.state.currentPressure
        ? "raise"
        : "lower";

  const targetForecast = forecastAtPressure(targetPressure);
  if (!targetForecast) return null;
  const predictedRaw = targetForecast.predicted;

  const candidates: PressureV4Candidate[] = [];
  const count = Math.round((maxPressure - minPressure) / step);
  const effectiveWeight = kineticRows.reduce(
    (sum, row) => sum + row.weight,
    0,
  );

  for (let index = 0; index <= count; index += 1) {
    const pressure = Number((minPressure + index * step).toFixed(2));
    const forecast = forecastAtPressure(pressure);
    if (!forecast) continue;
    const predicted = forecast.predicted;

    candidates.push({
      targetPressure: pressure,
      predictedCarbonation: Number(predicted.toFixed(3)),
      predictedDelta: Number(
        (predicted - args.state.carbonation).toFixed(3),
      ),
      supportCount: kineticRows.length,
      effectiveWeight,
    });
  }

  const meanDistance =
    kineticRows.reduce((sum, row) => sum + row.distance, 0) /
    kineticRows.length;
  const k25 = weightedQuantile(
    kineticRows,
    (row) => row.sample.kPerHour,
    0.25,
  );
  const k75 = weightedQuantile(
    kineticRows,
    (row) => row.sample.kPerHour,
    0.75,
  );
  const spread =
    k25 !== null && k75 !== null && k25 > 0
      ? k75 / k25
      : Infinity;

  const kineticConfidence: PressureV4Estimate["confidence"] =
    kineticRows.length >= 12 && meanDistance <= 2.5 && spread <= 2.5
      ? "high"
      : kineticRows.length >= 6 && meanDistance <= 4 && spread <= 4
        ? "medium"
        : "low";

  const empiricalResponse = targetForecast.response;
  const empiricalConfidence: PressureV4Estimate["confidence"] =
    empiricalResponse?.slopeIdentified &&
    empiricalResponse.support >= 12 &&
    empiricalResponse.actionSupport >= 5 &&
    empiricalResponse.meanDistance <= 3
      ? "high"
      : empiricalResponse?.slopeIdentified &&
          empiricalResponse.support >= 7 &&
          empiricalResponse.actionSupport >= 3 &&
          empiricalResponse.meanDistance <= 4.5
        ? "medium"
        : "low";

  const confidenceRank = { low: 0, medium: 1, high: 2 } as const;
  const confidence: PressureV4Estimate["confidence"] =
    confidenceRank[empiricalConfidence] >= confidenceRank[kineticConfidence]
      ? empiricalConfidence
      : kineticConfidence;

  const forecastInTargetWindow =
    Math.abs(predictedRaw - args.targetCarbonation) <=
    TARGET_TOLERANCE_VOL;
  const effectivelyStillCooling = isEffectivelyStillCooling(
    args.state,
    coldReferenceTemperature,
  );

  // Stable cold beer has a strict contract: either the 48h forecast lands
  // inside ±0.02 vol, or pressure-only is explicitly declared insufficient.
  // The only allowed forecast miss is while the beer is still in the active
  // cooling phase, where equilibrium/head-pressure history remains primary.
  const nearLowerPressureLimit =
    targetPressure <= minPressure + Math.max(step, 0.05);
  const nearUpperPressureLimit =
    targetPressure >= maxPressure - Math.max(step, 0.05);
  const requiresAtmosphericVenting =
    carbonationError < 0 &&
    !effectivelyStillCooling &&
    nearLowerPressureLimit &&
    minPressure >= 0 &&
    predictedRaw > args.targetCarbonation + TARGET_TOLERANCE_VOL;

  const trulyPressureLimited =
    (
      carbonationError > 0 &&
      nearUpperPressureLimit &&
      predictedRaw < args.targetCarbonation - TARGET_TOLERANCE_VOL
    ) ||
    requiresAtmosphericVenting;

  const actionEffect =
    action === "raise"
      ? predictedRaw - predictedCarbonationWithoutChangeRaw
      : action === "lower"
        ? predictedCarbonationWithoutChangeRaw - predictedRaw
        : 0;
  const neededEffect =
    carbonationError > 0
      ? Math.max(
          0,
          args.targetCarbonation -
            TARGET_TOLERANCE_VOL -
            predictedCarbonationWithoutChangeRaw,
        )
      : Math.max(
          0,
          predictedCarbonationWithoutChangeRaw -
            (args.targetCarbonation + TARGET_TOLERANCE_VOL),
        );
  const gapClosedFraction =
    neededEffect <= 0.001
      ? 1
      : clamp(actionEffect / neededEffect, 0, 1);

  // A pressure change is not an operational solution merely because it moves
  // carbonation by a few thousandths. For a stable cold tank, if the forecast
  // remains outside the target band, the proposed setpoint must close a
  // substantial share of the remaining gap. Otherwise classify pressure-only
  // as insufficient instead of presenting the headroom prior as a recommendation.
  const closeEnoughForRecheck =
    Math.abs(predictedRaw - args.targetCarbonation) <= 0.04;
  const responseTooSmall =
    action !== "hold" &&
    !forecastInTargetWindow &&
    (
      carbonationError > 0
        ? (
            !closeEnoughForRecheck &&
            (
              actionEffect < 0.015 ||
              gapClosedFraction < 0.5
            )
          )
        : actionEffect < 0.008
    );

  const responseEvidenceMissing =
    !empiricalResponse?.slopeIdentified &&
    kineticConfidence === "low";

  const decisionStatus: PressureV4Estimate["decisionStatus"] =
    forecastInTargetWindow
      ? "within_window"
      : effectivelyStillCooling
        ? "early_cooling_exception"
        : responseEvidenceMissing ||
            (responseTooSmall && confidence === "low")
          ? "insufficient_response_evidence"
          : trulyPressureLimited || responseTooSmall
            ? "pressure_only_insufficient"
            : "pressure_adjust_and_recheck";

  const pressureOnlyLikelyInsufficient =
    decisionStatus === "pressure_only_insufficient";

  return {
    targetPressure: Number(targetPressure.toFixed(2)),
    predictedCarbonation: Number(predictedRaw.toFixed(3)),
    predictedCarbonationWithoutChange: Number(
      predictedCarbonationWithoutChangeRaw.toFixed(3),
    ),
    targetCarbonation: args.targetCarbonation,
    error: Number(
      Math.abs(predictedRaw - args.targetCarbonation).toFixed(3),
    ),
    supportCount: kineticRows.length,
    confidence,
    accuracyPercent: accuracyPercent(kineticRows, kPerHour),
    candidates,
    kPerHour: Number(kPerHour.toFixed(5)),
    targetEquilibriumPressure: Number(
      targetEquilibriumPressure.toFixed(2),
    ),
    referenceTemperature: Number(refTemp.toFixed(1)),
    equilibriumSource,
    headroomBar: Number(headroomBar.toFixed(2)),
    headroomSupport,
    empiricalCorrectionVol: Number(
      (
        targetForecast.predicted -
        targetForecast.physicalPredicted
      ).toFixed(3),
    ),
    empiricalSupport: targetForecast.response?.support ?? 0,
    empiricalSlopeVolPerBar: Number(
      (targetForecast.response?.slope ?? 0).toFixed(3),
    ),
    empiricalDriftVol48h: Number(
      (targetForecast.response?.intercept ?? 0).toFixed(3),
    ),
    empiricalActionSupport:
      targetForecast.response?.actionSupport ?? 0,
    empiricalPassiveSupport:
      targetForecast.response?.passiveSupport ?? 0,
    empiricalModelUsed: targetForecast.empiricalWeight >= 0.65,
    pressureActionEffectVol: Number(actionEffect.toFixed(3)),
    pressureGapClosedFraction: Number(gapClosedFraction.toFixed(2)),
    action,
    pressureOnlyLikelyInsufficient,
    requiresAtmosphericVenting,
    forecastInTargetWindow,
    decisionStatus,
    targetWindowMin: Number(
      (args.targetCarbonation - TARGET_TOLERANCE_VOL).toFixed(2),
    ),
    targetWindowMax: Number(
      (args.targetCarbonation + TARGET_TOLERANCE_VOL).toFixed(2),
    ),
  };
}
