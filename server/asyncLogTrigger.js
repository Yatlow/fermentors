// ================================================================
// ASYNC LOG FLUSH TRIGGER
// ================================================================
// The Web App queues request logs into ScriptProperties. The regular fermentor
// cycle calls ensureAsyncLogTrigger_(), which keeps exactly one five-minute
// trigger for flushQueuedLogs_. The trigger writes queued rows to the
// operational Logs spreadsheet completely outside the user's request/response
// path.
// ================================================================

const ASYNC_LOG_TRIGGER_FLAG = "async_log_trigger_installed_v2_5min";

function ensureAsyncLogTrigger_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(ASYNC_LOG_TRIGGER_FLAG) === "1") return false;

  // v2 migration: remove any older flushQueuedLogs_ trigger (including the
  // previous every-minute trigger) and recreate it at the desired cadence.
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === "flushQueuedLogs_") {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger("flushQueuedLogs_")
    .timeBased()
    .everyMinutes(5)
    .create();

  props.setProperty(ASYNC_LOG_TRIGGER_FLAG, "1");
  Logger.log("Async Logs trigger ready: every 5 minutes");
  return true;
}
