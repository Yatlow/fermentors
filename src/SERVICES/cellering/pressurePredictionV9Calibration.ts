import type {
  PressureV9TankClass,
} from "./pressurePredictionV9Physics";
import {
  runPressureV9PhysicsValidation,
  type PressureV9ValidationBatch,
  type PressureV9ValidationResult,
} from "./pressurePredictionV9Validation";

export type PressureV9CalibrationParams = {
  vesselVolumeByTankClass: Record<
    PressureV9TankClass,
    number
  >;
  kPerHour: number;
};

export type PressureV9CalibrationRound = {
  name: string;
  params: PressureV9CalibrationParams;
  trainMae: number | null;
  validationMae: number | null;
  validationP90: number | null;
};

export type PressureV9CalibrationResult = {
  seed: number;
  fittingBatchCount: number;
  trainBatchCount: number;
  validationBatchCount: number;
  lockedTestBatchCount: number;
  reportOnlyBatchCount: number;
  excludedFromFitStyles: string[];

  initialParams: PressureV9CalibrationParams;
  calibratedParams: PressureV9CalibrationParams;

  currentV9LockedTest: PressureV9ValidationResult;
  calibratedLockedTest: PressureV9ValidationResult;
  improvementOnLockedTest: number | null;

  rounds: PressureV9CalibrationRound[];
};

const DEFAULT_VOLUMES: Record<
  PressureV9TankClass,
  number
> = {
  single: 1300,
  double: 3000,
  triple: 4000,
};

function normalizeStyle(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)[0];
}

function isFitStyle(style: string): boolean {
  const normalized = normalizeStyle(style);

  if (
    normalized === "לאגר" ||
    normalized === "lager" ||
    normalized === "הופי" ||
    normalized === "hoppy"
  ) {
    return false;
  }

  return true;
}

function hash32(text: string): number {
  let hash = 2166136261;
  for (const char of text) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function splitBucket(
  batchId: string,
  seed: number,
): number {
  return hash32(`${seed}|${batchId}`) % 10;
}

function median(values: number[]): number | null {
  const clean = values
    .filter(Number.isFinite)
    .slice()
    .sort((a, b) => a - b);
  if (!clean.length) return null;

  const middle = Math.floor(clean.length / 2);
  return clean.length % 2
    ? clean[middle]
    : (clean[middle - 1] + clean[middle]) / 2;
}

function score(
  result: PressureV9ValidationResult,
): number {
  if (
    result.carbonationMae === null ||
    result.caseCount < 3
  ) {
    return Number.POSITIVE_INFINITY;
  }

  // Carbonation accuracy is primary, but geometry is not identifiable
  // enough from carbonation alone because vessel volume and k can compensate
  // for one another. End pressure is an independent physical observable, so
  // include it as a secondary constraint. This is still dominated by carb MAE.
  return (
    result.carbonationMae +
    0.2 * (result.carbonationP90AbsError ?? 0) +
    0.08 * (result.pressureMae ?? 0) +
    0.02 * (result.pressureP90AbsError ?? 0)
  );
}

function evaluate(args: {
  batches: PressureV9ValidationBatch[];
  seed: number;
  params: PressureV9CalibrationParams;
  usePerBatchK?: boolean;
}): PressureV9ValidationResult {
  return runPressureV9PhysicsValidation({
    batches: args.batches,
    seed: args.seed,
    vesselVolumeByTankClass:
      args.params.vesselVolumeByTankClass,
    kPerHourOverride:
      args.usePerBatchK
        ? null
        : args.params.kPerHour,
  });
}

function roundNumber(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function volumeCandidates(
  tankClass: PressureV9TankClass,
  current: number,
  fine: boolean,
): number[] {
  let low: number;
  let high: number;
  let step: number;

  if (fine) {
    low = current - 175;
    high = current + 175;
    step = 25;
  } else if (tankClass === "single") {
    low = 1050;
    high = 1600;
    step = 50;
  } else if (tankClass === "double") {
    low = 2400;
    high = 3300;
    step = 50;
  } else {
    low = 3400;
    high = 4600;
    step = 50;
  }

  const values: number[] = [];
  for (let value = low; value <= high; value += step) {
    values.push(Math.round(value));
  }
  if (!values.includes(Math.round(current))) {
    values.push(Math.round(current));
  }

  return Array.from(new Set(values))
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
}

function kCandidates(
  current: number,
  fine: boolean,
): number[] {
  const values: number[] = [];

  if (fine) {
    const low = Math.max(0.0002, current * 0.55);
    const high = Math.min(0.05, current * 1.45);
    for (let index = 0; index <= 24; index += 1) {
      values.push(
        low + (high - low) * index / 24,
      );
    }
  } else {
    const low = Math.log(0.00035);
    const high = Math.log(0.02);
    for (let index = 0; index <= 32; index += 1) {
      values.push(
        Math.exp(
          low + (high - low) * index / 32,
        ),
      );
    }
  }

  values.push(current);
  return Array.from(
    new Set(
      values.map((value) =>
        roundNumber(value, 7),
      ),
    ),
  ).sort((a, b) => a - b);
}

function topTrainCandidates<T>(args: {
  values: T[];
  evaluateValue: (
    value: T,
  ) => PressureV9ValidationResult;
  topN?: number;
}): {
  value: T;
  result: PressureV9ValidationResult;
}[] {
  return args.values
    .map((value) => ({
      value,
      result: args.evaluateValue(value),
    }))
    .sort(
      (a, b) =>
        score(a.result) - score(b.result),
    )
    .slice(0, args.topN ?? 5);
}

function chooseOnValidation<T>(args: {
  trainTop: {
    value: T;
    result: PressureV9ValidationResult;
  }[];
  evaluateValue: (
    value: T,
  ) => PressureV9ValidationResult;
}): {
  value: T;
  train: PressureV9ValidationResult;
  validation: PressureV9ValidationResult;
} | null {
  const candidates = args.trainTop
    .map((item) => ({
      value: item.value,
      train: item.result,
      validation:
        args.evaluateValue(item.value),
    }))
    .filter(
      (item) =>
        Number.isFinite(score(item.validation)),
    )
    .sort(
      (a, b) =>
        score(a.validation) -
        score(b.validation),
    );

  return candidates[0] ?? null;
}

function cloneParams(
  params: PressureV9CalibrationParams,
): PressureV9CalibrationParams {
  return {
    vesselVolumeByTankClass: {
      ...params.vesselVolumeByTankClass,
    },
    kPerHour: params.kPerHour,
  };
}

function recordRound(args: {
  name: string;
  params: PressureV9CalibrationParams;
  train: PressureV9ValidationResult;
  validation: PressureV9ValidationResult;
}): PressureV9CalibrationRound {
  return {
    name: args.name,
    params: cloneParams(args.params),
    trainMae: args.train.carbonationMae,
    validationMae:
      args.validation.carbonationMae,
    validationP90:
      args.validation.carbonationP90AbsError,
  };
}

export function calibratePressureV9(args: {
  batches: PressureV9ValidationBatch[];
  seed: number;
}): PressureV9CalibrationResult | null {
  const fitting = args.batches.filter(
    (batch) => isFitStyle(batch.style),
  );
  const reportOnly = args.batches.filter(
    (batch) => !isFitStyle(batch.style),
  );

  if (fitting.length < 24) return null;

  const train: PressureV9ValidationBatch[] = [];
  const validation: PressureV9ValidationBatch[] = [];
  const lockedTest: PressureV9ValidationBatch[] = [];

  for (const batch of fitting) {
    const bucket = splitBucket(
      batch.batchId,
      args.seed,
    );

    if (bucket <= 5) {
      train.push(batch);
    } else if (bucket <= 7) {
      validation.push(batch);
    } else {
      lockedTest.push(batch);
    }
  }

  if (
    train.length < 12 ||
    validation.length < 6 ||
    lockedTest.length < 6
  ) {
    return null;
  }

  const initialK =
    median(
      train.map((batch) => batch.kPerHour),
    ) ?? 0.0025;

  const initialParams: PressureV9CalibrationParams = {
    vesselVolumeByTankClass: {
      ...DEFAULT_VOLUMES,
    },
    kPerHour: initialK,
  };
  let params = cloneParams(initialParams);
  const rounds: PressureV9CalibrationRound[] = [];

  const initialTrain = evaluate({
    batches: train,
    seed: args.seed,
    params,
  });
  const initialValidation = evaluate({
    batches: validation,
    seed: args.seed,
    params,
  });
  rounds.push(
    recordRound({
      name: "baseline",
      params,
      train: initialTrain,
      validation: initialValidation,
    }),
  );

  const calibrateGeometry = (
    tankClass: PressureV9TankClass,
    fine: boolean,
    name: string,
  ) => {
    const trainForClass = train.filter((batch) => {
      const tank = batch.tankNumber;
      const cls: PressureV9TankClass =
        tank < 5
          ? "single"
          : tank < 9
            ? "double"
            : "triple";
      return cls === tankClass;
    });
    const validationForClass =
      validation.filter((batch) => {
        const tank = batch.tankNumber;
        const cls: PressureV9TankClass =
          tank < 5
            ? "single"
            : tank < 9
              ? "double"
              : "triple";
        return cls === tankClass;
      });

    if (
      trainForClass.length < 5 ||
      validationForClass.length < 3
    ) {
      return;
    }

    const candidates = volumeCandidates(
      tankClass,
      params.vesselVolumeByTankClass[tankClass],
      fine,
    );

    const trainTop = topTrainCandidates({
      values: candidates,
      evaluateValue: (volume) => {
        const candidateParams = cloneParams(params);
        candidateParams.vesselVolumeByTankClass[
          tankClass
        ] = volume;
        return evaluate({
          batches: trainForClass,
          seed: args.seed,
          params: candidateParams,
        });
      },
    });

    const selected = chooseOnValidation({
      trainTop,
      evaluateValue: (volume) => {
        const candidateParams = cloneParams(params);
        candidateParams.vesselVolumeByTankClass[
          tankClass
        ] = volume;
        return evaluate({
          batches: validationForClass,
          seed: args.seed,
          params: candidateParams,
        });
      },
    });

    if (!selected) return;

    const currentValidation = evaluate({
      batches: validationForClass,
      seed: args.seed,
      params,
    });

    if (
      score(selected.validation) <=
      score(currentValidation) + 0.001
    ) {
      params.vesselVolumeByTankClass[
        tankClass
      ] = selected.value;
    }

    rounds.push(
      recordRound({
        name,
        params,
        train: evaluate({
          batches: train,
          seed: args.seed,
          params,
        }),
        validation: evaluate({
          batches: validation,
          seed: args.seed,
          params,
        }),
      }),
    );
  };

  const calibrateK = (
    fine: boolean,
    name: string,
  ) => {
    const candidates = kCandidates(
      params.kPerHour,
      fine,
    );

    const trainTop = topTrainCandidates({
      values: candidates,
      evaluateValue: (kPerHour) => {
        const candidateParams = cloneParams(params);
        candidateParams.kPerHour = kPerHour;
        return evaluate({
          batches: train,
          seed: args.seed,
          params: candidateParams,
        });
      },
    });

    const selected = chooseOnValidation({
      trainTop,
      evaluateValue: (kPerHour) => {
        const candidateParams = cloneParams(params);
        candidateParams.kPerHour = kPerHour;
        return evaluate({
          batches: validation,
          seed: args.seed,
          params: candidateParams,
        });
      },
    });

    if (!selected) return;

    const currentValidation = evaluate({
      batches: validation,
      seed: args.seed,
      params,
    });

    if (
      score(selected.validation) <=
      score(currentValidation) + 0.001
    ) {
      params.kPerHour = selected.value;
    }

    rounds.push(
      recordRound({
        name,
        params,
        train: evaluate({
          batches: train,
          seed: args.seed,
          params,
        }),
        validation: evaluate({
          batches: validation,
          seed: args.seed,
          params,
        }),
      }),
    );
  };

  // Several calibration passes. Geometry and kinetics influence one another,
  // so the second geometry pass happens only after k has moved.
  calibrateGeometry("single", false, "geometry-single-broad");
  calibrateGeometry("double", false, "geometry-double-broad");
  calibrateGeometry("triple", false, "geometry-triple-broad");
  calibrateK(false, "k-broad");

  calibrateGeometry("single", true, "geometry-single-fine");
  calibrateGeometry("double", true, "geometry-double-fine");
  calibrateGeometry("triple", true, "geometry-triple-fine");
  calibrateK(true, "k-fine-1");

  calibrateGeometry("single", true, "geometry-single-refine");
  calibrateGeometry("double", true, "geometry-double-refine");
  calibrateGeometry("triple", true, "geometry-triple-refine");
  calibrateK(true, "k-fine-2");

  const currentV9LockedTest = evaluate({
    batches: lockedTest,
    seed: args.seed,
    params: initialParams,
    usePerBatchK: true,
  });
  const calibratedLockedTest = evaluate({
    batches: lockedTest,
    seed: args.seed,
    params,
  });

  const improvementOnLockedTest =
    currentV9LockedTest.carbonationMae !== null &&
    calibratedLockedTest.carbonationMae !== null &&
    currentV9LockedTest.carbonationMae > 0
      ? 1 -
        calibratedLockedTest.carbonationMae /
          currentV9LockedTest.carbonationMae
      : null;

  return {
    seed: args.seed,
    fittingBatchCount: fitting.length,
    trainBatchCount: train.length,
    validationBatchCount: validation.length,
    lockedTestBatchCount: lockedTest.length,
    reportOnlyBatchCount: reportOnly.length,
    excludedFromFitStyles:
      Array.from(
        new Set(
          reportOnly.map((batch) =>
            normalizeStyle(batch.style),
          ),
        ),
      ).sort(),

    initialParams,
    calibratedParams: cloneParams(params),

    currentV9LockedTest,
    calibratedLockedTest,
    improvementOnLockedTest,

    rounds,
  };
}
