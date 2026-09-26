const FIREBASE_PROJECT_ID = "fermenter-dashboard-bada3";
const CELLAR_LISTENER_HANDLER = "cellarSheetOnEdit";
const CELLAR_LISTENER_MAP_PREFIX = "cellar_listener:";
const CELLAR_LISTENER_SECRET_PROPERTY = "CELLAR_LISTENER_SECRET";

function doPost(e) {
  const payload = parseJsonBody_(e);
  assertSecret_(payload.secret);

  const action = String(payload.action || "").trim();
  if (action === "add") return jsonOutput_(addCellarListener_(payload));
  if (action === "remove") return jsonOutput_(removeCellarListener_(payload));
  if (action === "status") return jsonOutput_(cellarListenerStatus_());

  throw new Error("Unsupported action: " + action);
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

function addCellarListener_(payload) {
  const spreadsheetId = extractSpreadsheetId_(payload.sheetUrl || payload.spreadsheetId);
  const tankNumber = String(payload.tankNumber || "").trim();
  if (!spreadsheetId) throw new Error("Missing sheetUrl/spreadsheetId");
  if (!tankNumber) throw new Error("Missing tankNumber");

  const props = PropertiesService.getScriptProperties();
  props.setProperty(listenerMapKey_(spreadsheetId), JSON.stringify({
    spreadsheetId: spreadsheetId,
    sheetUrl: String(payload.sheetUrl || ""),
    tankNumber: tankNumber,
    batchNumber: String(payload.batchNumber || "").replace("#", "").trim(),
    updatedAt: new Date().toISOString()
  }));

  const matches = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === CELLAR_LISTENER_HANDLER &&
      triggerSourceId_(trigger) === spreadsheetId;
  });

  matches.slice(1).forEach(function (trigger) {
    ScriptApp.deleteTrigger(trigger);
  });

  let installed = false;
  if (!matches.length) {
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
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (
      trigger.getHandlerFunction() === CELLAR_LISTENER_HANDLER &&
      triggerSourceId_(trigger) === spreadsheetId
    ) {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    }
  });

  PropertiesService.getScriptProperties().deleteProperty(listenerMapKey_(spreadsheetId));
  return { success: true, action: "remove", spreadsheetId: spreadsheetId, removed: removed };
}

function cellarListenerStatus_() {
  const triggers = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === CELLAR_LISTENER_HANDLER;
  });
  return {
    success: true,
    listeners: triggers.map(function (trigger) {
      return { spreadsheetId: triggerSourceId_(trigger) };
    }),
    count: triggers.length
  };
}

function cellarSheetOnEdit(event) {
  if (!event || !event.source) return;
  const spreadsheetId = String(event.source.getId() || "").trim();
  if (!spreadsheetId) return;

  try {
    const props = PropertiesService.getScriptProperties();
    const raw = props.getProperty(listenerMapKey_(spreadsheetId));
    if (!raw) {
      removeCellarListener_({ spreadsheetId: spreadsheetId });
      return;
    }

    const mapping = JSON.parse(raw);
    const fermentor = getFermentor_(mapping.tankNumber);
    if (!fermentor || Number(fermentor.action) !== 1 ||
        extractSpreadsheetId_(fermentor.sheetUrl) !== spreadsheetId) {
      removeCellarListener_({ spreadsheetId: spreadsheetId });
      return;
    }

    syncEditedSheetToFirestore_(event.source, fermentor, mapping.tankNumber);
  } catch (error) {
    console.log(
      "cellarSheetOnEdit failed for " + spreadsheetId + ": " +
      (error && error.message ? error.message : error)
    );
  }
}

function getFermentor_(tankNumber) {
  const id = String(tankNumber || "").trim();
  if (!id) return null;
  const url = "https://firestore.googleapis.com/v1/projects/" + FIREBASE_PROJECT_ID +
    "/databases/(default)/documents/fermentors/" + encodeURIComponent(id);
  const response = UrlFetchApp.fetch(url, {
    method: "get",
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });
  if (response.getResponseCode() === 404) return null;
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    throw new Error("Fermentor read failed: " + response.getResponseCode() + " " + response.getContentText());
  }
  return firestoreFieldsToObject_((JSON.parse(response.getContentText()) || {}).fields || {});
}

function syncEditedSheetToFirestore_(spreadsheet, fermentor, tankNumber) {
  const sheet = spreadsheet.getSheets()[0];
  if (!sheet) throw new Error("Spreadsheet has no sheet");
  const values = sheet.getDataRange().getDisplayValues();

  const latest = latestFermentationMeasurement_(values);
  const packaging = readPackagingFromValues_(sheet, values);
  const currentData = {};

  if (latest) {
    Object.keys(latest).forEach(function (key) {
      if (key === "measurementId") return;
      if (latest[key] !== undefined) currentData[key] = latest[key];
    });
  }
  Object.keys(packaging).forEach(function (key) {
    const value = packaging[key];
    if (value !== undefined && value !== null) currentData[key] = value;
  });

  if (!Object.keys(currentData).length) return;

  const batch = String(fermentor.batchNumber || "").replace("#", "").trim();
  commitCurrentDataAndMeasurement_(String(tankNumber), batch, currentData, latest);
}

function latestFermentationMeasurement_(values) {
  let header = -1;
  for (let r = 0; r < values.length; r++) {
    const row = values[r] || [];
    const labels = row.map(function (cell) { return String(cell || "").trim(); });
    if (
      labels.indexOf("תאריך") !== -1 &&
      labels.indexOf("שעה") !== -1 &&
      labels.indexOf("טמפרטורה") !== -1
    ) {
      header = r;
      break;
    }
  }
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

function readPackagingFromValues_(sheet, values) {
  const result = {};
  const kegs = findLabel_(values, ["חביות"]);
  const crates = findLabel_(values, ["ארגזים"]);
  const total = findLabel_(values, ['סה"כ', "סהכ"]);
  const shrinkage = findLabel_(values, ["פחת"]);
  const empty = findLabel_(values, ["ריק"]);

  if (kegs && values[kegs.row + 1]) result.kegs = numberOrNull_(values[kegs.row + 1][kegs.col]);
  if (crates && values[crates.row + 1]) result.crates = numberOrNull_(values[crates.row + 1][crates.col]);
  if (total && values[total.row]) result.totalLiters = numberOrNull_(values[total.row][total.col + 1]);
  if (shrinkage && values[shrinkage.row]) result.shrinkagePercent = percentOrNull_(values[shrinkage.row][shrinkage.col + 1]);

  if (empty) {
    const maxRow = Math.min(sheet.getMaxRows(), empty.row + 4);
    const maxCol = Math.min(sheet.getMaxColumns(), empty.col + 4);
    const r0 = Math.max(1, empty.row - 1);
    const c0 = Math.max(1, empty.col - 1);
    const validations = sheet.getRange(r0, c0, Math.max(1, maxRow - r0 + 1), Math.max(1, maxCol - c0 + 1)).getDataValidations();
    outer:
    for (let r = 0; r < validations.length; r++) {
      for (let c = 0; c < validations[r].length; c++) {
        const rule = validations[r][c];
        if (rule && rule.getCriteriaType() === SpreadsheetApp.DataValidationCriteria.CHECKBOX) {
          const value = sheet.getRange(r0 + r, c0 + c).getValue();
          result.isEmpty = value === true || String(value).toUpperCase() === "TRUE";
          break outer;
        }
      }
    }
  }

  return result;
}

function commitCurrentDataAndMeasurement_(tankNumber, batchNumber, currentData, latest) {
  const root = "projects/" + FIREBASE_PROJECT_ID + "/databases/(default)/documents/";
  const revision = Utilities.getUuid();
  const currentFields = {};
  const currentPaths = [];

  Object.keys(currentData).forEach(function (key) {
    if (currentData[key] === undefined) return;
    currentFields[key] = toFirestoreValue_(currentData[key]);
    currentPaths.push("currentData." + key);
  });

  const fermentorFields = {
    currentData: { mapValue: { fields: currentFields } },
    measurementsRevision: { stringValue: revision },
    updatedAt: { timestampValue: new Date().toISOString() }
  };
  const fermentorMask = currentPaths.concat(["measurementsRevision", "updatedAt"]);
  const writes = [{
    update: { name: root + "fermentors/" + encodeURIComponent(tankNumber), fields: fermentorFields },
    updateMask: { fieldPaths: fermentorMask },
    currentDocument: { exists: true }
  }];

  if (batchNumber && latest && latest.measurementId) {
    const measurement = {
      date: latest.date,
      time: latest.time,
      temp: latest.temp,
      plato: latest.plato,
      pressure: latest.pressure,
      carbonation: latest.carbonation,
      pH: latest.pH,
      notes: latest.notes
    };
    const fields = {};
    Object.keys(measurement).forEach(function (key) {
      fields[key] = toFirestoreValue_(measurement[key]);
    });
    writes.push({
      update: {
        name: root + "brews/" + encodeURIComponent(batchNumber) +
          "/measurements/" + encodeURIComponent(latest.measurementId),
        fields: fields
      },
      updateMask: { fieldPaths: Object.keys(measurement) }
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
  let match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
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
