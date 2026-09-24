import { getMeasurementsByBatch } from "../getAndPost/gettAllDataByBatch";

export const TANK_STAGES = {
  0: "BREWING",
  1: "FERMENTING",
  2: "COLD",
  3: "EMPTY",
  4: "CLEAN",
  5: "SANITIZED",
} as const;

export type TankStageInfo = {
  name: string;
  icon: string;
  className: string;
};

export const STAGE_INFO: Record<number, TankStageInfo> = {
  0: {
    name: "בישול חדש",
    icon: "🟣",
    className: "stage-brewing",
  },

  1: {
    name: "בתסיסה",
    icon: "🟠",
    className: "stage-fermenting",
  },

  2: {
    name: "קר",
    icon: "🔵",
    className: "stage-cold",
  },

  3: {
    name: "מלוכלך",
    icon: "⚪",
    className: "stage-empty",
  },

  4: {
    name: "נקי",
    icon: "🟢",
    className: "stage-clean",
  },

  5: {
    name: "מחוטא",
    icon: "🟡",
    className: "stage-sanitized",
  },
};

type Tank = {
  batchNumber?: unknown;
  action?: unknown;
  tankStatus?: unknown;
  currentData?: {
    temp?: unknown | null;
    notes?: unknown | null;
  };
};

// Cooling is monotonic inside one batch: once a batch entered the cold phase,
// keep that result for this browser session. This prevents every subsequent
// Firestore update from re-downloading the complete measurement history.
const cooledBatchCache = new Map<string, boolean>();

function batchKey(value: unknown): string {
  return String(value ?? "").replace("#", "").trim();
}

function currentNoteShowsCooling(tank: Tank): boolean {
  return String(tank.currentData?.notes ?? "").includes("קירור");
}

export async function getTankStage(tank: Tank): Promise<TankStageInfo> {
  if (!tank.batchNumber) {
    return STAGE_INFO[3];
  }

  if (tank.action === 0) {
    return STAGE_INFO[0];
  }

  if (tank.action === 4 && tank.tankStatus) {
    return STAGE_INFO[4];
  }

  // ACTION 5 is sanitized regardless of tankStatus. Cancellation of an
  // unstarted brew intentionally restores tankStatus=false, so requiring true
  // here made the UI fall through to the previous batch's cold measurements.
  if (tank.action === 5) {
    return STAGE_INFO[5];
  }

  if (tank.tankStatus) {
    return STAGE_INFO[3];
  }

  const batch = batchKey(tank.batchNumber);
  const temperature = Number(tank.currentData?.temp);
  const hasNumericTemperature =
    tank.currentData?.temp != null && !Number.isNaN(temperature);

  if (hasNumericTemperature && temperature < 9) {
    if (batch) cooledBatchCache.set(batch, true);
    return STAGE_INFO[2];
  }

  if (currentNoteShowsCooling(tank)) {
    if (batch) cooledBatchCache.set(batch, true);
    return STAGE_INFO[2];
  }

  const cachedCoolingState = batch ? cooledBatchCache.get(batch) : undefined;
  if (cachedCoolingState === true) {
    return STAGE_INFO[2];
  }

  // One history lookup per batch/browser session supports batches that were
  // already cooled before this client loaded. A future cooling report appears
  // in currentData immediately and flips a cached negative result above.
  if (batch && cachedCoolingState === undefined) {
    const measurements = await getMeasurementsByBatch(Number(batch));
    const cooled = measurements.some(
      (measurement) => String(measurement.notes || "").includes("קירור")
    );
    cooledBatchCache.set(batch, cooled);
    if (cooled) return STAGE_INFO[2];
  }

  if (tank.currentData?.temp === null || (hasNumericTemperature && temperature > 8)) {
    return STAGE_INFO[1];
  }

  return STAGE_INFO[Number(tank.tankStatus)] ?? STAGE_INFO[3];
}
