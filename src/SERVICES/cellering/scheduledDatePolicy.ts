/**
 * Scheduling is prospective. Keep the guard independent of browser date-input
 * behavior (notably on mobile) and of Firestore so every create entry point
 * uses the same calendar-date validation.
 *
 * Both keys must be local YYYY-MM-DD values. Compare keys, never UTC timestamps:
 * "today" means the user's calendar day, including around midnight.
 */
function isRealCalendarDateKey(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day;
}

export function scheduledDateValidationError(
  dueDate: string,
  today: string,
): string | null {
  if (!isRealCalendarDateKey(dueDate) || !isRealCalendarDateKey(today)) {
    return "יש לבחור תאריך תקין להמלצה";
  }
  if (dueDate < today) {
    return "ניתן לתזמן המלצה רק מהיום והלאה";
  }
  return null;
}
