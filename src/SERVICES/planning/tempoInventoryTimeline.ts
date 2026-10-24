import { daysBetween, num, weeklyDemand, type Product } from "./planningEngine";

export type TempoReceipt = {
  date: string;
  quantity: number;
  /** Physical dispatch/arrival instant. Needed for a snapshot on the same day. */
  occurredAt?: string;
  /** Future forecast events occur after today's opening snapshot. */
  forecast?: boolean;
};

/**
 * Project an inventory snapshot chronologically. The day-based planning model
 * assumes demand accumulates between day boundaries, and receipts enter on
 * their arrival day. A balance is clamped to zero after each sales interval,
 * NEVER before all future deliveries have been processed.
 *
 * Historical same-day shipments require an exact snapshot and receipt instant.
 * Without that evidence, do not guess whether the delivery was counted.
 */
export function tempoInventoryAt(
  product: Pick<Product, "monthly" | "tempo" | "tempoDate" | "tempoSnapshotAt">,
  targetDate: string,
  receipts: TempoReceipt[],
): number | null {
  const start = product.tempoDate;
  if (product.tempo === null || !/^\d{4}-\d{2}-\d{2}$/.test(start) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(targetDate) || start > targetDate) return null;
  const baselineInstant = product.tempoSnapshotAt
    ? Date.parse(product.tempoSnapshotAt) : NaN;
  const daily = weeklyDemand(product as Product) / 7;
  const ordered = receipts.filter((receipt) => {
    if (!Number.isFinite(receipt.quantity) || receipt.quantity <= 0 ||
        receipt.date > targetDate || receipt.date < start) return false;
    if (receipt.date > start) return true;
    if (receipt.forecast) return true;
    const received = receipt.occurredAt ? Date.parse(receipt.occurredAt) : NaN;
    return Number.isFinite(baselineInstant) &&
      Number.isFinite(received) && received > baselineInstant;
  }).sort((a, b) => a.date.localeCompare(b.date) ||
    String(a.occurredAt ?? "").localeCompare(String(b.occurredAt ?? "")));
  let balance = num(product.tempo);
  let cursor = start;
  for (const receipt of ordered) {
    balance = Math.max(0, balance - Math.max(0, daysBetween(cursor, receipt.date)) * daily);
    balance += receipt.quantity;
    cursor = receipt.date;
  }
  return Math.max(0, balance - Math.max(0, daysBetween(cursor, targetDate)) * daily);
}

/** The historical baseline is consumed through today; future projections can
 * start from this current-day value without reapplying already counted receipts.
 */
export function tempoInventoryBaselineAt(
  product: Product,
  today: string,
  receipts: TempoReceipt[],
): Product {
  const balance = tempoInventoryAt(product, today, receipts);
  return balance === null ? product : {
    ...product, tempo: balance, tempoDate: today, tempoSnapshotAt: undefined,
  };
}
