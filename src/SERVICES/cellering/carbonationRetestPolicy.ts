export type CarbonationRetestMeasurement = {
  id?: string | number | null;
  carbonation?: string | number | null;
  notes?: string | number | null;
};

export type CarbonationRetestPolicy = {
  hasCarbonation: boolean;
  lastCarbonation: number | null;
  lastCarbonationDate: string | null;
  due: boolean;
  waitReason: "tested_today" | "ordinary_pressure" | "bottom_carbonation" | "cadence" | null;
  treatmentDate: string | null;
  daysSinceReference: number | null;
  requiredWaitDays: number | null;
};

function measurementDate(id: unknown): string | null {
  const match = String(id ?? "").trim().match(/^(\d{4}-\d{2}-\d{2})(?:_\d{3,4})?$/);
  return match?.[1] ?? null;
}

function numericCarbonation(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

function dayNumber(date: string): number | null {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return Math.floor(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86400000,
  );
}

function daysBetween(from: string | null, to: string): number | null {
  if (!from) return null;
  const start = dayNumber(from);
  const end = dayNumber(to);
  if (start === null || end === null) return null;
  return end - start;
}

function hasBottomCarbonationClose(note: unknown): boolean {
  return String(note ?? "").includes("סגירת גיזוז מלמטה");
}

function hasOrdinaryPressureAdjustment(note: unknown): boolean {
  const text = String(note ?? "");
  if (!text || text.includes("גיזוז מלמטה")) return false;
  return /(?:העלאת|הורדת|שינוי|להעלות|להוריד)\s+לחץ/i.test(text);
}

/**
 * Operational retest cadence after an out-of-spec carbonation reading:
 * - ordinary pressure correction: wait 2 full calendar days;
 * - completed bottom carbonation: retest from the next day;
 * - no treatment recorded: retest once the carbonation reading is 2 days old.
 *
 * The caller decides whether the last carbonation is actually out of spec.
 */
export function carbonationRetestPolicy(
  measurements: CarbonationRetestMeasurement[],
  todayDate: string,
): CarbonationRetestPolicy {
  let lastCarbIndex = -1;
  let lastCarbonation: number | null = null;

  for (let index = measurements.length - 1; index >= 0; index--) {
    const value = numericCarbonation(measurements[index]?.carbonation);
    if (value !== null) {
      lastCarbIndex = index;
      lastCarbonation = value;
      break;
    }
  }

  if (lastCarbIndex < 0 || lastCarbonation === null) {
    return {
      hasCarbonation: false,
      lastCarbonation: null,
      lastCarbonationDate: null,
      due: false,
      waitReason: null,
      treatmentDate: null,
      daysSinceReference: null,
      requiredWaitDays: null,
    };
  }

  const lastCarbonationDate = measurementDate(measurements[lastCarbIndex]?.id);
  if (lastCarbonationDate === todayDate) {
    return {
      hasCarbonation: true,
      lastCarbonation,
      lastCarbonationDate,
      due: false,
      waitReason: "tested_today",
      treatmentDate: null,
      daysSinceReference: 0,
      requiredWaitDays: null,
    };
  }

  let latestTreatment:
    | { type: "ordinary_pressure" | "bottom_carbonation"; date: string }
    | null = null;

  for (let index = lastCarbIndex; index < measurements.length; index++) {
    const measurement = measurements[index];
    const date = measurementDate(measurement?.id);
    if (!date) continue;

    if (hasBottomCarbonationClose(measurement?.notes)) {
      latestTreatment = { type: "bottom_carbonation", date };
      continue;
    }

    if (hasOrdinaryPressureAdjustment(measurement?.notes)) {
      latestTreatment = { type: "ordinary_pressure", date };
    }
  }

  if (latestTreatment) {
    const requiredWaitDays =
      latestTreatment.type === "bottom_carbonation" ? 1 : 2;
    const daysSinceReference = daysBetween(latestTreatment.date, todayDate);

    return {
      hasCarbonation: true,
      lastCarbonation,
      lastCarbonationDate,
      due:
        daysSinceReference !== null &&
        daysSinceReference >= requiredWaitDays,
      waitReason: latestTreatment.type,
      treatmentDate: latestTreatment.date,
      daysSinceReference,
      requiredWaitDays,
    };
  }

  const daysSinceReference = daysBetween(lastCarbonationDate, todayDate);
  return {
    hasCarbonation: true,
    lastCarbonation,
    lastCarbonationDate,
    due: daysSinceReference !== null && daysSinceReference >= 2,
    waitReason: "cadence",
    treatmentDate: null,
    daysSinceReference,
    requiredWaitDays: 2,
  };
}
