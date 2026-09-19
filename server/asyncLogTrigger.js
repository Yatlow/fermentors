// ================================================================
// ASYNC / FIVE-MINUTE MAINTENANCE TRIGGER
// ================================================================
// One five-minute trigger owns all periodic background work on the free Apps
// Script account: the fermentor Sheet -> Firestore refresh, durable Sheet-write
// retries, queued operational logs and due planning snapshots. Keeping one
// trigger avoids duplicate quota/runtime cost and gives us one honest freshness
// heartbeat for the Sheet -> system direction.
//
// Fermentor sync cadence is intentionally smarter than the trigger cadence:
// - 04:30-17:00 Asia/Jerusalem: full cycle every trigger (~5 min).
// - 17:00-04:30 Asia/Jerusalem: full cycle at most once per hour.
// - During the night window, ACTION 0 tanks that are due today/past are checked
//   every trigger so a brew that actually starts is still promoted promptly.
// The trigger itself remains every five minutes so outbox retries, logs and
// planning checkpoint bookkeeping remain responsive.
// ================================================================

const ASYNC_LOG_TRIGGER_FLAG = "async_maintenance_trigger_installed_v4_cycle";
const SMART_FULL_CYCLE_LAST_AT_KEY_ = "smart_full_fermentor_cycle_last_at_v1";
const SMART_FULL_CYCLE_NIGHT_INTERVAL_MS_ = 60 * 60 * 1000;
const SMART_MANUAL_SYNC_MIN_AGE_MS_ = 10 * 60 * 1000;
const SMART_SYNC_TIMEZONE_ = "Asia/Jerusalem";
const SMART_SYNC_DAY_START_MINUTE_ = 4 * 60 + 30; // 04:30
const SMART_SYNC_DAY_END_MINUTE_ = 17 * 60;       // 17:00

function smartJerusalemClock_(now) {
  const hhmm = Utilities.formatDate(now, SMART_SYNC_TIMEZONE_, "HH:mm").split(":");
  const hour = Number(hhmm[0]);
  const minute = Number(hhmm[1]);
  return {
    text: ("0" + hour).slice(-2) + ":" + ("0" + minute).slice(-2),
    minuteOfDay: hour * 60 + minute
  };
}

function smartIsDaySyncWindow_(now) {
  const clock = smartJerusalemClock_(now);
  return clock.minuteOfDay >= SMART_SYNC_DAY_START_MINUTE_ &&
    clock.minuteOfDay < SMART_SYNC_DAY_END_MINUTE_;
}

function smartShouldRunFullCycle_(now) {
  if (smartIsDaySyncWindow_(now)) return true;

  const raw = PropertiesService.getScriptProperties().getProperty(
    SMART_FULL_CYCLE_LAST_AT_KEY_
  );
  const lastAt = Number(raw || 0);
  if (!Number.isFinite(lastAt) || lastAt <= 0) return true;

  return now.getTime() - lastAt >= SMART_FULL_CYCLE_NIGHT_INTERVAL_MS_;
}

function smartMarkFullCycleSuccess_(now) {
  PropertiesService.getScriptProperties().setProperty(
    SMART_FULL_CYCLE_LAST_AT_KEY_,
    String(now.getTime())
  );
}

function smartFirestoreDocumentToEntry_(document) {
  const name = String(document && document.name || "");
  const match = name.match(/\/documents\/fermentors\/([^/]+)$/);
  if (!match) return null;

  const normalized = {};
  const fields = document.fields || {};
  Object.keys(fields).forEach(function (key) {
    normalized[key] = normalizeFirestoreValue(fields[key]);
  });

  return {
    id: decodeURIComponent(match[1]),
    data: normalized
  };
}

// Narrow server-side query: unlike getAllFermentorsFromFirestore(), this bills
// only the matching ACTION 0 documents (Firestore still charges its normal
// minimum for an empty query). It is the only Firestore poll we keep at five
// minutes during the night window.
function smartGetAction0Fermentors_(projectId) {
  const url =
    "https://firestore.googleapis.com/v1/projects/" +
    encodeURIComponent(projectId) +
    "/databases/(default)/documents:runQuery";

  const payload = {
    structuredQuery: {
      from: [{ collectionId: "fermentors" }],
      where: {
        fieldFilter: {
          field: { fieldPath: "action" },
          op: "EQUAL",
          value: { integerValue: "0" }
        }
      }
    }
  };

  const response = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    headers: {
      Authorization: "Bearer " + ScriptApp.getOAuthToken()
    },
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error(
      "Firestore ACTION 0 query failed: " + code + " " + response.getContentText()
    );
  }

  const rows = JSON.parse(response.getContentText()) || [];
  return rows
    .map(function (row) {
      return row && row.document ? smartFirestoreDocumentToEntry_(row.document) : null;
    })
    .filter(function (entry) { return entry !== null; });
}

function smartDateKey_(value) {
  const text = String(value == null ? "" : value).trim();
  if (!text) return null;

  let match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    return Number(match[3]) * 10000 + Number(match[2]) * 100 + Number(match[1]);
  }

  match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) {
    return Number(match[1]) * 10000 + Number(match[2]) * 100 + Number(match[3]);
  }

  return null;
}

function smartJerusalemTodayKey_(now) {
  return Number(Utilities.formatDate(now, SMART_SYNC_TIMEZONE_, "yyyyMMdd"));
}

function smartAction0IsDue_(fermentor, now) {
  const data = fermentor && fermentor.data || {};
  const brewDateKey = smartDateKey_(data.brewDate);
  // Unknown/legacy date must remain safe: inspect rather than risk delaying a brew.
  return brewDateKey === null || brewDateKey <= smartJerusalemTodayKey_(now);
}

function smartRunNightAction0Guard_(projectId, now) {
  const matches = smartGetAction0Fermentors_(projectId);
  const due = matches.filter(function (fermentor) {
    return smartAction0IsDue_(fermentor, now);
  });

  let processed = 0;
  let errors = 0;

  due.forEach(function (entry) {
    try {
      // processAction0 expects the plain fermentor fields, not the {id,data}
      // wrapper used by the optimized full cycle.
      processAction0(Object.assign({ uid: entry.id, id: entry.id }, entry.data));
      processed++;
    } catch (error) {
      errors++;
      console.log(
        "Night ACTION 0 guard failed for tank " +
        String(entry.data && entry.data.tankNumber || entry.id) +
        ": " + error.message
      );
    }
  });

  return {
    matched: matches.length,
    due: due.length,
    processed: processed,
    errors: errors
  };
}

function runManualNightFermentorSync_() {
  const now = new Date();

  if (smartIsDaySyncWindow_(now)) {
    return {
      success: false,
      reason: "day_window",
      message: "הסנכרון הידני זמין רק בשעות הלילה"
    };
  }

  const props = PropertiesService.getScriptProperties();
  const lastAt = Number(
    props.getProperty(SMART_FULL_CYCLE_LAST_AT_KEY_) || 0
  );
  const ageMs = lastAt > 0 ? now.getTime() - lastAt : Infinity;

  if (Number.isFinite(ageMs) && ageMs < SMART_MANUAL_SYNC_MIN_AGE_MS_) {
    return {
      success: false,
      reason: "too_fresh",
      ageMinutes: Math.max(0, Math.floor(ageMs / 60000)),
      retryAfterMinutes: Math.max(
        1,
        Math.ceil((SMART_MANUAL_SYNC_MIN_AGE_MS_ - ageMs) / 60000)
      ),
      message: "הנתונים כבר סונכרנו בעשר הדקות האחרונות"
    };
  }

  const cycle = runFermentorCycle();
  if (!cycle || cycle.skipped === true) {
    return {
      success: false,
      reason: cycle && cycle.reason ? cycle.reason : "cycle_skipped",
      message: "סנכרון אחר כבר רץ. נסה שוב בעוד רגע"
    };
  }

  smartMarkFullCycleSuccess_(now);

  const sync = cycle.sync || {};
  const sheetPull = recordSheetPullFreshness_(FIREBASE_PROJECT_ID, {
    startedAt: new Date(
      Date.now() - Math.max(0, Number(cycle.durationSeconds) || 0) * 1000
    ),
    configuredSheets: Number(cycle.sheetReads) || 0,
    sheetsRead: Number(cycle.sheetReads) || 0,
    syncErrors: Number(sync.errors) || 0,
    measurementErrors: Number(sync.measurementErrors) || 0,
    packagingErrors: Number(sync.packagingErrors) || 0
  });

  return {
    success: true,
    cycle: cycle,
    sheetPull: sheetPull,
    completedAt: new Date().toISOString()
  };
}


function runAsyncMaintenance_() {
  // Self-migrate after deploy. The existing v3 trigger will execute this new
  // code once, remove the old standalone runFermentorCycle trigger, and leave
  // exactly one five-minute maintenance trigger behind.
  try {
    ensureAsyncLogTrigger_();
  } catch (error) {
    console.log("Maintenance trigger migration failed: " + error.message);
  }

  const now = new Date();
  const clock = smartJerusalemClock_(now);
  const isDayWindow = smartIsDaySyncWindow_(now);
  const shouldRunFullCycle = smartShouldRunFullCycle_(now);

  let cycle = null;
  let action0Guard = null;
  let sheetPull = null;
  let planningSnapshots = null;
  let sheetSync = null;
  let packagingCleanup = null;
  let operationReceiptCleanup = null;
  let styleModels = null;
  let pressureV4Backfill = null;
  let logs = null;

  try {
    if (shouldRunFullCycle) {
      cycle = runFermentorCycle();

      if (cycle && cycle.skipped !== true) {
        smartMarkFullCycleSuccess_(now);

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
    } else {
      action0Guard = smartRunNightAction0Guard_(FIREBASE_PROJECT_ID, now);
    }
  } catch (error) {
    console.log("Fermentor maintenance failed: " + error.message);
  }

  try {
    planningSnapshots = runDuePlanningSnapshots_(FIREBASE_PROJECT_ID, now);
  } catch (error) {
    console.log("Planning snapshot maintenance failed: " + error.message);
  }

  try {
    sheetSync = processPendingSheetSyncJobs_();
  } catch (error) {
    console.log("Sheet sync maintenance failed: " + error.message);
  }

  try {
    packagingCleanup = cleanupCompletedPackagingOperations_();
  } catch (error) {
    console.log("Packaging operation cleanup failed: " + error.message);
  }

  try {
    operationReceiptCleanup = cleanupLegacyOperationReceipts_();
  } catch (error) {
    console.log("Legacy operation receipt cleanup failed: " + error.message);
  }

  try {
    styleModels = calculateWeeklyStyleAverages(false);
  } catch (error) {
    console.log("Weekly style/pressure model maintenance failed: " + error.message);
  }

  try {
    let v4State = pressurePredictionV4BackfillState_();
    if (!v4State) {
      startPressurePredictionV4Backfill_();
      v4State = pressurePredictionV4BackfillState_();
    }
    if (v4State && v4State.active === true) {
      pressureV4Backfill = pressurePredictionV4BackfillStep_();
    } else {
      pressureV4Backfill = {
        skipped: true,
        reason: v4State && v4State.completed ? "completed" : "inactive"
      };
    }
  } catch (error) {
    console.log("Historical V4 pressure model backfill failed: " + error.message);
  }

  try {
    logs = flushQueuedLogs_();
  } catch (error) {
    console.log("Async log flush failed: " + error.message);
  }

  return {
    syncMode: shouldRunFullCycle ? "full" : "night_action0_guard",
    jerusalemTime: clock.text,
    dayWindow: isDayWindow,
    cycle: cycle,
    action0Guard: action0Guard,
    sheetPull: sheetPull,
    planningSnapshots: planningSnapshots,
    sheetSync: sheetSync,
    packagingCleanup: packagingCleanup,
    operationReceiptCleanup: operationReceiptCleanup,
    styleModels: styleModels,
    pressureV4Backfill: pressureV4Backfill,
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
    "(smart fermentor sync + outbox + planning snapshots + logs)"
  );
  return true;
}
