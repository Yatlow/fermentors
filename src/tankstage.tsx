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
  };
};

export function getTankStage(tank: Tank): TankStageInfo {
  // console.log(tank)
  if (!tank.batchNumber) {
    return STAGE_INFO[3];
  }

  if (tank.action === 0) {
    return STAGE_INFO[0];
  }

  if (tank.action === 4 && tank.tankStatus) {
    return STAGE_INFO[4];
  }

  if (tank.action === 5 && tank.tankStatus) {
    return STAGE_INFO[5];
  }

  if (tank.tankStatus) {
    return STAGE_INFO[3];
  }

  const temperature = Number(tank.currentData?.temp);

  if (tank.currentData?.temp && !Number.isNaN(temperature) && temperature < 9) {
    return STAGE_INFO[2];
  }

  if (tank.currentData?.temp===null || (!Number.isNaN(temperature) && temperature > 8)) {
    return STAGE_INFO[1];
  }

  return STAGE_INFO[Number(tank.tankStatus)] ?? STAGE_INFO[3];
}