import { doc, getDoc } from "firebase/firestore";
import { db } from "../../firebase";
import {
  estimateEquilibriumPressureV4,
  type PressureEquilibriumV4Curve,
  type PressureEquilibriumV4Point,
} from "./pressureEquilibriumV4";
import type { PressureV4Sample } from "./pressurePredictionV4";

export type PressurePredictionModelV4Readiness = {
  ready: boolean;
  usableSampleCount: number;
  distinctBatchCount: number;
  equilibriumPointCount: number;
};

export type PressurePredictionModelV4 = {
  version: 4;
  style: string;
  samples: PressureV4Sample[];
  sampleCount: number;
  equilibriumPoints: PressureEquilibriumV4Point[];
  equilibriumPointCount: number;
  readiness?: PressurePredictionModelV4Readiness;
  updatedAt?: string;
};

const MODEL_CACHE_MS = 5 * 60 * 1000;
const cache = new Map<string, {
  loadedAt: number;
  data: PressurePredictionModelV4 | null;
  pending?: Promise<PressurePredictionModelV4 | null>;
}>();

function normalizeStyle(style: unknown): string {
  return String(style ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)[0] || "other";
}

function enrichExposureWithEquilibrium(
  style: string,
  samples: PressureV4Sample[],
  points: PressureEquilibriumV4Point[],
): PressureV4Sample[] {
  const curve: PressureEquilibriumV4Curve = { style, points };

  return samples.map((sample) => {
    if (sample.exposure.equilibriumDeltaBarHours !== null) return sample;

    const temp =
      sample.exposure.temperatureMean ??
      sample.currentTemp ??
      null;
    const equilibrium = estimateEquilibriumPressureV4(curve, temp);
    if (
      equilibrium === null ||
      sample.exposure.hoursSinceT0 <= 0
    ) return sample;

    const pressureMean =
      sample.exposure.pressureMean ??
      (
        Number.isFinite(sample.exposure.pressureHours) &&
        sample.exposure.hoursSinceT0 > 0
          ? sample.exposure.pressureHours / sample.exposure.hoursSinceT0
          : null
      );

    if (pressureMean === null || !Number.isFinite(pressureMean)) return sample;

    return {
      ...sample,
      exposure: {
        ...sample.exposure,
        equilibriumDeltaBarHours:
          (pressureMean - equilibrium) * sample.exposure.hoursSinceT0,
      },
    };
  });
}

export async function getPressurePredictionModelV4(
  style: unknown,
): Promise<PressurePredictionModelV4 | null> {
  const key = normalizeStyle(style);
  const now = Date.now();
  const cached = cache.get(key);

  if (cached?.data !== undefined && now - cached.loadedAt < MODEL_CACHE_MS) {
    return cached.data;
  }
  if (cached?.pending) return cached.pending;

  const pending = getDoc(doc(db, "pressurePredictionModelsV4", key))
    .then((snapshot) => {
      if (!snapshot.exists()) return null;

      const raw = snapshot.data() as Partial<PressurePredictionModelV4>;
      const points = Array.isArray(raw.equilibriumPoints)
        ? raw.equilibriumPoints
        : [];
      const samples = Array.isArray(raw.samples)
        ? raw.samples
        : [];

      return {
        version: 4,
        style: String(raw.style ?? key),
        samples: enrichExposureWithEquilibrium(key, samples, points),
        sampleCount: Number(raw.sampleCount ?? samples.length),
        equilibriumPoints: points,
        equilibriumPointCount: Number(
          raw.equilibriumPointCount ?? points.length,
        ),
        readiness:
          raw.readiness && typeof raw.readiness === "object"
            ? raw.readiness as PressurePredictionModelV4Readiness
            : undefined,
        updatedAt: raw.updatedAt ? String(raw.updatedAt) : undefined,
      } satisfies PressurePredictionModelV4;
    })
    .catch((error) => {
      console.warn("V4 pressure prediction model unavailable", {
        style: key,
        error,
      });
      return null;
    });

  cache.set(key, {
    loadedAt: now,
    data: cached?.data ?? null,
    pending,
  });

  const data = await pending;
  cache.set(key, { loadedAt: Date.now(), data });
  return data;
}

export function getEquilibriumPressureForV4(
  model: PressurePredictionModelV4,
  temperature: number | null,
): number | null {
  return estimateEquilibriumPressureV4(
    {
      style: model.style,
      points: model.equilibriumPoints,
    },
    temperature,
  );
}


export function isPressurePredictionV4Ready(
  model: PressurePredictionModelV4 | null | undefined,
): boolean {
  if (!model) return false;
  if (model.readiness) return model.readiness.ready === true;

  const usable = model.samples.filter((sample) =>
    sample?.quality !== "low" &&
    sample?.primaryOutcome?.calendarDaysAfterAction === 2 &&
    Number.isFinite(Number(sample.carbonationDelta))
  );
  const batches = new Set(
    usable
      .map((sample) => String(sample.batchId ?? ""))
      .filter(Boolean),
  );
  const equilibriumPoints = model.equilibriumPoints.filter(
    (point) => Boolean(point),
  );

  return (
    usable.length >= 12 &&
    batches.size >= 4 &&
    equilibriumPoints.length >= 3
  );
}
