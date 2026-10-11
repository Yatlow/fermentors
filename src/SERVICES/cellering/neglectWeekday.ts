/** Neglect reminders run only on regular cellar workdays, Monday through Thursday. */
export const shouldShowNeglectedTank = (dayOfWeek: number): boolean =>
  Number.isInteger(dayOfWeek) && dayOfWeek >= 1 && dayOfWeek <= 4;
