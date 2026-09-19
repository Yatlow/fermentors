import type { PressureV4Exposure, PressureV4DecisionState } from "./pressurePredictionV4";

export type BottomCarbonationSample = {
  batchId?: string;
  brewDay?: number | null;
  temp?: number | null;
  carbonationBefore: number;
  pressureBefore?: number | null;
  startPressure: number;
  closePressure: number;
  durationMinutes: number;
  carbonationAfter: number;
  carbonationDelta: number;
  elapsedDays: number;
  success?: boolean;
  state?: {
    hoursSinceT0: number;
    currentPressure: number;
    currentTemp: number | null;
    exposure: PressureV4Exposure;
    quality: "low" | "medium" | "high";
  } | null;
};

export type BottomCarbonationEstimate = {
  startPressure: number;
  closePressure: number;
  durationMinutes: number;
  sampleCount: number;
  confidence: "medium" | "high";
  activationThreshold: number;
  expectedCarbGain: number;
  responsePerMinute: number;
  expectedDays: number;
};

export const BOTTOM_CARBONATION_CUTOFF_VOL = 2.15;

export type BottomCarbonationModel = {
  style: string;
  samples: BottomCarbonationSample[];
  sampleCount?: number;
  updatedAt?: string;
};

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function median(values: number[]): number | null {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values: number[], fraction: number): number | null {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.round((sorted.length - 1) * fraction)),
  );
  return sorted[index];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundToStep(value: number, step: number): number {
  return Math.round(value / step) * step;
}

export function getBottomCarbonationActivationThreshold(
  samples: BottomCarbonationSample[],
): { threshold: number; sampleCount: number } | null {
  const values = samples
    .filter((sample) => sample?.success !== false)
    .filter((sample) => {
      const duration = finiteNumber(sample.durationMinutes);
      const delta = finiteNumber(sample.carbonationDelta);
      return duration !== null && duration >= 5 && duration <= 360 &&
        delta !== null && delta >= 0.02;
    })
    .map((sample) => finiteNumber(sample.carbonationBefore))
    .filter((value): value is number => value !== null);

  if (values.length < 5) return null;

  return {
    threshold: BOTTOM_CARBONATION_CUTOFF_VOL,
    sampleCount: values.length,
  };
}

export function estimateBottomCarbonation(args: {
  samples: BottomCarbonationSample[];
  currentCarbonation: number;
  targetCarbonation: number;
  currentPressure?: number | null;
  brewDay?: number | null;
  temp?: number | null;
  state?: PressureV4DecisionState | null;
  equilibriumPressure?: (temperature: number | null) => number | null;
}): BottomCarbonationEstimate | null {
  const desiredGain = args.targetCarbonation - args.currentCarbonation;
  if (!Number.isFinite(desiredGain) || desiredGain <= 0.04) return null;

  const usable = args.samples
    .filter((sample) => sample?.success !== false)
    .map((sample) => ({
      ...sample,
      brewDay: finiteNumber(sample.brewDay),
      temp: finiteNumber(sample.temp),
      pressureBefore: finiteNumber(sample.pressureBefore),
      carbonationBefore: finiteNumber(sample.carbonationBefore),
      startPressure: finiteNumber(sample.startPressure),
      closePressure: finiteNumber(sample.closePressure),
      durationMinutes: finiteNumber(sample.durationMinutes),
      carbonationDelta: finiteNumber(sample.carbonationDelta),
      elapsedDays: finiteNumber(sample.elapsedDays),
    }))
    .filter((sample) =>
      sample.carbonationBefore !== null &&
      sample.startPressure !== null &&
      sample.closePressure !== null &&
      sample.durationMinutes !== null &&
      sample.carbonationDelta !== null &&
      sample.elapsedDays !== null &&
      sample.durationMinutes >= 5 &&
      sample.durationMinutes <= 360 &&
      sample.carbonationDelta >= 0.02 &&
      sample.elapsedDays >= 1 &&
      sample.elapsedDays <= 4
    );

  if (usable.length < 5) return null;

  const activationThreshold = BOTTOM_CARBONATION_CUTOFF_VOL;

  if (args.currentCarbonation >= BOTTOM_CARBONATION_CUTOFF_VOL) return null;

  const currentPressure = finiteNumber(args.currentPressure);
  const brewDay = finiteNumber(args.brewDay);
  const temp = finiteNumber(args.temp);

  const currentState = args.state ?? null;

  const stateDistance = (sample: typeof usable[number]): number => {
    let score = Math.abs(sample.carbonationBefore! - args.currentCarbonation) * 5;

    if (brewDay !== null && sample.brewDay !== null) {
      score += Math.abs(sample.brewDay - brewDay) * 0.08;
    }
    if (temp !== null && sample.temp !== null) {
      score += Math.abs(sample.temp - temp) * 0.25;
    }
    if (currentPressure !== null && sample.pressureBefore !== null) {
      score += Math.abs(sample.pressureBefore - currentPressure) * 0.3;
    }

    const historicalState = sample.state;
    if (currentState && historicalState) {
      score += Math.min(
        2,
        Math.abs(historicalState.hoursSinceT0 - currentState.hoursSinceT0) / 48,
      );

      const currentMean24 = currentState.exposure.pressureMean24h;
      const sampleMean24 = historicalState.exposure.pressureMean24h;
      if (currentMean24 !== null && sampleMean24 !== null) {
        score += Math.abs(sampleMean24 - currentMean24) * 1.2;
      }

      const currentMean48 = currentState.exposure.pressureMean48h;
      const sampleMean48 = historicalState.exposure.pressureMean48h;
      if (currentMean48 !== null && sampleMean48 !== null) {
        score += Math.abs(sampleMean48 - currentMean48) * 0.8;
      }

      const currentExposure = currentState.exposure.equilibriumDeltaBarHours;
      let sampleExposure = historicalState.exposure.equilibriumDeltaBarHours;

      if (
        sampleExposure === null &&
        args.equilibriumPressure &&
        historicalState.exposure.hoursSinceT0 > 0
      ) {
        const sampleTemp =
          historicalState.exposure.temperatureMean ??
          historicalState.currentTemp ??
          null;
        const equilibrium = args.equilibriumPressure(sampleTemp);
        const pressureMean = historicalState.exposure.pressureMean;
        if (equilibrium !== null && pressureMean !== null) {
          sampleExposure =
            (pressureMean - equilibrium) *
            historicalState.exposure.hoursSinceT0;
        }
      }

      if (currentExposure !== null && sampleExposure !== null) {
        score += Math.min(2.5, Math.abs(sampleExposure - currentExposure) / 24);
      }

      if (historicalState.quality === "low") score += 1.5;
    } else if (currentState) {
      // Legacy samples remain usable while the V4 backfill replaces them,
      // but prefer samples carrying the full tank state.
      score += 1.25;
    }

    return score;
  };

  const similar = usable
    .sort((a, b) => stateDistance(a) - stateDistance(b))
    .slice(0, 30);

  if (similar.length < 5) return null;

  const responsePerMinute = median(
    similar
      .map((sample) => sample.carbonationDelta! / sample.durationMinutes!)
      .filter((rate) => Number.isFinite(rate) && rate >= 0.0001 && rate <= 0.02),
  );
  const startPressure = median(similar.map((sample) => sample.startPressure!));
  const closePressure = median(similar.map((sample) => sample.closePressure!));
  if (
    responsePerMinute === null ||
    startPressure === null ||
    closePressure === null
  ) {
    return null;
  }

  const durations = similar.map((sample) => sample.durationMinutes!);
  const lowDuration = Math.max(5, percentile(durations, 0.1) ?? 10);
  const highDuration = Math.min(240, percentile(durations, 0.9) ?? 180);
  const rawDuration = desiredGain / responsePerMinute;
  const durationMinutes = Math.round(
    clamp(rawDuration, lowDuration, Math.max(lowDuration, highDuration)),
  );

  const expectedDays = Math.max(
    1,
    Math.round(median(similar.map((sample) => sample.elapsedDays!)) ?? 1),
  );

  return {
    startPressure: Number(roundToStep(startPressure, 0.05).toFixed(2)),
    closePressure: Number(roundToStep(closePressure, 0.05).toFixed(2)),
    durationMinutes,
    sampleCount: similar.length,
    confidence: similar.length >= 12 ? "high" : "medium",
    activationThreshold,
    expectedCarbGain: Number((responsePerMinute * durationMinutes).toFixed(2)),
    responsePerMinute: Number(responsePerMinute.toFixed(5)),
    expectedDays,
  };
}

