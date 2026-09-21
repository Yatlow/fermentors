import type { Fermentor } from "../../App";
import type { SpecChart } from "../getAndPost/getSpecsFromFb";
import type { Measurement } from "./calculateCelleringRecomendations";
import {
  estimatePressureTargetV9,
  type PressureV9Estimate,
} from "./pressurePredictionV9Physics";
import {
  getColdReferenceTemperatureV4,
  getPressurePredictionModelV4,
} from "./pressurePredictionV4Model";
import {
  PRESSURE_V9_K_PER_HOUR,
  PRESSURE_V9_MODEL_VERSION,
} from "./pressurePredictionV9Config";

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

function normalizeStyle(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)[0] || "other";
}

function measurementTimeMs(id: unknown): number | null {
  const text = String(id ?? "").trim();
  const match = text.match(
    /^(\d{4})-(\d{2})-(\d{2})_(\d{1,2})(\d{2})$/,
  );
  if (!match) return null;

  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

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

export function pressureV9TemperatureChange24h(
  measurements: Measurement[],
): number | null {
  const rows = measurements
    .map((row) => ({
      timeMs: measurementTimeMs(row.id),
      temp: finite(row.temp),
    }))
    .filter(
      (row): row is { timeMs: number; temp: number } =>
        row.timeMs !== null && row.temp !== null,
    )
    .sort((a, b) => a.timeMs - b.timeMs);

  if (rows.length < 2) return null;

  const latest = rows[rows.length - 1];
  for (let index = rows.length - 2; index >= 0; index -= 1) {
    const previous = rows[index];
    const hours = (latest.timeMs - previous.timeMs) / 3600000;
    if (hours < 8) continue;
    if (hours > 36) break;
    return ((latest.temp - previous.temp) * 24) / hours;
  }

  return null;
}

export type PressureV9LiveResult = {
  modelConfigVersion: string;
  estimate: PressureV9Estimate;
  targetCarbonation: number;
  targetToleranceVol: number;
  finalTemperature: number;
  kPerHour: number;
};

export async function estimatePressureV9ForTank(args: {
  tank: Fermentor;
  measurements: Measurement[];
  specs: SpecChart;
  carbonation?: number | null;
  pressure?: number | null;
  temperature?: number | null;
  targetCarbonation?: number | null;
}): Promise<PressureV9LiveResult | null> {
  const tankNumber = finite(args.tank.tankNumber);
  const beerVolumeLiters = finite(args.tank.beerVolume);
  const carbonation =
    finite(args.carbonation) ??
    finite(args.tank.currentData?.carbonation);
  const pressure =
    finite(args.pressure) ??
    finite(args.tank.currentData?.pressure);
  const temperature =
    finite(args.temperature) ??
    finite(args.tank.currentData?.temp);

  if (
    tankNumber === null ||
    beerVolumeLiters === null ||
    beerVolumeLiters <= 0 ||
    carbonation === null ||
    pressure === null ||
    temperature === null
  ) {
    return null;
  }

  const style = normalizeStyle(args.tank.beerStyle);
  const targetCarbonation =
    finite(args.targetCarbonation) ??
    finite(
      args.specs.carbonation?.[style] ??
        args.specs.carbonation?.other,
    );
  if (targetCarbonation === null) return null;

  const targetToleranceVol =
    finite(args.specs.tolorances?.carbonation) ?? 0.04;

  const model = await getPressurePredictionModelV4(
    args.tank.beerStyle,
  );
  const finalTemperature =
    (model ? getColdReferenceTemperatureV4(model) : null) ?? 0.5;

  const estimate = estimatePressureTargetV9({
    tankNumber,
    beerVolumeLiters,
    currentCarbonation: carbonation,
    currentPressure: pressure,
    currentTemperature: temperature,
    targetCarbonation,
    targetToleranceVol,
    finalTemperature,
    kPerHour: PRESSURE_V9_K_PER_HOUR,
    tempChange24h: pressureV9TemperatureChange24h(args.measurements),
    measurements: args.measurements,
  });

  if (!estimate) return null;

  return {
    modelConfigVersion: PRESSURE_V9_MODEL_VERSION,
    estimate,
    targetCarbonation,
    targetToleranceVol,
    finalTemperature,
    kPerHour: PRESSURE_V9_K_PER_HOUR,
  };
}
