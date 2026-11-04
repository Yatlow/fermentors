/** Chronological brewing progress: a later A/B/C block can be active while
 * an earlier block is farther along in the recipe. Never rank by stage alone. */
export type ClockStage = { key: string; label: string };
export type RecordedClockBlock = { fields?: Record<string, string> };
export type CurrentBrewStage<T extends ClockStage> = {
  blockIndex: number;
  stage: T;
  start: string;
  end: string;
  recordedAt: number;
};

const ROLLOVER_GAP_MINUTES = 6 * 60;

function clockMinutes(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text || "").trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour < 24 && minute >= 0 && minute < 60
    ? hour * 60 + minute : null;
}

function brewDay(value: string): Date | null {
  const text = String(value || "").trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  const local = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(text);
  if (!iso && !local) return null;
  const year = iso ? Number(iso[1]) : Number(local![3]) + (local![3].length === 2 ? 2000 : 0);
  const month = iso ? Number(iso[2]) : Number(local![2]);
  const day = iso ? Number(iso[3]) : Number(local![1]);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? date : null;
}

function firstClock<T extends ClockStage>(fields: Record<string, string>, stages: readonly T[]): number | null {
  for (const stage of stages) {
    const minutes = clockMinutes(fields[`${stage.key}.start`]);
    if (minutes !== null) return minutes;
  }
  return null;
}

/** Most recent *reached* process time, accounting for midnight and explicit
 * dates. Precalculated future times must not leap ahead of the actual brew. */
export function currentRecordedBrewStage<T extends ClockStage>(
  blocks: Record<string, RecordedClockBlock>,
  stages: readonly T[],
  blockCount: number,
  fallbackBrewDate: string,
  now: Date = new Date(),
): CurrentBrewStage<T> | null {
  let latest: CurrentBrewStage<T> | null = null;
  let precedingBlockDay: Date | null = null;
  let precedingFirstClock: number | null = null;
  const fallback = brewDay(fallbackBrewDate) ||
    new Date(now.getFullYear(), now.getMonth(), now.getDate());

  for (let blockIndex = 1; blockIndex <= blockCount; blockIndex++) {
    const fields = blocks[String(blockIndex)]?.fields || {};
    const explicit = brewDay(fields.brewDate || "");
    const first = firstClock(fields, stages);
    const day: Date = new Date((explicit || precedingBlockDay || fallback).getTime());

    if (!explicit && precedingBlockDay && precedingFirstClock !== null &&
        first !== null && precedingFirstClock - first > ROLLOVER_GAP_MINUTES) {
      day.setDate(day.getDate() + 1);
    }
    if (first !== null) {
      precedingFirstClock = first;
      precedingBlockDay = new Date(day.getTime());
    }

    let previousMinutes: number | null = null;
    let dayOffset = 0;

    stages.forEach((stage) => {
      const start = String(fields[`${stage.key}.start`] || "").trim();
      const end = String(fields[`${stage.key}.end`] || "").trim();
      for (const raw of [start, end]) {
        const minutes = clockMinutes(raw);
        if (minutes === null) continue;
        if (previousMinutes !== null &&
            previousMinutes - minutes > ROLLOVER_GAP_MINUTES) dayOffset++;
        previousMinutes = minutes;

        const when = new Date(day.getTime());
        when.setDate(when.getDate() + dayOffset);
        when.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
        const recordedAt = when.getTime();
        if (recordedAt > now.getTime() + 60 * 1000) continue;

        if (!latest || recordedAt >= latest.recordedAt) {
          latest = { blockIndex, stage, start, end, recordedAt };
        }
      }
    });
  }

  return latest;
}

/** Adjust an apparently AM-formatted manually typed time only if the prior
 * actual operation puts the +12h alternative within 90 minutes. A genuine
 * midnight crossover (23:50 -> 00:20) is left completely untouched. */
export function confidentPmClockCorrection(
  value: string,
  previous: string | null | undefined,
  next?: string | null,
): string | null {
  const minutes = clockMinutes(value);
  const prev = clockMinutes(String(previous || ""));
  if (minutes === null || prev === null || prev < 12 * 60 || minutes >= 12 * 60) return null;

  const corrected = minutes + 12 * 60;
  const originalGap = (minutes - prev + 1440) % 1440;
  const correctedGap = (corrected - prev + 1440) % 1440;
  if (originalGap < 12 * 60 || correctedGap > 90) return null;

  const following = clockMinutes(String(next || ""));
  if (following !== null && (following - corrected + 1440) % 1440 > 12 * 60) return null;
  return `${String(Math.floor(corrected / 60)).padStart(2, "0")}:${String(corrected % 60).padStart(2, "0")}`;
}
