export type GlobalReadDiagnostic = {
  updatedAt: string;
  counts: Record<string, number>;
};

const STORAGE_KEY = "fermentors:global-read-diagnostics:v1";
const ADMIN_EMAIL = "yisrael@atlow.co.il";

function allowed(): boolean {
  return typeof window !== "undefined" &&
    window.localStorage.getItem("fermentors:diagnostic-admin-email")?.toLowerCase() === ADMIN_EMAIL;
}

export function enableGlobalReadDiagnostics(email: string | null | undefined): void {
  if (typeof window === "undefined" || email?.toLowerCase() !== ADMIN_EMAIL) return;
  try { window.localStorage.setItem("fermentors:diagnostic-admin-email", ADMIN_EMAIL); } catch {}
}

export function recordGlobalServerRead(label: string, count: number): void {
  if (!allowed() || !Number.isFinite(count) || count < 0) return;
  try {
    const current = readGlobalReadDiagnostics() ?? { updatedAt: new Date().toISOString(), counts: {} };
    current.counts[label] = (current.counts[label] ?? 0) + count;
    current.updatedAt = new Date().toISOString();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Diagnostics must never affect normal app behavior.
  }
}

export function readGlobalReadDiagnostics(): GlobalReadDiagnostic | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<GlobalReadDiagnostic>;
    if (!parsed.counts || typeof parsed.counts !== "object") return null;
    return {
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      counts: Object.fromEntries(Object.entries(parsed.counts).filter(([, value]) => typeof value === "number")) as Record<string, number>,
    };
  } catch {
    return null;
  }
}

export function resetGlobalReadDiagnostics(): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.removeItem(STORAGE_KEY); } catch {}
}
