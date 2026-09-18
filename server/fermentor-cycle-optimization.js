/*
FERMENTOR CYCLE OPTIMIZATION — replacement functions, 2026-09-09

התקנה:
1. גבה את פרויקט Apps Script לפני ההחלפה.
2. לכל פונקציה ברשימת REPLACE למטה: מחק את כל ההגדרות הישנות שלה
   מכל קובצי הפרויקט. לאחר מכן הדבק את הקובץ הזה בקובץ gs חדש.
   אין להשאיר פונקציות כפולות בקבצים (8), (2) או בקבצים אחרים.
3. פונקציות fc... והמשתנה FC_CYCLE_CONTEXT_ חדשים: הוסף אותם פעם אחת.
4. השאר את יתר פונקציות העזר והקבועים בפרויקט. זהו תיקון לפרויקט הקיים,
   לא פרויקט עצמאי. getAllFermentorsFromFirestore ו-runActionFlow_ נשארות.
5. אפשר להשאיר את הטריגר החודשי resetChangeCache כאיפוס יזום. השתמש
   במימוש המוגבל כאן, ששומר הגדרות אחרות. אחרי האיפוס צפויות כתיבות
   נוספות לאתחול זיהוי השינויים; הוא אינו מסביר איטיות בכל מחזור.
6. הפעל runFermentorCycle ידנית ובדוק לוגים. ההרצה הראשונה תכתוב מחדש
   מדידות/progress בגלל מרחב מפתחות חדש. השווה גם את ההרצה השנייה.
7. אין שינוי במנגנון חיפוש ACTION 5. הבעיות האפשריות בו אינן מטופלות כאן.

ACTIVE OWNERSHIP:
- runFermentorCycle / syncFermentorsFromSheets_ / extractBrew /
  readPackagingInfoFromSheet / updateFermentorDocument /
  writeLatestMeasurementIfChanged_ / resetChangeCache live here.
- extractBrewStageInfo and updateFermentorBrewProgress live ONLY in
  extractBrewStageInfo.js. The legacy implementations below were renamed
  deliberately so Apps Script cannot silently override the current versions.

BEHAVIOR:
- One first-sheet values snapshot per spreadsheet per cycle; fresh next cycle.
- A short lease prevents overlapping cycles WITHOUT holding ScriptLock for the
  complete 15–60 second run. User-initiated Sheet writes can therefore proceed.
- Standalone measurement/progress/reset calls still acquire the script lock.
- Fermentor comparison uses the already-fetched Firestore snapshot, not hashes.
- Field-level currentData masks preserve omitted fields without an extra GET.
  Null/missing protected packaging fields are omitted; explicit zero is written.
- Measurement/progress hashes are saved only after successful writes.
- Active measurement history is embedded once on the fermentor document as
  cellarState, using the same Sheet snapshot already read by the cycle. Clients
  can therefore calculate cellar health/stage without reading each batch
  measurements subcollection separately.
- Action flow receives successfully synchronized in-memory data.
- Timings include reads, measurements, packaging, action flow and each tank.
- Sheet date corrections update the cached cell. Other writers called inside the
  same execution must invalidate/update the snapshot if they edit sheet cells.
*/

var FC_CYCLE_CONTEXT_ = null;
const FC_CYCLE_LEASE_KEY_ = "fc_cycle_lease_v2";
const FC_CYCLE_LEASE_TTL_MS_ = 9 * 60 * 1000;

function fcTimed_(label, callback) {
  const started = Date.now();
  try { return callback(); }
  finally { Logger.log("TIMING " + label + ": " + ((Date.now() - started) / 1000).toFixed(3) + "s"); }
}

function fcWithScriptLock_(callback) {
  if (FC_CYCLE_CONTEXT_ && FC_CYCLE_CONTEXT_.lockHeld) return callback();
  const lock = LockService.getScriptLock();
  fcTimed_("lock wait", function () { lock.waitLock(30000); });
  try { return callback(); } finally { lock.releaseLock(); }
}

function fcAcquireCycleLease_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return null;
  try {
    const props = PropertiesService.getScriptProperties();
    const raw = props.getProperty(FC_CYCLE_LEASE_KEY_);
    if (raw) {
      try {
        const current = JSON.parse(raw);
        const age = Date.now() - Number(current.startedAt || 0);
        if (current.token && age >= 0 && age < FC_CYCLE_LEASE_TTL_MS_) {
          return null;
        }
      } catch (error) {
        Logger.log("Ignoring invalid cycle lease: " + error.message);
      }
    }
    const token = Utilities.getUuid();
    props.setProperty(FC_CYCLE_LEASE_KEY_, JSON.stringify({ token: token, startedAt: Date.now() }));
    return token;
  } finally {
    lock.releaseLock();
  }
}

function fcReleaseCycleLease_(token) {
  if (!token) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    Logger.log("Cycle lease cleanup deferred; stale lease will expire automatically.");
    return;
  }
  try {
    const props = PropertiesService.getScriptProperties();
    const raw = props.getProperty(FC_CYCLE_LEASE_KEY_);
    if (!raw) return;
    try {
      const current = JSON.parse(raw);
      if (current.token === token) props.deleteProperty(FC_CYCLE_LEASE_KEY_);
    } catch (error) {
      props.deleteProperty(FC_CYCLE_LEASE_KEY_);
    }
  } finally {
    lock.releaseLock();
  }
}

function fcSheetSnapshot_(sheetUrl) {
  const id = extractSpreadsheetId(sheetUrl);
  const context = FC_CYCLE_CONTEXT_;
  if (context && context.sheets.has(id)) return context.sheets.get(id);
  const snapshot = fcTimed_("sheet read " + id, function () {
    const ss = SpreadsheetApp.openById(id);
    const sheet = ss.getSheets()[0];
    if (!sheet) throw new Error("No first sheet: " + id);
    return { ss: ss, sheet: sheet, values: sheet.getDataRange().getDisplayValues() };
  });
  if (context) {
    context.sheets.set(id, snapshot);
    context.sheetReads++;
  }
  return snapshot;
}

function fcChangeState_(key, value) {
  key = "fc_success_v1:" + key;
  const props = PropertiesService.getScriptProperties();
  const context = FC_CYCLE_CONTEXT_;
  let previous;
  if (context) {
    if (!context.properties) context.properties = props.getProperties();
    previous = context.properties[key];
  } else {
    previous = props.getProperty(key);
  }
  const hash = computeHash_(value);
  return { key: key, hash: hash, changed: previous !== hash };
}

function fcMarkSuccess_(state) {
  PropertiesService.getScriptProperties().setProperty(state.key, state.hash);
  if (FC_CYCLE_CONTEXT_ && FC_CYCLE_CONTEXT_.properties) {
    FC_CYCLE_CONTEXT_.properties[state.key] = state.hash;
  }
}

function runFermentorCycle() {
  Logger.log("START FERMENTOR CYCLE");
  const started = Date.now();
  const leaseToken = fcAcquireCycleLease_();
  if (!leaseToken) {
    Logger.log("CYCLE SKIPPED: another fermentor cycle is already running.");
    return { skipped: true, reason: "cycle_lease_busy" };
  }
  FC_CYCLE_CONTEXT_ = { sheets: new Map(), sheetReads: 0, properties: null, lockHeld: false };
  try {
    const projectId = FIREBASE_PROJECT_ID;
    const fermentors = fcTimed_("fetch fermentors", function () {
      return getAllFermentorsFromFirestore(projectId);
    });
    Logger.log("Fermentors fetched once: " + fermentors.length);
    const syncStats = fcTimed_("sync total", function () {
      return syncFermentorsFromSheets_(projectId, fermentors);
    });
    const actionStats = fcTimed_("actions total", function () {
      return runActionFlow_(fermentors);
    });
    const duration = (Date.now() - started) / 1000;
    Logger.log("CYCLE FINISHED in " + duration.toFixed(3) + "s");
    Logger.log("Sheet snapshots read: " + FC_CYCLE_CONTEXT_.sheetReads);
    Logger.log("Sync -> " + JSON.stringify(syncStats));
    Logger.log("Action -> " + JSON.stringify(actionStats));
    return { durationSeconds: duration, fermentorsCount: fermentors.length,
      sheetReads: FC_CYCLE_CONTEXT_.sheetReads, sync: syncStats, action: actionStats };
  } finally {
    FC_CYCLE_CONTEXT_ = null;
    fcReleaseCycleLease_(leaseToken);
  }
}

function fcFermentorPayload_(fermentor) {
  const names = ["tankNumber", "tankStatus", "batchNumber", "beerStyle", "brewDate",
    "beerVolume", "sheetUrl", "uid", "startingPlato", "cellarState", "updatedAt"];
  const payload = {};
  names.forEach(function (name) {
    if (Object.prototype.hasOwnProperty.call(fermentor, name) && fermentor[name] !== undefined) {
      payload[name] = fermentor[name];
    }
  });
  const current = fermentor.currentData;
  const protectedFields = ["kegs", "crates", "totalLiters", "shrinkagePercent"];
  if (current && typeof current === "object" && !Array.isArray(current)) {
    const fields = {};
    Object.keys(current).forEach(function (name) {
      const value = current[name];
      if (value === undefined) return;
      if (protectedFields.indexOf(name) !== -1 && value === null) return;
      fields[name] = value;
    });
    if (Object.keys(fields).length) payload.currentData = fields;
  }
  return payload;
}

function fcPayloadMatches_(existing, payload) {
  return Object.keys(payload).every(function (name) {
    if (name === "currentData") {
      const current = existing.currentData || {};
      return Object.keys(payload.currentData).every(function (field) {
        return objectsEqual(current[field], payload.currentData[field]);
      });
    }
    if (name === "cellarState") {
      const previousState = existing.cellarState;
      const nextState = payload.cellarState;
      if (previousState == null || nextState == null) {
        return objectsEqual(previousState, nextState);
      }
      return previousState.signature === nextState.signature;
    }
    return objectsEqual(existing[name], payload[name]);
  });
}

function fcMergePayload_(existing, payload) {
  const merged = Object.assign({}, existing, payload);
  if (payload.currentData) {
    merged.currentData = Object.assign({}, existing.currentData || {}, payload.currentData);
  }
  return merged;
}

function syncFermentorsFromSheets_(projectId, fermentors) {
  const stats = { updated: 0, skipped: 0, errors: 0,
    latestMeasurementWrites: 0, measurementErrors: 0, packagingErrors: 0 };
  fermentors.forEach(function (entry) {
    fcTimed_("tank " + entry.id, function () {
      try {
        const sheetUrl = entry.data.sheetUrl;
        if (!sheetUrl) { stats.skipped++; return; }
        const brew = fcTimed_("extract brew " + entry.id, function () {
          return extractBrew(sheetUrl);
        });
        if (!brew || !brew.tankNumber) { stats.skipped++; return; }
        const next = {
          tankNumber: String(brew.tankNumber).trim(),
          tankStatus: brew.tankStatus === true || String(brew.tankStatus).trim().toUpperCase() === "TRUE",
          batchNumber: brew.batchNumber || null,
          beerStyle: brew.beerStyle || null,
          brewDate: brew.brewDate || null,
          beerVolume: brew.beerVolume == null ? null : brew.beerVolume,
          currentData: brew.currentData ? Object.assign({}, brew.currentData) : null,
          cellarState: brew.cellarState || null,
          sheetUrl: brew.sheetUrl || null,
          uid: entry.id,
          startingPlato: brew.startingPlato == null ? null : brew.startingPlato
        };
        const action = parseAction(entry.data.action);
        if (action !== null && action >= 3 && next.currentData) {
          try {
            const packaging = fcTimed_("packaging " + entry.id, function () {
              return readPackagingInfoFromSheet(sheetUrl);
            });
            if (packaging) Object.keys(packaging).forEach(function (name) {
              if (packaging[name] !== null && packaging[name] !== undefined) {
                next.currentData[name] = packaging[name];
              }
            });
          } catch (error) {
            stats.packagingErrors++;
            Logger.log("Packaging error tank " + entry.id + ": " + error.message);
          }
        }
        if (next.batchNumber) {
          try {
            const wrote = fcTimed_("latest measurement " + entry.id, function () {
              return writeLatestMeasurementIfChanged_(projectId, next.batchNumber, sheetUrl);
            });
            if (wrote) stats.latestMeasurementWrites++;
          } catch (error) {
            stats.measurementErrors++;
            Logger.log("Measurement error tank " + entry.id + ": " + error.message);
          }
        }
        const payload = fcFermentorPayload_(next);
        if (fcPayloadMatches_(entry.data, payload)) {
          stats.skipped++;
          return;
        }
        payload.updatedAt = new Date();
        fcTimed_("fermentor write " + entry.id, function () {
          updateFermentorDocument(projectId, entry.id, payload);
        });
        entry.data = fcMergePayload_(entry.data, payload);
        stats.updated++;
      } catch (error) {
        stats.errors++;
        Logger.log("Sync error tank " + entry.id + ": " + error.message);
      }
    });
  });
  return stats;
}

function readPackagingInfoFromSheet(sheetUrl) {
  if (!sheetUrl) return null;
  const values = fcSheetSnapshot_(sheetUrl).values;
  const result = { kegs: null, crates: null, totalLiters: null, shrinkagePercent: null };
  const kegs = findLabelCell(values, ["חביות"]);
  if (kegs && values[kegs.row + 1]) result.kegs = extractNumber(values[kegs.row + 1][kegs.col]);
  const crates = findLabelCell(values, ["ארגזים"]);
  if (crates && values[crates.row + 1]) result.crates = extractNumber(values[crates.row + 1][crates.col]);
  const total = findLabelCell(values, ['סה"כ', "סהכ"]);
  if (total && values[total.row]) result.totalLiters = extractNumber(values[total.row][total.col + 1]);
  const shrinkage = findLabelCell(values, ["פחת"]);
  if (shrinkage && values[shrinkage.row]) result.shrinkagePercent = extractNumber(values[shrinkage.row][shrinkage.col + 1]);
  return result;
}

function updateFermentorDocument(projectId, fermentorId, fermentor) {
  const payload = fcFermentorPayload_(fermentor);
  const masks = [];
  Object.keys(payload).forEach(function (name) {
    if (name === "currentData") {
      Object.keys(payload.currentData).forEach(function (field) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) throw new Error("Unsupported currentData field: " + field);
        masks.push("currentData." + field);
      });
    } else { masks.push(name); }
  });
  if (!masks.length) return;
  const url = "https://firestore.googleapis.com/v1/projects/" + projectId +
    "/databases/(default)/documents/fermentors/" + encodeURIComponent(fermentorId) + "?" +
    masks.map(function (path) { return "updateMask.fieldPaths=" + encodeURIComponent(path); }).join("&");
  const response = UrlFetchApp.fetch(url, {
    method: "patch", contentType: "application/json",
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({ fields: toFirestoreFields(payload) }), muteHttpExceptions: true
  });
  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error("Fermentor update failed: " + code + " " + response.getContentText());
  }
}

function resetChangeCache() {
  return fcWithScriptLock_(function () {
    const props = PropertiesService.getScriptProperties();
    const all = props.getProperties();
    let count = 0;
    Object.keys(all).forEach(function (key) {
      if (/^(fermentor:|packaging:|measurement:|brewProgress:|fc_success_v1:)/.test(key)) {
        props.deleteProperty(key);
        count++;
      }
    });
    if (FC_CYCLE_CONTEXT_) FC_CYCLE_CONTEXT_.properties = null;
    Logger.log("Cleared " + count + " change-detection keys only; other script properties preserved.");
  });
}

function fcBuildCellarState_(values, batchNumber) {
  const batch = String(batchNumber || "").replace("#", "").trim();
  if (!batch) return null;

  const headerRow = findRowContaining(values, "טמפרטורה");
  const canonicalByDay = {};

  if (headerRow !== -1) {
    for (let r = headerRow + 1; r < values.length; r++) {
      const dateText = String(values[r][0] || "").trim();
      const date = parseIsraeliDate(dateText);
      if (!date) continue;

      const hasAnyValue = values[r][2] || values[r][3] || values[r][4] ||
        values[r][5] || values[r][6] || values[r][7];
      if (!hasAnyValue) continue;

      const time = String(values[r][1] || "").trim();
      const measurementId = createMeasurementId(date, time);
      const day = String(measurementId || "").slice(0, 10);
      if (!measurementId || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;

      canonicalByDay[day] = {
        id: measurementId,
        date: dateText,
        time: time,
        temp: extractNumber(values[r][3]),
        plato: extractNumber(values[r][2]),
        pressure: extractNumber(values[r][4]),
        carbonation: extractNumber(values[r][6]),
        pH: extractNumber(values[r][5]),
        notes: String(values[r][7] || "").trim()
      };
    }
  }

  const rows = Object.keys(canonicalByDay)
    .sort()
    .map(function (day) { return canonicalByDay[day]; });
  const measurements = {};
  rows.forEach(function (measurement) {
    measurements[measurement.id] = measurement;
  });

  const cooled = rows.some(function (measurement) {
    return String(measurement.notes || "").includes("קירור");
  });
  const lastMeasurementId = rows.length ? rows[rows.length - 1].id : null;
  const signature = computeHash_({
    batchNumber: batch,
    cooled: cooled,
    rows: rows
  });

  return {
    version: 1,
    batchNumber: batch,
    cooled: cooled,
    measurementCount: rows.length,
    lastMeasurementId: lastMeasurementId,
    signature: signature,
    measurements: measurements
  };
}

function extractBrew(spreadSheetId) {
  if (!spreadSheetId) throw new Error("No Spreadsheet ID or URL was provided.");
  const snapshot = fcSheetSnapshot_(spreadSheetId);
  const ss = snapshot.ss;
  const values = snapshot.values;
  const brew = {
    batchNumber: null, beerStyle: null, brewDate: null, tankNumber: null,
    sheetUrl: ss.getUrl(), tankStatus: null, beerVolume: null,
    startingPlato: null, pasivationDate: null, cellarState: null,
    currentData: { date: null, temp: null, plato: null, pressure:null,
      carbonation: null, pH: null, notes: "" }
  };
  const batchHeader = values[0] || [];
  brew.batchNumber = String(batchHeader[5] || "").replace("#", "").trim() || null;
  brew.beerStyle = String(batchHeader[1] || "").trim() || null;
  brew.tankNumber = String(batchHeader[3] || "").trim() || null;
  brew.brewDate = String(batchHeader[7] || "").trim() || null;

  const fermentationHeader = findRowContaining(values, "דף תסיסה");
  if (fermentationHeader !== -1) {
    for (let r = fermentationHeader; r < Math.min(fermentationHeader + 6, values.length); r++) {
      for (let c = 0; c < values[r].length; c++) {
        const cell = String(values[r][c] || "").trim();
        if (cell === "אצווה:") {
          const batch = String(values[r][c + 1] || "").replace("#", "").trim();
          if (batch) brew.batchNumber = brew.batchNumber ? brew.batchNumber : batch;
        }
        if (cell === "סוג:") {
          const beerStyle = String(values[r][c + 1] || "").trim();
          brew.beerStyle = brew.beerStyle ? brew.beerStyle : beerStyle || null;
        }
        if (cell === "מספר מיכל:") {
          const tankNumber = String(values[r][c + 1] || "").trim();
          brew.tankNumber = brew.tankNumber ? brew.tankNumber : tankNumber || null;
        }
      }
    }
  }

  const brewDayRow = findRowContaining(values, "יום בישול");
  if (brewDayRow !== -1) {
    const col = findColumnContaining(values[brewDayRow], "יום בישול");
    if (col !== -1) {
      const brewDate = String(values[brewDayRow][col + 1] || "").trim();
      brew.brewDate = brew.brewDate ? brew.brewDate : brewDate || null;
    }
  }

  const volumeLocation = findCell(values, "נפח:");
  if (volumeLocation) brew.beerVolume = extractNumber(values[volumeLocation.row][volumeLocation.col + 1]);

  const statusLocation = findCell(values, "ריק?:");
  if (statusLocation) {
    const statusVal = values[statusLocation.row][statusLocation.col + 1];
    brew.tankStatus = String(statusVal || "").trim() || null;
  }

  const startingPlatoLocation = findCell(values, "סוכר תחילי");
  if (startingPlatoLocation) {
    const startingPlatoText = String(values[startingPlatoLocation.row][startingPlatoLocation.col + 1] || "").trim();
    if (startingPlatoText) {
      brew.startingPlato = extractNumber(startingPlatoText);
    } else {
      for (let z = 1; z <= startingPlatoLocation.row; z++) {
        const row = startingPlatoLocation.row - z;
        for (let c = 0; c < values[row].length; c++) {
          const cell = String(values[row][c] || "").trim();
          if (cell === "תחילת תסיסה") {
            const number = extractNumber(values[row][c + 1]);
            if (number !== null) brew.startingPlato = number;
            break;
          }
        }
        if (brew.startingPlato !== null) break;
      }
    }
  }

  brew.currentData = findLatestAvailableMeasurements(values);
  brew.cellarState = fcBuildCellarState_(values, brew.batchNumber);
  return brew;
}

function writeLatestMeasurementIfChanged_(projectId, batchId, sheetUrl) {
  return fcWithScriptLock_(function () {
    const values = fcSheetSnapshot_(sheetUrl).values;
    const headerRow = findRowContaining(values, "טמפרטורה");
    if (headerRow === -1) return false;
    for (let r = values.length - 1; r > headerRow; r--) {
      const dateText = String(values[r][0] || "").trim();
      const date = parseIsraeliDate(dateText);
      if (!date) continue;
      const hasAnyValue = values[r][2] || values[r][3] || values[r][4] ||
        values[r][5] || values[r][6] || values[r][7];
      if (!hasAnyValue) continue;
      const time = String(values[r][1] || "").trim();
      const measurement = {
        date: dateText, time: time,
        temp: extractNumber(values[r][3]), plato: extractNumber(values[r][2]),
        pressure: extractNumber(values[r][4]), carbonation: extractNumber(values[r][6]),
        pH: extractNumber(values[r][5]), notes: String(values[r][7] || "").trim()
      };
      const measurementId = createMeasurementId(date, time);
      const state = fcChangeState_("measurement:" + projectId + ":" + batchId + ":" + measurementId, measurement);
      if (!state.changed) return false;
      const docPath = "projects/" + projectId + "/databases/(default)/documents/brews/" +
        encodeURIComponent(batchId) + "/measurements/" + encodeURIComponent(measurementId);
      mrCommitMeasurement_(projectId, batchId, measurementId, measurement);
      fcMarkSuccess_(state);
      Logger.log("Wrote latest measurement immediately: " + docPath);
      return true;
    }
    return false;
  });
}

function mrTargets_(projectId, batchId) {
  var rows;
  if (typeof FC_CYCLE_CONTEXT_ !== "undefined" && FC_CYCLE_CONTEXT_) {
    rows = FC_CYCLE_CONTEXT_.measurementRevisionTargets;
    if (!rows) {
      rows = getAllFermentorsFromFirestore(projectId);
      FC_CYCLE_CONTEXT_.measurementRevisionTargets = rows;
    }
  } else {
    rows = getAllFermentorsFromFirestore(projectId);
  }
  var key = String(batchId).replace("#", "").trim();
  return rows.filter(function (row) {
    return String(row.data.batchNumber || "").replace("#", "").trim() === key;
  }).map(function (row) { return row.id; });
}

function mrCommitMeasurement_(projectId, batchId, measurementId, measurement, targets) {
  if (!targets) targets = mrTargets_(projectId, batchId);
  var root = "projects/" + projectId + "/databases/(default)/documents/";
  var token = Utilities.getUuid();
  var writes = [{
    update: {
      name: root + "brews/" + String(batchId).replace("#", "").trim() + "/measurements/" + measurementId,
      fields: toFirestoreFields(measurement)
    },
    updateMask: { fieldPaths: Object.keys(measurement) }
  }];
  targets.forEach(function (id) {
    writes.push({
      update: { name: root + "fermentors/" + id, fields: {
        measurementsRevision: { stringValue: token }
      }},
      updateMask: { fieldPaths: ["measurementsRevision"] },
      currentDocument: { exists: true }
    });
  });
  var response = UrlFetchApp.fetch("https://firestore.googleapis.com/v1/projects/" +
    projectId + "/databases/(default)/documents:commit", {
    method: "post", contentType: "application/json",
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({ writes: writes }), muteHttpExceptions: true
  });
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    throw new Error("Measurement + revision commit failed: " + response.getResponseCode() + " " + response.getContentText());
  }
}