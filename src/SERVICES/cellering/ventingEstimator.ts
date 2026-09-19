import type {
  PressureV4DecisionState,
  PressureV4TransitionSample,
} from "./pressurePredictionV4";
import { evolveCarbonation } from "./pressureCarbonationPhysics";

export type VentingEstimate = {
  ventPressureBar: number;
  durationMinutes: number;
  predictedCarbonationAtClose: number;
  targetCarbonation: number;
  targetWindowMin: number;
  targetWindowMax: number;
  supportCount: number;
  kPerHour: number;
  confidence: "low" | "medium" | "high";
};

const TARGET_TOLERANCE_VOL = 0.02;

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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

  const total = sorted.reduce((sum, row) => sum + row.weight, 0);
  if (!sorted.length || total <= 0) return null;

  let running = 0;
  for (const row of sorted) {
    running += row.weight;
    if (running >= total / 2) return row.value;
  }
  return sorted[sorted.length - 1].value;
}

export function estimateVentingDuration(args: {
  transitions: PressureV4TransitionSample[];
  state: PressureV4DecisionState;
  targetCarbonation: number;
  ventPressureBar?: number;
  maxMinutes?: number;
  stepMinutes?: number;
}): VentingEstimate | null {
  const currentTemp = finite(args.state.currentTemp);
  if (
    currentTemp === null ||
    currentTemp > 9 ||
    !Number.isFinite(args.state.carbonation) ||
    !Number.isFinite(args.targetCarbonation)
  ) {
    return null;
  }

  const targetWindowMin =
    args.targetCarbonation - TARGET_TOLERANCE_VOL;
  const targetWindowMax =
    args.targetCarbonation + TARGET_TOLERANCE_VOL;

  if (args.state.carbonation <= targetWindowMax) return null;

  // Do not calculate a timed vent while the beer is still actively cooling:
  // the changing temperature makes desorption timing too unstable. In that
  // phase V4 should stay with the early-cooling pressure recommendation.
  if (args.state.cooling?.stillCooling) return null;

  const downward = args.transitions
    .filter((sample) => {
      const delta =
        sample.endCarbonation - sample.startCarbonation;
      const sampleTemp = finite(sample.currentTemp);
      return (
        delta <= -0.01 &&
        Number.isFinite(sample.kPerHour) &&
        sample.kPerHour > 0 &&
        sample.kPerHour < 1 &&
        sampleTemp !== null &&
        Math.abs(sampleTemp - currentTemp) <= 3 &&
        Math.abs(
          sample.startCarbonation - args.state.carbonation,
        ) <= 0.25
      );
    })
    .map((sample) => {
      const sampleTemp = finite(sample.currentTemp)!;
      const carbDistance =
        Math.abs(
          sample.startCarbonation - args.state.carbonation,
        ) / 0.12;
      const tempDistance =
        Math.abs(sampleTemp - currentTemp) / 2;
      const ageDistance =
        Math.abs(
          sample.hoursSinceT0 - args.state.hoursSinceT0,
        ) / 120;
      const distance =
        carbDistance * 1.8 +
        tempDistance +
        ageDistance * 0.5 +
        (sample.quality === "low"
          ? 1
          : sample.quality === "medium"
            ? 0.25
            : 0);

      return {
        sample,
        weight: 1 / (0.25 + distance * distance),
      };
    })
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 20);

  if (downward.length < 4) return null;

  const kPerHour = weightedMedian(
    downward.map((row) => ({
      value: row.sample.kPerHour,
      weight: row.weight,
    })),
  );
  if (kPerHour === null) return null;

  const ventPressureBar =
    finite(args.ventPressureBar) ?? 0;
  const maxMinutes =
    Math.max(30, Math.round(finite(args.maxMinutes) ?? 24 * 60));
  const stepMinutes =
    Math.max(1, Math.round(finite(args.stepMinutes) ?? 5));

  let best: {
    minutes: number;
    carbonation: number;
    error: number;
  } | null = null;

  for (
    let minutes = stepMinutes;
    minutes <= maxMinutes;
    minutes += stepMinutes
  ) {
    const predicted = evolveCarbonation({
      carbonation: args.state.carbonation,
      pressureBar: ventPressureBar,
      temperatureC: currentTemp,
      kPerHour,
      hours: minutes / 60,
    });
    if (predicted === null) continue;

    const error = Math.abs(
      predicted - args.targetCarbonation,
    );
    if (!best || error < best.error) {
      best = { minutes, carbonation: predicted, error };
    }

    if (
      predicted >= targetWindowMin &&
      predicted <= targetWindowMax
    ) {
      const confidence: VentingEstimate["confidence"] =
        downward.length >= 12
          ? "high"
          : downward.length >= 7
            ? "medium"
            : "low";

      return {
        ventPressureBar,
        durationMinutes: minutes,
        predictedCarbonationAtClose: Number(
          predicted.toFixed(3),
        ),
        targetCarbonation: args.targetCarbonation,
        targetWindowMin: Number(targetWindowMin.toFixed(2)),
        targetWindowMax: Number(targetWindowMax.toFixed(2)),
        supportCount: downward.length,
        kPerHour: Number(kPerHour.toFixed(5)),
        confidence,
      };
    }
  }

  return null;
}
