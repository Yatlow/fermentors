// ============================================================
// OPERATION RECEIPTS (disabled on hot path)
// ============================================================
// ContentService occasionally returns HTML after a successful mutation. We now
// rely on the existing requestId/idempotency retry instead of synchronously
// writing a Firestore receipt for every successful request. Keeping this helper
// as a no-op preserves the doPost call site and makes rollback straightforward.
// ============================================================

function writeOperationReceipt_() {
  return false;
}
