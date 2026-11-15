/*
 * Fermentation incubator reconciliation, piggybacking on existing cellar
 * maintenance. No Firestore GETs: the active-tank list is the existing cycle
 * snapshot. Historical sheets are discovered by recent Drive metadata hourly,
 * then opened only when their modification revision changes.
 */
var WFR_SHEET_REVISION_PREFIX_ = "wfr_sheet_revision_v1:";
var WFR_MANIFEST_PREFIX_ = "wfr_sheet_events_v2:";

function wfrReadManifest_(props, sheetId) {
  try {
    var parsed = JSON.parse(props.getProperty(WFR_MANIFEST_PREFIX_ + sheetId) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    throw new Error("Warm test manifest is invalid; cannot safely reconcile deletions");
  }
}

function wfrRememberWrittenTest_(sheetId, requestId) {
  // Called only AFTER a successful Sheet write. Register the same test ID
  // already persisted by the browser; a later Sheet deletion can reverse it
  // even if the first maintenance pass never happened.
  if (!requestId) return;
  var props = PropertiesService.getScriptProperties();
  var manifest = wfrReadManifest_(props, sheetId);
  if (!Object.prototype.hasOwnProperty.call(manifest, requestId)) {
    manifest[requestId] = null; // Unknown Sheet fingerprint until first scan.
    props.setProperty(WFR_MANIFEST_PREFIX_ + sheetId, JSON.stringify(manifest));
  }
}

function wfrFingerprint_(event) {
  return JSON.stringify([event.plato, event.pH, event.recordedAt,
    event.packaged, event.coolingPlato, event.source]);
}
var WFR_LAST_DISCOVERY_KEY_ = "wfr_recent_sheet_discovery_v1";
var WFR_DISCOVERY_INTERVAL_MS_ = 60 * 60 * 1000;
var WFR_DISCOVERY_LOOKBACK_DAYS_ = 14;
var WFR_MAX_SHEET_READS_PER_CYCLE_ = 24;

function wfrNum_(raw, max) {
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  var value = Number(String(raw).trim().replace(",", "."));
  return isFinite(value) && value >= 0 && value <= max ? value : null;
}

function wfrParseNote_(raw) {
  var note = String(raw || "").trim();
  if (!note) return null;
  // One physical Sheet row can contain several independent cellar actions.
  // Keep pH tied to the SAME note segment as the warm-incubator result.
  var sections = note.split(/[|\n]/);
  for (var i = 0; i < sections.length; i++) {
    var section = sections[i].trim();
    var marker = /בדיקת\s+תסיסה\s+חמה/i.exec(section);
    if (!marker) continue;
    var after = section.slice(marker.index + marker[0].length);
    // "בדיקת תסיסה חמה על 2.6 p" (1612) and
    // "בדיקת תסיסה חמה, סוכר 4.1°" (1606) are both valid.
    var platoMatch = /(?:סוכר|פלאטו|על|תוצאה|לאחר\s+אריזה)\s*[:=]?\s*(\d{1,2}(?:[.,]\d{1,3})?)/i.exec(after) ||
      /^\s*[:=,\-]?\s*(\d{1,2}(?:[.,]\d{1,3})?)\s*(?:°?\s*[pP]|°)/.exec(after);
    if (!platoMatch) continue; // E.g. "נלקחה בדיקת תסיסה חמה לשייקר".
    var plato = wfrNum_(platoMatch[1], 40);
    if (plato === null) continue;
    var phMatch = /\bp\s*h\s*[:=]?\s*(\d{1,2}(?:[.,]\d{1,3})?)/i.exec(section);
    var ph = phMatch ? wfrNum_(phMatch[1], 14) : null;
    var receipt = /\[בדיקת-תסיסה:([a-zA-Z0-9_-]{8,120})\]/.exec(section);
    return {
      plato: plato, pH: ph, note: section,
      receiptId: receipt ? receipt[1] : null,
      explicitlyPackaged: /לאחר\s+אריזה/.test(section)
    };
  }
  return null;
}

function wfrCoolingPlato_(values, from, through) {
  var lastPlato = null;
  var atCooling = null;
  for (var r = from; r <= through; r++) {
    var row = values[r] || [];
    var measured = wfrNum_(String(row[2] || "").replace(/°\s*P/i, "").trim(), 40);
    if (measured !== null) lastPlato = measured;
    var parts = String(row[7] || "").split(/[|\n]/);
    if (parts.some(function (part) {
      return /^(?:קירור(?:$|\s+מיכל|\s+ל\s*\d)|התחלת\s+קירור|(?:המיכל\s+)?הועבר\s+לקירור|חזרה\s+לקירור)/.test(part.trim());
    })) atCooling = lastPlato;
  }
  return atCooling;
}

function wfrFermentationHeader_(values) {
  for (var i = 0; i < values.length; i++) {
    var row = values[i] || [];
    var a = String(row[0] || "").trim();
    var b = String(row[1] || "").trim();
    var c = String(row[2] || "").trim();
    var d = String(row[3] || "").trim();
    // The fermentation log is distinct from earlier brewing tables.
    if (a === "תאריך" && b === "שעה" && c.indexOf("סוכר") !== -1 &&
        d.indexOf("טמפרטורה") !== -1) return i;
  }
  return -1;
}

function wfrSheetEvents_(values, sheetId, batchNumber) {
  var headerRow = wfrFermentationHeader_(values);
  if (headerRow < 0) return [];
  var events = [];
  for (var i = headerRow + 1; i < values.length; i++) {
    var row = values[i] || [];
    var date = parseIsraeliDate(String(row[0] || "").trim());
    if (!date || isNaN(date.getTime())) continue;
    var test = wfrParseNote_(row[7]);
    if (!test) continue;
    var clockMatch = /^(\d{1,2}):(\d{2})$/.exec(String(row[1] || "").trim());
    var hour = clockMatch ? Number(clockMatch[1]) : 12;
    var minute = clockMatch ? Number(clockMatch[2]) : 0;
    if (hour > 23 || minute > 59) continue;
    date.setHours(hour, minute, 0, 0);
    var dateText = Utilities.formatDate(date, "Asia/Jerusalem", "dd/MM/yyyy");
    var timeText = clockMatch ? (String(hour).padStart(2, "0") + ":" + clockMatch[2]) : null;
    var identity = sheetId + "|" + dateText + "|" + (timeText || "") + "|" + test.note;
    var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, identity, Utilities.Charset.UTF_8);
    var hex = digest.map(function (b) { return ("0" + ((b + 256) % 256).toString(16)).slice(-2); }).join("");
    var eventId = test.receiptId || ("sheet-" + hex.slice(0, 32));
    var previouslyPackaged = values.slice(headerRow + 1, i).some(function (candidate) {
      return /הורדת\s+[\d.,]+[^|\n]*(?:בקבוקים|חביות)/.test(String((candidate || [])[7] || ""));
    });
    events.push({
      eventId: eventId,
      requestId: test.receiptId || null,
      plato: test.plato,
      pH: test.pH,
      coolingPlato: wfrCoolingPlato_(values, headerRow + 1, i),
      recordedAt: date.toISOString(),
      recordedDate: dateText,
      recordedTime: timeText,
      source: test.receiptId ? "app-sheet" : "sheet-reconciliation",
      sheetRow: i + 1,
      packaged: test.explicitlyPackaged || previouslyPackaged,
      batchNumber: String(batchNumber),
      sheetUrl: "https://docs.google.com/spreadsheets/d/" + sheetId + "/edit",
      tankNumber: String((values[0] || [])[3] || "") || null,
      inTank: false
    });
  }
  return events;
}

function wfrCommitEvents_(projectId, changedEvents, activeEntry, deletedIds, visibleEvents, batchNumber) {
  deletedIds = deletedIds || [];
  visibleEvents = visibleEvents || changedEvents;
  if (!changedEvents.length && !deletedIds.length) return 0;
  var batch = String(batchNumber || (changedEvents[0] || visibleEvents[0] || {}).batchNumber || "");
  if (!/^\d+$/.test(batch)) throw new Error("Warm test reconciliation batch missing");
  var root = "projects/" + projectId + "/databases/(default)/documents/";
  var writes = changedEvents.map(function (event) {
    return {
      update: {
        name: root + "brews/" + encodeURIComponent(event.batchNumber) +
          "/warmFermentationTests/" + encodeURIComponent(event.eventId),
        fields: toFirestoreFields(event)
      },
      updateMask: { fieldPaths: Object.keys(event) }
    };
  });
  deletedIds.forEach(function (id) {
    writes.push({
      delete: root + "brews/" + encodeURIComponent(batch) +
        "/warmFermentationTests/" + encodeURIComponent(id)
    });
  });

  var active = activeEntry && Number(activeEntry.data.action) === 1 &&
    String(activeEntry.data.batchNumber || "").replace(/^#/, "") === batch;
  var latest = visibleEvents.slice().sort(function (a, b) {
    return a.recordedAt.localeCompare(b.recordedAt);
  }).pop() || null;
  var former = active ? activeEntry.data.warmFermentationTest : null;
  var formerId = former ? String(former.requestId || former.eventId || "") : "";
  var removedCurrent = formerId && deletedIds.indexOf(formerId) !== -1;
  var changedCurrent = formerId && changedEvents.some(function (event) {
    return event.eventId === formerId;
  });
  // A newer in-app test may not have reached Sheets yet: never overwrite it
  // with an older Sheet snapshot unless THAT specific test was removed.
  var isNewer = latest && (!former || !former.recordedAt ||
    latest.recordedAt > String(former.recordedAt));
  var useLatest = latest && (removedCurrent || isNewer ||
    (changedCurrent && latest.eventId === formerId));
  var clearCurrent = removedCurrent && !latest;
  var updateActive = active && activeEntry.updateTime && (useLatest || clearCurrent);
  if (updateActive) {
    var docName = root + "fermentors/" + encodeURIComponent(activeEntry.id);
    if (useLatest) {
      var patch = {
        warmFermentationTest: latest,
        warmFermentationTestUpdatedAt: new Date()
      };
      writes.push({
        update: {name: docName, fields: toFirestoreFields(patch)},
        updateMask: {fieldPaths: Object.keys(patch)},
        currentDocument: {updateTime: activeEntry.updateTime}
      });
    } else {
      writes.push({
        update: {name: docName, fields: {}},
        updateMask: {fieldPaths: ["warmFermentationTest", "warmFermentationTestUpdatedAt"]},
        currentDocument: {updateTime: activeEntry.updateTime}
      });
    }
  }
  var response = UrlFetchApp.fetch(
    "https://firestore.googleapis.com/v1/projects/" + projectId +
      "/databases/(default)/documents:commit", {
      method: "post", contentType: "application/json",
      headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
      payload: JSON.stringify({ writes: writes }), muteHttpExceptions: true
    });
  var status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    throw new Error("Warm fermentation reconciliation commit HTTP " + status +
      " " + response.getContentText().slice(0, 250));
  }
  if (updateActive) {
    if (useLatest) activeEntry.data.warmFermentationTest = latest;
    else delete activeEntry.data.warmFermentationTest;
    activeEntry.updateTime = null;
  }
  if (FC_CYCLE_CONTEXT_ && FC_CYCLE_CONTEXT_.io) {
    FC_CYCLE_CONTEXT_.io.firestoreWrites += writes.length;
    FC_CYCLE_CONTEXT_.io.warmTestWrites =
      (FC_CYCLE_CONTEXT_.io.warmTestWrites || 0) + writes.length;
  }
  return writes.length;
}

function wfrReconcileSheet_(projectId, sheetUrl, batchNumber, activeEntry, knownRevision) {
  var sheetId = extractSpreadsheetId(sheetUrl);
  var key = WFR_SHEET_REVISION_PREFIX_ + sheetId;
  var props = PropertiesService.getScriptProperties();
  var revision = String(knownRevision || DriveApp.getFileById(sheetId).getLastUpdated().getTime());
  if (props.getProperty(key) === revision) return { skipped: true, reason: "revision_unchanged" };
  var snapshot = fcSheetSnapshot_(sheetUrl);
  var sheetBatch = String(((snapshot.values[0] || [])[5]) || "").replace(/^#/, "").trim();
  if (!/^\d+$/.test(sheetBatch) || (batchNumber && sheetBatch !== String(batchNumber).replace(/^#/, ""))) {
    throw new Error("Warm test Sheet batch/header mismatch " + sheetId);
  }
  var events = wfrSheetEvents_(snapshot.values, sheetId, sheetBatch);
  var manifest = wfrReadManifest_(props, sheetId);
  var current = {};
  events.forEach(function (event) {
    current[event.eventId] = wfrFingerprint_(event);
  });
  var deleted = Object.keys(manifest).filter(function (id) {
    return !Object.prototype.hasOwnProperty.call(current, id);
  });
  var pending = events.filter(function (event) {
    var old = manifest[event.eventId];
    return !Object.prototype.hasOwnProperty.call(manifest, event.eventId) ||
      (old !== null && old !== current[event.eventId]);
  });
  // The commit contains additions, edits, deletions and an active snapshot
  // correction atomically. Never write an empty batch or read Firestore here.
  if (pending.length || deleted.length) {
    wfrCommitEvents_(projectId, pending, activeEntry, deleted, events, sheetBatch);
  }
  // The manifest and revision move forward ONLY after Firestore succeeded.
  if (Object.keys(current).length) props.setProperty(WFR_MANIFEST_PREFIX_ + sheetId, JSON.stringify(current));
  else props.deleteProperty(WFR_MANIFEST_PREFIX_ + sheetId);
  props.setProperty(key, revision);
  return { seen: events.length, wrote: pending.length, removed: deleted.length, skipped: false };
}

function wfrRecentSheetsMaintenance_(projectId, fermentors, now) {
  var props = PropertiesService.getScriptProperties();
  var current = now || new Date();
  var last = Number(props.getProperty(WFR_LAST_DISCOVERY_KEY_) || 0);
  if (current.getTime() - last < WFR_DISCOVERY_INTERVAL_MS_) return { due: false };
  // One Drive metadata query hourly (no Firestore queries) is enough to
  // discover manual notes written AFTER an old batch left its fermentor.
  var since = new Date(current.getTime() - WFR_DISCOVERY_LOOKBACK_DAYS_ * 86400000).toISOString();
  var listing = Drive.Files.list({
    q: "'" + BREW_FOLDER_ID + "' in parents and trashed = false" +
      " and mimeType = 'application/vnd.google-apps.spreadsheet'" +
      " and modifiedTime > '" + since + "'",
    orderBy: "modifiedTime desc",
    pageSize: 100,
    fields: "nextPageToken,files(id,name,modifiedTime)"
  });
  var files = listing.files || [];
  var activeByBatch = {};
  fermentors.forEach(function (row) {
    var batch = String(row.data.batchNumber || "").replace(/^#/, "");
    if (Number(row.data.action) === 1 && batch) activeByBatch[batch] = row;
  });
  var seen = 0, reconciled = 0, errors = 0;
  for (var i = 0; i < files.length && seen < WFR_MAX_SHEET_READS_PER_CYCLE_; i++) {
    var file = files[i];
    var revision = String(new Date(file.modifiedTime).getTime());
    var key = WFR_SHEET_REVISION_PREFIX_ + file.id;
    if (props.getProperty(key) === revision) continue;
    try {
      var snap = fcSheetSnapshot_(file.id);
      var batch = String((snap.values[0] || [])[5] || "").replace(/^#/, "").trim();
      if (!/^\d+$/.test(batch)) { props.setProperty(key, revision); continue; }
      wfrReconcileSheet_(projectId, file.id, batch, activeByBatch[batch] || null, revision);
      seen++;
      reconciled++;
    } catch (error) {
      seen++;
      errors++;
      Logger.log("Warm test Sheet reconciliation deferred " + file.id + ": " + error.message);
    }
  }
  props.setProperty(WFR_LAST_DISCOVERY_KEY_, String(current.getTime()));
  return { due: true, candidates: files.length, examined: seen, reconciled: reconciled, errors: errors };
}
