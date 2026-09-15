// ================================================================
// ASYNC LOG FLUSH TRIGGER
// ================================================================
// The Web App queues request logs into ScriptProperties. The regular fermentor
// cycle calls ensureAsyncLogTrigger_(), which installs this one-minute trigger
// once. The trigger writes queued rows to the operational Logs spreadsheet
// completely outside the user's request/response path.
// ================================================================

const ASYNC_LOG_TRIGGER_FLAG = "async_log_trigger_installed_v1";

function ensureAsyncLogTrigger_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(ASYNC_LOG_TRIGGER_FLAG) === "1") return false;

  const exists = ScriptApp.getProjectTriggers().some(function (trigger) {
    return trigger.getHandlerFunction() === "flushQueuedLogs_";
  });

  if (!exists) {
    ScriptApp.newTrigger("flushQueuedLogs_")
      .timeBased()
      .everyMinutes(1)
      .create();
  }

  props.setProperty(ASYNC_LOG_TRIGGER_FLAG, "1");
  Logger.log("Async Logs trigger ready");
  return !exists;
}
