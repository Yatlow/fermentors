/** Calendar-driven Wednesday test is independent of the underlying
 * carbonation recommendation. A repeat test may be higher priority but
 * must not hide next week's packaging routine from the daily action list.
 * Completion, grace, manual ignore, and KPI counting are handled by the
 * dashboard using the same physical carbonation action.
 */
export function shouldShowWednesdayPackagingCarb(input: {
  day: number;
  stageName?: string | null;
  tankNumber?: string | number | null;
  plannedNextWeekTankNumbers: readonly number[];
}): boolean {
  if (input.day !== 3 || input.stageName !== "קר") return false;
  const number = Number(input.tankNumber);
  return Number.isFinite(number) &&
    input.plannedNextWeekTankNumbers.includes(number);
}
