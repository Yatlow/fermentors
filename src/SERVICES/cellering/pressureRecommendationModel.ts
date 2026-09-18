import { doc, getDoc } from "firebase/firestore";
import { db } from "../../firebase";

export type PressureResponseSample = {
  batchId?: string;
  brewDay?: number | null;
  temp?: number | null;
  carbonationBefore: number;
  pressureBefore: number;
  targetPressure: number;
  pressureDelta: number;
  carbonationAfter: number;
  carbonationDelta: number;
  elapsedDays: number;
  success?: boolean;
};

export type PressureResponseModel = {
  style: string;
  samples: PressureResponseSample[];
  sampleCount?: number;
  updatedAt?: string;
};

export type PressureRecommendationEstimate = {
  targetPressure: number;
  pressureDelta: number;
  sampleCount: number;
  confidence: "medium" | "high";
  expectedDays: number;
  responsePerBar: number;
};

const MODEL_CACHE_MS = 5 * 60 * 1000;
const modelCache = new Map<string, {
  loadedAt: number;
  data: PressureResponseModel | null;
  pending?: Promise<PressureResponseModel | null>;
}>();

export function normalizePressureModelStyle(style: unknown): string {
  return String(style ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)[0] || "other";
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
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
  ) {
    return null;
  }

  const direction = Math.sign(desiredCarbDelta);
  const valid = args.samples
    .filter((sample) => sample?.success !== false)
    .map((sample) => ({
      ...sample,
      pressureDelta: finiteNumber(sample.pressureDelta),
      carbonationDelta: finiteNumber(sample.carbonationDelta),
      elapsedDays: finiteNumber(sample.elapsedDays),
      brewDay: finiteNumber(sample.brewDay),
      temp: finiteNumber(sample.temp),
    }))
    .filter((sample) =>
      sample.pressureDelta !== null &&
      sample.carbonationDelta !== null &&
      sample.elapsedDays !== null &&
      Math.sign(sample.pressureDelta) === direction &&
      Math.sign(sample.carbonationDelta) === direction &&
      Math.abs(sample.pressureDelta) >= 0.02 &&
      Math.abs(sample.carbonationDelta) >= 0.01 &&
      sample.elapsedDays >= 1 &&
      sample.elapsedDays <= 5
    )
    .sort((a, b) => {
      const aAge = brewDay !== null && a.brewDay !== null ? Math.abs(a.brewDay - brewDay) : 0;
      const bAge = brewDay !== null && b.brewDay !== null ? Math.abs(b.brewDay - brewDay) : 0;
      const aTemp = temp !== null && a.temp !== null ? Math.abs(a.temp - temp) : 0;
      const bTemp = temp !== null && b.temp !== null ? Math.abs(b.temp - temp) : 0;
      return aAge - bAge || aTemp - bTemp;
    })
    .slice(0, 30);

  if (valid.length < 5) return null;

  const responseRates = valid
    .map((sample) => Math.abs(sample.carbonationDelta! / sample.pressureDelta!))
    .filter((rate) => Number.isFinite(rate) && rate >= 0.05 && rate <= 4);
  const responsePerBar = median(responseRates);
  if (responsePerBar === null || responseRates.length < 5) return null;

  const rawDelta = desiredCarbDelta / responsePerBar;
  const boundedDelta = clamp(rawDelta, -0.35, 0.35);
  const roundedDelta = roundToStep(boundedDelta, 0.05);
  if (Math.abs(roundedDelta) < 0.05) return null;

  const expectedDaysMedian = median(
    valid.map((sample) => sample.elapsedDays!).filter(Number.isFinite),
  );

  const targetPressure = clamp(
    roundToStep(currentPressure + roundedDelta, 0.05),
    0,
    2.2,
  );

  return {
    targetPressure: Number(targetPressure.toFixed(2)),
    pressureDelta: Number((targetPressure - currentPressure).toFixed(2)),
    sampleCount: valid.length,
    confidence: valid.length >= 12 ? "high" : "medium",
    expectedDays: Math.max(1, Math.round(expectedDaysMedian ?? 2)),
    responsePerBar: Number(responsePerBar.toFixed(3)),
  };
}

export async function getPressureResponseModel(
  style: unknown,
): Promise<PressureResponseModel | null> {
  const key = normalizePressureModelStyle(style);
  const cached = modelCache.get(key);
  const now = Date.now();

  if (cached?.data !== undefined && now - cached.loadedAt < MODEL_CACHE_MS) {
    return cached.data;
  }
  if (cached?.pending) return cached.pending;

  const pending = getDoc(doc(db, "pressureResponseModels", key))
    .then((snapshot) => {
      if (!snapshot.exists()) return null;
      const data = snapshot.data() as Partial<PressureResponseModel>;
      return {
        style: String(data.style ?? key),
        samples: Array.isArray(data.samples) ? data.samples : [],
        sampleCount: Number(data.sampleCount ?? 0),
        updatedAt: data.updatedAt ? String(data.updatedAt) : undefined,
      } satisfies PressureResponseModel;
    })
    .catch((error) => {
      console.warn("Pressure response model unavailable", { style: key, error });
      return null;
    });

  modelCache.set(key, { loadedAt: now, data: cached?.data ?? null, pending });
  const data = await pending;
  modelCache.set(key, { loadedAt: Date.now(), data });
  return data;
}
