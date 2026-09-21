import {
  runPressureV9PhysicsValidation,
  type PressureV9ValidationBatch,
  type PressureV9ValidationResult,
} from "./pressurePredictionV9Validation";

export type PressureV9OutOfTimeResult = {
  seed: number;
  trainBatchCount: number;
  validationBatchCount: number;
  testBatchCount: number;
  trainUntil: string | null;
  validationUntil: string | null;
  learnedKPerHour: number | null;
  candidateKAcceptedOnValidation: boolean;
  train: PressureV9ValidationResult;
  validationCurrent: PressureV9ValidationResult;
  validationCandidate: PressureV9ValidationResult | null;
  testCurrent: PressureV9ValidationResult;
  testSelected: PressureV9ValidationResult;
  informationalGatePassed: boolean;
  informationalGateReasons: string[];
};

function caseDateKey(
  item: PressureV9ValidationResult["cases"][number],
): string {
  return String(
    item.endMeasurementId ||
      item.startMeasurementId ||
      "",
  ).slice(0, 10);
}

function subset(
  batches: PressureV9ValidationBatch[],
  ids: Set<string>,
): PressureV9ValidationBatch[] {
  return batches.filter((batch) =>
    ids.has(String(batch.batchId)),
  );
}

function validationImprovedEnough(
  current: PressureV9ValidationResult,
  candidate: PressureV9ValidationResult | null,
): boolean {
  if (
    !candidate ||
    current.carbonationMae === null ||
    candidate.carbonationMae === null
  ) {
    return false;
  }

  // Do not switch kinetics for a cosmetic improvement. Require at least 2%
  // on the middle chronological cohort before the newest cohort is opened.
  return (
    candidate.carbonationMae <=
    current.carbonationMae * 0.98
  );
}

function informationalGate(
  result: PressureV9ValidationResult,
): {
  passed: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];

  if (result.caseCount < 20) {
    reasons.push(
      `רק ${result.caseCount} אצוות ב-Test הכרונולוגי (נדרש לפחות 20)`,
    );
  }

  if (result.strictClosedCaseCount < 15) {
    reasons.push(
      `רק ${result.strictClosedCaseCount} חלונות סגורים באמת ב-Test (נדרש לפחות 15)`,
    );
  }

  if (
    result.strictClosedCarbonationMae === null ||
    result.strictClosedCarbonationMae > 0.035
  ) {
    reasons.push(
      `MAE בחלונות הסגורים ${result.strictClosedCarbonationMae?.toFixed(3) ?? "—"} vol (יעד ≤0.035)`,
    );
  }

  if (
    result.strictClosedCarbonationP90AbsError === null ||
    result.strictClosedCarbonationP90AbsError > 0.07
  ) {
    reasons.push(
      `P90 בחלונות הסגורים ${result.strictClosedCarbonationP90AbsError?.toFixed(3) ?? "—"} vol (יעד ≤0.070)`,
    );
  }

  if (
    result.strictClosedImprovementVsPersistence === null ||
    result.strictClosedImprovementVsPersistence < 0.05
  ) {
    reasons.push(
      `השיפור מול baseline בחלונות הסגורים ${result.strictClosedImprovementVsPersistence === null ? "—" : `${Math.round(result.strictClosedImprovementVsPersistence * 100)}%`} (יעד ≥5%)`,
    );
  }

  if (
    result.carbonationMae === null ||
    result.carbonationMae > 0.05
  ) {
    reasons.push(
      `MAE בכל ה-Test ${result.carbonationMae?.toFixed(3) ?? "—"} vol (יעד ≤0.050)`,
    );
  }

  return {
    passed: reasons.length === 0,
    reasons,
  };
}

/**
 * Chronological validation with no random train/test leakage.
 *
 * We intentionally keep one deterministic clean interval per batch here.
 * That gives every batch one vote and avoids making a batch with many
 * measurements look like many independent experiments.
 */
export function runPressureV9OutOfTimeValidation(args: {
  batches: PressureV9ValidationBatch[];
  seed?: number;
}): PressureV9OutOfTimeResult | null {
  const seed = args.seed ?? 0x20260921;

  const chronologicalBasis =
    runPressureV9PhysicsValidation({
      batches: args.batches,
      seed,
    });

  const ordered = chronologicalBasis.cases
    .slice()
    .sort((a, b) => {
      const dateCompare =
        caseDateKey(a).localeCompare(caseDateKey(b));
      if (dateCompare !== 0) return dateCompare;
      return String(a.batchId).localeCompare(
        String(b.batchId),
        undefined,
        { numeric: true },
      );
    });

  if (ordered.length < 40) return null;

  const trainEnd = Math.max(
    1,
    Math.floor(ordered.length * 0.7),
  );
  const validationEnd = Math.max(
    trainEnd + 1,
    Math.floor(ordered.length * 0.85),
  );

  const trainIds = new Set(
    ordered
      .slice(0, trainEnd)
      .map((item) => item.batchId),
  );
  const validationIds = new Set(
    ordered
      .slice(trainEnd, validationEnd)
      .map((item) => item.batchId),
  );
  const testIds = new Set(
    ordered
      .slice(validationEnd)
      .map((item) => item.batchId),
  );

  const trainBatches = subset(
    args.batches,
    trainIds,
  );
  const validationBatches = subset(
    args.batches,
    validationIds,
  );
  const testBatches = subset(
    args.batches,
    testIds,
  );

  const train = runPressureV9PhysicsValidation({
    batches: trainBatches,
    seed,
  });
  const learnedKPerHour =
    train.inferredKMedianPerHour;

  const validationCurrent =
    runPressureV9PhysicsValidation({
      batches: validationBatches,
      seed,
    });

  const validationCandidate =
    learnedKPerHour === null
      ? null
      : runPressureV9PhysicsValidation({
          batches: validationBatches,
          seed,
          kPerHourOverride: learnedKPerHour,
        });

  const candidateKAcceptedOnValidation =
    validationImprovedEnough(
      validationCurrent,
      validationCandidate,
    );

  // The newest cohort is evaluated only after the choice above has been made
  // using train + middle validation. No parameter is selected from Test.
  const testCurrent =
    runPressureV9PhysicsValidation({
      batches: testBatches,
      seed,
    });

  const testSelected =
    candidateKAcceptedOnValidation &&
    learnedKPerHour !== null
      ? runPressureV9PhysicsValidation({
          batches: testBatches,
          seed,
          kPerHourOverride:
            learnedKPerHour,
        })
      : testCurrent;

  const gate = informationalGate(
    testSelected,
  );

  return {
    seed,
    trainBatchCount: train.caseCount,
    validationBatchCount:
      validationCurrent.caseCount,
    testBatchCount: testSelected.caseCount,
    trainUntil:
      ordered[trainEnd - 1]
        ? caseDateKey(ordered[trainEnd - 1])
        : null,
    validationUntil:
      ordered[validationEnd - 1]
        ? caseDateKey(ordered[validationEnd - 1])
        : null,
    learnedKPerHour,
    candidateKAcceptedOnValidation,
    train,
    validationCurrent,
    validationCandidate,
    testCurrent,
    testSelected,
    informationalGatePassed: gate.passed,
    informationalGateReasons: gate.reasons,
  };
}
