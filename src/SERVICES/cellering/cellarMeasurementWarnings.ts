export type CellarReadingValues = { temp?: unknown; pressure?: unknown; plato?: unknown; pH?: unknown };
export type CellarReadingHistory = { temp?: unknown; pressure?: unknown; plato?: unknown; pH?: unknown };
type Options = { previousNotes?: string; brewAge?: number; checkPressureActions?: boolean; checkCoolingAction?: boolean };
const hasValue = (value: unknown) => value !== undefined && value !== null && value !== "";
const numeric = (value: unknown) => hasValue(value) && Number.isFinite(Number(value)) ? Number(value) : null;

/** Pure validation shared by inline feedback and the pre-submit confirmation. */
export function cellarMeasurementWarnings(
  tankNumber: string | number,
  reading: CellarReadingValues,
  previous: CellarReadingHistory,
  options: Options = {},
): string[] {
  const warnings: string[] = [];
  const notes = options.previousNotes ?? "";
  const temp = numeric(reading.temp), pressure = numeric(reading.pressure);
  const pH = numeric(reading.pH), plato = numeric(reading.plato);
  const oldTemp = numeric(previous.temp), oldPressure = numeric(previous.pressure);
  const oldPh = numeric(previous.pH), oldPlato = numeric(previous.plato);
  const prefix = `מיכל ${tankNumber}: `;
  if (temp !== null && oldTemp !== null && Math.abs(temp - oldTemp) > 5) {
    const cooling = options.checkCoolingAction && /קירור/.test(notes);
    if (!(temp < oldTemp && cooling)) warnings.push(prefix + `שינוי טמפרטורה של ${(temp - oldTemp).toFixed(1)}° מהמדידה הקודמת`);
  }
  if (pressure !== null && oldPressure !== null) {
    const delta = pressure - oldPressure;
    const increasedByAction = options.checkPressureActions && /סגירת|סגירה|העלאת|להעלות לחץ/.test(notes);
    const decreasedByAction = options.checkPressureActions && /הורדת|להוריד לחץ/.test(notes);
    if (delta > 0.5 && !increasedByAction) warnings.push(prefix + "עליית לחץ מעל 0.5 בר ללא פעולה מתועדת");
    if (delta < -0.5 && !decreasedByAction) warnings.push(prefix + "ירידת לחץ מעל 0.5 בר ללא פעולה מתועדת");
  }
  if (pH !== null) {
    if (pH > 6) warnings.push(prefix + "pH מעל 6");
    if (pH < 3.5) warnings.push(prefix + "pH מתחת 3.5");
    if (oldPh !== null && Math.abs(pH - oldPh) > 0.5 && (options.brewAge ?? 0) > 2) {
      warnings.push(prefix + "שינוי pH מעל 0.5 מהמדידה הקודמת");
    }
  }
  if (plato !== null && oldPlato !== null && plato - oldPlato > 0.3) {
    warnings.push(prefix + "עליית פלאטו מעל 0.3 מהמדידה הקודמת");
  }
  if (temp !== null && pressure === null) warnings.push(prefix + "דווחה טמפרטורה ללא לחץ");
  if (pressure !== null && temp === null) warnings.push(prefix + "דווח לחץ ללא טמפרטורה");
  if (plato !== null && pH === null) warnings.push(prefix + "דווח פלאטו ללא pH");
  if (pH !== null && plato === null) warnings.push(prefix + "דווח pH ללא פלאטו");
  return warnings;
}
