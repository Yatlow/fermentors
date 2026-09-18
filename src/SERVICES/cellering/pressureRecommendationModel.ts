import { doc, getDoc } from "firebase/firestore";
import { db } from "../../firebase";
import {
  estimatePressureTarget,
  type PressureRecommendationEstimate,
  type PressureResponseSample,
} from "./pressureRecommendationEstimator";

export { estimatePressureTarget };
export type { PressureRecommendationEstimate, PressureResponseSample };

export type PressureResponseModel = {
  style: string;
  samples: PressureResponseSample[];
  sampleCount?: number;
  updatedAt?: string;
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
