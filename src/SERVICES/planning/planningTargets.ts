import { styleKey, type Settings } from "./planningEngine";

export type StylePlanningTargets = {
  targetWeeks: number;
  totalTargetWeeks: number;
  maxTotalWeeks: number;
};

export type SettingsWithStylePlanning = Settings & {
  stylePlanning?: Record<string, Partial<StylePlanningTargets>>;
};

export function planningTargetsForStyle(
  settings: Settings,
  style: string,
): StylePlanningTargets {
  const extended = settings as SettingsWithStylePlanning;
  const override = extended.stylePlanning?.[styleKey(style)] ?? {};
  const targetWeeks = Number.isFinite(override.targetWeeks)
    ? Number(override.targetWeeks)
    : settings.targetWeeks;
  const totalTargetWeeks = Number.isFinite(override.totalTargetWeeks)
    ? Number(override.totalTargetWeeks)
    : (settings.totalTargetWeeks ?? settings.targetWeeks);
  const fallbackMax = Math.max(totalTargetWeeks, totalTargetWeeks + 2);
  const maxTotalWeeks = Number.isFinite(override.maxTotalWeeks)
    ? Number(override.maxTotalWeeks)
    : fallbackMax;

  return {
    targetWeeks,
    totalTargetWeeks: Math.max(targetWeeks, totalTargetWeeks),
    maxTotalWeeks: Math.max(totalTargetWeeks, maxTotalWeeks),
  };
}

export function withStylePlanningTarget(
  settings: Settings,
  style: string,
  patch: Partial<StylePlanningTargets>,
): SettingsWithStylePlanning {
  const current = planningTargetsForStyle(settings, style);
  const key = styleKey(style);
  const next = { ...current, ...patch };
  return {
    ...(settings as SettingsWithStylePlanning),
    stylePlanning: {
      ...((settings as SettingsWithStylePlanning).stylePlanning ?? {}),
      [key]: next,
    },
  };
}

export function validateStylePlanning(settings: Settings, styles: string[]): string | null {
  for (const style of styles) {
    const target = planningTargetsForStyle(settings, style);
    if (
      !Number.isFinite(target.targetWeeks) || target.targetWeeks < 0.5 || target.targetWeeks > 12 ||
      !Number.isFinite(target.totalTargetWeeks) || target.totalTargetWeeks < target.targetWeeks || target.totalTargetWeeks > 26 ||
      !Number.isFinite(target.maxTotalWeeks) || target.maxTotalWeeks < target.totalTargetWeeks || target.maxTotalWeeks > 30
    ) {
      return style;
    }
  }
  return null;
}
