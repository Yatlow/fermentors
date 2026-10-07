const APP_VERSION = (import.meta as any).env.VITE_APP_VERSION || "development";
const VERSION_URL = "/app-version.json";
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

type VersionFile = {
  version?: string;
};

let reloadStarted = false;
let pendingReload = false;
let editingDepth = 0;

function hasUnsavedEditing(): boolean {
  return editingDepth > 0;
}

export function beginUnsavedEditing(): () => void {
  editingDepth += 1;
  let ended = false;

  return () => {
    if (ended) return;
    ended = true;
    editingDepth = Math.max(0, editingDepth - 1);

    if (editingDepth === 0 && pendingReload && !reloadStarted) {
      reloadStarted = true;
      window.location.reload();
    }
  };
}

export function setUnsavedEditing(isEditing: boolean): void {
  if (isEditing) {
    editingDepth = Math.max(1, editingDepth);
    return;
  }

  editingDepth = 0;
  if (pendingReload && !reloadStarted) {
    reloadStarted = true;
    window.location.reload();
  }
}

async function fetchDeployedVersion(): Promise<string | null> {
  try {
    const response = await fetch(`${VERSION_URL}?t=${Date.now()}`, {
      cache: "no-store",
    });

    if (!response.ok) return null;

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) return null;

    const data = (await response.json()) as VersionFile;
    const version = String(data.version || "").trim();
    return version || null;
  } catch (error) {
    console.warn("Could not check deployed app version", error);
    return null;
  }
}

export async function checkForNewAppVersion(): Promise<void> {
  if (reloadStarted || APP_VERSION === "development") return;

  const deployedVersion = await fetchDeployedVersion();
  if (!deployedVersion || deployedVersion === APP_VERSION) return;

  console.info("New app version detected", {
    current: APP_VERSION,
    deployed: deployedVersion,
  });

  if (hasUnsavedEditing()) {
    pendingReload = true;
    console.info("Deferring app reload until unsaved editing is finished");
    return;
  }

  reloadStarted = true;
  window.location.reload();
}

export function startVersionGuard(): () => void {
  void checkForNewAppVersion();

  // Check even while hidden. A stale background tab can otherwise keep an old
  // Firestore listener graph alive indefinitely and never discover a deployed fix.
  const intervalId = window.setInterval(() => {
    void checkForNewAppVersion();
  }, CHECK_INTERVAL_MS);

  const handleVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      void checkForNewAppVersion();
    }
  };

  const handleFocus = () => {
    void checkForNewAppVersion();
  };

  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("focus", handleFocus);

  const handleBeforeUnload = (event: BeforeUnloadEvent) => {
    if (!hasUnsavedEditing()) return;
    event.preventDefault();
    event.returnValue = "";
  };
  window.addEventListener("beforeunload", handleBeforeUnload);

  return () => {
    window.clearInterval(intervalId);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener("focus", handleFocus);
    window.removeEventListener("beforeunload", handleBeforeUnload);
  };
}
