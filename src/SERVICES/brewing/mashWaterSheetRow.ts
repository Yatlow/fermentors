/** MASH IN water is labeled in column A, with amount usually in B and
 * temperature in C. Some historical layouts also contain a water amount in D.
 * Never guess a temperature from a nearby unnamed process row.
 */
export function mashWaterFromSheetRow(
  amountCell: string,
  temperatureCell: string,
  extraCell: string,
): { amount: string; temperature: string } {
  const numbers = [amountCell, temperatureCell, extraCell]
    .flatMap(value => String(value ?? "").match(/-?\d+(?:[.,]\d+)?/g) || [])
    .map(value => Number(value.replace(",", ".")))
    .filter(Number.isFinite);
  const amount = numbers.find(value => value >= 100);
  // The form writes MASH IN water temperature explicitly to column C.
  const rawTemp = String(temperatureCell ?? "").match(/-?\d+(?:[.,]\d+)?/u)?.[0];
  const temperature = rawTemp === undefined ? null : Number(rawTemp.replace(",", "."));
  return {
    amount: amount === undefined ? "" : String(amount),
    temperature: temperature !== null && Number.isFinite(temperature) &&
      temperature >= 0 && temperature <= 100 ? String(temperature) : "",
  };
}
