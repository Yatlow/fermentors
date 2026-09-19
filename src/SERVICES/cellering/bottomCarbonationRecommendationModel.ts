import { doc, getDoc } from "firebase/firestore";
import { db } from "../../firebase";
import { normalizePressureModelStyle } from "./pressureRecommendationModel";
import type { BottomCarbonationModel } from "./bottomCarbonationEstimator";
export {
  estimateBottomCarbonation,
  getBottomCarbonationActivationThreshold,
} from "./bottomCarbonationEstimator";
export type {
  BottomCarbonationEstimate,
  BottomCarbonationModel,
  BottomCarbonationSample,
} from "./bottomCarbonationEstimator";

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
