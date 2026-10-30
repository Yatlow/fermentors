export type CarbonationRetestMeasurement = {
  id?: string | number | null;
  carbonation?: string | number | null;
  pressure?: string | number | null;
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
 * - ordinary pressure correction: retest once the calendar-date difference is 2
 *   (for example 01/01 23:59 -> 03/01 00:00 is already due);
 * - completed bottom carbonation: retest from the next day;
 * - no treatment recorded: retest once the carbonation reading is 2 days old.
 *
 * The caller decides whether the last carbonation is actually out of spec.
 */
export function carbonationRetestPolicy(
  measurements: CarbonationRetestMeasurement[],
  todayDate: string,
): CarbonationRetestPolicy {
  // A repeat test stays due in history, but is not recommended on Friday.
  // Calculate from the supplied local date, not the browser's current timezone.
  const todayDay = dayNumber(todayDate);
  const skipFridayRetest = todayDay !== null &&
    new Date(todayDay * 86400000).getUTCDay() === 5;

  let lastCarbIndex = -1;
  let lastCarbonation: number | null = null;

  // API/Firestore measurements are not guaranteed to arrive chronologically.
  // A stale reading appended last must not restart the retest clock.
  const ordered = [...measurements].sort((a, b) =>
    String(a.id ?? "").localeCompare(String(b.id ?? ""))
  );
  measurements = ordered;
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
        !skipFridayRetest &&
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
    due: !skipFridayRetest && daysSinceReference !== null && daysSinceReference >= 2,
    waitReason: "cadence",
    treatmentDate: null,
    daysSinceReference,
    requiredWaitDays: 2,
  };
}


function hebrewAgeText(days: number | null): string {
  if (days === 0) return "היום";
  if (days === 1) return "אתמול";
  if (days === 2) return "לפני יומיים";
  if (days !== null && days > 2) return `לפני ${days} ימים`;
  return "לאחרונה";
}

export function carbonationRetestDueReason(
  policy: CarbonationRetestPolicy,
): string | null {
  if (
    !policy.due ||
    !policy.hasCarbonation ||
    policy.lastCarbonation === null
  ) return null;

  if (policy.waitReason === "bottom_carbonation") {
    const when = hebrewAgeText(policy.daysSinceReference);
    return (
      `${when} בוצע גיזוז מלמטה לאחר בדיקת גיזוז לא תקינה ` +
      `(${policy.lastCarbonation})- מומלץ לבצע היום בדיקת גיזוז חוזרת`
    );
  }

  if (policy.waitReason === "ordinary_pressure") {
    const when = hebrewAgeText(policy.daysSinceReference);
    return (
      `${when} בוצע שינוי לחץ בעקבות בדיקת גיזוז לא תקינה ` +
      `(${policy.lastCarbonation})- מומלץ לבצע היום בדיקת גיזוז חוזרת`
    );
  }

  const when = hebrewAgeText(policy.daysSinceReference);
  return (
    `בדיקת הגיזוז האחרונה בוצעה ${when} ולא היתה תקינה ` +
    `(${policy.lastCarbonation})- מומלץ לבצע היום בדיקת גיזוז חוזרת`
  );
}


/**
 * Pressure context for a repeat carbonation test. Only a real pressure reading
 * from today enables it; never substitute the current tank snapshot, a target
 * pressure or a target. Compare the latest pressure today against the previous
 * recorded pressure, whether minutes or several days earlier.
 */
export function carbonationRetestPressureContext(
  measurements: CarbonationRetestMeasurement[],
  todayDate: string,
): string | null {
  const readings = [...measurements]
    .filter((measurement) => measurementDate(measurement.id) !== null)
    .sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")))
    .map((measurement) => ({
      date: measurementDate(measurement.id),
      pressure: numericCarbonation(measurement.pressure),
    }))
    .filter((measurement): measurement is { date: string; pressure: number } =>
      measurement.date !== null && measurement.pressure !== null && measurement.date <= todayDate
    );
  const todayReadings = readings.filter((reading) => reading.date === todayDate);
  if (todayReadings.length === 0) return null;
  const current = todayReadings[todayReadings.length - 1];
  const previous = readings[readings.length - 2];
  const format = (value: number) => Number(value.toFixed(2)).toString();
  const currentText = `לחץ היום: ${format(current.pressure)} bar`;
  if (!previous) return currentText;
  const previousLabel = previous.date === todayDate ? "לחץ במדידה הקודמת היום" : `לחץ קודם (${previous.date.split("-").reverse().join("/")})`;
  const summary = `${currentText} · ${previousLabel}: ${format(previous.pressure)} bar`;
  const delta = Math.round((current.pressure - previous.pressure) * 100) / 100;
  return delta === 0 ? summary : `${summary} · הפרש: ${delta > 0 ? "עלייה" : "ירידה"} של ${Math.abs(delta).toFixed(2)} bar`;
}
