/** Only a physical Tempo dispatch with actual pallet quantities affects
 * brewery planning. A free-form paper-only invoice has no pallet movement and
 * must not close/hold a physical truck or inflate warehouse receipts.
 */
export function isPhysicalTempoShipment(data: Record<string, unknown>): boolean {
  if (data.sourceType === "manual" || !Array.isArray(data.totals) ||
      !data.totals.some((line) => !!line && typeof line === "object" &&
        Number((line as Record<string, unknown>).totalQuantity) > 0)) return false;
  const customerId = typeof data.customerId === "string"
    ? data.customerId.trim().toLowerCase() : "";
  if (customerId) return customerId === "tempo";
  return /טמפו|tempo/i.test(String(data.customerName ?? "").trim());
}
