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

REPLACE:
runFermentorCycle
syncFermentorsFromSheets_
writeLatestMeasurementIfChanged_
extractBrew
extractBrewStageInfo
readPackagingInfoFromSheet
updateFermentorDocument
updateFermentorBrewProgress
resetChangeCache

BEHAVIOR:
- One first-sheet values snapshot per spreadsheet per cycle; fresh next cycle.
- Shared script lock for the whole cycle, no nested measurement lock.
- Standalone measurement/progress/reset calls still acquire the script lock.
- Fermentor comparison uses the already-fetched Firestore snapshot, not hashes.
- Field-level currentData masks preserve omitted fields without an extra GET.
  Null/missing protected packaging fields are omitted; explicit zero is written.
- Measurement/progress hashes are saved only after successful writes.
- Action flow receives successfully synchronized in-memory data.
- Timings include reads, measurements, packaging, action flow and each tank.
- Sheet date corrections update the cached cell. Other writers called inside the
  same execution must invalidate/update the snapshot if they edit sheet cells.

Not executed against live Google Sheets/Firestore. Existing helper dependencies
and business parsing logic are retained. Remove duplicate definitions of other
shared functions (for example processAction0) separately if both old service
files are active. Keep just the intended current version.
*/

var FC_CYCLE_CONTEXT_ = null;

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
  // New namespace does not trust hashes saved by the old pre-write cache.
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
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    Logger.log("CYCLE SKIPPED: another execution holds the script lock.");
    return { skipped: true, reason: "script_lock_busy" };
  }
  FC_CYCLE_CONTEXT_ = { sheets: new Map(), sheetReads: 0, properties: null, lockHeld: true };
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
    lock.releaseLock();
  }
}

function fcFermentorPayload_(fermentor) {
  const names = ["tankNumber", "tankStatus", "batchNumber", "beerStyle", "brewDate",
    "beerVolume", "sheetUrl", "uid", "startingPlato", "updatedAt"];
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
  // A missing/null measurement object must not erase packaging or other fields.
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
        // Measurement change detection remains independent of fermentor changes.
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
        // Only publish new in-memory state after the write succeeded.
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


function extractBrew(spreadSheetId) {

  if (!spreadSheetId) {
    throw new Error(
      "No Spreadsheet ID or URL was provided."
    );
  }

  const snapshot = fcSheetSnapshot_(spreadSheetId);
  const ss = snapshot.ss;
  const sheet = snapshot.sheet;
  const values = snapshot.values;

  const brew = {

    batchNumber: null,
    beerStyle: null,
    brewDate: null,
    tankNumber: null,

    sheetUrl:
      ss.getUrl(),

    tankStatus: null,
    beerVolume: null,
    startingPlato: null,
    pasivationDate: null,

    currentData: {

      date: null,
      temp: null,
      plato: null,
      pressure:null,
      carbonation: null,
      pH: null,
      notes: ""
    }
  };


  // ==========================================================
  // BREW HEADER
  // ==========================================================

  const batchHeader =
    values[0] || [];

  brew.batchNumber =
    String(
      batchHeader[5] || ""
    )
      .replace("#", "")
      .trim() || null;

  brew.beerStyle =
    String(
      batchHeader[1] || ""
    )
      .trim() || null;

  brew.tankNumber =
    String(
      batchHeader[3] || ""
    )
      .trim() || null;

  brew.brewDate =
    String(
      batchHeader[7] || ""
    )
      .trim() || null;


  // ==========================================================
  // FERMENTATION HEADER
  // ==========================================================

  const fermentationHeader =
    findRowContaining(
      values,
      "דף תסיסה"
    );

  if (
    fermentationHeader !== -1
  ) {

    for (
      let r = fermentationHeader;
      r < Math.min(
        fermentationHeader + 6,
        values.length
      );
      r++
    ) {

      for (
        let c = 0;
        c < values[r].length;
        c++
      ) {

        const cell =
          String(
            values[r][c] || ""
          ).trim();


        // ------------------------------------------------------
        // BATCH
        // ------------------------------------------------------

        if (
          cell === "אצווה:"
        ) {

          const batch =
            String(
              values[r][c + 1] || ""
            )
              .replace("#", "")
              .trim();

          if (batch) {

            brew.batchNumber =
              brew.batchNumber
                ? brew.batchNumber
                : batch;
          }
        }


        // ------------------------------------------------------
        // BEER STYLE
        // ------------------------------------------------------

        if (
          cell === "סוג:"
        ) {

          const beerStyle =
            String(
              values[r][c + 1] || ""
            ).trim();

          brew.beerStyle =
            brew.beerStyle
              ? brew.beerStyle
              : beerStyle || null;
        }


        // ------------------------------------------------------
        // TANK NUMBER
        // ------------------------------------------------------

        if (
          cell === "מספר מיכל:"
        ) {

          const tankNumber =
            String(
              values[r][c + 1] || ""
            ).trim();

          brew.tankNumber =
            brew.tankNumber
              ? brew.tankNumber
              : tankNumber || null;
        }
      }
    }
  }


  // ==========================================================
  // BREW DATE
  // ==========================================================

  const brewDayRow =
    findRowContaining(
      values,
      "יום בישול"
    );

  if (
    brewDayRow !== -1
  ) {

    const col =
      findColumnContaining(
        values[brewDayRow],
        "יום בישול"
      );

    if (
      col !== -1
    ) {

      const brewDate =
        String(
          values[brewDayRow][col + 1] || ""
        ).trim();

      brew.brewDate =
        brew.brewDate
          ? brew.brewDate
          : brewDate || null;
    }
  }


  // ==========================================================
  // VOLUME
  // ==========================================================

  const volumeLocation =
    findCell(
      values,
      "נפח:"
    );

  if (
    volumeLocation
  ) {

    const volumeText =
      values[
      volumeLocation.row
      ][
      volumeLocation.col + 1
      ];

    brew.beerVolume =
      extractNumber(
        volumeText
      );
  }


  // ==========================================================
  // TANK STATUS
  // ==========================================================

  const statusLocation =
    findCell(
      values,
      "ריק?:"
    );

  if (
    statusLocation
  ) {

    const statusVal =
      values[
      statusLocation.row
      ][
      statusLocation.col + 1
      ];

    brew.tankStatus =
      String(
        statusVal || ""
      ).trim() || null;
  }


  // ==========================================================
  // STARTING PLATO
  // ==========================================================

  const startingPlatoLocation =
    findCell(
      values,
      "סוכר תחילי"
    );

  if (
    startingPlatoLocation
  ) {

    const startingPlatoValue =
      values[
      startingPlatoLocation.row
      ][
      startingPlatoLocation.col + 1
      ];

    const startingPlatoText =
      String(
        startingPlatoValue || ""
      ).trim();

    if (
      startingPlatoText
    ) {

      brew.startingPlato =
        extractNumber(
          startingPlatoText
        );

    } else {

      for (
        let z = 1;
        z <= startingPlatoLocation.row;
        z++
      ) {

        const row =
          startingPlatoLocation.row - z;

        for (
          let c = 0;
          c < values[row].length;
          c++
        ) {

          const cell =
            String(
              values[row][c] || ""
            ).trim();

          if (
            cell === "תחילת תסיסה"
          ) {

            const possibleValue =
              values[row][c + 1];

            const number =
              extractNumber(
                possibleValue
              );

            if (
              number !== null
            ) {

              brew.startingPlato =
                number;
            }

            break;
          }
        }

        if (
          brew.startingPlato !== null
        ) {

          break;
        }
      }
    }
  }


  // ==========================================================
  // CURRENT DATA
  // ==========================================================

  brew.currentData =
    findLatestAvailableMeasurements(
      values
    );


  // Logger.log(
  //   JSON.stringify(
  //     brew,
  //     null,
  //     2
  //   )
  // );

  return brew;
}

function extractBrewStageInfo(spreadSheetId, fermentorHint) {

  const spreadsheetId = extractSpreadsheetId(spreadSheetId);
  const snapshot = fcSheetSnapshot_(spreadsheetId);
  const ss = snapshot.ss;
  const sheet = snapshot.sheet;
  const values = snapshot.values;

  const batchHeader = values[0] || [];
  const tankNumber = String(batchHeader[3] || "").trim() || null;

  // ------------------------------------------------------
  // ANCHOR DATE - שרשרת fallback עם בדיקת "תאריך תקוע"
  // ------------------------------------------------------

  let dateAssumed = false;
  let anchorDate = extractDateFromText(batchHeader[7]);

  const blockStarts = findBrewBlockStarts(values);

  let firstBlockHeaderDate = null;

  if (blockStarts.length > 0) {

    const r = blockStarts[0];

    for (let c = 0; c < values[r].length; c++) {

      if (String(values[r][c]).trim() === "תאריך") {

        firstBlockHeaderDate = extractDateFromText(values[r][c + 1]);
        break;
      }
    }
  }

  // מזהים אם התאריך בכותרת העליונה תקוע (יותר מ-10 ימים מהיום)
  let topHeaderDateWasStale = false;

  if (anchorDate) {

    const todayCheck = new Date();
    todayCheck.setHours(0, 0, 0, 0);

    const anchorCheck = new Date(anchorDate.getTime());
    anchorCheck.setHours(0, 0, 0, 0);

    const diffDays =
      Math.abs(todayCheck.getTime() - anchorCheck.getTime()) /
      (1000 * 60 * 60 * 24);

    if (diffDays > 10) {

      Logger.log(
        "anchorDate from top header looks stale (" +
        diffDays + " days off) - discarding: " +
        batchHeader[7]
      );

      topHeaderDateWasStale = true;
      anchorDate = null;
    }
  }

  if (!anchorDate && firstBlockHeaderDate) {
    anchorDate = firstBlockHeaderDate;
  }

  if (!anchorDate && tankNumber) {

    try {

      // CHANGED: prefer the already-fetched fermentor object over
      // a fresh Firestore GET.
      const existing = fermentorHint || getFermentorFromFirebase(tankNumber);

      if (existing && existing.brewDate) {
        anchorDate = extractDateFromText(existing.brewDate);
      }

    } catch (e) {
      // best effort
    }
  }

  if (!anchorDate) {

    anchorDate = new Date();
    anchorDate.setHours(0, 0, 0, 0);
    dateAssumed = true;

  } else {

    anchorDate.setHours(0, 0, 0, 0);
  }

  // אם זוהה תאריך תקוע בכותרת העליונה ומצאנו תאריך תקין שמחליף
  // אותו - כותבים אותו בחזרה לתא בגיליון, כדי שבפעם הבאה לא
  // נצטרך את כל שרשרת ה-fallback הזו שוב.
  if (topHeaderDateWasStale) {

    try {

      const dateCell = findCell(values, "תאריך:");

      if (dateCell) {

        const targetRow = dateCell.row + 1;       // 1-indexed
        const targetCol = dateCell.col + 2;        // התא מימין לתווית, 1-indexed
        const day = String(anchorDate.getDate()).padStart(2, "0");
        const month = String(anchorDate.getMonth() + 1).padStart(2, "0");
        const year = String(anchorDate.getFullYear());

        sheet
          .getRange(targetRow, targetCol)
          .setNumberFormat("@")
          .setValue(`${day}/${month}/${year}`);

        // Keep the shared snapshot consistent with this successful sheet write.
        if (values[targetRow - 1]) values[targetRow - 1][targetCol - 1] = `${day}/${month}/${year}`;

        Logger.log(
          "Fixed stale top-header date in sheet -> " +
          `${day}/${month}`
        );

      } else {

        Logger.log(
          "Could not locate top header date cell to fix - label 'תאריך:' not found."
        );
      }

    } catch (error) {

      // כתיבה לגיליון תלויה בהרשאות ה-deploy ("execute as") -
      // אם הן לא מאפשרות כתיבה, לא נכשיל את כל התהליך.
      Logger.log(
        "Failed to write corrected date back to sheet: " + error.message
      );
    }
  }

  // ------------------------------------------------------
  // WALK ALL ROWS, SPLIT INTO BLOCKS
  // ------------------------------------------------------

  const fermentationRow = findRowContaining(values, "דף תסיסה");
  const headerStarts = new Set(blockStarts);

  const scanStart = blockStarts.length ? blockStarts[0] : 0;
  const scanEnd = (fermentationRow !== -1 ? fermentationRow : values.length) - 1;

  const blocks = [];
  let currentStages = [];
  let sawOutToFermentInCurrentBlock = false;
  let cursorMinutes = null;
  const cursorDate = new Date(anchorDate.getTime());

  function closeCurrentBlock() {
    if (currentStages.length > 0) {
      blocks.push({
        blockIndex: blocks.length + 1,
        stages: currentStages
      });
    }
    currentStages = [];
    sawOutToFermentInCurrentBlock = false;
  }

  rowLoop:
  for (let r = scanStart; r <= scanEnd; r++) {

    const row = values[r] || [];
    const rowText = row.map(c => String(c || "").trim());

    if (headerStarts.has(r) && r !== scanStart) {
      closeCurrentBlock();
    }

    for (let s = 0; s < STAGE_DEFS.length; s++) {

      const def = STAGE_DEFS[s];

      for (let c = 0; c < rowText.length; c++) {

        const cellText = rowText[c];
        if (!cellText) continue;

        const match = cellText.match(def.regex);
        if (!match) continue;

        const subIndex = def.indexed ? Number(match[1]) : null;
        const code = def.indexed ? def.code + (subIndex - 1) : def.code;
        const name = def.indexed ? (def.name + " " + subIndex) : def.name;

        if (code === 10 && sawOutToFermentInCurrentBlock) {
          closeCurrentBlock();
        }

        let startMin = null;
        let endMin = null;

        for (let cc = c + 1; cc < rowText.length; cc++) {

          const t = extractTimeFromCell(rowText[cc]);
          if (t === null) continue;

          if (startMin === null) {
            startMin = t;
          } else {
            endMin = t;
            break;
          }
        }

        if (startMin === null) continue;

        // ----------------------------------------------------
        // FIXED: only treat a LARGE backward jump as a real
        // midnight crossing. A small backward jump is far more
        // likely to be a typo in the sheet (e.g. "20:58" meant
        // to be "20:08") than an actual day rollover.
        // ----------------------------------------------------
        if (
          cursorMinutes !== null &&
          startMin < cursorMinutes &&
          (cursorMinutes - startMin) > MIDNIGHT_ROLLOVER_MIN_GAP_MINUTES
        ) {
          cursorDate.setDate(cursorDate.getDate() + 1);
        } else if (cursorMinutes !== null && startMin < cursorMinutes) {
          Logger.log(
            "Small backward time jump at stage '" + name +
            "' (row " + (r + 1) + "): " +
            cursorMinutes + "min -> " + startMin + "min. " +
            "Treating as same-day (likely a typo in the sheet), not midnight."
          );
        }

        cursorMinutes = startMin;

        const startDateTime = new Date(cursorDate.getTime());
        startDateTime.setHours(0, startMin, 0, 0);

        let endDateTime = null;

        if (endMin !== null) {

          if (
            endMin < startMin &&
            (startMin - endMin) > MIDNIGHT_ROLLOVER_MIN_GAP_MINUTES
          ) {
            cursorDate.setDate(cursorDate.getDate() + 1);
          }

          cursorMinutes = endMin;

          endDateTime = new Date(cursorDate.getTime());
          endDateTime.setHours(0, endMin, 0, 0);
        }

        currentStages.push({
          code: code,
          name: name,
          row: r,
          startDateTime: startDateTime,
          endDateTime: endDateTime
        });

        if (code === STAGE_CODE_OUT_TO_FERMENTOR) {
          sawOutToFermentInCurrentBlock = true;
        }

        continue rowLoop;
      }
    }
  }

  closeCurrentBlock();

  // ------------------------------------------------------
  // CURRENT STAGE
  // ------------------------------------------------------

  const now = new Date();
  let currentStage = null;
  let currentBlockIndex = null;

  for (let bi = blocks.length - 1; bi >= 0 && !currentStage; bi--) {

    const stages = blocks[bi].stages;

    for (let si = stages.length - 1; si >= 0; si--) {

      if (stages[si].startDateTime.getTime() <= now.getTime()) {

        currentStage = stages[si];
        currentBlockIndex = blocks[bi].blockIndex;
        break;
      }
    }
  }

  // ------------------------------------------------------
  // VOLUME
  // ------------------------------------------------------

  let beerVolume = null;
  const volumeLocation = findCell(values, "נפח:");

  if (volumeLocation) {
    beerVolume = extractNumber(values[volumeLocation.row][volumeLocation.col + 1]);
  }

  const headerCount = blockStarts.length;
  const hasUnstartedHeader = headerCount > blocks.length;

  return {

    tankNumber: tankNumber,
    dateAssumed: dateAssumed,

    blockCount: blocks.length,
    headerCount: headerCount,
    hasUnstartedHeader: hasUnstartedHeader,

    lastBlock: blocks.length ? blocks[blocks.length - 1] : null,

    currentBlockIndex: currentBlockIndex,
    currentStage: currentStage,

    beerVolume: beerVolume
  };
}

function writeLatestMeasurementIfChanged_(
  projectId,
  batchId,
  sheetUrl
) {

  return fcWithScriptLock_(function () {

    const values = fcSheetSnapshot_(sheetUrl).values;

    const headerRow =
      findRowContaining(
        values,
        "טמפרטורה"
      );

    if (headerRow === -1) {
      return false;
    }

    for (
      let r = values.length - 1;
      r > headerRow;
      r--
    ) {

      const dateText =
        String(values[r][0] || "").trim();

      const date =
        parseIsraeliDate(dateText);

      if (!date) continue;

      const hasAnyValue =
        values[r][2] ||
        values[r][3] ||
        values[r][4] ||
        values[r][5] ||
        values[r][6] ||
        values[r][7];

      if (!hasAnyValue) continue;

      const time =
        String(values[r][1] || "").trim();

      const measurement = {

        date: dateText,

        time: time,

        temp:
          extractNumber(values[r][3]),

        plato:
          extractNumber(values[r][2]),

        pressure:
          extractNumber(values[r][4]),

        carbonation:
          extractNumber(values[r][6]),

        pH:
          extractNumber(values[r][5]),

        notes:
          String(values[r][7] || "").trim()
      };

      const measurementId =
        createMeasurementId(
          date,
          time
        );

      const cacheKey =
        "measurement:" +
        batchId +
        ":" +
        measurementId;

      const state = fcChangeState_("measurement:" + projectId + ":" + batchId + ":" + measurementId, measurement);
      if (!state.changed) return false;

      const docPath =
        "projects/" +
        projectId +
        "/databases/(default)/documents/brews/" +
        encodeURIComponent(batchId) +
        "/measurements/" +
        encodeURIComponent(measurementId);

      const url =
        "https://firestore.googleapis.com/v1/projects/" +
        projectId +
        "/databases/(default)/documents/brews/" +
        encodeURIComponent(batchId) +
        "/measurements/" +
        encodeURIComponent(measurementId);

      mrCommitMeasurement_(projectId, batchId, measurementId, measurement);
      fcMarkSuccess_(state);

      Logger.log(
        "Wrote latest measurement immediately: " +
        docPath
      );

      return true;
    }

    return false;

  });
}

function updateFermentorBrewProgress(tankNumber, stageInfo) {
  return fcWithScriptLock_(function () {

  const fermentorId = String(tankNumber).trim();

  const stage = stageInfo.currentStage;

  const progress = {

    blockIndex: stageInfo.currentBlockIndex || null,
    blockCount: stageInfo.blockCount || null,

    stageCode: stage ? stage.code : null,
    stageName: stage ? stage.name : null,

    // ISO מלא - שימושי למיון/חישובים עתידיים בפרונט אם יידרש
    stageStartTime: stage ? stage.startDateTime : null,
    stageEndTime: stage ? stage.endDateTime : null, // null מפורש אם עוד לא הסתיים

    // HH:MM מוכן לתצוגה - לא צריך parsing בפרונט
    stageStartTimeText: stage ? formatHHMM(stage.startDateTime) : null,
    stageEndTimeText: stage ? formatHHMM(stage.endDateTime) : null, // null מפורש

    dateAssumed: !!stageInfo.dateAssumed
  };

  const state = fcChangeState_("brewProgress:" + FIREBASE_PROJECT_ID + ":" + fermentorId, progress);
  if (!state.changed) return;

  const url =
    "https://firestore.googleapis.com/v1/projects/" + FIREBASE_PROJECT_ID +
    "/databases/(default)/documents/fermentors/" + encodeURIComponent(fermentorId) +
    "?updateMask.fieldPaths=brewProgress";

  const document = {
    fields: {
      brewProgress: toFirestoreValue(progress)
    }
  };

  const response = UrlFetchApp.fetch(url, {

    method: "patch",
    contentType: "application/json",

    headers: {
      Authorization: "Bearer " + ScriptApp.getOAuthToken()
    },

    payload: JSON.stringify(document),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();

  if (code < 200 || code >= 300) {

    throw new Error(
      "Failed to update brewProgress for tank " + fermentorId +
      ": " + code + " " + response.getContentText()
    );
  }
  fcMarkSuccess_(state);
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
