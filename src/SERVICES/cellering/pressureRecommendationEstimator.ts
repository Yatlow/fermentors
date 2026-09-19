export type PressureResponseSample = {
  batchId?: string;
  brewDay?: number | null;
  temp?: number | null;
  carbonationBefore: number;
  carbAgeAtAdjustment?: number | null;
  pressureBefore: number;
  targetPressure: number;
  pressureDelta: number;
  pressureAfter?: number | null;
  carbonationAfter: number;
  carbonationDelta: number;
  elapsedDays: number;
  pressureMeanToDate?: number | null;
  pressureMeanLast3Days?: number | null;
  pressureMeanLast7Days?: number | null;
  success?: boolean;
};

export type PressureEquilibriumObservation = {
  batchId?: string;
  date?: string;
  brewDay?: number | null;
  temp?: number | null;
  carbonation: number;
  pressure: number;
};

export type PressureModelCalibration = {
  responseMultiplier?: number | null;
  evaluatedSamples?: number | null;
  directionSuccessRate?: number | null;
  within005Rate?: number | null;
  meanAbsoluteError?: number | null;
  equilibriumPressure?: number | null;
  equilibriumSampleCount?: number | null;
  updatedAt?: string;
};

export type PressureRecommendationEstimate = {
  targetPressure: number;
  /** Offset above/below the learned equilibrium pressure. */
  pressureDelta: number;
  /** Physical change from the pressure measured right now. */
  currentPressureChange: number;
  equilibriumPressure: number;
  equilibriumSampleCount: number;
  sampleCount: number;
  confidence: "medium" | "high";
  expectedDays: number;
  responsePerBar: number;
  calibrationMultiplier: number;
  calibrationEvaluatedSamples: number;
  calibrationWithin005Rate: number | null;
};

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
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
  carbAgeAtAdjustment?: number | null;
  calibration?: PressureModelCalibration | null;
  equilibriumObservations?: PressureEquilibriumObservation[];
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

  const mapped = args.samples
    .map((sample) => ({
      ...sample,
      carbonationBefore: finiteNumber(sample.carbonationBefore),
      carbonationAfter: finiteNumber(sample.carbonationAfter),
      pressureBefore: finiteNumber(sample.pressureBefore),
      targetPressure: finiteNumber(sample.targetPressure),
      pressureAfter: finiteNumber(sample.pressureAfter),
      carbonationDelta: finiteNumber(sample.carbonationDelta),
      elapsedDays: finiteNumber(sample.elapsedDays),
      brewDay: finiteNumber(sample.brewDay),
      temp: finiteNumber(sample.temp),
    }))
    .filter((sample) =>
      sample.carbonationBefore !== null &&
      sample.carbonationAfter !== null &&
      sample.pressureBefore !== null &&
      sample.targetPressure !== null &&
      sample.carbonationDelta !== null &&
      sample.elapsedDays !== null &&
      sample.elapsedDays >= 1 &&
      sample.elapsedDays <= 5
    );

  const currentTemp = finiteNumber(temp);
  const currentBrewDay = finiteNumber(brewDay);

  // Equilibrium is a style/target property, not a property of the current tank.
  // Learn it only from batches that show a genuinely stable cold period:
  // carbonation close to target for several observations and pressure staying
  // within a narrow band. Each batch contributes one median so long batches
  // cannot dominate the style-level equilibrium.
  const equilibriumRows = (args.equilibriumObservations ?? [])
    .map((observation) => ({
      batchId: String(observation.batchId ?? ""),
      date: String(observation.date ?? ""),
      pressure: finiteNumber(observation.pressure),
      carbonation: finiteNumber(observation.carbonation),
      temp: finiteNumber(observation.temp),
    }))
    .filter((observation) =>
      observation.batchId &&
      observation.pressure !== null &&
      observation.carbonation !== null &&
      (observation.temp === null || observation.temp <= 9) &&
      Math.abs(observation.carbonation - targetCarbonation) <= 0.05
    );

  const equilibriumByBatch = new Map<string, typeof equilibriumRows>();
  equilibriumRows.forEach((row) => {
    const rows = equilibriumByBatch.get(row.batchId) ?? [];
    rows.push(row);
    equilibriumByBatch.set(row.batchId, rows);
  });

  const stableBatchEquilibria: number[] = [];
  equilibriumByBatch.forEach((rows) => {
    const ordered = [...rows].sort((a, b) => a.date.localeCompare(b.date));
    if (ordered.length < 3) return;

    // Any 3+ observation window with <=0.10 bar total spread is treated as a
    // stable period. We use the longest qualifying tail ending at each point,
    // then contribute only one median for the batch.
    let bestWindow: typeof ordered = [];
    for (let end = 0; end < ordered.length; end += 1) {
      for (let start = 0; start <= end - 2; start += 1) {
        const window = ordered.slice(start, end + 1);
        const pressures = window.map((row) => row.pressure!);
        const spread = Math.max(...pressures) - Math.min(...pressures);
        if (spread <= 0.10 && window.length > bestWindow.length) {
          bestWindow = window;
        }
      }
    }

    if (bestWindow.length >= 3) {
      const batchMedian = median(bestWindow.map((row) => row.pressure!));
      if (batchMedian !== null) stableBatchEquilibria.push(batchMedian);
    }
  });

  const observationCandidates = stableBatchEquilibria;

  const responseOutcomeCandidates = mapped
    .filter((sample) =>
      sample.pressureAfter !== null &&
      Math.abs(sample.carbonationAfter! - targetCarbonation) <= 0.1
    )
    .map((sample) => sample.pressureAfter!);

  const learnedCalibrationEquilibrium =
    finiteNumber(args.calibration?.equilibriumPressure);

  let equilibriumPressure: number | null = null;
  let equilibriumSampleCount = 0;

  if (observationCandidates.length >= 5) {
    equilibriumPressure = median(observationCandidates);
    equilibriumSampleCount = observationCandidates.length;
  } else if (responseOutcomeCandidates.length >= 5) {
    equilibriumPressure = median(responseOutcomeCandidates);
    equilibriumSampleCount = responseOutcomeCandidates.length;
  } else if (learnedCalibrationEquilibrium !== null) {
    equilibriumPressure = learnedCalibrationEquilibrium;
    equilibriumSampleCount = Math.max(
      responseOutcomeCandidates.length,
      Math.round(Number(args.calibration?.equilibriumSampleCount) || 0),
    );
  }

  if (equilibriumPressure === null) return null;
  equilibriumPressure = clamp(equilibriumPressure, 0, 1.5);

  const direction = Math.sign(desiredCarbDelta);

  const valid = mapped
    .filter((sample) => sample.success !== false)
    .filter((sample) => {
      const dose = sample.targetPressure! - equilibriumPressure!;
      return (
        Math.sign(dose) === direction &&
        Math.sign(sample.carbonationDelta!) === direction &&
        Math.abs(dose) >= 0.02 &&
        Math.abs(sample.carbonationDelta!) >= 0.01
      );
    })
    .sort((a, b) => {
      const contextDistance = (sample: typeof a) => {
        let score = 0;
        if (brewDay !== null && sample.brewDay !== null) {
          score += Math.abs(sample.brewDay - brewDay) * 0.15;
        }
        if (temp !== null && sample.temp !== null) {
          score += Math.abs(sample.temp - temp) * 0.5;
        }

        score += Math.abs(sample.carbonationBefore! - currentCarbonation) * 4;
        score += Math.abs(sample.pressureBefore! - currentPressure) * 0.75;

        const sampleMeanToDate = finiteNumber(sample.pressureMeanToDate);
        const sampleMean3 = finiteNumber(sample.pressureMeanLast3Days);
        const sampleMean7 = finiteNumber(sample.pressureMeanLast7Days);
        const sampleCarbAge = finiteNumber(sample.carbAgeAtAdjustment);

        if (args.carbAgeAtAdjustment != null && sampleCarbAge !== null) {
          score += Math.abs(sampleCarbAge - args.carbAgeAtAdjustment) * 0.75;
        }
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
    .map((sample) => {
      const dose = Math.abs(sample.targetPressure! - equilibriumPressure!);
      return dose >= 0.02
        ? Math.abs(sample.carbonationDelta! / dose)
        : NaN;
    })
    .filter((rate) => Number.isFinite(rate) && rate >= 0.05 && rate <= 4);

  const baseResponsePerBar = median(responseRates);
  if (baseResponsePerBar === null || responseRates.length < 5) return null;

  const calibrationMultiplierRaw = finiteNumber(args.calibration?.responseMultiplier);
  const calibrationMultiplier = calibrationMultiplierRaw === null
    ? 1
    : clamp(calibrationMultiplierRaw, 0.7, 1.3);
  const responsePerBar = baseResponsePerBar * calibrationMultiplier;

  const rawOffset = desiredCarbDelta / responsePerBar;
  const boundedOffset = clamp(rawOffset, -0.35, 0.35);
  const roundedOffset = roundToStep(boundedOffset, 0.05);
  if (Math.abs(roundedOffset) < 0.05) return null;

  const expectedDaysMedian = median(
    valid.map((sample) => sample.elapsedDays!).filter(Number.isFinite),
  );

  const targetPressure = clamp(
    roundToStep(equilibriumPressure + roundedOffset, 0.05),
    0,
    2.2,
  );

  const calibrationEvaluatedSamples = Math.max(
    0,
    Math.round(Number(args.calibration?.evaluatedSamples) || 0),
  );
  const calibrationWithin005Rate = finiteNumber(args.calibration?.within005Rate);
  const calibrationReliable =
    calibrationEvaluatedSamples < 8 ||
    calibrationWithin005Rate === null ||
    calibrationWithin005Rate >= 0.55;

  return {
    targetPressure: Number(targetPressure.toFixed(2)),
    pressureDelta: Number((targetPressure - equilibriumPressure).toFixed(2)),
    currentPressureChange: Number((targetPressure - currentPressure).toFixed(2)),
    equilibriumPressure: Number(equilibriumPressure.toFixed(2)),
    equilibriumSampleCount,
    sampleCount: valid.length,
    confidence: valid.length >= 12 && calibrationReliable ? "high" : "medium",
    expectedDays: Math.max(1, Math.round(expectedDaysMedian ?? 2)),
    responsePerBar: Number(responsePerBar.toFixed(3)),
    calibrationMultiplier: Number(calibrationMultiplier.toFixed(3)),
    calibrationEvaluatedSamples,
    calibrationWithin005Rate,
  };
}
