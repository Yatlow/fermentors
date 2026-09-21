import type {
  PressureV9ValidationBatch,
} from "./pressurePredictionV9Validation";

const DB_NAME = "cellar-simulator-v9";
const DB_VERSION = 1;
const STORE_NAME = "validation-datasets";
const CACHE_KEY = "historical-v1";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type PressureV9ValidationCache = {
  savedAt: number;
  candidatePool: number;
  attempted: number;
  metadataResolved: number;
  measurementRowsLoaded: number;
  batches: PressureV9ValidationBatch[];
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable"));
      return;
    }

    const request = indexedDB.open(
      DB_NAME,
      DB_VERSION,
    );

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () =>
      resolve(request.result);
    request.onerror = () =>
      reject(
        request.error ??
          new Error("Failed opening IndexedDB"),
      );
  });
}

export async function loadPressureV9ValidationCache(): Promise<
  PressureV9ValidationCache | null
> {
  try {
    const db = await openDb();

    const value = await new Promise<
      PressureV9ValidationCache | null
    >((resolve, reject) => {
      const transaction = db.transaction(
        STORE_NAME,
        "readonly",
      );
      const request = transaction
        .objectStore(STORE_NAME)
        .get(CACHE_KEY);

      request.onsuccess = () =>
        resolve(
          (request.result as
            | PressureV9ValidationCache
            | undefined) ?? null,
        );
      request.onerror = () =>
        reject(
          request.error ??
            new Error("Failed reading V9 cache"),
        );
    });

    db.close();

    if (!value) return null;
    if (
      !Number.isFinite(value.savedAt) ||
      Date.now() - value.savedAt > MAX_AGE_MS
    ) {
      return null;
    }
    if (
      !Array.isArray(value.batches) ||
      value.batches.length === 0
    ) {
      return null;
    }

    return value;
  } catch (error) {
    console.warn(
      "V9 validation cache unavailable",
      error,
    );
    return null;
  }
}

export async function savePressureV9ValidationCache(
  value: Omit<
    PressureV9ValidationCache,
    "savedAt"
  >,
): Promise<void> {
  try {
    const db = await openDb();

    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(
        STORE_NAME,
        "readwrite",
      );
      transaction.objectStore(STORE_NAME).put(
        {
          ...value,
          savedAt: Date.now(),
        } satisfies PressureV9ValidationCache,
        CACHE_KEY,
      );

      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(
          transaction.error ??
            new Error("Failed writing V9 cache"),
        );
    });

    db.close();
  } catch (error) {
    console.warn(
      "Could not persist V9 validation cache",
      error,
    );
  }
}

export async function clearPressureV9ValidationCache(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(
        STORE_NAME,
        "readwrite",
      );
      transaction
        .objectStore(STORE_NAME)
        .delete(CACHE_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(
          transaction.error ??
            new Error("Failed clearing V9 cache"),
        );
    });
    db.close();
  } catch (error) {
    console.warn(
      "Could not clear V9 validation cache",
      error,
    );
  }
}
