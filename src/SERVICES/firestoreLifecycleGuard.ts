import { disableNetwork, enableNetwork } from "firebase/firestore";
import { db } from "../firebase";

let networkPausedForBackground = false;
let transition = Promise.resolve();

function queueTransition(action: () => Promise<void>): void {
  transition = transition.then(action, action).catch((error) => {
    console.warn("Firestore lifecycle transition failed", error);
  });
}

function pauseForBackground(): void {
  if (networkPausedForBackground) return;
  networkPausedForBackground = true;
  queueTransition(async () => {
    await disableNetwork(db);
    console.info("Firestore network paused while app is hidden");
  });
}

function resumeFromBackground(): void {
  if (!networkPausedForBackground) return;
  networkPausedForBackground = false;
  queueTransition(async () => {
    await enableNetwork(db);
    console.info("Firestore network resumed");
  });
}

/**
 * A hidden/background tab must not keep live Firestore listeners attached.
 * Firestore's persistent cache keeps the UI usable while offline and pending
 * writes are synchronized after the app becomes visible again.
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
    resumeFromBackground();
  };
}
