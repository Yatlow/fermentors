import {
  equilibriumCarbonationVolumes,
  equilibriumPressureBar,
} from "./pressureCarbonationPhysics";
import type {
  PressureV4Measurement,
} from "./pressurePredictionV4";

const ATMOSPHERIC_PRESSURE_BAR = 1.01325;
const GAS_CONSTANT_L_BAR_PER_MOL_K = 0.083144626;
const STANDARD_CO2_MOLAR_VOLUME_L = 22.414;
const MAX_OPERATIONAL_PRESSURE_BAR = 1.9;
const MIN_HEADSPACE_LITERS = 25;

export type PressureV9TankClass =
  | "single"
  | "double"
  | "triple";

export type PressureV9Estimate = {
  version: 9;
  tankClass: PressureV9TankClass;
  tankNumber: number;
  vesselVolumeLiters: number;
  beerVolumeLiters: number;
  headspaceLiters: number;
  headspaceFraction: number;
  geometryAssumption: "estimated";

  currentCarbonation: number;
  currentPressure: number;
  currentTemperature: number;
  targetCarbonation: number;
  finalTemperature: number;
  targetFinalEquilibriumPressure: number;

  kPerHour: number;
  coolingHoursRemaining: number;

  expectedFutureYeastDrops: number;
  expectedFutureOperationalLossBar: number;
  operationalLossSource:
    | "observed_batch_yeast_drop"
    | "fallback_one_cold_drop"
    | "none";

  targetPressure: number | null;
  action:
    | "hold"
    | "raise"
    | "lower"
    | "insufficient_geometry"
    | "outside_operational_range";

  holdFinalCarbonation: number | null;
  holdFinalPressure: number | null;
  targetFinalCarbonation: number | null;
  targetFinalPressure: number | null;

  target48hCarbonation: number | null;
  target48hPressure: number | null;
  target72hCarbonation: number | null;
  target72hPressure: number | null;
  target96hCarbonation: number | null;
  target96hPressure: number | null;

  geometrySensitivityLowBar: number | null;
  geometrySensitivityHighBar: number | null;
  geometrySensitivityWidthBar: number | null;
  operationalLossSensitivityLowBar: number | null;
  operationalLossSensitivityHighBar: number | null;

  massBalanceResidualMoles: number | null;
};

type TankGeometry = {
  tankClass: PressureV9TankClass;
  totalVolumeLiters: number;
};

type TrajectoryPoint = {
  hour: number;
  temperature: number;
  carbonation: number;
  pressure: number;
};

export type PressureV9TemperaturePathPoint = {
  hour: number;
  temperature: number;
};

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(String(value).replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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

export function estimatedV9TankGeometry(
  tankNumber: number,
): TankGeometry | null {
  if (!Number.isFinite(tankNumber) || tankNumber < 2) {
    return null;
  }

  if (tankNumber < 5) {
    return {
      tankClass: "single",
      totalVolumeLiters: 1300,
    };
  }

  if (tankNumber < 9) {
    return {
      tankClass: "double",
      totalVolumeLiters: 3000,
    };
  }

  return {
    tankClass: "triple",
    totalVolumeLiters: 4000,
  };
}

function dissolvedCo2Moles(
  carbonationVolumes: number,
  beerVolumeLiters: number,
): number {
  return (
    carbonationVolumes *
    beerVolumeLiters /
    STANDARD_CO2_MOLAR_VOLUME_L
  );
}

function headspaceCo2Moles(args: {
  gaugePressureBar: number;
  headspaceLiters: number;
  temperatureC: number;
}): number {
  const absolutePressureBar =
    args.gaugePressureBar +
    ATMOSPHERIC_PRESSURE_BAR;
  const temperatureK = args.temperatureC + 273.15;

  return (
    absolutePressureBar *
    args.headspaceLiters /
    (GAS_CONSTANT_L_BAR_PER_MOL_K * temperatureK)
  );
}

function gaugePressureFromHeadspaceMoles(args: {
  gasMoles: number;
  headspaceLiters: number;
  temperatureC: number;
}): number {
  const temperatureK = args.temperatureC + 273.15;
  const absolutePressure =
    args.gasMoles *
    GAS_CONSTANT_L_BAR_PER_MOL_K *
    temperatureK /
    args.headspaceLiters;

  return absolutePressure - ATMOSPHERIC_PRESSURE_BAR;
}

function totalMolesAtState(args: {
  carbonation: number;
  pressure: number;
  temperature: number;
  beerVolumeLiters: number;
  headspaceLiters: number;
}): number {
  return (
    dissolvedCo2Moles(
      args.carbonation,
      args.beerVolumeLiters,
    ) +
    headspaceCo2Moles({
      gaugePressureBar: args.pressure,
      headspaceLiters: args.headspaceLiters,
      temperatureC: args.temperature,
    })
  );
}

function operationalLossMoles(args: {
  lossBar: number;
  headspaceLiters: number;
  temperatureC: number;
}): number {
  if (args.lossBar <= 0) return 0;

  return (
    args.lossBar *
    args.headspaceLiters /
    (
      GAS_CONSTANT_L_BAR_PER_MOL_K *
      (args.temperatureC + 273.15)
    )
  );
}

function equilibriumTotalMolesAtPressure(args: {
  gaugePressureBar: number;
  temperatureC: number;
  beerVolumeLiters: number;
  headspaceLiters: number;
}): number | null {
  const carbonation =
    equilibriumCarbonationVolumes(
      args.temperatureC,
      args.gaugePressureBar,
    );
  if (carbonation === null) return null;

  return (
    dissolvedCo2Moles(
      carbonation,
      args.beerVolumeLiters,
    ) +
    headspaceCo2Moles({
      gaugePressureBar: args.gaugePressureBar,
      headspaceLiters: args.headspaceLiters,
      temperatureC: args.temperatureC,
    })
  );
}

function solveClosedTankEquilibrium(args: {
  totalMoles: number;
  temperatureC: number;
  beerVolumeLiters: number;
  headspaceLiters: number;
}): {
  carbonation: number;
  pressure: number;
  residualMoles: number;
} | null {
  let low = -0.95;
  let high = 4;

  const value = (pressure: number): number | null => {
    const total = equilibriumTotalMolesAtPressure({
      gaugePressureBar: pressure,
      temperatureC: args.temperatureC,
      beerVolumeLiters: args.beerVolumeLiters,
      headspaceLiters: args.headspaceLiters,
    });
    return total === null ? null : total - args.totalMoles;
  };

  let lowValue = value(low);
  let highValue = value(high);
  if (lowValue === null || highValue === null) return null;

  for (let expansion = 0; expansion < 4 && highValue < 0; expansion += 1) {
    high += 3;
    highValue = value(high);
    if (highValue === null) return null;
  }

  if (lowValue > 0 || highValue < 0) return null;

  for (let iteration = 0; iteration < 90; iteration += 1) {
    const middle = (low + high) / 2;
    const middleValue = value(middle);
    if (middleValue === null) return null;

    if (middleValue > 0) {
      high = middle;
      highValue = middleValue;
    } else {
      low = middle;
      lowValue = middleValue;
    }
  }

  const pressure = (low + high) / 2;
  const carbonation =
    equilibriumCarbonationVolumes(
      args.temperatureC,
      pressure,
    );
  if (carbonation === null) return null;

  const residual = value(pressure);

  return {
    carbonation,
    pressure,
    residualMoles: residual ?? 0,
  };
}

function requiredActionPressureForTarget(args: {
  currentCarbonation: number;
  currentTemperature: number;
  beerVolumeLiters: number;
  headspaceLiters: number;
  targetCarbonation: number;
  finalTemperature: number;
  futureOperationalLossBar: number;
}): number | null {
  const finalPressure = equilibriumPressureBar(
    args.finalTemperature,
    args.targetCarbonation,
  );
  if (finalPressure === null) return null;

  const requiredFinalMoles = totalMolesAtState({
    carbonation: args.targetCarbonation,
    pressure: finalPressure,
    temperature: args.finalTemperature,
    beerVolumeLiters: args.beerVolumeLiters,
    headspaceLiters: args.headspaceLiters,
  });

  const lossReferenceTemperature =
    clamp(
      Math.min(args.currentTemperature, 2),
      args.finalTemperature,
      3,
    );
  const lossMoles = operationalLossMoles({
    lossBar: args.futureOperationalLossBar,
    headspaceLiters: args.headspaceLiters,
    temperatureC: lossReferenceTemperature,
  });

  const dissolvedNow = dissolvedCo2Moles(
    args.currentCarbonation,
    args.beerVolumeLiters,
  );
  const requiredGasMoles =
    requiredFinalMoles +
    lossMoles -
    dissolvedNow;

  if (requiredGasMoles <= 0) return -1;

  return gaugePressureFromHeadspaceMoles({
    gasMoles: requiredGasMoles,
    headspaceLiters: args.headspaceLiters,
    temperatureC: args.currentTemperature,
  });
}

function parseYeastLosses(
  measurements: PressureV4Measurement[],
): number[] {
  const rows = measurements.slice().sort(
    (a, b) =>
      String(a.id ?? "").localeCompare(
        String(b.id ?? ""),
      ),
  );
  const losses: number[] = [];
  let previousPressure: number | null = null;

  for (const row of rows) {
    const pressure = finite(row.pressure);
    const note = String(row.notes ?? "");

    if (/שמר(?:ים|י)/.test(note)) {
      const match = note.match(
        /לחץ\s+אחרי\s*:?-?\s*(\d+(?:[.,]\d+)?)\s*(?:bar|באר)?/i,
      );
      const after = match ? finite(match[1]) : null;
      const before = pressure ?? previousPressure;

      if (
        before !== null &&
        after !== null &&
        before > after
      ) {
        const loss = before - after;
        if (loss >= 0.02 && loss <= 0.6) {
          losses.push(loss);
        }
      }
    }

    if (pressure !== null) {
      previousPressure = pressure;
    }
  }

  return losses;
}

function coolingIndex(
  measurements: PressureV4Measurement[],
): number {
  const rows = measurements.slice().sort(
    (a, b) =>
      String(a.id ?? "").localeCompare(
        String(b.id ?? ""),
      ),
  );

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const note = String(rows[index].notes ?? "");
    if (
      note.includes("קירור") &&
      !/אחרי\s+קירור|לאחר\s+קירור/.test(note)
    ) {
      return index;
    }
  }

  return -1;
}

function hasColdYeastDrop(
  measurements: PressureV4Measurement[],
): boolean {
  const rows = measurements.slice().sort(
    (a, b) =>
      String(a.id ?? "").localeCompare(
        String(b.id ?? ""),
      ),
  );
  const start = coolingIndex(rows);
  if (start < 0) return false;

  return rows
    .slice(start + 1)
    .some((row) =>
      /שמר(?:ים|י)/.test(String(row.notes ?? "")),
    );
}

export function estimateV9FutureOperationalLoss(args: {
  measurements: PressureV4Measurement[];
}): {
  futureDrops: number;
  lossBar: number;
  source:
    | "observed_batch_yeast_drop"
    | "fallback_one_cold_drop"
    | "none";
} {
  if (hasColdYeastDrop(args.measurements)) {
    return {
      futureDrops: 0,
      lossBar: 0,
      source: "none",
    };
  }

  const observedMedian = median(
    parseYeastLosses(args.measurements),
  );

  if (observedMedian !== null) {
    return {
      futureDrops: 1,
      lossBar: clamp(observedMedian, 0.04, 0.3),
      source: "observed_batch_yeast_drop",
    };
  }

  return {
    futureDrops: 1,
    lossBar: 0.12,
    source: "fallback_one_cold_drop",
  };
}

export function estimateV9CoolingHours(args: {
  currentTemperature: number;
  finalTemperature: number;
  tempChange24h?: number | null;
}): number {
  if (
    args.currentTemperature <=
    args.finalTemperature + 0.2
  ) {
    return 0;
  }

  const change24h = finite(args.tempChange24h);
  if (
    change24h !== null &&
    change24h < -0.2
  ) {
    const ratePerHour = Math.abs(change24h) / 24;
    return clamp(
      (
        args.currentTemperature -
        args.finalTemperature
      ) / ratePerHour,
      4,
      72,
    );
  }

  return 24;
}

function interpolatedTemperature(args: {
  hour: number;
  currentTemperature: number;
  finalTemperature: number;
  coolingHours: number;
  temperaturePath?: PressureV9TemperaturePathPoint[];
}): number {
  const path = (args.temperaturePath ?? [])
    .filter(
      (point) =>
        Number.isFinite(point.hour) &&
        Number.isFinite(point.temperature),
    )
    .slice()
    .sort((a, b) => a.hour - b.hour);

  if (path.length >= 2) {
    if (args.hour <= path[0].hour) {
      return path[0].temperature;
    }

    for (let index = 1; index < path.length; index += 1) {
      const right = path[index];
      if (args.hour > right.hour) continue;

      const left = path[index - 1];
      const span = right.hour - left.hour;
      if (span <= 0) return right.temperature;

      const fraction = clamp(
        (args.hour - left.hour) / span,
        0,
        1,
      );
      return (
        left.temperature +
        (right.temperature - left.temperature) * fraction
      );
    }

    return path[path.length - 1].temperature;
  }

  const coolingFraction =
    args.coolingHours <= 0
      ? 1
      : clamp(args.hour / args.coolingHours, 0, 1);

  return (
    args.currentTemperature +
    (
      args.finalTemperature -
      args.currentTemperature
    ) * coolingFraction
  );
}

function simulateTrajectory(args: {
  startCarbonation: number;
  setPressure: number;
  currentTemperature: number;
  finalTemperature: number;
  coolingHours: number;
  beerVolumeLiters: number;
  headspaceLiters: number;
  kPerHour: number;
  futureOperationalLossBar: number;
  hours: number;
  temperaturePath?: PressureV9TemperaturePathPoint[];
}): {
  points: TrajectoryPoint[];
  finalEquilibrium: {
    carbonation: number;
    pressure: number;
    residualMoles: number;
  } | null;
} {
  let liquidMoles = dissolvedCo2Moles(
    args.startCarbonation,
    args.beerVolumeLiters,
  );
  let gasMoles = headspaceCo2Moles({
    gaugePressureBar: args.setPressure,
    headspaceLiters: args.headspaceLiters,
    temperatureC: args.currentTemperature,
  });

  const points: TrajectoryPoint[] = [];
  const lossHour =
    args.futureOperationalLossBar > 0
      ? Math.max(6, Math.min(24, args.coolingHours || 24))
      : -1;

  for (let hour = 0; hour <= args.hours; hour += 1) {
    const temperature = interpolatedTemperature({
      hour,
      currentTemperature: args.currentTemperature,
      finalTemperature: args.finalTemperature,
      coolingHours: args.coolingHours,
      temperaturePath: args.temperaturePath,
    });

    if (
      hour === lossHour &&
      args.futureOperationalLossBar > 0
    ) {
      const loss = operationalLossMoles({
        lossBar: args.futureOperationalLossBar,
        headspaceLiters: args.headspaceLiters,
        temperatureC: temperature,
      });
      gasMoles = Math.max(0.0001, gasMoles - loss);
    }

    let pressure = gaugePressureFromHeadspaceMoles({
      gasMoles,
      headspaceLiters: args.headspaceLiters,
      temperatureC: temperature,
    });
    let carbonation =
      liquidMoles *
      STANDARD_CO2_MOLAR_VOLUME_L /
      args.beerVolumeLiters;

    points.push({
      hour,
      temperature,
      carbonation,
      pressure,
    });

    if (hour >= args.hours) break;

    const equilibrium =
      equilibriumCarbonationVolumes(
        temperature,
        pressure,
      );
    if (equilibrium === null) continue;

    const nextCarbonation =
      equilibrium -
      (
        equilibrium - carbonation
      ) * Math.exp(-args.kPerHour);

    let transferMoles =
      (
        nextCarbonation - carbonation
      ) *
      args.beerVolumeLiters /
      STANDARD_CO2_MOLAR_VOLUME_L;

    if (transferMoles > gasMoles - 0.0001) {
      transferMoles = gasMoles - 0.0001;
    }

    liquidMoles += transferMoles;
    gasMoles -= transferMoles;

    pressure = gaugePressureFromHeadspaceMoles({
      gasMoles,
      headspaceLiters: args.headspaceLiters,
      temperatureC: temperature,
    });
    carbonation =
      liquidMoles *
      STANDARD_CO2_MOLAR_VOLUME_L /
      args.beerVolumeLiters;
  }

  const totalMoles = liquidMoles + gasMoles;
  const finalEquilibrium = solveClosedTankEquilibrium({
    totalMoles,
    temperatureC: args.finalTemperature,
    beerVolumeLiters: args.beerVolumeLiters,
    headspaceLiters: args.headspaceLiters,
  });

  return {
    points,
    finalEquilibrium,
  };
}

export type PressureV9ObservedInventory = {
  tankClass: PressureV9TankClass;
  vesselVolumeLiters: number;
  headspaceLiters: number;
  startTotalMoles: number;
  endTotalMoles: number;
  deltaMoles: number;
  deltaEquivalentCarbonationVol: number;
};

export function pressureV9ObservedInventory(args: {
  tankNumber: number;
  beerVolumeLiters: number;
  vesselVolumeLiters?: number | null;
  startCarbonation: number;
  startPressure: number;
  startTemperature: number;
  endCarbonation: number;
  endPressure: number;
  endTemperature: number;
}): PressureV9ObservedInventory | null {
  const geometry = estimatedV9TankGeometry(
    args.tankNumber,
  );
  if (!geometry) return null;

  const vesselVolumeLiters =
    finite(args.vesselVolumeLiters) ??
    geometry.totalVolumeLiters;
  const headspaceLiters =
    vesselVolumeLiters - args.beerVolumeLiters;
  if (headspaceLiters < MIN_HEADSPACE_LITERS) {
    return null;
  }

  const startTotalMoles = totalMolesAtState({
    carbonation: args.startCarbonation,
    pressure: args.startPressure,
    temperature: args.startTemperature,
    beerVolumeLiters: args.beerVolumeLiters,
    headspaceLiters,
  });
  const endTotalMoles = totalMolesAtState({
    carbonation: args.endCarbonation,
    pressure: args.endPressure,
    temperature: args.endTemperature,
    beerVolumeLiters: args.beerVolumeLiters,
    headspaceLiters,
  });
  const deltaMoles =
    endTotalMoles - startTotalMoles;

  return {
    tankClass: geometry.tankClass,
    vesselVolumeLiters,
    headspaceLiters,
    startTotalMoles,
    endTotalMoles,
    deltaMoles,
    deltaEquivalentCarbonationVol:
      deltaMoles *
      STANDARD_CO2_MOLAR_VOLUME_L /
      args.beerVolumeLiters,
  };
}

export type PressureV9ObservedIntervalPrediction = {
  durationHours: number;
  predictedCarbonation: number;
  predictedPressure: number;
  startTotalMoles: number;
  endTotalMoles: number;
  massBalanceResidualMoles: number;
};

export function simulateV9ObservedClosedInterval(args: {
  tankNumber: number;
  beerVolumeLiters: number;
  vesselVolumeLiters?: number | null;
  startCarbonation: number;
  startPressure: number;
  startTemperature: number;
  endTemperature: number;
  durationHours: number;
  kPerHour: number;
  temperaturePath?: PressureV9TemperaturePathPoint[];
}): PressureV9ObservedIntervalPrediction | null {
  const geometry = estimatedV9TankGeometry(args.tankNumber);
  if (!geometry) return null;

  const vesselVolumeLiters =
    finite(args.vesselVolumeLiters) ??
    geometry.totalVolumeLiters;
  const headspaceLiters =
    vesselVolumeLiters - args.beerVolumeLiters;
  if (headspaceLiters < MIN_HEADSPACE_LITERS) return null;

  const durationHours = clamp(
    Math.round(args.durationHours),
    1,
    168,
  );
  const kPerHour = clamp(args.kPerHour, 0.0002, 0.05);

  const startTotalMoles = totalMolesAtState({
    carbonation: args.startCarbonation,
    pressure: args.startPressure,
    temperature: args.startTemperature,
    beerVolumeLiters: args.beerVolumeLiters,
    headspaceLiters,
  });

  const simulated = simulateTrajectory({
    startCarbonation: args.startCarbonation,
    setPressure: args.startPressure,
    currentTemperature: args.startTemperature,
    finalTemperature: args.endTemperature,
    coolingHours: durationHours,
    beerVolumeLiters: args.beerVolumeLiters,
    headspaceLiters,
    kPerHour,
    futureOperationalLossBar: 0,
    hours: durationHours,
    temperaturePath: args.temperaturePath,
  });

  const endPoint =
    simulated.points[simulated.points.length - 1];
  if (!endPoint) return null;

  const endTotalMoles = totalMolesAtState({
    carbonation: endPoint.carbonation,
    pressure: endPoint.pressure,
    temperature: endPoint.temperature,
    beerVolumeLiters: args.beerVolumeLiters,
    headspaceLiters,
  });

  return {
    durationHours,
    predictedCarbonation: endPoint.carbonation,
    predictedPressure: endPoint.pressure,
    startTotalMoles,
    endTotalMoles,
    massBalanceResidualMoles:
      endTotalMoles - startTotalMoles,
  };
}

function pointAt(
  points: TrajectoryPoint[],
  hour: number,
): TrajectoryPoint | null {
  return (
    points.find((point) => point.hour === hour) ??
    null
  );
}

function targetPressureForGeometry(args: {
  vesselVolumeLiters: number;
  beerVolumeLiters: number;
  currentCarbonation: number;
  currentTemperature: number;
  targetCarbonation: number;
  finalTemperature: number;
  futureOperationalLossBar: number;
}): number | null {
  const headspace =
    args.vesselVolumeLiters -
    args.beerVolumeLiters;
  if (headspace < MIN_HEADSPACE_LITERS) return null;

  return requiredActionPressureForTarget({
    currentCarbonation: args.currentCarbonation,
    currentTemperature: args.currentTemperature,
    beerVolumeLiters: args.beerVolumeLiters,
    headspaceLiters: headspace,
    targetCarbonation: args.targetCarbonation,
    finalTemperature: args.finalTemperature,
    futureOperationalLossBar:
      args.futureOperationalLossBar,
  });
}

export function estimatePressureTargetV9(args: {
  tankNumber: number;
  beerVolumeLiters: number;
  currentCarbonation: number;
  currentPressure: number;
  currentTemperature: number;
  targetCarbonation: number;
  targetToleranceVol: number;
  finalTemperature?: number | null;
  kPerHour?: number | null;
  tempChange24h?: number | null;
  measurements?: PressureV4Measurement[];
}): PressureV9Estimate | null {
  const geometry = estimatedV9TankGeometry(
    args.tankNumber,
  );
  if (!geometry) return null;

  const beerVolume = finite(args.beerVolumeLiters);
  if (
    beerVolume === null ||
    beerVolume <= 0
  ) return null;

  const headspace =
    geometry.totalVolumeLiters - beerVolume;

  const finalTemperature =
    finite(args.finalTemperature) ?? 0.5;
  const kPerHour = clamp(
    finite(args.kPerHour) ?? 0.0025,
    0.0002,
    0.05,
  );

  const operationalLoss =
    estimateV9FutureOperationalLoss({
      measurements: args.measurements ?? [],
    });

  const targetFinalPressure =
    equilibriumPressureBar(
      finalTemperature,
      args.targetCarbonation,
    );
  if (targetFinalPressure === null) return null;

  const common = {
    version: 9 as const,
    tankClass: geometry.tankClass,
    tankNumber: args.tankNumber,
    vesselVolumeLiters:
      geometry.totalVolumeLiters,
    beerVolumeLiters: beerVolume,
    headspaceLiters: headspace,
    headspaceFraction:
      headspace > 0
        ? headspace / geometry.totalVolumeLiters
        : 0,
    geometryAssumption: "estimated" as const,

    currentCarbonation: args.currentCarbonation,
    currentPressure: args.currentPressure,
    currentTemperature: args.currentTemperature,
    targetCarbonation: args.targetCarbonation,
    finalTemperature,
    targetFinalEquilibriumPressure:
      targetFinalPressure,

    kPerHour,
    coolingHoursRemaining:
      estimateV9CoolingHours({
        currentTemperature:
          args.currentTemperature,
        finalTemperature,
        tempChange24h: args.tempChange24h,
      }),

    expectedFutureYeastDrops:
      operationalLoss.futureDrops,
    expectedFutureOperationalLossBar:
      operationalLoss.lossBar,
    operationalLossSource:
      operationalLoss.source,
  };

  if (headspace < MIN_HEADSPACE_LITERS) {
    return {
      ...common,
      targetPressure: null,
      action: "insufficient_geometry",
      holdFinalCarbonation: null,
      holdFinalPressure: null,
      targetFinalCarbonation: null,
      targetFinalPressure: null,
      target48hCarbonation: null,
      target48hPressure: null,
      target72hCarbonation: null,
      target72hPressure: null,
      target96hCarbonation: null,
      target96hPressure: null,
      geometrySensitivityLowBar: null,
      geometrySensitivityHighBar: null,
      geometrySensitivityWidthBar: null,
      operationalLossSensitivityLowBar: null,
      operationalLossSensitivityHighBar: null,
      massBalanceResidualMoles: null,
    };
  }

  const rawTarget = requiredActionPressureForTarget({
    currentCarbonation: args.currentCarbonation,
    currentTemperature: args.currentTemperature,
    beerVolumeLiters: beerVolume,
    headspaceLiters: headspace,
    targetCarbonation: args.targetCarbonation,
    finalTemperature,
    futureOperationalLossBar:
      operationalLoss.lossBar,
  });

  if (rawTarget === null) return null;

  const lossHigh =
    operationalLoss.futureDrops > 0
      ? Math.max(
          0.2,
          operationalLoss.lossBar * 1.5,
        )
      : 0.12;

  const nominalLowVolume =
    geometry.totalVolumeLiters * 0.9;
  const nominalHighVolume =
    geometry.totalVolumeLiters * 1.1;

  const geometryCandidates = [
    nominalLowVolume,
    geometry.totalVolumeLiters,
    nominalHighVolume,
  ]
    .map((vesselVolumeLiters) =>
      targetPressureForGeometry({
        vesselVolumeLiters,
        beerVolumeLiters: beerVolume,
        currentCarbonation:
          args.currentCarbonation,
        currentTemperature:
          args.currentTemperature,
        targetCarbonation:
          args.targetCarbonation,
        finalTemperature,
        futureOperationalLossBar:
          operationalLoss.lossBar,
      }),
    )
    .filter(
      (value): value is number =>
        value !== null &&
        Number.isFinite(value),
    );

  const geometryLow =
    geometryCandidates.length
      ? Math.min(...geometryCandidates)
      : null;
  const geometryHigh =
    geometryCandidates.length
      ? Math.max(...geometryCandidates)
      : null;

  const lossLow = targetPressureForGeometry({
    vesselVolumeLiters:
      geometry.totalVolumeLiters,
    beerVolumeLiters: beerVolume,
    currentCarbonation:
      args.currentCarbonation,
    currentTemperature:
      args.currentTemperature,
    targetCarbonation:
      args.targetCarbonation,
    finalTemperature,
    futureOperationalLossBar: 0,
  });

  const lossHighTarget =
    targetPressureForGeometry({
      vesselVolumeLiters:
        geometry.totalVolumeLiters,
      beerVolumeLiters: beerVolume,
      currentCarbonation:
        args.currentCarbonation,
      currentTemperature:
        args.currentTemperature,
      targetCarbonation:
        args.targetCarbonation,
      finalTemperature,
      futureOperationalLossBar: lossHigh,
    });

  const holdTrajectory = simulateTrajectory({
    startCarbonation:
      args.currentCarbonation,
    setPressure: args.currentPressure,
    currentTemperature:
      args.currentTemperature,
    finalTemperature,
    coolingHours:
      common.coolingHoursRemaining,
    beerVolumeLiters: beerVolume,
    headspaceLiters: headspace,
    kPerHour,
    futureOperationalLossBar:
      operationalLoss.lossBar,
    hours: 120,
  });

  const holdFinal =
    holdTrajectory.finalEquilibrium;

  const holdWithinTolerance =
    holdFinal !== null &&
    Math.abs(
      holdFinal.carbonation -
      args.targetCarbonation,
    ) <= args.targetToleranceVol;

  const targetOperational =
    clamp(
      rawTarget,
      0,
      MAX_OPERATIONAL_PRESSURE_BAR,
    );

  let action: PressureV9Estimate["action"];
  let targetPressure: number | null;

  if (
    rawTarget < 0 ||
    rawTarget > MAX_OPERATIONAL_PRESSURE_BAR
  ) {
    action = "outside_operational_range";
    targetPressure = null;
  } else if (
    holdWithinTolerance ||
    Math.abs(
      targetOperational -
      args.currentPressure,
    ) < 0.03
  ) {
    action = "hold";
    targetPressure = args.currentPressure;
  } else {
    targetPressure = targetOperational;
    action =
      targetPressure > args.currentPressure
        ? "raise"
        : "lower";
  }

  const trajectoryPressure =
    targetPressure ?? targetOperational;

  const targetTrajectory = simulateTrajectory({
    startCarbonation:
      args.currentCarbonation,
    setPressure: trajectoryPressure,
    currentTemperature:
      args.currentTemperature,
    finalTemperature,
    coolingHours:
      common.coolingHoursRemaining,
    beerVolumeLiters: beerVolume,
    headspaceLiters: headspace,
    kPerHour,
    futureOperationalLossBar:
      operationalLoss.lossBar,
    hours: 120,
  });

  const p48 = pointAt(
    targetTrajectory.points,
    48,
  );
  const p72 = pointAt(
    targetTrajectory.points,
    72,
  );
  const p96 = pointAt(
    targetTrajectory.points,
    96,
  );
  const targetFinal =
    targetTrajectory.finalEquilibrium;

  return {
    ...common,
    targetPressure,
    action,
    holdFinalCarbonation:
      holdFinal?.carbonation ?? null,
    holdFinalPressure:
      holdFinal?.pressure ?? null,
    targetFinalCarbonation:
      targetFinal?.carbonation ?? null,
    targetFinalPressure:
      targetFinal?.pressure ?? null,

    target48hCarbonation:
      p48?.carbonation ?? null,
    target48hPressure:
      p48?.pressure ?? null,
    target72hCarbonation:
      p72?.carbonation ?? null,
    target72hPressure:
      p72?.pressure ?? null,
    target96hCarbonation:
      p96?.carbonation ?? null,
    target96hPressure:
      p96?.pressure ?? null,

    geometrySensitivityLowBar:
      geometryLow,
    geometrySensitivityHighBar:
      geometryHigh,
    geometrySensitivityWidthBar:
      geometryLow === null ||
      geometryHigh === null
        ? null
        : geometryHigh - geometryLow,
    operationalLossSensitivityLowBar:
      lossLow,
    operationalLossSensitivityHighBar:
      lossHighTarget,

    massBalanceResidualMoles:
      targetFinal?.residualMoles ?? null,
  };
}
