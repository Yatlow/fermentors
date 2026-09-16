// ================================================================
// ASYNC MAINTENANCE TRIGGER
// ================================================================
// One five-minute trigger handles work that should never block a user's Web App
// response: flushing queued operational logs and retrying durable Sheet sync
// jobs. Keeping both tasks on one trigger avoids doubling Apps Script executions
// on the free account.
// ================================================================

const ASYNC_LOG_TRIGGER_FLAG = "async_maintenance_trigger_installed_v3_5min";

function runAsyncMaintenance_() {
  let sheetSync = null;
  let logs = null;

  try {
    sheetSync = processPendingSheetSyncJobs_();
  } catch (error) {
    console.log("Sheet sync maintenance failed: " + error.message);
  }

  try {
    logs = flushQueuedLogs_();
  } catch (error) {
    console.log("Async log flush failed: " + error.message);
  }

  return { sheetSync: sheetSync, logs: logs };
}

function ensureAsyncLogTrigger_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(ASYNC_LOG_TRIGGER_FLAG) === "1") return false;

  // v3 migration: replace the old log-only trigger with one shared maintenance
  // trigger. Delete duplicates if a partial/manual setup created more than one.
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    const handler = trigger.getHandlerFunction();
    if (handler === "flushQueuedLogs_" || handler === "runAsyncMaintenance_") {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger("runAsyncMaintenance_")
    .timeBased()
    .everyMinutes(5)
    .create();

  props.setProperty(ASYNC_LOG_TRIGGER_FLAG, "1");
  Logger.log("Async maintenance trigger ready: every 5 minutes");
  return true;
}
