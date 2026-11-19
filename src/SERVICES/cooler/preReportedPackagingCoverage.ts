import { dateKey } from "../planning/planningEngine";

export type PreShippedPalletCandidate = {
  id: string;
  zone?: string;
  itemType?: string;
  beerStyle?: string;
  batchNumber?: string | null;
  expiryDateStr?: string | null;
  sourceTankNumber?: string | number | null;
  packagingOperationId?: string | null;
  quantity?: number;
  createdAtMs?: number;
  shippedAtMs?: number;
};

export type PreShippedMatch = {
  palletIds: string[];
  quantity: number;
};

/**
 * Attribution is deliberately strict. An earlier batch's stock must not
 * accidentally cover a fresh packaging report just because it shipped today.
 * Shipped pallet documents themselves remain immutable.
 */
export function matchPreReportedShippedPallets(input: {
  operationCreatedMs: number;
  operationBatch: string;
  itemType: string;
  beerStyle: string;
  expiryDateStr: string;
  tankNumber: string | number | null;
  expectedQuantity: number;
  candidates: PreShippedPalletCandidate[];
}): PreShippedMatch {
  const { operationCreatedMs, operationBatch, itemType, beerStyle, expiryDateStr,
    tankNumber, expectedQuantity, candidates } = input;
  if (!Number.isFinite(operationCreatedMs) || operationCreatedMs <= 0) return { palletIds: [], quantity: 0 };
  const localDay = dateKey(new Date(operationCreatedMs));
  const withinWindow = candidates.filter((p) =>
    p.zone === "shipped" && !String(p.packagingOperationId ?? "").trim() &&
    String(p.batchNumber ?? "").replace("#", "").trim() === operationBatch.replace("#", "").trim() &&
    p.itemType === itemType && String(p.beerStyle ?? "").trim() === beerStyle.trim() &&
    Number.isFinite(p.createdAtMs) && Number.isFinite(p.shippedAtMs) &&
    Number(p.createdAtMs) > 0 && Number(p.shippedAtMs) > 0 &&
    Number(p.createdAtMs) <= Number(p.shippedAtMs) &&
    Number(p.shippedAtMs) <= operationCreatedMs &&
    operationCreatedMs - Number(p.createdAtMs) <= 8 * 60 * 60 * 1000 &&
    dateKey(new Date(Number(p.createdAtMs))) === localDay &&
    dateKey(new Date(Number(p.shippedAtMs))) === localDay
  );
  // A differing expiry or source tank is ambiguous, not a reason to silently
  // create another copy of the same batch's already departed stock.
  const conflicting = withinWindow.filter((p) =>
    (expiryDateStr && String(p.expiryDateStr ?? "") !== expiryDateStr) ||
    (p.sourceTankNumber != null && tankNumber != null &&
      String(p.sourceTankNumber) !== String(tankNumber)));
  if (conflicting.length > 0) {
    throw new Error("נמצאו משטחים שנשלחו לפני דיווח האריזה עם פרטי תוקף/מיכל שונים. נדרשת בדיקת עקיבות לפני יצירת משטחים נוספים.");
  }
  const matched = withinWindow;
  const quantity = matched.reduce((sum, p) => sum + Math.max(0, Math.round(Number(p.quantity ?? 0))), 0);
  if (matched.some((p) => !Number.isInteger(Number(p.quantity)) || Number(p.quantity) <= 0) ||
      quantity > expectedQuantity) {
    throw new Error("נמצאו משטחים שנשלחו לפני דיווח האריזה בכמות שאינה תואמת לדיווח. לא נוצר מלאי נוסף; יש לבדוק את המשלוח.");
  }
  return { palletIds: matched.map((p) => p.id), quantity };
}
