const APP_VERSION = (import.meta as any).env.VITE_APP_VERSION || "development";
const VERSION_URL = "/app-version.json";
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

type VersionFile = {
  version?: string;
};

let reloadStarted = false;

async function fetchDeployedVersion(): Promise<string | null> {
  try {
    const response = await fetch(`${VERSION_URL}?t=${Date.now()}`, {
      cache: "no-store",
    });

    if (!response.ok) return null;

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

  reloadStarted = true;
  console.info("New app version detected", {
    current: APP_VERSION,
    deployed: deployedVersion,
  });

  window.location.reload();
}

export function startVersionGuard(): () => void {
  void checkForNewAppVersion();

  const intervalId = window.setInterval(() => {
    if (document.visibilityState === "visible") {
      void checkForNewAppVersion();
    }
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

  return () => {
    window.clearInterval(intervalId);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener("focus", handleFocus);
  };
}
