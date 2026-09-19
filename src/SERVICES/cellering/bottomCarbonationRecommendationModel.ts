import { doc, getDoc } from "firebase/firestore";
import { db } from "../../firebase";
import { normalizePressureModelStyle } from "./pressureRecommendationModel";

export type BottomCarbonationSample = {
  batchId?: string;
  brewDay?: number | null;
  temp?: number | null;
  carbonationBefore: number;
  pressureBefore?: number | null;
  startPressure: number;
  closePressure: number;
  durationMinutes: number;
  carbonationAfter: number;
  carbonationDelta: number;
  elapsedDays: number;
  success?: boolean;
};

export type BottomCarbonationEstimate = {
  startPressure: number;
  closePressure: number;
  durationMinutes: number;
  sampleCount: number;
  confidence: "medium" | "high";
  activationThreshold: number;
  expectedCarbGain: number;
  responsePerMinute: number;
};

export type BottomCarbonationModel = {
  style: string;
  samples: BottomCarbonationSample[];
  sampleCount?: number;
  updatedAt?: string;
};

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
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

function percentile(values: number[], fraction: number): number | null {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.round((sorted.length - 1) * fraction)),
  );
  return sorted[index];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundToStep(value: number, step: number): number {
  return Math.round(value / step) * step;
}

export function estimateBottomCarbonation(args: {
  samples: BottomCarbonationSample[];
  currentCarbonation: number;
  targetCarbonation: number;
  currentPressure?: number | null;
  brewDay?: number | null;
  temp?: number | null;
}): BottomCarbonationEstimate | null {
  const desiredGain = args.targetCarbonation - args.currentCarbonation;
  if (!Number.isFinite(desiredGain) || desiredGain <= 0.04) return null;

  const usable = args.samples
    .filter((sample) => sample?.success !== false)
    .map((sample) => ({
      ...sample,
      brewDay: finiteNumber(sample.brewDay),
      temp: finiteNumber(sample.temp),
      pressureBefore: finiteNumber(sample.pressureBefore),
      carbonationBefore: finiteNumber(sample.carbonationBefore),
      startPressure: finiteNumber(sample.startPressure),
      closePressure: finiteNumber(sample.closePressure),
      durationMinutes: finiteNumber(sample.durationMinutes),
      carbonationDelta: finiteNumber(sample.carbonationDelta),
      elapsedDays: finiteNumber(sample.elapsedDays),
    }))
    .filter((sample) =>
      sample.carbonationBefore !== null &&
      sample.startPressure !== null &&
      sample.closePressure !== null &&
      sample.durationMinutes !== null &&
      sample.carbonationDelta !== null &&
      sample.elapsedDays !== null &&
      sample.durationMinutes >= 5 &&
      sample.durationMinutes <= 360 &&
      sample.carbonationDelta >= 0.02 &&
      sample.elapsedDays >= 1 &&
      sample.elapsedDays <= 4
    );

  if (usable.length < 5) return null;

  const learnedThreshold = percentile(
    usable.map((sample) => sample.carbonationBefore!),
    0.75,
  );
  const activationThreshold = Math.min(
    2.2,
    Number(((learnedThreshold ?? 2.15) + 0.05).toFixed(2)),
  );

  if (args.currentCarbonation > activationThreshold) return null;

  const currentPressure = finiteNumber(args.currentPressure);
  const brewDay = finiteNumber(args.brewDay);
  const temp = finiteNumber(args.temp);

  const similar = usable
    .sort((a, b) => {
      const distance = (sample: typeof a) => {
        let score = Math.abs(sample.carbonationBefore! - args.currentCarbonation) * 5;
        if (brewDay !== null && sample.brewDay !== null) {
          score += Math.abs(sample.brewDay - brewDay) * 0.12;
        }
        if (temp !== null && sample.temp !== null) {
          score += Math.abs(sample.temp - temp) * 0.5;
        }
        if (currentPressure !== null && sample.pressureBefore !== null) {
          score += Math.abs(sample.pressureBefore - currentPressure) * 0.5;
        }
        return score;
      };
      return distance(a) - distance(b);
    })
    .slice(0, 30);

  if (similar.length < 5) return null;

  const responsePerMinute = median(
    similar
      .map((sample) => sample.carbonationDelta! / sample.durationMinutes!)
      .filter((rate) => Number.isFinite(rate) && rate >= 0.0001 && rate <= 0.02),
  );
  const startPressure = median(similar.map((sample) => sample.startPressure!));
  const closePressure = median(similar.map((sample) => sample.closePressure!));
  if (
    responsePerMinute === null ||
    startPressure === null ||
    closePressure === null
  ) {
    return null;
  }

  const durations = similar.map((sample) => sample.durationMinutes!);
  const lowDuration = Math.max(5, percentile(durations, 0.1) ?? 10);
  const highDuration = Math.min(240, percentile(durations, 0.9) ?? 180);
  const rawDuration = desiredGain / responsePerMinute;
  const durationMinutes = Math.round(
    clamp(rawDuration, lowDuration, Math.max(lowDuration, highDuration)),
  );

  return {
    startPressure: Number(roundToStep(startPressure, 0.05).toFixed(2)),
    closePressure: Number(roundToStep(closePressure, 0.05).toFixed(2)),
    durationMinutes,
    sampleCount: similar.length,
    confidence: similar.length >= 12 ? "high" : "medium",
    activationThreshold,
    expectedCarbGain: Number((responsePerMinute * durationMinutes).toFixed(2)),
    responsePerMinute: Number(responsePerMinute.toFixed(5)),
  };
}

const MODEL_CACHE_MS = 5 * 60 * 1000;
const modelCache = new Map<string, {
  loadedAt: number;
  data: BottomCarbonationModel | null;
  pending?: Promise<BottomCarbonationModel | null>;
}>();

export async function getBottomCarbonationModel(
  style: unknown,
): Promise<BottomCarbonationModel | null> {
  const key = normalizePressureModelStyle(style);
  const cached = modelCache.get(key);
  const now = Date.now();

  if (cached?.data !== undefined && now - cached.loadedAt < MODEL_CACHE_MS) {
    return cached.data;
  }
  if (cached?.pending) return cached.pending;

  const pending = getDoc(doc(db, "bottomCarbonationModels", key))
    .then((snapshot) => {
      if (!snapshot.exists()) return null;
      const data = snapshot.data() as Partial<BottomCarbonationModel>;
      return {
        style: String(data.style ?? key),
        samples: Array.isArray(data.samples) ? data.samples : [],
        sampleCount: Number(data.sampleCount ?? 0),
        updatedAt: data.updatedAt ? String(data.updatedAt) : undefined,
      } satisfies BottomCarbonationModel;
    })
    .catch((error) => {
      console.warn("Bottom carbonation model unavailable", { style: key, error });
      return null;
    });

  modelCache.set(key, { loadedAt: now, data: cached?.data ?? null, pending });
  const data = await pending;
  modelCache.set(key, { loadedAt: Date.now(), data });
  return data;
}
