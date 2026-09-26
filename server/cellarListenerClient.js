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

function cellarListenerEnsureForFermentor_(fermentor) {
  const data = fermentor && fermentor.data ? fermentor.data : (fermentor || {});
  const tankNumber = String(data.tankNumber || data.uid || data.id || "").trim();
  const tank = Number(tankNumber);
  if (!Number.isInteger(tank) || tank < 2 || tank > 19) {
    return { success: false, skipped: true, reason: "tank_out_of_range" };
  }

  const sheetUrl = String(data.sheetUrl || "").trim();
  if (!sheetUrl) return { success: false, skipped: true, reason: "missing_sheet" };

  return cellarListenerCall_("add", {
    tankNumber: tankNumber,
    sheetUrl: sheetUrl,
    batchNumber: String(data.batchNumber || "").replace("#", "").trim()
  });
}

function cellarListenerRemoveForFermentor_(fermentor) {
  const data = fermentor && fermentor.data ? fermentor.data : (fermentor || {});
  const sheetUrl = String(data.sheetUrl || "").trim();
  if (!sheetUrl) return { success: false, skipped: true, reason: "missing_sheet" };
  return cellarListenerCall_("remove", { sheetUrl: sheetUrl });
}

function cellarListenerReconcileNow_() {
  return cellarListenerCall_("reconcile", {});
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
    return cellarListenerEnsureForFermentor_(fermentor);
  }
  return cellarListenerRemoveForFermentor_(fermentor);
}

function cellarListenerSafeEnsureForFermentor_(fermentor) {
  try {
    return cellarListenerEnsureForFermentor_(fermentor);
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
