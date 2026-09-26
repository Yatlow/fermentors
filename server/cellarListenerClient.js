// ============================================================
// DEDICATED CELLAR LISTENER SERVICE CLIENT
// ============================================================
// The listener itself lives in the separate Apps Script project under
// /cellar-listener. The main server owns ACTION transitions and tells that
// service when an ACTION-1 Sheet should gain/lose its installable onEdit.
//
// Required Script Properties in the MAIN Apps Script project:
//   CELLAR_LISTENER_WEBAPP_URL
//   CELLAR_LISTENER_SECRET
// ============================================================

const CELLAR_LISTENER_WEBAPP_URL_PROPERTY_ = "CELLAR_LISTENER_WEBAPP_URL";
const CELLAR_LISTENER_SECRET_PROPERTY_ = "CELLAR_LISTENER_SECRET";
const CELLAR_LISTENER_ENSURE_PREFIX_ = "cellar_listener_ensure:";
const CELLAR_LISTENER_ENSURE_INTERVAL_MS_ = 55 * 60 * 1000;
const CELLAR_LISTENER_STATUS_LAST_AT_KEY_ = "cellar_listener_status_last_at_v1";
const CELLAR_LISTENER_STATUS_INTERVAL_MS_ = 5 * 60 * 1000;
const CELLAR_LISTENER_STATUS_DOC_ID_ = "_cellarListenerStatus";

function cellarListenerConfig_() {
  const props = PropertiesService.getScriptProperties();
  return {
    url: String(props.getProperty(CELLAR_LISTENER_WEBAPP_URL_PROPERTY_) || "").trim(),
    secret: String(props.getProperty(CELLAR_LISTENER_SECRET_PROPERTY_) || "").trim()
  };
}

function cellarListenerCall_(action, payload) {
  const config = cellarListenerConfig_();
  if (!config.url || !config.secret) {
    Logger.log(
      "Cellar listener service not configured; skipped " + action +
      ". Set CELLAR_LISTENER_WEBAPP_URL and CELLAR_LISTENER_SECRET."
    );
    return { success: false, skipped: true, reason: "not_configured" };
  }

  const body = Object.assign({}, payload || {}, {
    action: action,
    secret: config.secret
  });

  const response = UrlFetchApp.fetch(config.url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
    followRedirects: true
  });

  const code = response.getResponseCode();
  const text = response.getContentText();
  let parsed = null;
  try { parsed = JSON.parse(text || "{}"); } catch (error) { parsed = null; }

  if (code < 200 || code >= 300 || !parsed || parsed.success !== true) {
    throw new Error(
      "Cellar listener " + action + " failed: HTTP " + code + " " + text
    );
  }
  return parsed;
}

function cellarListenerStatusFirestoreValue_(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  return { stringValue: String(value) };
}

function cellarListenerWriteStatusDoc_(status) {
  const fields = {
    listenerCount: cellarListenerStatusFirestoreValue_(Number(status.listenerCount) || 0),
    totalProjectTriggerCount: cellarListenerStatusFirestoreValue_(Number(status.totalProjectTriggerCount) || 0),
    state: cellarListenerStatusFirestoreValue_("ok"),
    updatedAt: { timestampValue: new Date().toISOString() }
  };

  const url =
    "https://firestore.googleapis.com/v1/projects/" + FIREBASE_PROJECT_ID +
    "/databases/(default)/documents/sheetSyncJobs/" + CELLAR_LISTENER_STATUS_DOC_ID_;

  const response = UrlFetchApp.fetch(url + "?updateMask.fieldPaths=listenerCount" +
    "&updateMask.fieldPaths=totalProjectTriggerCount" +
    "&updateMask.fieldPaths=state" +
    "&updateMask.fieldPaths=updatedAt", {
    method: "patch",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({ fields: fields }),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error(
      "Cellar listener status write failed: " + code + " " + response.getContentText()
    );
  }
}

function cellarListenerPublishStatus_(force) {
  const props = PropertiesService.getScriptProperties();
  const now = Date.now();
  const lastAt = Number(props.getProperty(CELLAR_LISTENER_STATUS_LAST_AT_KEY_) || 0);
  if (!force && lastAt > 0 && now - lastAt < CELLAR_LISTENER_STATUS_INTERVAL_MS_) {
    return { success: true, skipped: true, reason: "fresh_status" };
  }

  try {
    const status = cellarListenerCall_("status", {});
    if (!status || status.success !== true) return status;
    cellarListenerWriteStatusDoc_(status);
    props.setProperty(CELLAR_LISTENER_STATUS_LAST_AT_KEY_, String(now));
    return status;
  } catch (error) {
    Logger.log("Cellar listener status publish failed: " + error.message);
    return { success: false, error: error.message };
  }
}

function cellarListenerSheetId_(value) {
  const text = String(value || "").trim();
  const match = text.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : text;
}

function cellarListenerEnsureKey_(sheetUrl) {
  const id = cellarListenerSheetId_(sheetUrl);
  return id ? CELLAR_LISTENER_ENSURE_PREFIX_ + id : "";
}

function cellarListenerEnsureForFermentor_(fermentor) {
  const data = fermentor && fermentor.data ? fermentor.data : (fermentor || {});
  const tankNumber = String(data.tankNumber || data.uid || data.id || "").trim();
  const tank = Number(tankNumber);
  if (!Number.isInteger(tank) || tank < 2 || tank > 19) {
    return { success: false, skipped: true, reason: "tank_out_of_range" };
  }

  const sheetUrl = String(data.sheetUrl || "").trim();
  if (!sheetUrl) return { success: false, skipped: true, reason: "missing_sheet" };

  const result = cellarListenerCall_("add", {
    tankNumber: tankNumber,
    sheetUrl: sheetUrl,
    batchNumber: String(data.batchNumber || "").replace("#", "").trim()
  });
  cellarListenerPublishStatus_(Boolean(result && result.installed));
  return result;
}

function cellarListenerRemoveForFermentor_(fermentor) {
  const data = fermentor && fermentor.data ? fermentor.data : (fermentor || {});
  const sheetUrl = String(data.sheetUrl || "").trim();
  if (!sheetUrl) return { success: false, skipped: true, reason: "missing_sheet" };

  const result = cellarListenerCall_("remove", { sheetUrl: sheetUrl });
  const ensureKey = cellarListenerEnsureKey_(sheetUrl);
  if (ensureKey) PropertiesService.getScriptProperties().deleteProperty(ensureKey);
  cellarListenerPublishStatus_(true);
  return result;
}

function cellarListenerReconcileNow_() {
  const result = cellarListenerCall_("reconcile", {});
  cellarListenerPublishStatus_(true);
  return result;
}

function cellarListenerReadFermentor_(tankNumber) {
  const id = String(tankNumber || "").trim();
  if (!id) return null;

  const url =
    "https://firestore.googleapis.com/v1/projects/" +
    FIREBASE_PROJECT_ID +
    "/databases/(default)/documents/fermentors/" +
    encodeURIComponent(id);

  const response = UrlFetchApp.fetch(url, {
    method: "get",
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });

  if (response.getResponseCode() === 404) return null;
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    throw new Error(
      "Cellar listener fermentor read failed: " +
      response.getResponseCode() + " " + response.getContentText()
    );
  }

  const fields = (JSON.parse(response.getContentText() || "{}") || {}).fields || {};
  const result = {};
  Object.keys(fields).forEach(function (key) {
    result[key] = normalizeFirestoreValue(fields[key]);
  });
  if (!result.tankNumber) result.tankNumber = id;
  return result;
}

function cellarListenerSyncForAction_(tankNumber, action) {
  const numericAction = Number(action);
  if (numericAction !== 1 && numericAction !== 3) {
    return { success: false, skipped: true, reason: "irrelevant_action" };
  }

  const fermentor = cellarListenerReadFermentor_(tankNumber);
  if (!fermentor) return { success: false, skipped: true, reason: "fermentor_missing" };

  if (numericAction === 1) {
    const result = cellarListenerEnsureForFermentor_(fermentor);
    if (result && result.success === true) {
      const key = cellarListenerEnsureKey_(fermentor.sheetUrl);
      if (key) PropertiesService.getScriptProperties().setProperty(key, String(Date.now()));
    }
    return result;
  }
  return cellarListenerRemoveForFermentor_(fermentor);
}

function cellarListenerSafeEnsureForFermentor_(fermentor) {
  try {
    const data = fermentor && fermentor.data ? fermentor.data : (fermentor || {});
    const key = cellarListenerEnsureKey_(data.sheetUrl);
    if (key) {
      const lastAt = Number(PropertiesService.getScriptProperties().getProperty(key) || 0);
      if (lastAt > 0 && Date.now() - lastAt < CELLAR_LISTENER_ENSURE_INTERVAL_MS_) {
        cellarListenerPublishStatus_(false);
        return { success: true, skipped: true, reason: "recently_ensured" };
      }
    }

    const result = cellarListenerEnsureForFermentor_(fermentor);
    if (result && result.success === true && key) {
      PropertiesService.getScriptProperties().setProperty(key, String(Date.now()));
    }
    return result;
  } catch (error) {
    Logger.log("Cellar listener ensure failed: " + error.message);
    return { success: false, error: error.message };
  }
}

function cellarListenerSafeRemoveForFermentor_(fermentor) {
  try {
    return cellarListenerRemoveForFermentor_(fermentor);
  } catch (error) {
    Logger.log("Cellar listener remove failed: " + error.message);
    return { success: false, error: error.message };
  }
}

function cellarListenerSafeSyncForAction_(tankNumber, action) {
  try {
    return cellarListenerSyncForAction_(tankNumber, action);
  } catch (error) {
    Logger.log(
      "Cellar listener ACTION hook failed for tank " + tankNumber +
      " ACTION " + action + ": " + error.message
    );
    return { success: false, error: error.message };
  }
}
