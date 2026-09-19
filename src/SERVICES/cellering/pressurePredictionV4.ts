export type PressureV4Measurement = {
  id?: string | number | null;
  temp?: string | number | null;
  pressure?: string | number | null;
  carbonation?: string | number | null;
  notes?: string | number | null;
};

export type PressureV4T0 = {
  index: number;
  dateTimeMs: number;
  source: "explicit_close" | "first_positive_pressure";
  pressure: number;
  previousPressure: number | null;
};

export type PressureV4Exposure = {
  hoursSinceT0: number;
  pressureHours: number;
  temperatureHours: number;
  equilibriumDeltaBarHours: number | null;
  pressureMean: number | null;
  pressureMean24h: number | null;
  pressureMean48h: number | null;
  temperatureMean: number | null;
  pressurePoints: number;
  temperaturePoints: number;
  coveredHours: number;
  coverageRatio: number;
};

export type PressureV4CoolingState = {
  startDateTimeMs: number;
  hoursSinceCooling: number;
  startTemp: number | null;
  currentTemp: number | null;
  tempDropSinceCooling: number | null;
  tempChange24h: number | null;
  pressureMeanSinceCooling: number | null;
  pressureMean24h: number | null;
  pressureHoursSinceCooling: number;
  equilibriumDeltaBarHoursSinceCooling: number | null;
  coverageRatio: number;
  stillCooling: boolean;
};

export type PressureV4DecisionState = {
  carbonation: number;
  currentPressure: number;
  currentTemp: number | null;
  hoursSinceT0: number;
  exposure: PressureV4Exposure;
  cooling: PressureV4CoolingState | null;
};

export type PressureV4Outcome = {
  carbonation: number;
  dateTimeMs: number;
  calendarDaysAfterAction: number;
};

export type PressureV4TransitionSample = {
  batchId?: string;
  style?: string;
  startDateTimeMs: number;
  endDateTimeMs: number;
  durationHours: number;
  startCarbonation: number;
  endCarbonation: number;
  currentPressure: number;
  currentTemp: number | null;
  hoursSinceT0: number;
  exposure: PressureV4Exposure;
  cooling: PressureV4CoolingState | null;
  pressureMeanDuring: number | null;
  temperatureMeanDuring: number | null;
  kPerHour: number;
  quality: "low" | "medium" | "high";
};

export type PressureV4PassiveSample = {
  batchId?: string;
  style?: string;
  sampleDateTimeMs: number;
  sampleDate: string;
  carbonationBefore: number;
  currentPressure: number;
  currentTemp: number | null;
  hoursSinceT0: number;
  exposure: PressureV4Exposure;
  primaryOutcome: PressureV4Outcome;
  carbonationDelta: number;
  quality: "low" | "medium" | "high";
};

export type PressureV4Sample = {
  batchId?: string;
  style?: string;
  t0: PressureV4T0;
  actionDateTimeMs: number;
  actionDate: string;
  carbonationBefore: number;
  currentPressure: number;
  targetPressure: number;
  currentTemp: number | null;
  hoursSinceT0: number;
  exposure: PressureV4Exposure;
  intermediateDay1: PressureV4Outcome | null;
  primaryOutcome: PressureV4Outcome;
  carbonationDelta: number;
  actionPressureDelta: number;
  quality: "low" | "medium" | "high";
  invalidReason?: string;
};

export type EquilibriumPressureFn =
  (temperature: number | null) => number | null;

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

function dateOnly(value: unknown): string | null {
  const text = String(value ?? "").trim();
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;

  match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!match) return null;
  return `${match[3]}-${String(match[2]).padStart(2, "0")}-${String(match[1]).padStart(2, "0")}`;
}

function measurementDateTimeMs(measurement: PressureV4Measurement): number | null {
  const id = String(measurement.id ?? "");
  const idMatch = id.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})$/);
  if (idMatch) {
    return new Date(
      Number(idMatch[1]),
      Number(idMatch[2]) - 1,
      Number(idMatch[3]),
      Number(idMatch[4]),
      Number(idMatch[5]),
      0,
      0,
    ).getTime();
  }

  const day = dateOnly(measurement.id);
  if (!day) return null;
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date, 12, 0, 0, 0).getTime();
}

function calendarDaySerial(ms: number): number {
  const d = new Date(ms);
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
}

function calendarDayDiff(fromMs: number, toMs: number): number {
  return calendarDaySerial(toMs) - calendarDaySerial(fromMs);
}

function noteText(measurement: PressureV4Measurement): string {
  return String(measurement.notes ?? "");
}

function isBottomCarbonation(measurement: PressureV4Measurement): boolean {
  return noteText(measurement).includes("גיזוז מלמטה");
}

function isExplicitPressureClose(measurement: PressureV4Measurement): boolean {
  if (isBottomCarbonation(measurement)) return false;
  const note = noteText(measurement);
  return /סגירת\s+(?:לחץ|מיכל)|סגירה\s+(?:לחץ|מיכל)/i.test(note);
}

function isCoolingAction(measurement: PressureV4Measurement): boolean {
  const note = noteText(measurement);
  if (!note.includes("קירור")) return false;
  if (/אחרי\s+קירור|לאחר\s+קירור/.test(note)) return false;
  return /(?:^|\||\s)קירור(?:$|\||\s|[-–—])/u.test(note);
}

function ordinaryPressureTarget(measurement: PressureV4Measurement): number | null {
  if (isBottomCarbonation(measurement)) return null;
  const matches = Array.from(
    noteText(measurement).matchAll(
      /(?:העלאת|הורדת|שינוי)\s+לחץ\s+ל\s*:?-?\s*(\d+(?:[.,]\d+)?)/gi,
    ),
  );
  const match = matches.length ? matches[matches.length - 1] : null;
  return match ? finiteNumber(match[1]) : null;
}

export function detectPressureV4T0(
  measurements: PressureV4Measurement[],
  positivePressureThreshold = 0.1,
): PressureV4T0 | null {
  const rows = measurements
    .map((measurement, originalIndex) => ({
      measurement,
      originalIndex,
      time: measurementDateTimeMs(measurement),
      pressure: finiteNumber(measurement.pressure),
    }))
    .filter((row) => row.time !== null)
    .sort((a, b) => a.time! - b.time!);

  const explicit = rows.find((row) =>
    isExplicitPressureClose(row.measurement) &&
    row.pressure !== null &&
    row.pressure >= positivePressureThreshold
  );

  const chosen = explicit ?? rows.find((row) =>
    row.pressure !== null && row.pressure >= positivePressureThreshold
  );

  if (!chosen) return null;

  const chosenIndex = rows.indexOf(chosen);
  let previousPressure: number | null = null;
  for (let index = chosenIndex - 1; index >= 0; index -= 1) {
    if (rows[index].pressure !== null) {
      previousPressure = rows[index].pressure;
      break;
    }
  }

  return {
    index: chosen.originalIndex,
    dateTimeMs: chosen.time!,
    source: explicit ? "explicit_close" : "first_positive_pressure",
    pressure: chosen.pressure!,
    previousPressure,
  };
}

type TimedState = {
  time: number;
  pressure: number | null;
  temp: number | null;
};

function weightedMean(
  points: Array<{ value: number; hours: number }>,
): number | null {
  const totalHours = points.reduce((sum, point) => sum + point.hours, 0);
  if (totalHours <= 0) return null;
  return points.reduce((sum, point) => sum + point.value * point.hours, 0) / totalHours;
}

export function buildPressureV4Exposure(args: {
  measurements: PressureV4Measurement[];
  t0Ms: number;
  endMs: number;
  equilibriumPressure?: EquilibriumPressureFn;
}): PressureV4Exposure {
  const equilibriumPressure = args.equilibriumPressure ?? (() => null);

  const rows: TimedState[] = args.measurements
    .map((measurement) => ({
      time: measurementDateTimeMs(measurement),
      pressure: finiteNumber(measurement.pressure),
      temp: finiteNumber(measurement.temp),
    }))
    .filter((row): row is TimedState & { time: number } =>
      row.time !== null && row.time >= args.t0Ms && row.time <= args.endMs
    )
    .sort((a, b) => a.time - b.time);

  const hoursSinceT0 = Math.max(0, (args.endMs - args.t0Ms) / 3600000);
  let lastPressure: number | null = null;
  let lastTemp: number | null = null;

  // Carry the last known state into the integration window. Cooling/action
  // rows are often notes-only, so starting from null would throw away the
  // pressure and temperature that were actually present at that moment.
  const priorRows = args.measurements
    .map((measurement) => ({
      time: measurementDateTimeMs(measurement),
      pressure: finiteNumber(measurement.pressure),
      temp: finiteNumber(measurement.temp),
    }))
    .filter((row) => row.time !== null && row.time! <= args.t0Ms)
    .sort((a, b) => a.time! - b.time!);

  for (let index = priorRows.length - 1; index >= 0; index -= 1) {
    if (lastPressure === null && priorRows[index].pressure !== null) {
      lastPressure = priorRows[index].pressure;
    }
    if (lastTemp === null && priorRows[index].temp !== null) {
      lastTemp = priorRows[index].temp;
    }
    if (lastPressure !== null && lastTemp !== null) break;
  }

  let cursor = args.t0Ms;

  const pressureSegments: Array<{ value: number; hours: number; end: number }> = [];
  const tempSegments: Array<{ value: number; hours: number }> = [];
  let equilibriumDeltaBarHours = 0;
  let equilibriumHours = 0;
  let coveredHours = 0;

  function consume(until: number) {
    const hours = Math.max(0, (until - cursor) / 3600000);
    if (hours <= 0) {
      cursor = until;
      return;
    }

    if (lastPressure !== null) {
      pressureSegments.push({ value: lastPressure, hours, end: until });
      coveredHours += hours;
    }
    if (lastTemp !== null) {
      tempSegments.push({ value: lastTemp, hours });
    }
    if (lastPressure !== null) {
      const eq = equilibriumPressure(lastTemp);
      if (eq !== null) {
        equilibriumDeltaBarHours += (lastPressure - eq) * hours;
        equilibriumHours += hours;
      }
    }
    cursor = until;
  }

  rows.forEach((row) => {
    consume(row.time);
    if (row.pressure !== null) lastPressure = row.pressure;
    if (row.temp !== null) lastTemp = row.temp;
  });
  consume(args.endMs);

  const last24Start = args.endMs - 24 * 3600000;
  const last48Start = args.endMs - 48 * 3600000;

  function trailingMean(startMs: number): number | null {
    const points: Array<{ value: number; hours: number }> = [];
    pressureSegments.forEach((segment) => {
      const segmentStart = segment.end - segment.hours * 3600000;
      const overlapStart = Math.max(segmentStart, startMs);
      const overlapEnd = Math.min(segment.end, args.endMs);
      const hours = Math.max(0, (overlapEnd - overlapStart) / 3600000);
      if (hours > 0) points.push({ value: segment.value, hours });
    });
    return weightedMean(points);
  }

  return {
    hoursSinceT0,
    pressureHours: pressureSegments.reduce((sum, segment) => sum + segment.value * segment.hours, 0),
    temperatureHours: tempSegments.reduce((sum, segment) => sum + segment.value * segment.hours, 0),
    equilibriumDeltaBarHours:
      equilibriumHours > 0 ? equilibriumDeltaBarHours : null,
    pressureMean: weightedMean(
      pressureSegments.map((segment) => ({ value: segment.value, hours: segment.hours })),
    ),
    pressureMean24h: trailingMean(last24Start),
    pressureMean48h: trailingMean(last48Start),
    temperatureMean: weightedMean(tempSegments),
    pressurePoints: rows.filter((row) => row.pressure !== null).length,
    temperaturePoints: rows.filter((row) => row.temp !== null).length,
    coveredHours,
    coverageRatio: hoursSinceT0 > 0 ? Math.min(1, coveredHours / hoursSinceT0) : 0,
  };
}

function valueAtOrBefore(
  rows: Array<{ measurement: PressureV4Measurement; time: number }>,
  endMs: number,
  field: "temp" | "pressure",
): number | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index].time > endMs) continue;
    const value = finiteNumber(rows[index].measurement[field]);
    if (value !== null) return value;
  }
  return null;
}

function detectCoolingStartMs(
  measurements: PressureV4Measurement[],
  t0Ms: number,
): number | null {
  const rows = measurements
    .map((measurement) => ({
      measurement,
      time: measurementDateTimeMs(measurement),
      temp: finiteNumber(measurement.temp),
    }))
    .filter((row): row is {
      measurement: PressureV4Measurement;
      time: number;
      temp: number | null;
    } => row.time !== null && row.time >= t0Ms)
    .sort((a, b) => a.time - b.time);

  const explicit = rows.find((row) => isCoolingAction(row.measurement));
  if (explicit) return explicit.time;

  // Fallback only when the action note is absent: first clear crossing from
  // fermentation temperature into the cold range.
  let previousTemp: number | null = null;
  for (const row of rows) {
    if (row.temp === null) continue;
    if (previousTemp !== null && previousTemp > 9 && row.temp <= 9) {
      return row.time;
    }
    previousTemp = row.temp;
  }
  return null;
}

export function buildPressureV4CoolingState(args: {
  measurements: PressureV4Measurement[];
  t0Ms: number;
  endMs: number;
  equilibriumPressure?: EquilibriumPressureFn;
}): PressureV4CoolingState | null {
  const coolingStartMs = detectCoolingStartMs(args.measurements, args.t0Ms);
  if (coolingStartMs === null || coolingStartMs > args.endMs) return null;

  const rows = args.measurements
    .map((measurement) => ({
      measurement,
      time: measurementDateTimeMs(measurement),
    }))
    .filter((row): row is { measurement: PressureV4Measurement; time: number } =>
      row.time !== null
    )
    .sort((a, b) => a.time - b.time);

  const startTemp = valueAtOrBefore(rows, coolingStartMs, "temp");
  const currentTemp = valueAtOrBefore(rows, args.endMs, "temp");
  const temp24hAgo = valueAtOrBefore(
    rows,
    Math.max(coolingStartMs, args.endMs - 24 * 3600000),
    "temp",
  );

  const exposure = buildPressureV4Exposure({
    measurements: args.measurements,
    t0Ms: coolingStartMs,
    endMs: args.endMs,
    equilibriumPressure: args.equilibriumPressure,
  });

  const tempDropSinceCooling =
    startTemp !== null && currentTemp !== null
      ? startTemp - currentTemp
      : null;
  const tempChange24h =
    temp24hAgo !== null && currentTemp !== null
      ? currentTemp - temp24hAgo
      : null;

  return {
    startDateTimeMs: coolingStartMs,
    hoursSinceCooling: Math.max(0, (args.endMs - coolingStartMs) / 3600000),
    startTemp,
    currentTemp,
    tempDropSinceCooling,
    tempChange24h,
    pressureMeanSinceCooling: exposure.pressureMean,
    pressureMean24h: exposure.pressureMean24h,
    pressureHoursSinceCooling: exposure.pressureHours,
    equilibriumDeltaBarHoursSinceCooling:
      exposure.equilibriumDeltaBarHours,
    coverageRatio: exposure.coverageRatio,
    stillCooling:
      tempChange24h !== null
        ? tempChange24h <= -0.5
        : (
            startTemp !== null &&
            currentTemp !== null &&
            startTemp - currentTemp >= 2 &&
            currentTemp > 2
          ),
  };
}


function sampleQuality(exposure: PressureV4Exposure): "low" | "medium" | "high" {
  if (
    exposure.coverageRatio >= 0.75 &&
    exposure.pressurePoints >= 4 &&
    exposure.temperaturePoints >= 3
  ) return "high";

  if (
    exposure.coverageRatio >= 0.4 &&
    exposure.pressurePoints >= 2 &&
    exposure.temperaturePoints >= 1
  ) return "medium";

  return "low";
}

export function buildPressureV4Samples(args: {
  measurements: PressureV4Measurement[];
  batchId?: string;
  style?: string;
  equilibriumPressure?: EquilibriumPressureFn;
  positivePressureThreshold?: number;
}): PressureV4Sample[] {
  const rows = args.measurements
    .map((measurement) => ({
      measurement,
      time: measurementDateTimeMs(measurement),
    }))
    .filter((row): row is { measurement: PressureV4Measurement; time: number } =>
      row.time !== null
    )
    .sort((a, b) => a.time - b.time);

  const t0 = detectPressureV4T0(
    args.measurements,
    args.positivePressureThreshold ?? 0.1,
  );
  if (!t0) return [];

  const samples: PressureV4Sample[] = [];

  rows.forEach((row, actionIndex) => {
    if (row.time < t0.dateTimeMs) return;

    const targetPressure = ordinaryPressureTarget(row.measurement);
    if (targetPressure === null) return;

    const currentCarb = finiteNumber(row.measurement.carbonation);
    if (currentCarb === null) return;

    // The pressure recorded on an action row is usually the post-action
    // target. Learn the physical change from the most recent pressure observed
    // before the action; only fall back to the action row when no prior
    // pressure exists.
    let currentPressure: number | null = null;
    for (let index = actionIndex - 1; index >= 0; index -= 1) {
      const candidate = finiteNumber(rows[index].measurement.pressure);
      if (candidate !== null) {
        currentPressure = candidate;
        break;
      }
    }
    if (currentPressure === null) {
      currentPressure = finiteNumber(row.measurement.pressure);
    }
    if (currentPressure === null) return;

    const intermediate = rows.find((candidate, index) =>
      index > actionIndex &&
      calendarDayDiff(row.time, candidate.time) === 1 &&
      finiteNumber(candidate.measurement.carbonation) !== null
    );

    const outcome = rows.find((candidate, index) => {
      if (index <= actionIndex) return false;
      const dayDiff = calendarDayDiff(row.time, candidate.time);
      if (dayDiff !== 2) return false;
      return finiteNumber(candidate.measurement.carbonation) !== null;
    });
    if (!outcome) return;

    const invalidatingRows = rows.filter((candidate, index) => {
      if (index <= actionIndex || candidate.time >= outcome.time) return false;
      return (
        isBottomCarbonation(candidate.measurement) ||
        ordinaryPressureTarget(candidate.measurement) !== null
      );
    });
    if (invalidatingRows.length > 0) return;

    const exposure = buildPressureV4Exposure({
      measurements: args.measurements,
      t0Ms: t0.dateTimeMs,
      endMs: row.time,
      equilibriumPressure: args.equilibriumPressure,
    });

    const outcomeCarb = finiteNumber(outcome.measurement.carbonation)!;
    const intermediateCarb = intermediate
      ? finiteNumber(intermediate.measurement.carbonation)
      : null;

    samples.push({
      batchId: args.batchId,
      style: args.style,
      t0,
      actionDateTimeMs: row.time,
      actionDate: dateOnly(row.measurement.id) ?? "",
      carbonationBefore: currentCarb,
      currentPressure,
      targetPressure,
      currentTemp: finiteNumber(row.measurement.temp),
      hoursSinceT0: Math.max(0, (row.time - t0.dateTimeMs) / 3600000),
      exposure,
      intermediateDay1: intermediate && intermediateCarb !== null
        ? {
            carbonation: intermediateCarb,
            dateTimeMs: intermediate.time,
            calendarDaysAfterAction: 1,
          }
        : null,
      primaryOutcome: {
        carbonation: outcomeCarb,
        dateTimeMs: outcome.time,
        calendarDaysAfterAction: 2,
      },
      carbonationDelta: outcomeCarb - currentCarb,
      actionPressureDelta: targetPressure - currentPressure,
      quality: sampleQuality(exposure),
    });
  });

  return samples;
}


export function buildPressureV4PassiveSamples(args: {
  measurements: PressureV4Measurement[];
  batchId?: string;
  style?: string;
  equilibriumPressure?: EquilibriumPressureFn;
  positivePressureThreshold?: number;
}): PressureV4PassiveSample[] {
  const rows = args.measurements
    .map((measurement) => ({
      measurement,
      time: measurementDateTimeMs(measurement),
    }))
    .filter((row): row is { measurement: PressureV4Measurement; time: number } =>
      row.time !== null
    )
    .sort((a, b) => a.time - b.time);

  const t0 = detectPressureV4T0(
    args.measurements,
    args.positivePressureThreshold ?? 0.1,
  );
  if (!t0) return [];

  const samples: PressureV4PassiveSample[] = [];

  rows.forEach((row, startIndex) => {
    if (row.time < t0.dateTimeMs) return;
    if (
      isBottomCarbonation(row.measurement) ||
      ordinaryPressureTarget(row.measurement) !== null
    ) return;

    const carbonationBefore = finiteNumber(row.measurement.carbonation);
    if (carbonationBefore === null) return;

    let currentPressure: number | null = finiteNumber(row.measurement.pressure);
    let currentTemp: number | null = finiteNumber(row.measurement.temp);

    for (let index = startIndex - 1; index >= 0; index -= 1) {
      if (currentPressure === null) {
        currentPressure = finiteNumber(rows[index].measurement.pressure);
      }
      if (currentTemp === null) {
        currentTemp = finiteNumber(rows[index].measurement.temp);
      }
      if (currentPressure !== null && currentTemp !== null) break;
    }
    if (currentPressure === null) return;

    const outcome = rows.find((candidate, index) => {
      if (index <= startIndex) return false;
      const dayDiff = calendarDayDiff(row.time, candidate.time);
      if (dayDiff !== 2) return false;
      return finiteNumber(candidate.measurement.carbonation) !== null;
    });
    if (!outcome) return;

    const invalidatingRows = rows.filter((candidate, index) => {
      if (index <= startIndex || candidate.time >= outcome.time) return false;
      return (
        isBottomCarbonation(candidate.measurement) ||
        ordinaryPressureTarget(candidate.measurement) !== null
      );
    });
    if (invalidatingRows.length > 0) return;

    const exposure = buildPressureV4Exposure({
      measurements: args.measurements,
      t0Ms: t0.dateTimeMs,
      endMs: row.time,
      equilibriumPressure: args.equilibriumPressure,
    });

    const outcomeCarb = finiteNumber(outcome.measurement.carbonation);
    if (outcomeCarb === null) return;

    samples.push({
      batchId: args.batchId,
      style: args.style,
      sampleDateTimeMs: row.time,
      sampleDate: dateOnly(row.measurement.id) ?? "",
      carbonationBefore,
      currentPressure,
      currentTemp,
      hoursSinceT0: Math.max(0, (row.time - t0.dateTimeMs) / 3600000),
      exposure,
      primaryOutcome: {
        carbonation: outcomeCarb,
        dateTimeMs: outcome.time,
        calendarDaysAfterAction: 2,
      },
      carbonationDelta: outcomeCarb - carbonationBefore,
      quality: sampleQuality(exposure),
    });
  });

  return samples;
}


export function buildPressureV4DecisionState(args: {
  measurements: PressureV4Measurement[];
  equilibriumPressure?: EquilibriumPressureFn;
}): PressureV4DecisionState | null {
  const rows = args.measurements
    .map((measurement) => ({
      measurement,
      time: measurementDateTimeMs(measurement),
    }))
    .filter((row): row is { measurement: PressureV4Measurement; time: number } =>
      row.time !== null
    )
    .sort((a, b) => a.time - b.time);

  if (!rows.length) return null;

  const t0 = detectPressureV4T0(args.measurements);
  if (!t0) return null;

  const latest = rows[rows.length - 1];
  let carbonation: number | null = null;
  let currentPressure: number | null = null;
  let currentTemp: number | null = null;

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index].measurement;
    if (carbonation === null) carbonation = finiteNumber(row.carbonation);
    if (currentPressure === null) currentPressure = finiteNumber(row.pressure);
    if (currentTemp === null) currentTemp = finiteNumber(row.temp);
    if (
      carbonation !== null &&
      currentPressure !== null &&
      currentTemp !== null
    ) break;
  }

  if (carbonation === null || currentPressure === null) return null;

  const exposure = buildPressureV4Exposure({
    measurements: args.measurements,
    t0Ms: t0.dateTimeMs,
    endMs: latest.time,
    equilibriumPressure: args.equilibriumPressure,
  });
  const cooling = buildPressureV4CoolingState({
    measurements: args.measurements,
    t0Ms: t0.dateTimeMs,
    endMs: latest.time,
    equilibriumPressure: args.equilibriumPressure,
  });

  return {
    carbonation,
    currentPressure,
    currentTemp,
    hoursSinceT0: Math.max(0, (latest.time - t0.dateTimeMs) / 3600000),
    exposure,
    cooling,
  };
}
