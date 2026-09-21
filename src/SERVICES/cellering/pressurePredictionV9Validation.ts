import type {
  PressureV4Measurement,
} from "./pressurePredictionV4";
import {
  pressureV9ObservedInventory,
  simulateV9ObservedClosedInterval,
  type PressureV9TankClass,
  type PressureV9TemperaturePathPoint,
} from "./pressurePredictionV9Physics";

const MIN_PLAUSIBLE_CARBONATION_VOL = 0.5;
const MAX_PLAUSIBLE_CARBONATION_VOL = 4.0;
const CLOSED_INVENTORY_TOLERANCE_VOL = 0.08;

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
  temperatureDrop: number;
  actualPressureChange: number | null;
  pressureResidualBar: number | null;
  suspectedPressureEvent:
    | "possible_unrecorded_release"
    | "possible_unrecorded_addition"
    | "none"
    | "unknown";
  temperaturePathPointCount: number;
  observedInventoryDeltaVol: number | null;
  inventoryStatus:
    | "closed_consistent"
    | "possible_net_addition"
    | "possible_net_release"
    | "unknown";
  inferredKPerHour: number | null;
  estimatedHeadspaceFraction: number | null;
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

  strictClosedCaseCount: number;
  strictClosedCarbonationMae: number | null;
  strictClosedCarbonationP90AbsError: number | null;
  strictClosedPersistenceMae: number | null;
  strictClosedImprovementVsPersistence: number | null;

  inferredKMedianPerHour: number | null;
  inferredKP10PerHour: number | null;
  inferredKP90PerHour: number | null;
  kCrossFitCaseCount: number;
  kCrossFitCarbonationMae: number | null;
  kCrossFitCarbonationP90AbsError: number | null;
  kCrossFitImprovementVsCurrentK: number | null;
  byStyle: PressureV9ValidationGroup[];
  byTankClass: PressureV9ValidationGroup[];
  byHorizon: PressureV9ValidationGroup[];
  byCoolingDrop: PressureV9ValidationGroup[];
  byActualPressureChange: PressureV9ValidationGroup[];
  byPressureResidual: PressureV9ValidationGroup[];
  byInventoryBalance: PressureV9ValidationGroup[];
  byHeadspaceFraction: PressureV9ValidationGroup[];
  byStartCarbonation: PressureV9ValidationGroup[];
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

function plausibleCarbonation(value: unknown): number | null {
  const number = finite(value);
  if (number === null) return null;
  if (
    number < MIN_PLAUSIBLE_CARBONATION_VOL ||
    number > MAX_PLAUSIBLE_CARBONATION_VOL
  ) {
    return null;
  }
  return number;
}

function measurementTimeMs(
  measurement: PressureV4Measurement,
): number | null {
  const text = String(measurement.id ?? "").trim();

  let match = text.match(
    /^(\d{4})-(\d{2})-(\d{2})_(\d{1,2})(\d{2})$/,
  );
  if (match) {
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    if (
      hour >= 0 &&
      hour <= 23 &&
      minute >= 0 &&
      minute <= 59
    ) {
      return new Date(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]),
        hour,
        minute,
        0,
        0,
      ).getTime();
    }
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

function normalizedNote(
  row: PressureV4Measurement,
): string {
  return noteText(row)
    .replace(/[–—−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function pressureNumbersInNote(
  row: PressureV4Measurement,
): number[] {
  const note = normalizedNote(row);
  const values: number[] = [];

  for (const match of note.matchAll(
    /(?:לחץ|bar|באר)[^\d-]{0,12}(-?\d+(?:[.,]\d+)?)/gi,
  )) {
    const value = finite(match[1]);
    if (
      value !== null &&
      value >= 0 &&
      value <= 2.2
    ) {
      values.push(value);
    }
  }

  for (const match of note.matchAll(
    /(-?\d+(?:[.,]\d+)?)\s*(?:bar|באר)/gi,
  )) {
    const value = finite(match[1]);
    if (
      value !== null &&
      value >= 0 &&
      value <= 2.2
    ) {
      values.push(value);
    }
  }

  return Array.from(new Set(values));
}

function pressureNoteDiffersFromNumericRow(
  row: PressureV4Measurement,
): boolean {
  const measured = finite(row.pressure);
  const candidates = pressureNumbersInNote(row);
  if (!candidates.length) return false;

  if (measured === null) {
    // A pressure number in notes with no numeric pressure is ambiguous enough
    // that this row should not be assumed to be a clean closed-tank state.
    return true;
  }

  return candidates.some(
    (value) => Math.abs(value - measured) >= 0.05,
  );
}

function looksLikePressureInterventionNote(
  row: PressureV4Measurement,
): boolean {
  const note = normalizedNote(row);
  if (!note) return false;

  if (note.includes("גיזוז מלמטה")) return true;

  const actionWord =
    /(?:העל(?:את|ה)|להעלות|הוספת|הורד(?:ת|ה)|להוריד|הנמכ(?:ת|ה)|שחרור|שחרר|פריק(?:ת|ה)|הוצאת|פתיחת|פתח|שינוי|שינה|כיוון|כוונון|ויסות|ווסת)/i;
  const pressureWord = /(?:לחץ|bar|באר)/i;

  if (actionWord.test(note) && pressureWord.test(note)) {
    return true;
  }

  // Common shorthand: "לחץ ל 1.15", "לחץ -> 1.15", etc.
  if (
    /לחץ\s*(?:ל|על|עד|->|=|:)\s*-?\s*\d+(?:[.,]\d+)?/i.test(note)
  ) {
    return true;
  }

  // Historical shorthand is inconsistent. If the note contains a plausible
  // pressure that materially differs from the row's numeric pressure, treat it
  // as an intervention/ambiguous state rather than silently assuming "closed".
  if (
    !/שמר(?:ים|י)/.test(note) &&
    pressureNoteDiffersFromNumericRow(row)
  ) {
    return true;
  }

  return false;
}

function pressureTargetFromNote(
  row: PressureV4Measurement,
): number | null {
  const note = normalizedNote(row);
  if (!note || note.includes("גיזוז מלמטה")) return null;

  // "לחץ אחרי" on a yeast-drop note is an observation after the drop,
  // not a regulator/set-point action.
  if (
    /שמר(?:ים|י)/.test(note) &&
    /לחץ\s+אחרי/i.test(note)
  ) {
    return null;
  }

  const patterns = [
    /(?:העל(?:את|ה)|להעלות|הוספת|הורד(?:ת|ה)|להוריד|הנמכ(?:ת|ה)|שחרור|שחרר|פריק(?:ת|ה)|הוצאת|פתיחת|פתח|שינוי|שינה|כיוון|כוונון|ויסות|ווסת)[^\d]{0,24}(?:לחץ[^\d]{0,12})?(?:ל|על|עד|->|=|:)?\s*(-?\d+(?:[.,]\d+)?)/gi,
    /לחץ\s*(?:ל|על|עד|->|=|:)\s*(-?\d+(?:[.,]\d+)?)/gi,
  ];

  const candidates: number[] = [];
  for (const pattern of patterns) {
    for (const match of note.matchAll(pattern)) {
      const value = finite(match[1]);
      if (
        value !== null &&
        value >= 0 &&
        value <= 2.2
      ) {
        candidates.push(value);
      }
    }
  }

  if (candidates.length) {
    return candidates[candidates.length - 1];
  }

  const genericCandidates =
    pressureNumbersInNote(row);
  const measured = finite(row.pressure);
  const materiallyDifferent =
    genericCandidates.filter(
      (value) =>
        measured === null ||
        Math.abs(value - measured) >= 0.05,
    );

  return materiallyDifferent.length === 1
    ? materiallyDifferent[0]
    : null;
}

function isIntervention(
  row: PressureV4Measurement,
): boolean {
  const note = normalizedNote(row);
  return (
    note.includes("גיזוז מלמטה") ||
    looksLikePressureInterventionNote(row) ||
    /שמר(?:ים|י)/.test(note)
  );
}

function actualStartPressure(
  rows: IndexedMeasurement[],
  index: number,
): number | null {
  const row = rows[index]?.row;
  if (!row) return null;

  // Validation must never invent a state by carrying pressure forward from a
  // previous day. If there was an explicit pressure action on this row, that
  // is the pressure actually set after the carbonation check. Otherwise the
  // numeric pressure must exist on this same measurement row.
  const noteTarget = pressureTargetFromNote(row);
  if (noteTarget !== null) return noteTarget;

  if (looksLikePressureInterventionNote(row)) {
    return null;
  }

  return finite(row.pressure);
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
  temperaturePath: PressureV9TemperaturePathPoint[];
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
    temperaturePath: PressureV9TemperaturePathPoint[];
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

    // A yeast-drop note can be appended later to the same daily row after the
    // morning pressure/carbonation reading. The numeric pressure on that row
    // therefore often describes the pre-drop state while "לחץ אחרי" in notes
    // describes a later post-drop state. Mixing those timestamps creates a
    // physically impossible validation start. Be strict: use such a row as an
    // endpoint for the morning measurement, but never as the start of the next
    // closed-tank interval.
    if (/שמר(?:ים|י)/.test(noteText(start.row))) continue;

    const contaminated = rows
      .slice(startIndex + 1, endIndex)
      .some((item) => isIntervention(item.row));
    if (contaminated) continue;

    const startPressure = actualStartPressure(
      rows,
      startIndex,
    );
    const startTemperature =
      finite(start.row.temp);
    const endTemperature =
      finite(end.row.temp);

    if (
      startPressure === null ||
      startTemperature === null ||
      endTemperature === null ||
      startTemperature > 9 ||
      endTemperature > 9 ||
      startPressure < 0 ||
      startPressure > 2.2
    ) continue;

    const temperaturePath = rows
      .slice(startIndex, endIndex + 1)
      .map((item) => {
        const temperature = finite(item.row.temp);
        if (temperature === null) return null;
        return {
          hour:
            (item.timeMs - start.timeMs) /
            3600000,
          temperature,
        };
      })
      .filter(
        (item): item is PressureV9TemperaturePathPoint =>
          item !== null &&
          item.hour >= 0 &&
          item.hour <= durationHours,
      );

    if (
      temperaturePath.some(
        (point) => point.temperature > 9.5,
      )
    ) {
      continue;
    }

    intervals.push({
      start,
      end,
      startPressure,
      startTemperature,
      endTemperature,
      durationHours,
      temperaturePath,
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

function coolingDropBucket(dropC: number): string {
  if (dropC < -0.25) return "התחמם";
  if (dropC < 0.75) return "כמעט יציב <0.75°C";
  if (dropC < 2) return "קירור 0.75–2°C";
  if (dropC < 4) return "קירור 2–4°C";
  return "קירור מעל 4°C";
}

function pressureChangeBucket(deltaBar: number | null): string {
  if (deltaBar === null) return "לחץ סופי חסר";
  if (deltaBar <= -0.3) return "ירידה מעל 0.30 bar";
  if (deltaBar <= -0.1) return "ירידה 0.10–0.30 bar";
  if (deltaBar < 0.1) return "לחץ כמעט יציב ±0.10";
  if (deltaBar < 0.3) return "עלייה 0.10–0.30 bar";
  return "עלייה מעל 0.30 bar";
}

function pressureResidualBucket(
  item: PressureV9ValidationCase,
): string {
  if (item.suspectedPressureEvent === "unknown") {
    return "לחץ סופי חסר";
  }
  if (
    item.suspectedPressureEvent ===
    "possible_unrecorded_release"
  ) {
    return "חשד לשחרור/הורדת לחץ לא מתועדת";
  }
  if (
    item.suspectedPressureEvent ===
    "possible_unrecorded_addition"
  ) {
    return "חשד להוספת לחץ לא מתועדת";
  }
  return "ללא residual חריג (±0.18 bar)";
}

function inventoryStatusFromDelta(
  deltaVol: number | null,
): PressureV9ValidationCase["inventoryStatus"] {
  if (deltaVol === null || !Number.isFinite(deltaVol)) {
    return "unknown";
  }
  if (deltaVol > CLOSED_INVENTORY_TOLERANCE_VOL) {
    return "possible_net_addition";
  }
  if (deltaVol < -CLOSED_INVENTORY_TOLERANCE_VOL) {
    return "possible_net_release";
  }
  return "closed_consistent";
}

function inventoryBucket(
  item: PressureV9ValidationCase,
): string {
  if (item.inventoryStatus === "possible_net_addition") {
    return "מאזן CO₂: חשד לתוספת גז נטו";
  }
  if (item.inventoryStatus === "possible_net_release") {
    return "מאזן CO₂: חשד לאיבוד/שחרור גז נטו";
  }
  if (item.inventoryStatus === "closed_consistent") {
    return "מאזן CO₂: תואם מיכל סגור (±0.08 vol)";
  }
  return "מאזן CO₂: לא ניתן לחשב";
}

function inferKPerHour(args: {
  batch: PressureV9ValidationBatch;
  selected: ReturnType<typeof eligibleIntervals>[number];
  startCarbonation: number;
  actualEndCarbonation: number;
  vesselVolumeLiters?: number;
}): number | null {
  let bestK: number | null = null;
  let bestError = Number.POSITIVE_INFINITY;

  const logLow = Math.log(0.0002);
  const logHigh = Math.log(0.02);

  for (let index = 0; index <= 72; index += 1) {
    const kPerHour = Math.exp(
      logLow + (logHigh - logLow) * index / 72,
    );
    const prediction = simulateV9ObservedClosedInterval({
      tankNumber: args.batch.tankNumber,
      beerVolumeLiters: args.batch.beerVolumeLiters,
      vesselVolumeLiters: args.vesselVolumeLiters,
      startCarbonation: args.startCarbonation,
      startPressure: args.selected.startPressure,
      startTemperature: args.selected.startTemperature,
      endTemperature: args.selected.endTemperature,
      durationHours: args.selected.durationHours,
      temperaturePath: args.selected.temperaturePath,
      kPerHour,
    });
    if (!prediction) continue;

    const error = Math.abs(
      prediction.predictedCarbonation -
      args.actualEndCarbonation,
    );
    if (error < bestError) {
      bestError = error;
      bestK = kPerHour;
    }
  }

  return bestK;
}

function headspaceBucket(fraction: number | null): string {
  if (fraction === null || !Number.isFinite(fraction)) return "headspace לא ידוע";
  if (fraction < 0.15) return "headspace <15%";
  if (fraction < 0.25) return "headspace 15–25%";
  if (fraction < 0.35) return "headspace 25–35%";
  return "headspace ≥35%";
}

function startCarbonationBucket(value: number): string {
  if (value < 2.1) return "גיזוז התחלתי <2.10";
  if (value < 2.25) return "2.10–2.25";
  if (value < 2.4) return "2.25–2.40";
  return "≥2.40";
}

function nominalVesselVolume(
  tankClass: PressureV9TankClass,
): number {
  if (tankClass === "single") return 1300;
  if (tankClass === "double") return 3000;
  return 4000;
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
      plausibleCarbonation(selected.start.row.carbonation);
    const actualEndCarbonation =
      plausibleCarbonation(selected.end.row.carbonation);
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
        temperaturePath:
          selected.temperaturePath,
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

    const temperatureDrop =
      selected.startTemperature -
      selected.endTemperature;
    const actualPressureChange =
      actualEndPressure === null
        ? null
        : actualEndPressure -
          selected.startPressure;
    const pressureResidualBar =
      actualEndPressure === null
        ? null
        : actualEndPressure -
          prediction.predictedPressure;
    const suspectedPressureEvent:
      PressureV9ValidationCase["suspectedPressureEvent"] =
      pressureResidualBar === null
        ? "unknown"
        : pressureResidualBar <= -0.18
          ? "possible_unrecorded_release"
          : pressureResidualBar >= 0.18
            ? "possible_unrecorded_addition"
            : "none";
    const nominalVolume =
      nominalVesselVolume(tankClass);
    const estimatedHeadspaceFraction =
      nominalVolume > batch.beerVolumeLiters
        ? (
            nominalVolume -
            batch.beerVolumeLiters
          ) / nominalVolume
        : null;

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
      temperatureDrop,
      actualPressureChange,
      pressureResidualBar,
      suspectedPressureEvent,
      temperaturePathPointCount:
        selected.temperaturePath.length,
      estimatedHeadspaceFraction,
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
    byCoolingDrop: grouped(
      cases,
      (item) => coolingDropBucket(item.temperatureDrop),
    ),
    byActualPressureChange: grouped(
      cases,
      (item) => pressureChangeBucket(item.actualPressureChange),
    ),
    byPressureResidual: grouped(
      cases,
      (item) => pressureResidualBucket(item),
    ),
    byHeadspaceFraction: grouped(
      cases,
      (item) => headspaceBucket(item.estimatedHeadspaceFraction),
    ),
    byStartCarbonation: grouped(
      cases,
      (item) => startCarbonationBucket(item.startCarbonation),
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
