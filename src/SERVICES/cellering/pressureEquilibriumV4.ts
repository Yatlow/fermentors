export type PressureV4Measurement = {
  id?: string | number | null;
  temp?: string | number | null;
  pressure?: string | number | null;
  carbonation?: string | number | null;
  notes?: string | number | null;
};

import type { Measurement } from "./calculateCelleringRecomendations";
import { detectPressureV4T0 } from "./pressurePredictionV4";

export type PressureEquilibriumV4Point = {
  batchId: string;
  temperature: number;
  pressure: number;
  stableDays: number;
  carbonationChecks: number;
  quality: "medium" | "high";
};

export type PressureEquilibriumV4Curve = {
  style: string;
  points: PressureEquilibriumV4Point[];
};

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

function median(values: number[]): number | null {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function dayKey(measurement: PressureV4Measurement): string | null {
  const text = String(measurement.id ?? "");
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}

function note(measurement: PressureV4Measurement): string {
  return String(measurement.notes ?? "");
}

function hasPressureIntervention(measurement: PressureV4Measurement): boolean {
  const text = note(measurement);
  return (
    text.includes("גיזוז מלמטה") ||
    /(?:העלאת|הורדת|שינוי)\s+לחץ\s+ל/i.test(text)
  );
}

export function buildEquilibriumV4PointForBatch(args: {
  measurements: PressureV4Measurement[];
  batchId: string;
  targetCarbonation: number;
  carbonationTolerance?: number;
  pressureSpreadMax?: number;
  temperatureSpreadMax?: number;
}): PressureEquilibriumV4Point | null {
  const tolerance = args.carbonationTolerance ?? 0.05;
  const pressureSpreadMax = args.pressureSpreadMax ?? 0.1;
  const temperatureSpreadMax = args.temperatureSpreadMax ?? 2;

  const t0 = detectPressureV4T0(args.measurements);
  if (!t0) return null;

  const daily = new Map<string, PressureV4Measurement[]>();
  args.measurements.forEach((measurement) => {
    const key = dayKey(measurement);
    if (!key) return;

    const match = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return;
    const time = new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      12,
    ).getTime();
    if (time < t0.dateTimeMs) return;

    const rows = daily.get(key) ?? [];
    rows.push(measurement);
    daily.set(key, rows);
  });

  const days = Array.from(daily.entries())
    .map(([date, rows]) => {
      const pressures = rows
        .map((row) => finite(row.pressure))
        .filter((value): value is number => value !== null);
      const temps = rows
        .map((row) => finite(row.temp))
        .filter((value): value is number => value !== null);
      const carbons = rows
        .map((row) => finite(row.carbonation))
        .filter((value): value is number => value !== null);

      return {
        date,
        pressure: median(pressures),
        temp: median(temps),
        carbons,
        intervention: rows.some(hasPressureIntervention),
      };
    })
    .filter((day) =>
      day.pressure !== null &&
      day.temp !== null &&
      day.temp <= 9
    )
    .sort((a, b) => a.date.localeCompare(b.date));

  let best:
    | {
        days: typeof days;
        carbons: number[];
      }
    | null = null;

  for (let start = 0; start < days.length; start += 1) {
    for (let end = start + 2; end < days.length; end += 1) {
      const window = days.slice(start, end + 1);
      if (window.some((day) => day.intervention)) continue;

      const pressures = window.map((day) => day.pressure!);
      const temps = window.map((day) => day.temp!);
      const pressureSpread = Math.max(...pressures) - Math.min(...pressures);
      const temperatureSpread = Math.max(...temps) - Math.min(...temps);
      if (
        pressureSpread > pressureSpreadMax ||
        temperatureSpread > temperatureSpreadMax
      ) continue;

      const carbons = window.flatMap((day) => day.carbons);
      const usefulCarbons = carbons.filter(
        (carbonation) =>
          Math.abs(carbonation - args.targetCarbonation) <= tolerance,
      );
      if (usefulCarbons.length === 0) continue;

      // A measured carbonation outside a wider guard band means this window is
      // not trustworthy as equilibrium even if another check happened to be on target.
      if (
        carbons.some(
          (carbonation) =>
            Math.abs(carbonation - args.targetCarbonation) > tolerance + 0.05,
        )
      ) continue;

      if (!best || window.length > best.days.length) {
        best = { days: window, carbons: usefulCarbons };
      }
    }
  }

  if (!best) return null;

  const temperature = median(best.days.map((day) => day.temp!));
  const pressure = median(best.days.map((day) => day.pressure!));
  if (temperature === null || pressure === null) return null;

  return {
    batchId: args.batchId,
    temperature: Number(temperature.toFixed(2)),
    pressure: Number(pressure.toFixed(3)),
    stableDays: best.days.length,
    carbonationChecks: best.carbons.length,
    quality:
      best.days.length >= 4 && best.carbons.length >= 2
        ? "high"
        : "medium",
  };
}

export function estimateEquilibriumPressureV4(
  curve: PressureEquilibriumV4Curve | null | undefined,
  temperature: number | null,
): number | null {
  if (!curve?.points?.length || temperature === null || !Number.isFinite(temperature)) {
    return null;
  }

  const nearest = curve.points
    .filter((point) =>
      Number.isFinite(point.temperature) &&
      Number.isFinite(point.pressure)
    )
    .map((point) => ({
      point,
      distance: Math.abs(point.temperature - temperature),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 15);

  if (nearest.length < 3) return null;

  let weightedPressure = 0;
  let weightSum = 0;
  nearest.forEach(({ point, distance }) => {
    const qualityWeight = point.quality === "high" ? 1.5 : 1;
    const weight = qualityWeight / (0.35 + distance);
    weightedPressure += point.pressure * weight;
    weightSum += weight;
  });

  if (weightSum <= 0) return null;
  return Number((weightedPressure / weightSum).toFixed(3));
}
