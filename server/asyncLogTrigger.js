// ================================================================
// ASYNC / FIVE-MINUTE MAINTENANCE TRIGGER
// ================================================================
// One five-minute trigger owns all periodic background work on the free Apps
// Script account: the fermentor Sheet -> Firestore refresh, durable Sheet-write
// retries, queued operational logs and due planning snapshots. Keeping one
// trigger avoids duplicate quota/runtime cost and gives us one honest freshness
// heartbeat for the Sheet -> system direction.
// ================================================================

const ASYNC_LOG_TRIGGER_FLAG = "async_maintenance_trigger_installed_v4_cycle";

function runAsyncMaintenance_() {
  // Self-migrate after deploy. The existing v3 trigger will execute this new
  // code once, remove the old standalone runFermentorCycle trigger, and leave
  // exactly one five-minute maintenance trigger behind.
  try {
    ensureAsyncLogTrigger_();
  } catch (error) {
    console.log("Maintenance trigger migration failed: " + error.message);
  }

  let cycle = null;
  let sheetPull = null;
  let planningSnapshots = null;
  let sheetSync = null;
  let logs = null;

  try {
    cycle = runFermentorCycle();

    if (cycle && cycle.skipped !== true) {
      const sync = cycle.sync || {};
      sheetPull = recordSheetPullFreshness_(FIREBASE_PROJECT_ID, {
        startedAt: new Date(Date.now() - Math.max(0, Number(cycle.durationSeconds) || 0) * 1000),
        // sheetReads counts unique successfully-read spreadsheet snapshots in
        // this cycle. Any failed Sheet extraction increments sync.errors.
        configuredSheets: Number(cycle.sheetReads) || 0,
        sheetsRead: Number(cycle.sheetReads) || 0,
        syncErrors: Number(sync.errors) || 0,
        measurementErrors: Number(sync.measurementErrors) || 0,
        packagingErrors: Number(sync.packagingErrors) || 0
      });
    }
  } catch (error) {
    console.log("Fermentor cycle maintenance failed: " + error.message);
  }

  try {
    planningSnapshots = runDuePlanningSnapshots_(FIREBASE_PROJECT_ID, new Date());
  } catch (error) {
    console.log("Planning snapshot maintenance failed: " + error.message);
  }

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

  return {
    cycle: cycle,
    sheetPull: sheetPull,
    planningSnapshots: planningSnapshots,
    sheetSync: sheetSync,
    logs: logs
  };
}

function ensureAsyncLogTrigger_() {
  const props = PropertiesService.getScriptProperties();
  const triggers = ScriptApp.getProjectTriggers();

  const managedTriggers = triggers.filter(function (trigger) {
    const handler = trigger.getHandlerFunction();
    return (
      handler === "flushQueuedLogs_" ||
      handler === "runAsyncMaintenance_" ||
      handler === "runFermentorCycle"
    );
  });

  const maintenanceTriggers = managedTriggers.filter(function (trigger) {
    return trigger.getHandlerFunction() === "runAsyncMaintenance_";
  });

  const legacyTriggers = managedTriggers.filter(function (trigger) {
    return trigger.getHandlerFunction() !== "runAsyncMaintenance_";
  });

  // Do not trust the ScriptProperty flag by itself. Triggers can be duplicated
  // manually or survive older deployments while the flag still says "installed".
  // A healthy project has exactly one maintenance trigger and no legacy owner.
  if (maintenanceTriggers.length === 1 && legacyTriggers.length === 0) {
    props.setProperty(ASYNC_LOG_TRIGGER_FLAG, "1");
    props.deleteProperty("async_maintenance_trigger_installed_v3_5min");
    props.deleteProperty("async_log_trigger_installed_v2_5min");
    props.deleteProperty("async_log_trigger_installed_v1");
    return false;
  }

  // Self-heal duplicates and legacy standalone jobs. It is safe to delete the
  // trigger that invoked the current execution; the running execution continues.
  managedTriggers.forEach(function (trigger) {
    ScriptApp.deleteTrigger(trigger);
  });

  ScriptApp.newTrigger("runAsyncMaintenance_")
    .timeBased()
    .everyMinutes(5)
    .create();

  props.setProperty(ASYNC_LOG_TRIGGER_FLAG, "1");
  props.deleteProperty("async_maintenance_trigger_installed_v3_5min");
  props.deleteProperty("async_log_trigger_installed_v2_5min");
  props.deleteProperty("async_log_trigger_installed_v1");

  Logger.log(
    "Async maintenance trigger repaired: exactly one every 5 minutes " +
    "(fermentor cycle + outbox + planning snapshots + logs)"
  );
  return true;
}
