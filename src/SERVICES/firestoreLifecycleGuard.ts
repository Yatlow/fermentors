import { disableNetwork, enableNetwork } from "firebase/firestore";
import { db } from "../firebase";

const BACKGROUND_GRACE_MS = 15 * 60 * 1000;

let networkPausedForBackground = false;
let backgroundPauseTimer: number | null = null;
let transition = Promise.resolve();

function queueTransition(action: () => Promise<void>): void {
  transition = transition.then(action, action).catch((error) => {
    console.warn("Firestore lifecycle transition failed", error);
  });
}

function clearBackgroundPauseTimer(): void {
  if (backgroundPauseTimer === null) return;
  window.clearTimeout(backgroundPauseTimer);
  backgroundPauseTimer = null;
}

function pauseForBackground(): void {
  clearBackgroundPauseTimer();
  if (networkPausedForBackground) return;
  backgroundPauseTimer = window.setTimeout(() => {
    backgroundPauseTimer = null;
    if (document.visibilityState !== "hidden" || networkPausedForBackground) return;
    networkPausedForBackground = true;
    queueTransition(async () => {
      await disableNetwork(db);
      console.info("Firestore network paused after 15 minutes in background");
    });
  }, BACKGROUND_GRACE_MS);
}

function resumeFromBackground(): void {
  clearBackgroundPauseTimer();
  if (!networkPausedForBackground) return;
  networkPausedForBackground = false;
  queueTransition(async () => {
    await enableNetwork(db);
    console.info("Firestore network resumed");
  });
}

/**
 * Short browser-tab switches should keep the existing Firestore connection and
 * listeners alive. Only a tab that remains hidden for 15 minutes is taken
 * offline; persistent cache keeps its UI available and pending writes sync on
 * foreground. This avoids reconnect/read churn during normal active sessions.
 */
export function startFirestoreLifecycleGuard(): () => void {
  const syncWithVisibility = () => {
    if (document.visibilityState === "hidden") pauseForBackground();
    else resumeFromBackground();
  };

  syncWithVisibility();
  document.addEventListener("visibilitychange", syncWithVisibility);

  return () => {
    document.removeEventListener("visibilitychange", syncWithVisibility);
    clearBackgroundPauseTimer();
    resumeFromBackground();
  };
}
