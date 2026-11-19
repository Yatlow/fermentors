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
  packagingSource?: string | null;
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
  const ambiguousToday = candidates.filter((p) => {
    if (p.zone !== "shipped" || String(p.packagingOperationId ?? "").trim() ||
        String(p.batchNumber ?? "").replace("#", "").trim() !== operationBatch.replace("#", "").trim() ||
        p.itemType !== itemType || String(p.beerStyle ?? "").trim() !== beerStyle.trim()) return false;
    const createdToday = Number.isFinite(p.createdAtMs) && Number(p.createdAtMs) > 0 &&
      Number(p.createdAtMs) <= operationCreatedMs &&
      dateKey(new Date(Number(p.createdAtMs))) === localDay;
    const shippedToday = Number.isFinite(p.shippedAtMs) && Number(p.shippedAtMs) > 0 &&
      Number(p.shippedAtMs) <= operationCreatedMs &&
      dateKey(new Date(Number(p.shippedAtMs))) === localDay;
    return (createdToday || shippedToday) && !withinWindow.includes(p);
  });
  if (ambiguousToday.length) {
    throw new Error("נמצא משטח מהאצווה שנשלח היום אך חסרה התאמת זמן בטוחה לדיווח האריזה. לא נוצר מלאי כפול; יש לבדוק עקיבות.");
  }
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

/** Match manual pallets that are still physically in stock but were created
 * before their packaging report. Excludes all pallets tied to another operation.
 * The caller must claim these documents transactionally before creating stock.
 */
export function matchPreReportedActivePallets(input: {
  operationId: string;
  operationCreatedMs: number;
  operationBatch: string;
  itemType: string;
  beerStyle: string;
  expiryDateStr: string;
  tankNumber: string | number | null;
  expectedQuantity: number;
  preShippedQuantity: number;
  candidates: PreShippedPalletCandidate[];
}): PreShippedMatch {
  const { operationId, operationCreatedMs, operationBatch, itemType, beerStyle,
    expiryDateStr, tankNumber, expectedQuantity, preShippedQuantity, candidates } = input;
  if (!Number.isFinite(operationCreatedMs) || operationCreatedMs <= 0) {
    throw new Error("חסרה שעת יצירת דיווח האריזה. לא ניתן לשייך משטח ידני ישן בבטחה.");
  }
  const date = dateKey(new Date(operationCreatedMs));
  const matchingProduct = candidates.filter((p) =>
    ["pending", "cooler", "bottleRoom", "loadingDock"].includes(String(p.zone)) &&
    String(p.batchNumber ?? "").replace("#", "").trim() === operationBatch.replace("#", "").trim() &&
    p.itemType === itemType && String(p.beerStyle ?? "").trim() === beerStyle.trim()
  );
  const adopted = matchingProduct.filter((p) =>
    p.packagingOperationId === operationId && p.packagingSource === "manual");
  const unlinked = matchingProduct.filter((p) => !String(p.packagingOperationId ?? "").trim());
  const sameDayUnlinked = unlinked.filter((p) =>
    Number.isFinite(p.createdAtMs) && Number(p.createdAtMs) > 0 &&
    dateKey(new Date(Number(p.createdAtMs))) === date
  );
  // Even an earlier-day manual pallet may physically belong to this report.
  // Do not silently generate a second copy when attribution is uncertain.
  const earlierUnlinked = unlinked.filter((p) =>
    Number.isFinite(p.createdAtMs) && Number(p.createdAtMs) > 0 &&
    dateKey(new Date(Number(p.createdAtMs))) !== date
  );
  if (earlierUnlinked.length) {
    throw new Error("נמצא משטח ידני מאותה אצווה מתאריך קודם ללא שיוך לדיווח. לא נוצר מלאי נוסף; יש לבדוק עקיבות.");
  }
  const ambiguous = sameDayUnlinked.filter((p) =>
    Number(p.createdAtMs) > operationCreatedMs ||
    operationCreatedMs - Number(p.createdAtMs) > 8 * 60 * 60 * 1000 ||
    p.id.startsWith("pkg_")
  );
  if (ambiguous.length || unlinked.some((p) => !Number.isFinite(p.createdAtMs))) {
    throw new Error("נמצאו משטחים מאותה אצווה עם זמן יצירה לא חד־משמעי. לא ייווצר מלאי נוסף לפני בדיקת עקיבות.");
  }
  const selected = [...adopted, ...sameDayUnlinked.filter((p) => !ambiguous.includes(p))];
  if (selected.some((p) =>
    (expiryDateStr && String(p.expiryDateStr ?? "").trim() !== expiryDateStr) ||
    (p.sourceTankNumber != null && tankNumber != null &&
      String(p.sourceTankNumber) !== String(tankNumber))
  )) {
    throw new Error("נמצא משטח קיים מאותה אצווה עם פרטי תוקף או מיכל שאינם תואמים. יש לבדוק עקיבות לפני יצירת משטחים.");
  }
  if (selected.some((p) =>
    !Number.isInteger(Number(p.quantity)) || Number(p.quantity) <= 0
  )) {
    throw new Error("משטח קיים מכיל כמות לא תקינה. לא ניתן להמשיך ביצירת משטחים.");
  }
  const quantity = selected.reduce((sum, p) => sum + Number(p.quantity), 0);
  if (preShippedQuantity + quantity > expectedQuantity) {
    throw new Error("כמות המשטחים הקיימים והמשטחים שנשלחו גבוהה מכמות האריזה שדווחה. לא נוצר מלאי נוסף.");
  }
  return { palletIds: selected.map((p) => p.id), quantity };
}
