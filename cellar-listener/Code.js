const FIREBASE_PROJECT_ID = "fermenter-dashboard-bada3";
const CELLAR_LISTENER_HANDLER = "cellarSheetOnEdit";
const CELLAR_MAINTENANCE_HANDLER = "hourlyCellarListenerMaintenance";
const CELLAR_LISTENER_MAP_PREFIX = "cellar_listener:";
const CELLAR_LISTENER_SECRET_PROPERTY = "CELLAR_LISTENER_SECRET";
const CELLAR_MIN_TANK = 2;
const CELLAR_MAX_TANK = 19;
const CELLAR_MAX_ONEDIT_TRIGGERS = CELLAR_MAX_TANK - CELLAR_MIN_TANK + 1; // 18

function doPost(e) {
  try {
    const payload = parseJsonBody_(e);
    assertSecret_(payload.secret);

    const action = String(payload.action || "").trim().toLowerCase();
    if (action === "add") return jsonOutput_(addCellarListener_(payload));
    if (action === "remove") return jsonOutput_(removeCellarListener_(payload));
    if (action === "status") return jsonOutput_(cellarListenerStatus_());
    if (action === "reconcile") return jsonOutput_(reconcileCellarListeners_());
    if (action === "setup") return jsonOutput_(setupCellarListenerService());

    return jsonOutput_({ success: false, error: "Unsupported action: " + action });
  } catch (error) {
    console.log("cellar listener API failed: " + (error && error.stack ? error.stack : error));
    return jsonOutput_({
      success: false,
      error: error && error.message ? error.message : String(error)
    });
  }
}

function parseJsonBody_(e) {
  const text = e && e.postData ? String(e.postData.contents || "") : "";
  if (!text) throw new Error("Missing JSON body");
  return JSON.parse(text);
}

function assertSecret_(provided) {
  const expected = String(
    PropertiesService.getScriptProperties().getProperty(CELLAR_LISTENER_SECRET_PROPERTY) || ""
  );
  if (!expected) throw new Error("CELLAR_LISTENER_SECRET is not configured");
  if (String(provided || "") !== expected) throw new Error("Unauthorized");
}

function jsonOutput_(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function extractSpreadsheetId_(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const match = text.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : text;
}

function listenerMapKey_(spreadsheetId) {
  return CELLAR_LISTENER_MAP_PREFIX + String(spreadsheetId || "").trim();
}

function triggerSourceId_(trigger) {
  try {
    return String(trigger.getTriggerSourceId() || "").trim();
  } catch (error) {
    return "";
  }
}

function tankNumberInListenerRange_(tankNumber) {
  const tank = Number(tankNumber);
  return Number.isInteger(tank) && tank >= CELLAR_MIN_TANK && tank <= CELLAR_MAX_TANK;
}

function mappingFromFermentor_(fermentor, fallbackId) {
  const tankNumber = String(fermentor.tankNumber || fallbackId || "").trim();
  const spreadsheetId = extractSpreadsheetId_(fermentor.sheetUrl);
  return {
    spreadsheetId: spreadsheetId,
    sheetUrl: String(fermentor.sheetUrl || ""),
    tankNumber: tankNumber,
    batchNumber: String(fermentor.batchNumber || "").replace("#", "").trim(),
    updatedAt: new Date().toISOString()
  };
}

function saveMapping_(mapping) {
  PropertiesService.getScriptProperties().setProperty(
    listenerMapKey_(mapping.spreadsheetId),
    JSON.stringify(mapping)
  );
}

function readMapping_(spreadsheetId) {
  const raw = PropertiesService.getScriptProperties().getProperty(listenerMapKey_(spreadsheetId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    PropertiesService.getScriptProperties().deleteProperty(listenerMapKey_(spreadsheetId));
    return null;
  }
}

function deleteMapping_(spreadsheetId) {
  PropertiesService.getScriptProperties().deleteProperty(listenerMapKey_(spreadsheetId));
}

function managedOnEditTriggers_() {
  return ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === CELLAR_LISTENER_HANDLER;
  });
}

function ensureHourlyMaintenanceTrigger_() {
  const triggers = ScriptApp.getProjectTriggers();
  const matches = triggers.filter(function (trigger) {
    return trigger.getHandlerFunction() === CELLAR_MAINTENANCE_HANDLER;
  });

  matches.slice(1).forEach(function (trigger) {
    ScriptApp.deleteTrigger(trigger);
  });

  if (!matches.length) {
    ScriptApp.newTrigger(CELLAR_MAINTENANCE_HANDLER)
      .timeBased()
      .everyHours(1)
      .create();
    return true;
  }
  return false;
}

function setupCellarListenerService() {
  const maintenanceInstalled = ensureHourlyMaintenanceTrigger_();
  const reconciliation = reconcileCellarListeners_();
  return {
    success: true,
    maintenanceInstalled: maintenanceInstalled,
    reconciliation: reconciliation
  };
}

function hourlyCellarListenerMaintenance() {
  return reconcileCellarListeners_();
}

function addCellarListener_(payload) {
  const spreadsheetId = extractSpreadsheetId_(payload.sheetUrl || payload.spreadsheetId);
  const tankNumber = String(payload.tankNumber || "").trim();
  if (!spreadsheetId) throw new Error("Missing sheetUrl/spreadsheetId");
  if (!tankNumberInListenerRange_(tankNumber)) {
    throw new Error("Cellar listener supports tanks 2-19 only");
  }

  const mapping = {
    spreadsheetId: spreadsheetId,
    sheetUrl: String(payload.sheetUrl || ""),
    tankNumber: tankNumber,
    batchNumber: String(payload.batchNumber || "").replace("#", "").trim(),
    updatedAt: new Date().toISOString()
  };
  saveMapping_(mapping);
  ensureHourlyMaintenanceTrigger_();

  const matches = managedOnEditTriggers_().filter(function (trigger) {
    return triggerSourceId_(trigger) === spreadsheetId;
  });
  matches.slice(1).forEach(function (trigger) {
    ScriptApp.deleteTrigger(trigger);
  });

  let installed = false;
  if (!matches.length) {
    if (managedOnEditTriggers_().length >= CELLAR_MAX_ONEDIT_TRIGGERS) {
      throw new Error("Cellar listener trigger capacity reached (18 onEdit triggers)");
    }
    ScriptApp.newTrigger(CELLAR_LISTENER_HANDLER)
      .forSpreadsheet(spreadsheetId)
      .onEdit()
      .create();
    installed = true;
  }

  return {
    success: true,
    action: "add",
    spreadsheetId: spreadsheetId,
    tankNumber: tankNumber,
    installed: installed
  };
}

function removeCellarListener_(payload) {
  const spreadsheetId = extractSpreadsheetId_(payload.sheetUrl || payload.spreadsheetId);
  if (!spreadsheetId) throw new Error("Missing sheetUrl/spreadsheetId");

  let removed = 0;
  managedOnEditTriggers_().forEach(function (trigger) {
    if (triggerSourceId_(trigger) === spreadsheetId) {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    }
  });
  deleteMapping_(spreadsheetId);

  return { success: true, action: "remove", spreadsheetId: spreadsheetId, removed: removed };
}

function cellarListenerStatus_() {
  const triggers = managedOnEditTriggers_();
  return {
    success: true,
    listeners: triggers.map(function (trigger) {
      const spreadsheetId = triggerSourceId_(trigger);
      return {
        spreadsheetId: spreadsheetId,
        mapping: readMapping_(spreadsheetId)
      };
    }),
    listenerCount: triggers.length,
    totalProjectTriggerCount: ScriptApp.getProjectTriggers().length
  };
}

function listFermentors_() {
  const result = [];
  let pageToken = null;
  do {
    let url = "https://firestore.googleapis.com/v1/projects/" + FIREBASE_PROJECT_ID +
      "/databases/(default)/documents/fermentors?pageSize=100";
    if (pageToken) url += "&pageToken=" + encodeURIComponent(pageToken);

    const response = UrlFetchApp.fetch(url, {
      method: "get",
      headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });
    const code = response.getResponseCode();
    if (code < 200 || code >= 300) {
      throw new Error("Fermentor list failed: " + code + " " + response.getContentText());
    }

    const body = JSON.parse(response.getContentText() || "{}");
    (body.documents || []).forEach(function (document) {
      const id = String(document.name || "").split("/").pop();
      result.push({ id: id, data: firestoreFieldsToObject_(document.fields || {}) });
    });
    pageToken = body.nextPageToken || null;
  } while (pageToken);
  return result;
}

function reconcileCellarListeners_() {
  ensureHourlyMaintenanceTrigger_();

  const fermentors = listFermentors_();
  const desired = {};
  fermentors.forEach(function (entry) {
    const fermentor = entry.data || {};
    const tank = Number(fermentor.tankNumber || entry.id);
    if (Number(fermentor.action) !== 1) return;
    if (!tankNumberInListenerRange_(tank)) return;
    const spreadsheetId = extractSpreadsheetId_(fermentor.sheetUrl);
    if (!spreadsheetId) return;
    desired[spreadsheetId] = mappingFromFermentor_(fermentor, entry.id);
  });

  const desiredIds = Object.keys(desired);
  if (desiredIds.length > CELLAR_MAX_ONEDIT_TRIGGERS) {
    throw new Error("More than 18 ACTION 1 cellar Sheets found; refusing to exceed trigger capacity");
  }

  const kept = {};
  let removed = 0;
  managedOnEditTriggers_().forEach(function (trigger) {
    const spreadsheetId = triggerSourceId_(trigger);
    if (spreadsheetId && desired[spreadsheetId] && !kept[spreadsheetId]) {
      kept[spreadsheetId] = true;
      return;
    }
    ScriptApp.deleteTrigger(trigger);
    removed++;
    if (spreadsheetId && !desired[spreadsheetId]) deleteMapping_(spreadsheetId);
  });

  let installed = 0;
  desiredIds.forEach(function (spreadsheetId) {
    saveMapping_(desired[spreadsheetId]);
    if (kept[spreadsheetId]) return;
    ScriptApp.newTrigger(CELLAR_LISTENER_HANDLER)
      .forSpreadsheet(spreadsheetId)
      .onEdit()
      .create();
    kept[spreadsheetId] = true;
    installed++;
  });

  const props = PropertiesService.getScriptProperties();
  const allProps = props.getProperties();
  Object.keys(allProps).forEach(function (key) {
    if (key.indexOf(CELLAR_LISTENER_MAP_PREFIX) !== 0) return;
    const spreadsheetId = key.slice(CELLAR_LISTENER_MAP_PREFIX.length);
    if (!desired[spreadsheetId]) props.deleteProperty(key);
  });

  return {
    success: true,
    fermentorsRead: fermentors.length,
    desiredListeners: desiredIds.length,
    installed: installed,
    removed: removed,
    totalProjectTriggers: ScriptApp.getProjectTriggers().length
  };
}

function cellarSheetOnEdit(event) {
  if (!event || !event.source) return;
  const spreadsheetId = String(event.source.getId() || "").trim();
  if (!spreadsheetId) return;

  try {
    const mapping = readMapping_(spreadsheetId);
    if (!mapping) {
      removeCellarListener_({ spreadsheetId: spreadsheetId });
      return;
    }

    // No Firestore read here. Lifecycle ownership belongs to the ACTION service,
    // and the hourly reconciliation is the self-healing safety net.
    syncEditedSheetToFirestore_(event, mapping);
  } catch (error) {
    console.log(
      "cellarSheetOnEdit failed for " + spreadsheetId + ": " +
      (error && error.message ? error.message : error)
    );
  }
}

function syncEditedSheetToFirestore_(event, mapping) {
  const spreadsheet = event.source;
  const sheet = spreadsheet.getSheets()[0];
  if (!sheet || !event.range) return;
  if (event.range.getSheet().getSheetId() !== sheet.getSheetId()) return;

  const values = sheet.getDataRange().getDisplayValues();
  if (!editCouldAffectCellar_(event, sheet, values)) return;

  const latest = latestFermentationMeasurement_(values);
  const measurementPatches = editedFermentationPatches_(event, sheet, values);
  const packagingPatch = editedPackagingPatch_(event, sheet, values);
  const currentData = {};

  const latestRowIndex = latest ? latest.rowIndex : -1;
  measurementPatches.forEach(function (patch) {
    if (patch.rowIndex !== latestRowIndex) return;
    Object.keys(patch.fields).forEach(function (key) {
      currentData[key] = patch.fields[key];
    });
  });

  Object.keys(packagingPatch).forEach(function (key) {
    currentData[key] = packagingPatch[key];
  });

  if (!Object.keys(currentData).length && !measurementPatches.length) return;

  const batch = String(mapping.batchNumber || "").replace("#", "").trim();
  commitPartialCellarUpdate_(
    String(mapping.tankNumber),
    batch,
    currentData,
    measurementPatches
  );
}

function editCouldAffectCellar_(event, sheet, values) {
  if (!event || !event.range) return false;
  const range = event.range;
  if (range.getSheet().getSheetId() !== sheet.getSheetId()) return false;

  const firstRow = range.getRow();
  const lastRow = range.getLastRow();
  const firstCol = range.getColumn();
  const lastCol = range.getLastColumn();

  const header = fermentationHeaderRow_(values);
  if (header >= 0) {
    const headerOneBased = header + 1;
    // Only C:H are cellar data. A:B are date/time metadata and do not touch currentData.
    if (lastRow > headerOneBased && firstCol <= 8 && lastCol >= 3) return true;
  }

  const targets = packagingTargets_(sheet, values);
  return targets.some(function (target) {
    return target && target.row >= firstRow && target.row <= lastRow &&
      target.col >= firstCol && target.col <= lastCol;
  });
}

function fermentationHeaderRow_(values) {
  for (let r = 0; r < values.length; r++) {
    const labels = (values[r] || []).map(function (cell) {
      return String(cell || "").trim();
    });
    if (
      labels.indexOf("תאריך") !== -1 &&
      labels.indexOf("שעה") !== -1 &&
      labels.indexOf("טמפרטורה") !== -1
    ) return r;
  }
  return -1;
}

function latestFermentationMeasurement_(values) {
  const header = fermentationHeaderRow_(values);
  if (header < 0) return null;

  let found = null;
  for (let r = header + 1; r < values.length; r++) {
    const row = values[r] || [];
    const parsedDate = parseIsraeliDate_(row[0]);
    if (!parsedDate) continue;
    const hasData = [2, 3, 4, 5, 6, 7].some(function (col) {
      return String(row[col] == null ? "" : row[col]).trim() !== "";
    });
    if (!hasData) continue;

    const timeText = String(row[1] || "").trim();
    found = {
      rowIndex: r,
      measurementId: measurementId_(parsedDate, timeText),
      date: String(row[0] || "").trim(),
      time: timeText,
      plato: numberOrNull_(row[2]),
      temp: numberOrNull_(row[3]),
      pressure: numberOrNull_(row[4]),
      pH: numberOrNull_(row[5]),
      carbonation: numberOrNull_(row[6]),
      notes: String(row[7] || "").trim()
    };
  }
  return found;
}

function fermentationFieldForColumn_(column) {
  if (column === 3) return { key: "plato", numeric: true };
  if (column === 4) return { key: "temp", numeric: true };
  if (column === 5) return { key: "pressure", numeric: true };
  if (column === 6) return { key: "pH", numeric: true };
  if (column === 7) return { key: "carbonation", numeric: true };
  if (column === 8) return { key: "notes", numeric: false };
  return null;
}

function editedFermentationPatches_(event, sheet, values) {
  const range = event && event.range;
  if (!range || range.getSheet().getSheetId() !== sheet.getSheetId()) return [];

  const header = fermentationHeaderRow_(values);
  if (header < 0) return [];

  const firstRow = Math.max(range.getRow(), header + 2);
  const lastRow = range.getLastRow();
  const firstCol = Math.max(range.getColumn(), 3);
  const lastCol = Math.min(range.getLastColumn(), 8);
  if (firstRow > lastRow || firstCol > lastCol) return [];

  const patches = [];
  for (let rowNumber = firstRow; rowNumber <= lastRow; rowNumber++) {
    const rowIndex = rowNumber - 1;
    const row = values[rowIndex] || [];
    const parsedDate = parseIsraeliDate_(row[0]);
    if (!parsedDate) continue;

    const fields = {};
    for (let column = firstCol; column <= lastCol; column++) {
      const spec = fermentationFieldForColumn_(column);
      if (!spec) continue;

      const raw = String(row[column - 1] == null ? "" : row[column - 1]).trim();
      // Empty cells never erase Firestore values. This mirrors the existing additive behavior.
      if (!raw) continue;

      if (spec.numeric) {
        const parsed = numberOrNull_(raw);
        if (parsed === null) continue;
        fields[spec.key] = parsed;
      } else {
        fields[spec.key] = raw;
      }
    }

    if (!Object.keys(fields).length) continue;

    const timeText = String(row[1] || "").trim();
    patches.push({
      rowIndex: rowIndex,
      measurementId: measurementId_(parsedDate, timeText),
      date: String(row[0] || "").trim(),
      time: timeText,
      fields: fields
    });
  }
  return patches;
}

function normalizeLabel_(text) {
  return String(text || "")
    .replace(/[:?？׃\-–—"'״׳]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function findLabel_(values, labels) {
  const wanted = labels.map(normalizeLabel_);
  for (let r = 0; r < values.length; r++) {
    for (let c = 0; c < (values[r] || []).length; c++) {
      if (wanted.indexOf(normalizeLabel_(values[r][c])) !== -1) return { row: r, col: c };
    }
  }
  return null;
}

function findEmptyCheckbox_(sheet, values) {
  const empty = findLabel_(values, ["ריק"]);
  if (!empty) return null;

  const firstRow = Math.max(1, empty.row - 1);
  const firstCol = Math.max(1, empty.col - 1);
  const lastRow = Math.min(sheet.getMaxRows(), empty.row + 4);
  const lastCol = Math.min(sheet.getMaxColumns(), empty.col + 4);
  const height = Math.max(1, lastRow - firstRow + 1);
  const width = Math.max(1, lastCol - firstCol + 1);
  const validations = sheet.getRange(firstRow, firstCol, height, width).getDataValidations();

  let best = null;
  let bestDistance = Infinity;
  for (let r = 0; r < validations.length; r++) {
    for (let c = 0; c < validations[r].length; c++) {
      const rule = validations[r][c];
      if (!rule || rule.getCriteriaType() !== SpreadsheetApp.DataValidationCriteria.CHECKBOX) continue;
      const row = firstRow + r;
      const col = firstCol + c;
      const distance = Math.abs((row - 1) - empty.row) + Math.abs((col - 1) - empty.col);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { row: row, col: col };
      }
    }
  }
  return best;
}

function packagingTargets_(sheet, values) {
  return packagingFieldTargets_(sheet, values).map(function (target) {
    return { row: target.row, col: target.col };
  });
}

function packagingFieldTargets_(sheet, values) {
  const kegs = findLabel_(values, ["חביות"]);
  const crates = findLabel_(values, ["ארגזים"]);
  const total = findLabel_(values, ['סה"כ', "סהכ"]);
  const shrinkage = findLabel_(values, ["פחת"]);
  const checkbox = findEmptyCheckbox_(sheet, values);

  return [
    kegs ? { key: "kegs", row: kegs.row + 2, col: kegs.col + 1, type: "number" } : null,
    crates ? { key: "crates", row: crates.row + 2, col: crates.col + 1, type: "number" } : null,
    total ? { key: "totalLiters", row: total.row + 1, col: total.col + 2, type: "number" } : null,
    shrinkage ? { key: "shrinkagePercent", row: shrinkage.row + 1, col: shrinkage.col + 2, type: "percent" } : null,
    checkbox ? { key: "isEmpty", row: checkbox.row, col: checkbox.col, type: "checkbox" } : null
  ].filter(Boolean);
}

function editedPackagingPatch_(event, sheet, values) {
  const range = event && event.range;
  if (!range || range.getSheet().getSheetId() !== sheet.getSheetId()) return {};

  const firstRow = range.getRow();
  const lastRow = range.getLastRow();
  const firstCol = range.getColumn();
  const lastCol = range.getLastColumn();
  const result = {};

  packagingFieldTargets_(sheet, values).forEach(function (target) {
    if (target.row < firstRow || target.row > lastRow || target.col < firstCol || target.col > lastCol) {
      return;
    }

    if (target.type === "checkbox") {
      const value = sheet.getRange(target.row, target.col).getValue();
      result[target.key] = value === true || String(value).trim().toUpperCase() === "TRUE";
      return;
    }

    const raw = String(
      values[target.row - 1] && values[target.row - 1][target.col - 1] != null
        ? values[target.row - 1][target.col - 1]
        : ""
    ).trim();
    // Empty packaging cells also keep the previous Firestore value.
    if (!raw) return;

    const parsed = target.type === "percent" ? percentOrNull_(raw) : numberOrNull_(raw);
    if (parsed !== null) result[target.key] = parsed;
  });

  return result;
}

function readPackagingFromValues_(sheet, values) {
  const result = {};
  const kegs = findLabel_(values, ["חביות"]);
  const crates = findLabel_(values, ["ארגזים"]);
  const total = findLabel_(values, ['סה"כ', "סהכ"]);
  const shrinkage = findLabel_(values, ["פחת"]);

  if (kegs && values[kegs.row + 1]) result.kegs = numberOrNull_(values[kegs.row + 1][kegs.col]);
  if (crates && values[crates.row + 1]) result.crates = numberOrNull_(values[crates.row + 1][crates.col]);
  if (total && values[total.row]) result.totalLiters = numberOrNull_(values[total.row][total.col + 1]);
  if (shrinkage && values[shrinkage.row]) result.shrinkagePercent = percentOrNull_(values[shrinkage.row][shrinkage.col + 1]);

  const checkbox = findEmptyCheckbox_(sheet, values);
  if (checkbox) {
    const value = sheet.getRange(checkbox.row, checkbox.col).getValue();
    result.isEmpty = value === true || String(value).trim().toUpperCase() === "TRUE";
  }
  return result;
}

function commitPartialCellarUpdate_(tankNumber, batchNumber, currentData, measurementPatches) {
  const root = "projects/" + FIREBASE_PROJECT_ID + "/databases/(default)/documents/";
  const revision = Utilities.getUuid();
  const currentFields = {};
  const currentPaths = [];
  const patches = measurementPatches || [];

  Object.keys(currentData || {}).forEach(function (key) {
    const value = currentData[key];
    if (value === undefined || value === null) return;
    currentFields[key] = toFirestoreValue_(value);
    currentPaths.push("currentData." + key);
  });

  const fermentorFields = {
    updatedAt: { timestampValue: new Date().toISOString() }
  };
  const fermentorMask = ["updatedAt"];

  if (currentPaths.length) {
    fermentorFields.currentData = { mapValue: { fields: currentFields } };
    Array.prototype.push.apply(fermentorMask, currentPaths);
  }
  if (patches.length) {
    fermentorFields.measurementsRevision = { stringValue: revision };
    fermentorMask.push("measurementsRevision");
  }

  const writes = [{
    update: { name: root + "fermentors/" + encodeURIComponent(tankNumber), fields: fermentorFields },
    updateMask: { fieldPaths: fermentorMask },
    currentDocument: { exists: true }
  }];

  if (batchNumber) {
    patches.forEach(function (patch) {
      if (!patch || !patch.measurementId || !patch.fields || !Object.keys(patch.fields).length) return;

      const measurement = {
        date: patch.date,
        time: patch.time
      };
      Object.keys(patch.fields).forEach(function (key) {
        measurement[key] = patch.fields[key];
      });

      const fields = {};
      Object.keys(measurement).forEach(function (key) {
        if (measurement[key] === undefined || measurement[key] === null) return;
        fields[key] = toFirestoreValue_(measurement[key]);
      });

      writes.push({
        update: {
          name: root + "brews/" + encodeURIComponent(batchNumber) +
            "/measurements/" + encodeURIComponent(patch.measurementId),
          fields: fields
        },
        updateMask: { fieldPaths: Object.keys(fields) }
      });
    });
  }

  const response = UrlFetchApp.fetch(
    "https://firestore.googleapis.com/v1/projects/" + FIREBASE_PROJECT_ID +
      "/databases/(default)/documents:commit",
    {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
      payload: JSON.stringify({ writes: writes }),
      muteHttpExceptions: true
    }
  );
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    throw new Error("Firestore commit failed: " + response.getResponseCode() + " " + response.getContentText());
  }
}

function parseIsraeliDate_(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!match) return null;
  let year = Number(match[3]);
  if (year < 100) year += 2000;
  const date = new Date(year, Number(match[2]) - 1, Number(match[1]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function measurementId_(date, timeText) {
  const day = Utilities.formatDate(date, "Asia/Jerusalem", "yyyy-MM-dd");
  const time = String(timeText || "").trim();
  const match = time.match(/^(\d{1,2}):(\d{2})/);
  return match ? day + "_" + ("0" + Number(match[1])).slice(-2) + match[2] : day;
}

function numberOrNull_(value) {
  const text = String(value == null ? "" : value).trim().replace(",", ".");
  if (!text) return null;
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isFinite(number) ? number : null;
}

function percentOrNull_(value) {
  const n = numberOrNull_(value);
  if (n === null) return null;
  return String(value || "").indexOf("%") !== -1 ? n : (n <= 1 ? n * 100 : n);
}

function firestoreFieldsToObject_(fields) {
  const result = {};
  Object.keys(fields || {}).forEach(function (key) {
    result[key] = fromFirestoreValue_(fields[key]);
  });
  return result;
}

function fromFirestoreValue_(value) {
  if (!value) return null;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.integerValue !== undefined) return Number(value.integerValue);
  if (value.doubleValue !== undefined) return Number(value.doubleValue);
  if (value.booleanValue !== undefined) return value.booleanValue;
  if (value.timestampValue !== undefined) return value.timestampValue;
  if (value.nullValue !== undefined) return null;
  if (value.mapValue) return firestoreFieldsToObject_(value.mapValue.fields || {});
  if (value.arrayValue) return (value.arrayValue.values || []).map(fromFirestoreValue_);
  return null;
}

function toFirestoreValue_(value) {
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
