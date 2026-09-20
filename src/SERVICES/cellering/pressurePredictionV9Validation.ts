import type {
  PressureV4Measurement,
} from "./pressurePredictionV4";
import {
  simulateV9ObservedClosedInterval,
  type PressureV9TankClass,
} from "./pressurePredictionV9Physics";

export type PressureV9ValidationBatch = {
  batchId: string;
  style: string;
  tankNumber: number;
  beerVolumeLiters: number;
  kPerHour: number;
  measurements: PressureV4Measurement[];
};

export type PressureV9ValidationCase = {
  batchId: string;
  style: string;
  tankNumber: number;
  tankClass: PressureV9TankClass;
  beerVolumeLiters: number;
  durationHours: number;
  startCarbonation: number;
  actualEndCarbonation: number;
  predictedEndCarbonation: number;
  carbonationAbsError: number;
  persistenceAbsError: number;
  startPressure: number;
  actualEndPressure: number | null;
  predictedEndPressure: number;
  pressureAbsError: number | null;
  startTemperature: number;
  endTemperature: number;
  kPerHour: number;
  startMeasurementId: string;
  endMeasurementId: string;
};

export type PressureV9ValidationGroup = {
  key: string;
  caseCount: number;
  carbonationMae: number | null;
  carbonationP90: number | null;
  pressureMae: number | null;
  persistenceMae: number | null;
};

export type PressureV9ValidationResult = {
  batchCount: number;
  caseCount: number;
  carbonationMae: number | null;
  carbonationMedianAbsError: number | null;
  carbonationP90AbsError: number | null;
  carbonationWithin003: number | null;
  carbonationWithin005: number | null;
  pressureMae: number | null;
  pressureMedianAbsError: number | null;
  pressureP90AbsError: number | null;
  persistenceMae: number | null;
  improvementVsPersistence: number | null;
  massBalanceMaxResidualMoles: number | null;
  byStyle: PressureV9ValidationGroup[];
  byTankClass: PressureV9ValidationGroup[];
  byHorizon: PressureV9ValidationGroup[];
  worstCases: PressureV9ValidationCase[];
  cases: PressureV9ValidationCase[];
};

type IndexedMeasurement = {
  row: PressureV4Measurement;
  index: number;
  timeMs: number;
};

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

function measurementTimeMs(
  measurement: PressureV4Measurement,
): number | null {
  const text = String(measurement.id ?? "").trim();

  let match = text.match(
    /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})$/,
  );
  if (match) {
    return new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      0,
      0,
    ).getTime();
  }

  match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    return new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      12,
      0,
      0,
      0,
    ).getTime();
  }

  return null;
}

function noteText(row: PressureV4Measurement): string {
  return String(row.notes ?? "");
}

function pressureTargetFromNote(
  row: PressureV4Measurement,
): number | null {
  if (noteText(row).includes("גיזוז מלמטה")) return null;

  const matches = Array.from(
    noteText(row).matchAll(
      /(?:העלאת|הורדת|שינוי)\s+לחץ\s+ל\s*:?-?\s*(\d+(?:[.,]\d+)?)/gi,
    ),
  );
  const match = matches[matches.length - 1];
  return match ? finite(match[1]) : null;
}

function pressureAfterYeastFromNote(
  row: PressureV4Measurement,
): number | null {
  const note = noteText(row);
  if (!/שמר(?:ים|י)/.test(note)) return null;

  const match = note.match(
    /לחץ\s+אחרי\s*:?-?\s*(\d+(?:[.,]\d+)?)\s*(?:bar|באר)?/i,
  );
  return match ? finite(match[1]) : null;
}

function isIntervention(
  row: PressureV4Measurement,
): boolean {
  const note = noteText(row);
  return (
    note.includes("גיזוז מלמטה") ||
    pressureTargetFromNote(row) !== null ||
    /שמר(?:ים|י)/.test(note)
  );
}

function previousFinite(
  rows: IndexedMeasurement[],
  index: number,
  field: "pressure" | "temp",
): number | null {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const value = finite(rows[cursor]?.row[field]);
    if (value !== null) return value;
  }
  return null;
}

function actualStartPressure(
  rows: IndexedMeasurement[],
  index: number,
): number | null {
  const row = rows[index]?.row;
  if (!row) return null;

  return (
    pressureTargetFromNote(row) ??
    pressureAfterYeastFromNote(row) ??
    previousFinite(rows, index, "pressure")
  );
}

function tankClassForNumber(
  tankNumber: number,
): PressureV9TankClass {
  if (tankNumber < 5) return "single";
  if (tankNumber < 9) return "double";
  return "triple";
}

function hash32(text: string): number {
  let hash = 2166136261;
  for (const char of text) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function chooseIndex(
  length: number,
  seed: number,
  batchId: string,
): number {
  if (length <= 1) return 0;
  return hash32(`${seed}|${batchId}`) % length;
}

function eligibleIntervals(
  batch: PressureV9ValidationBatch,
): {
  start: IndexedMeasurement;
  end: IndexedMeasurement;
  startPressure: number;
  startTemperature: number;
  endTemperature: number;
  durationHours: number;
}[] {
  const rows = batch.measurements
    .map((row, index) => ({
      row,
      index,
      timeMs: measurementTimeMs(row),
    }))
    .filter(
      (item): item is {
        row: PressureV4Measurement;
        index: number;
        timeMs: number;
      } => item.timeMs !== null,
    )
    .sort((a, b) => a.timeMs - b.timeMs);

  const checks = rows.filter(
    (item) => finite(item.row.carbonation) !== null,
  );

  const intervals: {
    start: IndexedMeasurement;
    end: IndexedMeasurement;
    startPressure: number;
    startTemperature: number;
    endTemperature: number;
    durationHours: number;
  }[] = [];

  for (let checkIndex = 0; checkIndex < checks.length - 1; checkIndex += 1) {
    const start = checks[checkIndex];
    const end = checks[checkIndex + 1];
    const durationHours =
      (end.timeMs - start.timeMs) / 3600000;

    if (durationHours < 8 || durationHours > 120) continue;

    const startIndex = rows.findIndex(
      (item) => item.timeMs === start.timeMs &&
        item.index === start.index,
    );
    const endIndex = rows.findIndex(
      (item) => item.timeMs === end.timeMs &&
        item.index === end.index,
    );
    if (startIndex < 0 || endIndex <= startIndex) continue;

    if (noteText(start.row).includes("גיזוז מלמטה")) continue;

    const contaminated = rows
      .slice(startIndex + 1, endIndex)
      .some((item) => isIntervention(item.row));
    if (contaminated) continue;

    const startPressure = actualStartPressure(
      rows,
      startIndex,
    );
    const startTemperature = previousFinite(
      rows,
      startIndex,
      "temp",
    );
    const endTemperature = previousFinite(
      rows,
      endIndex,
      "temp",
    );

    if (
      startPressure === null ||
      startTemperature === null ||
      endTemperature === null ||
      startTemperature > 9 ||
      endTemperature > 9 ||
      startPressure < 0 ||
      startPressure > 2.2
    ) continue;

    intervals.push({
      start,
      end,
      startPressure,
      startTemperature,
      endTemperature,
      durationHours,
    });
  }

  return intervals;
}

function mean(values: number[]): number | null {
  const clean = values.filter(Number.isFinite);
  if (!clean.length) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function quantile(values: number[], q: number): number | null {
  const clean = values
    .filter(Number.isFinite)
    .slice()
    .sort((a, b) => a - b);
  if (!clean.length) return null;
  if (clean.length === 1) return clean[0];

  const position = (clean.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return clean[lower];

  const fraction = position - lower;
  return (
    clean[lower] * (1 - fraction) +
    clean[upper] * fraction
  );
}

function groupSummary(
  key: string,
  cases: PressureV9ValidationCase[],
): PressureV9ValidationGroup {
  const carbErrors = cases.map(
    (item) => item.carbonationAbsError,
  );
  const pressureErrors = cases
    .map((item) => item.pressureAbsError)
    .filter((value): value is number => value !== null);

  return {
    key,
    caseCount: cases.length,
    carbonationMae: mean(carbErrors),
    carbonationP90: quantile(carbErrors, 0.9),
    pressureMae: mean(pressureErrors),
    persistenceMae: mean(
      cases.map((item) => item.persistenceAbsError),
    ),
  };
}

function grouped(
  cases: PressureV9ValidationCase[],
  keyOf: (item: PressureV9ValidationCase) => string,
): PressureV9ValidationGroup[] {
  const map = new Map<string, PressureV9ValidationCase[]>();

  for (const item of cases) {
    const key = keyOf(item);
    const values = map.get(key) ?? [];
    values.push(item);
    map.set(key, values);
  }

  return Array.from(map.entries())
    .map(([key, values]) => groupSummary(key, values))
    .sort((a, b) => b.caseCount - a.caseCount);
}

function horizonBucket(hours: number): string {
  if (hours <= 24) return "8–24h";
  if (hours <= 48) return "24–48h";
  if (hours <= 72) return "48–72h";
  return "72–120h";
}

export function runPressureV9PhysicsValidation(args: {
  batches: PressureV9ValidationBatch[];
  seed: number;
  vesselVolumeByTankClass?: Partial<
    Record<PressureV9TankClass, number>
  >;
  kPerHourOverride?: number | null;
}): PressureV9ValidationResult {
  const cases: PressureV9ValidationCase[] = [];
  let maxResidual = 0;

  for (const batch of args.batches) {
    const intervals = eligibleIntervals(batch);
    if (!intervals.length) continue;

    const selected = intervals[
      chooseIndex(
        intervals.length,
        args.seed,
        batch.batchId,
      )
    ];

    const startCarbonation =
      finite(selected.start.row.carbonation);
    const actualEndCarbonation =
      finite(selected.end.row.carbonation);
    if (
      startCarbonation === null ||
      actualEndCarbonation === null
    ) continue;

    const tankClass =
      tankClassForNumber(batch.tankNumber);
    const vesselVolumeLiters =
      args.vesselVolumeByTankClass?.[tankClass];

    const prediction =
      simulateV9ObservedClosedInterval({
        tankNumber: batch.tankNumber,
        beerVolumeLiters: batch.beerVolumeLiters,
        vesselVolumeLiters,
        startCarbonation,
        startPressure: selected.startPressure,
        startTemperature:
          selected.startTemperature,
        endTemperature:
          selected.endTemperature,
        durationHours:
          selected.durationHours,
        kPerHour:
          finite(args.kPerHourOverride) ??
          batch.kPerHour,
      });
    if (!prediction) continue;

    const actualEndPressure = finite(
      selected.end.row.pressure,
    );
    const carbonationAbsError = Math.abs(
      prediction.predictedCarbonation -
      actualEndCarbonation,
    );

    maxResidual = Math.max(
      maxResidual,
      Math.abs(prediction.massBalanceResidualMoles),
    );

    cases.push({
      batchId: batch.batchId,
      style: batch.style,
      tankNumber: batch.tankNumber,
      tankClass,
      beerVolumeLiters: batch.beerVolumeLiters,
      durationHours: selected.durationHours,
      startCarbonation,
      actualEndCarbonation,
      predictedEndCarbonation:
        prediction.predictedCarbonation,
      carbonationAbsError,
      persistenceAbsError:
        Math.abs(
          startCarbonation -
          actualEndCarbonation,
        ),
      startPressure: selected.startPressure,
      actualEndPressure,
      predictedEndPressure:
        prediction.predictedPressure,
      pressureAbsError:
        actualEndPressure === null
          ? null
          : Math.abs(
              prediction.predictedPressure -
              actualEndPressure,
            ),
      startTemperature:
        selected.startTemperature,
      endTemperature:
        selected.endTemperature,
      kPerHour:
        finite(args.kPerHourOverride) ??
        batch.kPerHour,
      startMeasurementId:
        String(selected.start.row.id ?? ""),
      endMeasurementId:
        String(selected.end.row.id ?? ""),
    });
  }

  const carbonationErrors = cases.map(
    (item) => item.carbonationAbsError,
  );
  const pressureErrors = cases
    .map((item) => item.pressureAbsError)
    .filter((value): value is number => value !== null);
  const persistenceErrors = cases.map(
    (item) => item.persistenceAbsError,
  );

  const carbonationMae = mean(carbonationErrors);
  const persistenceMae = mean(persistenceErrors);

  return {
    batchCount: new Set(
      cases.map((item) => item.batchId),
    ).size,
    caseCount: cases.length,
    carbonationMae,
    carbonationMedianAbsError:
      quantile(carbonationErrors, 0.5),
    carbonationP90AbsError:
      quantile(carbonationErrors, 0.9),
    carbonationWithin003:
      cases.length
        ? cases.filter(
            (item) => item.carbonationAbsError <= 0.03,
          ).length / cases.length
        : null,
    carbonationWithin005:
      cases.length
        ? cases.filter(
            (item) => item.carbonationAbsError <= 0.05,
          ).length / cases.length
        : null,
    pressureMae: mean(pressureErrors),
    pressureMedianAbsError:
      quantile(pressureErrors, 0.5),
    pressureP90AbsError:
      quantile(pressureErrors, 0.9),
    persistenceMae,
    improvementVsPersistence:
      carbonationMae !== null &&
      persistenceMae !== null &&
      persistenceMae > 0
        ? 1 - carbonationMae / persistenceMae
        : null,
    massBalanceMaxResidualMoles:
      cases.length ? maxResidual : null,
    byStyle: grouped(
      cases,
      (item) => item.style || "unknown",
    ),
    byTankClass: grouped(
      cases,
      (item) => item.tankClass,
    ),
    byHorizon: grouped(
      cases,
      (item) => horizonBucket(item.durationHours),
    ),
    worstCases: cases
      .slice()
      .sort(
        (a, b) =>
          b.carbonationAbsError -
          a.carbonationAbsError,
      )
      .slice(0, 10),
    cases,
  };
}
