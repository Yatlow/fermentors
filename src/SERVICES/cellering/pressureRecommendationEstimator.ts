export type PressureResponseSample = {
  batchId?: string;
  brewDay?: number | null;
  temp?: number | null;
  carbonationBefore: number;
  pressureBefore: number;
  targetPressure: number;
  pressureDelta: number;
  carbonationAfter: number;
  carbonationDelta: number;
  elapsedDays: number;
  pressureMeanToDate?: number | null;
  pressureMeanLast3Days?: number | null;
  pressureMeanLast7Days?: number | null;
  success?: boolean;
};

export type PressureRecommendationEstimate = {
  targetPressure: number;
  pressureDelta: number;
  sampleCount: number;
  confidence: "medium" | "high";
  expectedDays: number;
  responsePerBar: number;
};

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundToStep(value: number, step: number): number {
  return Math.round(value / step) * step;
}

export function estimatePressureTarget(args: {
  samples: PressureResponseSample[];
  currentCarbonation: number;
  targetCarbonation: number;
  currentPressure: number;
  brewDay?: number | null;
  temp?: number | null;
  pressureMeanToDate?: number | null;
  pressureMeanLast3Days?: number | null;
  pressureMeanLast7Days?: number | null;
}): PressureRecommendationEstimate | null {
  const {
    currentCarbonation,
    targetCarbonation,
    currentPressure,
    brewDay = null,
    temp = null,
  } = args;
  const desiredCarbDelta = targetCarbonation - currentCarbonation;
  if (
    !Number.isFinite(desiredCarbDelta) ||
    Math.abs(desiredCarbDelta) < 0.01 ||
    !Number.isFinite(currentPressure)
  ) return null;

  const direction = Math.sign(desiredCarbDelta);
  const valid = args.samples
    .filter((sample) => sample?.success !== false)
    .map((sample) => ({
      ...sample,
      pressureDelta: finiteNumber(sample.pressureDelta),
      carbonationDelta: finiteNumber(sample.carbonationDelta),
      elapsedDays: finiteNumber(sample.elapsedDays),
      brewDay: finiteNumber(sample.brewDay),
      temp: finiteNumber(sample.temp),
    }))
    .filter((sample) =>
      sample.pressureDelta !== null &&
      sample.carbonationDelta !== null &&
      sample.elapsedDays !== null &&
      Math.sign(sample.pressureDelta) === direction &&
      Math.sign(sample.carbonationDelta) === direction &&
      Math.abs(sample.pressureDelta) >= 0.02 &&
      Math.abs(sample.carbonationDelta) >= 0.01 &&
      sample.elapsedDays >= 1 &&
      sample.elapsedDays <= 5
    )
    .sort((a, b) => {
      const contextDistance = (sample: typeof a) => {
        let score = 0;
        if (brewDay !== null && sample.brewDay !== null) {
          score += Math.abs(sample.brewDay - brewDay) * 0.15;
        }
        if (temp !== null && sample.temp !== null) {
          score += Math.abs(sample.temp - temp) * 0.5;
        }

        score += Math.abs(sample.carbonationBefore - currentCarbonation) * 4;
        score += Math.abs(sample.pressureBefore - currentPressure) * 1.5;

        const sampleMeanToDate = finiteNumber(sample.pressureMeanToDate);
        const sampleMean3 = finiteNumber(sample.pressureMeanLast3Days);
        const sampleMean7 = finiteNumber(sample.pressureMeanLast7Days);

        if (args.pressureMeanToDate != null && sampleMeanToDate !== null) {
          score += Math.abs(sampleMeanToDate - args.pressureMeanToDate) * 0.5;
        }
        if (args.pressureMeanLast3Days != null && sampleMean3 !== null) {
          score += Math.abs(sampleMean3 - args.pressureMeanLast3Days) * 1.5;
        }
        if (args.pressureMeanLast7Days != null && sampleMean7 !== null) {
          score += Math.abs(sampleMean7 - args.pressureMeanLast7Days);
        }

        return score;
      };

      return contextDistance(a) - contextDistance(b);
    })
    .slice(0, 40);

  if (valid.length < 5) return null;

  const responseRates = valid
    .map((sample) => Math.abs(sample.carbonationDelta! / sample.pressureDelta!))
    .filter((rate) => Number.isFinite(rate) && rate >= 0.05 && rate <= 4);
  const responsePerBar = median(responseRates);
  if (responsePerBar === null || responseRates.length < 5) return null;

  const rawDelta = desiredCarbDelta / responsePerBar;
  const boundedDelta = clamp(rawDelta, -0.35, 0.35);
  const roundedDelta = roundToStep(boundedDelta, 0.05);
  if (Math.abs(roundedDelta) < 0.05) return null;

  const expectedDaysMedian = median(
    valid.map((sample) => sample.elapsedDays!).filter(Number.isFinite),
  );
  const targetPressure = clamp(
    roundToStep(currentPressure + roundedDelta, 0.05),
    0,
    2.2,
  );

  return {
    targetPressure: Number(targetPressure.toFixed(2)),
    pressureDelta: Number((targetPressure - currentPressure).toFixed(2)),
    sampleCount: valid.length,
    confidence: valid.length >= 12 ? "high" : "medium",
    expectedDays: Math.max(1, Math.round(expectedDaysMedian ?? 2)),
    responsePerBar: Number(responsePerBar.toFixed(3)),
  };
}
