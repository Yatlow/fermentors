type AuditBucket = {
  events: number;
  docs: number;
};

type AuditState = {
  startedAt: number;
  firestoreRequests: number;
  firestoreBytes: number;
  buckets: Record<string, AuditBucket>;
};

const AUDIT_EVENT = "fermentors:read-audit-updated";
const ENABLED = typeof window !== "undefined" && window.location.hostname.includes("--pr");
const state: AuditState = {
  startedAt: Date.now(),
  firestoreRequests: 0,
  firestoreBytes: 0,
  buckets: {},
};

function emit(): void {
  if (!ENABLED) return;
  window.dispatchEvent(new CustomEvent(AUDIT_EVENT));
}

export function isReadAuditEnabled(): boolean {
  return ENABLED;
}

export function recordReadAudit(label: string, docs: number): void {
  if (!ENABLED) return;
  const safeDocs = Math.max(0, Math.round(Number(docs) || 0));
  const current = state.buckets[label] ?? { events: 0, docs: 0 };
  state.buckets[label] = {
    events: current.events + 1,
    docs: current.docs + safeDocs,
  };
  emit();
}

export function getReadAuditSnapshot(): AuditState {
  return {
    startedAt: state.startedAt,
    firestoreRequests: state.firestoreRequests,
    firestoreBytes: state.firestoreBytes,
    buckets: Object.fromEntries(
      Object.entries(state.buckets).map(([key, value]) => [key, { ...value }]),
    ),
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function ensureOverlay(): HTMLElement | null {
  if (!ENABLED || typeof document === "undefined") return null;
  let root = document.getElementById("firestore-read-audit-overlay");
  if (root) return root;

  root = document.createElement("details");
  root.id = "firestore-read-audit-overlay";
  root.setAttribute("dir", "ltr");
  root.style.position = "fixed";
  root.style.left = "8px";
  root.style.bottom = "8px";
  root.style.zIndex = "2147483647";
  root.style.maxWidth = "min(92vw, 390px)";
  root.style.maxHeight = "55vh";
  root.style.overflow = "auto";
  root.style.padding = "7px 9px";
  root.style.border = "1px solid #334155";
  root.style.borderRadius = "8px";
  root.style.background = "rgba(255,255,255,.96)";
  root.style.color = "#0f172a";
  root.style.font = "12px/1.45 system-ui, sans-serif";
  root.style.boxShadow = "0 4px 18px rgba(15,23,42,.18)";
  document.body.appendChild(root);
  return root;
}

function renderOverlay(): void {
  const root = ensureOverlay();
  if (!root) return;
  const snapshot = getReadAuditSnapshot();
  const seconds = Math.max(1, Math.round((Date.now() - snapshot.startedAt) / 1000));
  const rows = Object.entries(snapshot.buckets)
    .sort((a, b) => b[1].docs - a[1].docs)
    .map(([label, value]) => `<div><b>${label}</b>: ${value.docs} docs / ${value.events} events</div>`)
    .join("");
  root.innerHTML = `
    <summary style="cursor:pointer;font-weight:700">Read audit · ${snapshot.firestoreRequests} Firestore req</summary>
    <div style="margin-top:6px">Session ${seconds}s · transfer ${formatBytes(snapshot.firestoreBytes)}</div>
    ${rows || "<div>No instrumented reads yet</div>"}
    <div style="margin-top:5px;opacity:.7">Preview only. Network requests are observed globally; doc counts are instrumented hotspots.</div>
  `;
}

export function startReadAudit(): void {
  if (!ENABLED || typeof window === "undefined") return;

  renderOverlay();
  window.addEventListener(AUDIT_EVENT, renderOverlay);

  if (typeof PerformanceObserver !== "undefined") {
    const observer = new PerformanceObserver((list) => {
      let changed = false;
      list.getEntries().forEach((entry) => {
        const resource = entry as PerformanceResourceTiming;
        const name = String(resource.name || "");
        if (!name.includes("firestore.googleapis.com") && !name.includes("google.firestore.v1.Firestore")) return;
        state.firestoreRequests += 1;
        state.firestoreBytes += Math.max(0, Number(resource.transferSize) || 0);
        changed = true;
      });
      if (changed) renderOverlay();
    });
    try {
      observer.observe({ type: "resource", buffered: true });
    } catch {
      observer.observe({ entryTypes: ["resource"] });
    }
  }

  window.setInterval(renderOverlay, 5000);
}
