// ============================================================
// OPERATION RECEIPTS (disabled) + MAINTENANCE TRIGGER MIGRATION
// ============================================================
// ContentService occasionally returns HTML after a successful mutation. We rely
// on requestId/idempotency instead of synchronously writing a Firestore receipt.
//
// doPost still calls this compatibility hook after successful requests. Use that
// cheap hook to guarantee the v4 five-minute maintenance trigger gets installed
// after deployment even if the previous trigger layout was log-only or the
// standalone runFermentorCycle trigger is the only one still present. Once the
// v4 flag exists, ensureAsyncLogTrigger_() is only a ScriptProperties read.
// ============================================================

function writeOperationReceipt_() {
  try {
    return ensureAsyncLogTrigger_();
  } catch (error) {
    // Trigger migration must never turn a successful user mutation into a failed
    // response. The next successful request (or maintenance run) will retry it.
    console.log("Maintenance trigger migration deferred: " + error.message);
    return false;
  }
}
