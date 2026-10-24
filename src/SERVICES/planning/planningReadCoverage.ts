import { parseDate, weekStart, type Product } from "./planningEngine";

/**
 * Required data for each planning surface. Do not condition business truth on
 * which tab the operator happened to open first.
 */
export function planningReadRequirements(tab: string): {
  pallets: boolean; actuals: boolean; shipments: boolean;
} {
  const pallets = ["stock", "calendar", "fiveWeeks", "schedule"].includes(tab);
  const actuals = ["stock", "calendar", "fiveWeeks", "schedule", "tanks", "review"].includes(tab);
  // The Stock and Review surfaces also use actual Tempo receipts; omitting
  // the shipment listener here silently gave them the old inventory snapshot.
  const shipments = ["stock", "calendar", "fiveWeeks", "schedule", "review"].includes(tab);
  return { pallets, actuals, shipments };
}

/**
 * A Tempo snapshot is a baseline, not a real-time quantity. We need every
 * physical receipt AFTER the OLDEST live product snapshot to reconstruct the
 * present consistently. The Gantt week boundary is not a safe lookback limit.
 */
export function shipmentHistoryStart(currentWeek: string, products: Product[]): string {
  const dates = products
    .filter((product) => product.tempo !== null && product.tempo !== undefined)
    .map((product) => parseDate(product.tempoDate))
    .filter((date): date is string => !!date && date <= currentWeek);
  const oldest = dates.sort()[0];
  return oldest && oldest < currentWeek ? oldest : weekStart(currentWeek);
}
