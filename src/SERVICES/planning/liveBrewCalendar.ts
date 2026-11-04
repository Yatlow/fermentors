import { parseDate, weekStart, type BrewPlan } from "./planningEngine";

export type CalendarBrewSource = {
  id: string;
  tankNumber?: string | number | null;
  action?: string | number | null;
  brewDate?: string | null;
  beerStyle?: string | null;
  beerVolume?: string | number | null;
  batchNumber?: string | number | null;
  tankStatus?: boolean | null;
};

export type LiveBrewCalendarEntry = {
  id: string;
  tankNumber: string;
  style: string;
  date: string;
  liters: number;
  batchNumber: string;
};

const norm = (value: unknown) => String(value ?? "").replace(/^#/, "").trim();

/**
 * A brew assigned to today in the fermentor record must remain visible in the
 * planning board even before the saved planning-week decision is populated.
 * This is display-only and MUST NOT be persisted into a planning decision or
 * treated as brewing completed. Only current/future dates are eligible.
 */
export function sourceBrewCalendarEntries(
  sources: CalendarBrewSource[],
  plannedBrews: BrewPlan[],
  week: string,
  today: string,
): LiveBrewCalendarEntry[] {
  const seen = new Set<string>();
  const result: LiveBrewCalendarEntry[] = [];
  for (const source of sources) {
    const date = parseDate(source.brewDate ?? "");
    if (!date || date < today || weekStart(date) !== week ||
        (Number(source.action) !== 0 && Number(source.action) !== 1) ||
        source.tankStatus === true || !source.beerStyle || !source.batchNumber ||
        Number(source.tankNumber) === 1) continue;

    const number = norm(source.tankNumber || source.id);
    const batch = norm(source.batchNumber);
    const matched = plannedBrews.some((brew) => {
      if (brew.date !== date) return false;
      const plannedTank = norm(brew.tankId);
      const plannedBatch = norm(brew.batchNumber);
      return (plannedTank && (plannedTank === norm(source.id) || plannedTank === number)) ||
        (plannedBatch && plannedBatch === batch);
    });
    const key = number + "::" + batch + "::" + date;
    if (matched || seen.has(key)) continue;
    seen.add(key);
    result.push({
      id: source.id,
      tankNumber: number,
      style: source.beerStyle,
      date,
      liters: Math.max(0, Number(source.beerVolume) || 0),
      batchNumber: batch,
    });
  }
  return result.sort((a,b) => a.date.localeCompare(b.date) ||
    Number(a.tankNumber) - Number(b.tankNumber));
}
