// Short-lived Firestore workflow data retention. Called from maintenance.
const TRANSIENT_RETENTION_ = {
  brewSheetCreationJobs: { days: 30, terminalField: "state", terminalValues: ["ready"] },
  coolerUndoHistory: { days: 30 },
  ignoredCellarRecommendations: { days: 30 },
  scheduledCellarRecommendations: { days: 90, terminalField: "status", terminalValues: ["completed", "cancelled"] }
};
const TRANSIENT_CLEANUP_PAGE_SIZE_ = 100;
const TRANSIENT_CLEANUP_MAX_SCANNED_ = 1000;
const TRANSIENT_CLEANUP_MAX_DELETED_ = 200;

function transientCleanupTimestamp_(fields) {
  return String(normalizeFirestoreValue(fields.resolvedAt || fields.completedAt || fields.cancelledAt || fields.updatedAt || fields.ignoredAt || fields.createdAt) || "");
}
function transientCleanupEligible_(fields, policy, cutoff) {
  const terminal = !policy.terminalField || policy.terminalValues.indexOf(String(normalizeFirestoreValue(fields[policy.terminalField]) || "")) >= 0;
  const stamp = transientCleanupTimestamp_(fields);
  return terminal && !!stamp && stamp <= cutoff;
}
function cleanupTransientCollections_() {
  const props = PropertiesService.getScriptProperties();
  const today = Utilities.formatDate(new Date(), "Asia/Jerusalem", "yyyy-MM-dd");
  if (props.getProperty("transient_cleanup_day_v2") === today) return { skipped: true, deleted: 0, scanned: 0 };

  const token = ScriptApp.getOAuthToken();
  let deleted = 0;
  let scanned = 0;
  let fullyDrained = true;

  Object.keys(TRANSIENT_RETENTION_).forEach(function(collection) {
    if (deleted >= TRANSIENT_CLEANUP_MAX_DELETED_ || scanned >= TRANSIENT_CLEANUP_MAX_SCANNED_) { fullyDrained = false; return; }
    const policy = TRANSIENT_RETENTION_[collection];
    const cutoff = new Date(Date.now() - policy.days * 86400000).toISOString();
    let pageToken = null;
    let collectionFinished = false;

    while (!collectionFinished && deleted < TRANSIENT_CLEANUP_MAX_DELETED_ && scanned < TRANSIENT_CLEANUP_MAX_SCANNED_) {
      let url = packagingCleanupBaseUrl_() + "/" + collection + "?pageSize=" + TRANSIENT_CLEANUP_PAGE_SIZE_;
      if (pageToken) url += "&pageToken=" + encodeURIComponent(pageToken);
      const response = UrlFetchApp.fetch(url, { method: "get", headers: { Authorization: "Bearer " + token }, muteHttpExceptions: true });
      if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) { fullyDrained = false; break; }
      const payload = JSON.parse(response.getContentText() || "{}");
      const documents = payload.documents || [];
      scanned += documents.length;
      documents.forEach(function(doc) {
        if (deleted >= TRANSIENT_CLEANUP_MAX_DELETED_) return;
        const fields = doc.fields || {};
        if (!transientCleanupEligible_(fields, policy, cutoff)) return;
        const id = String(doc.name || "").split("/").pop();
        if (!id) return;
        const del = UrlFetchApp.fetch(packagingCleanupBaseUrl_() + "/" + collection + "/" + encodeURIComponent(id), { method: "delete", headers: { Authorization: "Bearer " + token }, muteHttpExceptions: true });
        if (del.getResponseCode() === 404 || (del.getResponseCode() >= 200 && del.getResponseCode() < 300)) deleted++;
      });
      pageToken = payload.nextPageToken || null;
      collectionFinished = !pageToken;
      if (!collectionFinished && (deleted >= TRANSIENT_CLEANUP_MAX_DELETED_ || scanned >= TRANSIENT_CLEANUP_MAX_SCANNED_)) fullyDrained = false;
    }
  });

  // Mark the day complete only after all configured collections were fully scanned.
  // If limits were reached, the next maintenance cycle continues instead of waiting a day.
  if (fullyDrained) props.setProperty("transient_cleanup_day_v2", today);
  if (deleted) console.log("Transient cleanup deleted " + deleted + " records after scanning " + scanned);
  return { skipped: false, deleted: deleted, scanned: scanned, fullyDrained: fullyDrained };
}
