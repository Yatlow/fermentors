export type PlanningReadCounts = {
  recordedAt: string;
  tab: string;
  settings: number | null;
  plans: number | null;
  pallets: number | null;
  packaging: number | null;
  shipments: number | null;
};

const STORAGE_KEY = "fermentors:planning-read-counts:v1";
const ADMIN_EMAIL = "yisrael@atlow.co.il";

export function recordPlanningReadCounts(
  email: string | null | undefined,
  value: PlanningReadCounts,
): void {
  if (typeof window === "undefined" || email?.toLowerCase() !== ADMIN_EMAIL) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Diagnostics must never affect normal planning.
  }
}

export function readPlanningReadCounts(): PlanningReadCounts | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PlanningReadCounts>;
    if (typeof parsed.recordedAt !== "string") return null;
    return {
      recordedAt: parsed.recordedAt,
      tab: String(parsed.tab ?? ""),
      settings: typeof parsed.settings === "number" ? parsed.settings : null,
      plans: typeof parsed.plans === "number" ? parsed.plans : null,
      pallets: typeof parsed.pallets === "number" ? parsed.pallets : null,
      packaging: typeof parsed.packaging === "number" ? parsed.packaging : null,
      shipments: typeof parsed.shipments === "number" ? parsed.shipments : null,
    };
  } catch {
    return null;
  }
}
