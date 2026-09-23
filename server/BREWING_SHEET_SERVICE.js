// ============================================================
// BREWING SHEET SERVICE
// Server-side Drive / Sheets bridge for the new brewing workflow.
//
// Purpose:
// - browser authenticates only with Firebase ID token (handled in post.js)
// - Apps Script performs Drive/Sheets work with the script account
// - no Google OAuth popup is required in the browser once the client switches
//   to these actions.
//
// Required Script Properties before production activation:
//   BREWING_DESTINATION_FOLDER_ID
//   BREWING_TEMPLATE_SINGLE_ID
//   BREWING_TEMPLATE_DOUBLE_ID
//   BREWING_TEMPLATE_TRIPLE_ID
// ============================================================

const BREWING_CREATED_FILE_PREFIX_ = "brewing_created_file:";
const BREWING_HISTORY_CACHE_KEY_ = "brewing_drive_history_v1";

function brewingSheetInvalidateHistoryCache_() {
  try {
    CacheService.getScriptCache().remove(BREWING_HISTORY_CACHE_KEY_);
  } catch (error) {
    console.log("Brew history cache invalidation skipped: " + error.message);
  }
}

function brewingSheetConfig_() {
  const props = PropertiesService.getScriptProperties();

  // Keep the new brewing workflow on the same Drive source of truth as the
  // existing brewery service. Script Properties may override these values, but
  // a deployment must not become unusable merely because the new properties
  // were never provisioned.
  const existingBrewFolderId =
    typeof BREW_FOLDER_ID !== "undefined" ? String(BREW_FOLDER_ID || "").trim() : "";

  return {
    folderId: String(
      props.getProperty("BREWING_DESTINATION_FOLDER_ID") ||
      existingBrewFolderId
    ).trim(),
    templates: {
      single: String(
        props.getProperty("BREWING_TEMPLATE_SINGLE_ID") ||
        "1qqYHpIhokc7mEsCHW2bhM6LDGrmh4CN0l937nYnonOw"
      ).trim(),
      double: String(
        props.getProperty("BREWING_TEMPLATE_DOUBLE_ID") ||
        "1M-IFhJL-JwphQDEKsAHFCpCR8zz4zXXgaXkCZ2hpXtY"
      ).trim(),
      triple: String(
        props.getProperty("BREWING_TEMPLATE_TRIPLE_ID") ||
        "1I8P0aoD7WEo0AYZcYebhFzCGdik5TzgPnNq2SgPEzkI"
      ).trim()
    }
  };
}

function brewingSheetNormalizeTankType_(value) {
  const type = String(value || "").trim();
  if (type !== "single" && type !== "double" && type !== "triple") {
    throw new Error("Invalid tankType");
  }
  return type;
}

function brewingSheetExtractId_(value) {
  const text = String(value || "").trim();
  if (!text) return "";

  const match = text.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : text;
}

function brewingSheetRememberCreated_(fileId) {
  PropertiesService.getScriptProperties().setProperty(
    BREWING_CREATED_FILE_PREFIX_ + fileId,
    String(Date.now())
  );
}

function brewingSheetAssertAllowedFile_(fileId) {
  const id = brewingSheetExtractId_(fileId);
  if (!id) throw new Error("Missing spreadsheetId");

  // Do not scan the entire brewing Drive folder on the request path. The caller
  // is already an approved Firebase user; SpreadsheetApp.openById() below is
  // the actual access check and avoids a second expensive open here.
  return id;
}

function brewingSheetCellValue_(value) {
  if (value === undefined || value === null) return "";
  return value;
}

function brewingSheetReadRange_(data) {
  const startedAt = Date.now();
  const fileId = brewingSheetAssertAllowedFile_(data.spreadsheetId || data.sheetUrl);
  const range = String(data.range || "").trim();
  if (!range) throw new Error("Missing range");

  const openStartedAt = Date.now();
  const ss = SpreadsheetApp.openById(fileId);
  const openMs = Date.now() - openStartedAt;

  const readStartedAt = Date.now();
  // Avoid opening the same spreadsheet a second time through the advanced
  // Sheets API. SpreadsheetApp already has it open, so resolve the tab locally.
  const bang = range.lastIndexOf("!");
  const rawSheetName = bang >= 0 ? range.slice(0, bang) : "";
  const a1 = bang >= 0 ? range.slice(bang + 1) : range;
  const sheetName = rawSheetName.replace(/^'(.*)'$/, "$1").replace(/''/g, "'");
  // Old/new brew templates do not consistently use the same tab name.
  // The brew file is single-sheet, so a stale requested tab name must not
  // block reconciliation; fall back to the file's first sheet.
  const sheet = (sheetName ? ss.getSheetByName(sheetName) : null) || ss.getSheets()[0];
  if (!sheet) throw new Error("Brew Sheet has no sheets");
  const values = sheet.getRange(a1).getDisplayValues();
  const readMs = Date.now() - readStartedAt;

  const timing = {
    openMs: openMs,
    readMs: readMs,
    totalMs: Date.now() - startedAt
  };
  console.log("BrewSheetReadRange timing " + JSON.stringify(timing));

  return {
    spreadsheetId: fileId,
    range: range,
    values: values,
    timing: timing
  };
}

function brewingSheetWriteCells_(data) {
  const fileId = brewingSheetAssertAllowedFile_(data.spreadsheetId || data.sheetUrl);
  const writes = Array.isArray(data.writes) ? data.writes : [];
  if (!writes.length) throw new Error("Missing writes");

  const ss = SpreadsheetApp.openById(fileId);
  const conflicts = [];
  let updated = 0;

  writes.forEach(function (item) {
    const rangeText = String(item && item.range || "").trim();
    if (!rangeText) throw new Error("Write is missing range");

    // A1 ranges are generated from template metadata and historically use
    // 'גיליון1'. Production brew files may have a renamed tab. Resolve the
    // requested tab when present and otherwise fall back to the file's single
    // actual sheet, just like the read path.
    const bang = rangeText.lastIndexOf("!");
    const rawSheetName = bang >= 0 ? rangeText.slice(0, bang) : "";
    const a1 = bang >= 0 ? rangeText.slice(bang + 1) : rangeText;
    const sheetName = rawSheetName.replace(/^'(.*)'$/, "$1").replace(/''/g, "'");
    const sheet = (sheetName ? ss.getSheetByName(sheetName) : null) || ss.getSheets()[0];
    if (!sheet) throw new Error("Brew Sheet has no sheets");
    const range = sheet.getRange(a1);

    if (
      item &&
      Object.prototype.hasOwnProperty.call(item, "expectedValue")
    ) {
      const current = String(range.getDisplayValue() || "").trim();
      const expected = String(item.expectedValue == null ? "" : item.expectedValue).trim();

      if (current !== expected) {
        conflicts.push({
          range: rangeText,
          expectedValue: expected,
          actualValue: current,
          proposedValue: brewingSheetCellValue_(item.value)
        });
        return;
      }
    }

    range.setValue(brewingSheetCellValue_(item.value));
    updated++;
  });

  SpreadsheetApp.flush();

  return {
    spreadsheetId: fileId,
    updated: updated,
    conflicts: conflicts,
    hasConflict: conflicts.length > 0
  };
}

function brewingSheetTemplateForType_(tankType) {
  const config = brewingSheetConfig_();
  const type = brewingSheetNormalizeTankType_(tankType);
  const templateId = config.templates[type];

  if (!config.folderId) {
    throw new Error("BREWING_DESTINATION_FOLDER_ID is not configured");
  }
  if (!templateId) {
    throw new Error("Brewing template is not configured for " + type);
  }

  return {
    folderId: config.folderId,
    templateId: templateId,
    tankType: type
  };
}

function brewingSheetCreate_(data) {
  const batchNumber = String(data.batchNumber || "").replace("#", "").trim();
  if (!/^\d+$/.test(batchNumber)) throw new Error("Invalid batchNumber");

  const config = brewingSheetTemplateForType_(data.tankType);
  const style = String(data.style || "").trim();
  const tankNumber = String(data.tankNumber || "").trim();
  const name =
    String(data.name || "").trim() ||
    [style || "בישול", batchNumber + "#"].join(" ");

  const template = DriveApp.getFileById(config.templateId);
  const folder = DriveApp.getFolderById(config.folderId);
  const copy = template.makeCopy(name, folder);
  const fileId = copy.getId();

  brewingSheetRememberCreated_(fileId);
  brewingSheetInvalidateHistoryCache_();

  try {
    const ss = SpreadsheetApp.openById(fileId);
    ss.setSpreadsheetTimeZone("Asia/Jerusalem");

    // Creation deliberately does NOT set the brew date.
    // The date is entered by the brewer in the first step when brewing begins.
    if (data.initialWrites && Array.isArray(data.initialWrites)) {
      data.initialWrites.forEach(function (item) {
        const rangeText = String(item.range || "").trim();
        if (!rangeText) return;
        ss.getRange(rangeText).setValue(brewingSheetCellValue_(item.value));
      });
      SpreadsheetApp.flush();
    }

    return {
      id: fileId,
      name: copy.getName(),
      url: copy.getUrl(),
      batchNumber: batchNumber,
      tankNumber: tankNumber,
      style: style,
      tankType: config.tankType
    };
  } catch (error) {
    try {
      copy.setTrashed(true);
    } catch (cleanupError) {
      logToSheet("Failed cleaning orphan Brew Sheet: " + cleanupError.message);
    }
    throw error;
  }
}

function brewingSheetTrash_(data) {
  const fileId = brewingSheetAssertAllowedFile_(data.spreadsheetId || data.sheetUrl);
  const file = DriveApp.getFileById(fileId);
  file.setTrashed(true);
  brewingSheetInvalidateHistoryCache_();

  return {
    spreadsheetId: fileId,
    trashed: true
  };
}

function brewingSheetRenameBatch_(data) {
  const fileId = brewingSheetAssertAllowedFile_(data.spreadsheetId || data.sheetUrl);
  const oldBatch = String(data.oldBatchNumber || "").replace("#", "").trim();
  const newBatch = String(data.newBatchNumber || "").replace("#", "").trim();
  const style = String(data.style || "").trim();
  if (!/^\d+$/.test(newBatch)) throw new Error("Invalid newBatchNumber");

  const file = DriveApp.getFileById(fileId);
  const ss = SpreadsheetApp.openById(fileId);
  const sheet = ss.getSheets()[0];
  const values = sheet.getDataRange().getDisplayValues();
  const starts = findBrewBlockStarts(values);

  sheet.getRange("B1").setValue(style);
  sheet.getRange("F1").setValue(newBatch);
  starts.forEach(function (start, index) {
    const headerRow = start - 5;
    if (headerRow >= 1) {
      sheet.getRange(headerRow, 3).setValue(style);
      sheet.getRange(headerRow, 5).setValue(newBatch + ["A", "B", "C"][index]);
    }
  });

  const fermentationHeaderRow =
    starts.length >= 3 ? 154 : starts.length === 2 ? 104 : 57;
  sheet.getRange(fermentationHeaderRow, 2).setValue(
    starts.length === 1 ? style : style + " " + (starts.length === 2 ? "כפול" : "משולש")
  );
  sheet.getRange(fermentationHeaderRow, 4).setValue(newBatch);

  const currentName = file.getName();
  const replaced = oldBatch
    ? currentName.replace(new RegExp("#?" + oldBatch + "#?"), newBatch + "#")
    : currentName;
  if (replaced !== currentName) file.setName(replaced);
  SpreadsheetApp.flush();
  brewingSheetInvalidateHistoryCache_();

  return { spreadsheetId: fileId, batchNumber: newBatch, style: style, name: file.getName() };
}

function brewingSheetNumber_(value) {
  const match = String(value == null ? "" : value)
    .replace(/,/g, ".")
    .match(/-?\d+(?:\.\d+)?/);
  return match ? match[0] : "";
}

function brewingSheetBatchFromName_(name) {
  const matches = String(name || "").match(/\d{3,6}/g) || [];
  if (!matches.length) return null;
  const value = Number(matches[matches.length - 1]);
  return Number.isFinite(value) ? value : null;
}

function brewingSheetBlockLayout_(name) {
  if (String(name).indexOf("משולש") !== -1) {
    return { bases: [9, 59, 106], headers: [4, 54, 102] };
  }
  if (String(name).indexOf("כפול") !== -1) {
    return { bases: [9, 59], headers: [4, 54] };
  }
  return { bases: [9], headers: [4] };
}

function brewingSheetParseHistoryBlock_(
  values,
  baseRow,
  headerRow,
  letter,
  batchNumber,
  file
) {
  function cell(row, col) {
    return String((values[row - 1] || [])[col - 1] || "").trim();
  }

  const mashMeta = cell(baseRow, 8);
  const mashVolumeMatch = mashMeta.match(/נפח\s*מאש\s*([\d.,]+)/i);
  const mashPhMatch = mashMeta.match(/pH\s*([\d.,]+)/i);

  const row = {
    batchNumber: String(batchNumber),
    brewLetter: letter,
    brewDate: cell(headerRow, 8),
    mashPh: mashPhMatch ? String(mashPhMatch[1]).replace(",", ".") : "",
    mashVolume: mashVolumeMatch ? String(mashVolumeMatch[1]).replace(",", ".") : "",
    acidMl: brewingSheetNumber_(cell(baseRow + 28, 1)),
    outToBoilPh: brewingSheetNumber_(cell(baseRow + 15, 8)),
    boilPh: brewingSheetNumber_(cell(baseRow + 28, 6)),
    kettleVolume: brewingSheetNumber_(cell(baseRow + 38, 3)),
    boilAcidMl: brewingSheetNumber_(cell(baseRow + 29, 1)),
    outToFermentorPh: brewingSheetNumber_(cell(baseRow + 40, 8)),
    sheetName: file.fileName || "",
    sheetUrl: buildSheetUrl(file.fileId)
  };

  if (
    !row.mashPh &&
    !row.mashVolume &&
    !row.acidMl &&
    !row.outToBoilPh &&
    !row.boilPh &&
    !row.kettleVolume &&
    !row.boilAcidMl &&
    !row.outToFermentorPh
  ) {
    return null;
  }

  return row;
}

function brewingSheetStyleFromFileName_(fileName) {
  return String(fileName || "")
    .replace(/^\s*\[SANDBOX\]\s*/i, "")
    .replace(/^\s*עותק של\s*/i, "")
    .replace(/#?\s*\d{3,6}\s*#?/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function brewingSheetTankTypeFromFileName_(fileName) {
  const name = String(fileName || "");
  if (name.indexOf("משולש") !== -1) return "triple";
  if (name.indexOf("כפול") !== -1) return "double";
  return "single";
}

function brewingSheetListHistory_(data) {
  const requestedLimit = Number(data && data.limit);
  try {
    const cached = CacheService.getScriptCache().get(BREWING_HISTORY_CACHE_KEY_);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed)) return parsed.slice(0, Number.isFinite(requestedLimit) ? requestedLimit : 100);
    }
  } catch (error) {
    console.log("Brew history cache read skipped: " + error.message);
  }
  const safeLimit =
    Number.isFinite(requestedLimit)
      ? Math.max(10, Math.min(150, Math.round(requestedLimit)))
      : 100;

  let candidates = [];
  if (typeof getBrewFolderCandidatesCached === "function") {
    candidates = getBrewFolderCandidatesCached() || [];
  }

  const seenBatches = {};
  const result = candidates
    .slice()
    .sort(function (a, b) {
      return Number(b.batch || 0) - Number(a.batch || 0);
    })
    .filter(function (candidate) {
      const name = String(candidate.fileName || "");
      if (/^\s*\[SANDBOX\]/i.test(name)) return false;

      const batch = Number(
        candidate.batch || brewingSheetBatchFromName_(name)
      );
      if (!Number.isFinite(batch)) return false;
      if (seenBatches[batch]) return false;

      seenBatches[batch] = true;
      return true;
    })
    .slice(0, safeLimit)
    .map(function (candidate) {
      const fileName = String(candidate.fileName || "");
      const batch = Number(
        candidate.batch || brewingSheetBatchFromName_(fileName)
      );

      return {
        id: String(candidate.fileId || ""),
        fileId: String(candidate.fileId || ""),
        fileName: fileName,
        batchNumber: String(batch),
        beerStyle: brewingSheetStyleFromFileName_(fileName),
        brewDate: "",
        sheetUrl: buildSheetUrl(candidate.fileId),
        tankNumber: "",
        tankType: brewingSheetTankTypeFromFileName_(fileName)
      };
    });

  try {
    CacheService.getScriptCache().put(BREWING_HISTORY_CACHE_KEY_, JSON.stringify(result), 300);
  } catch (error) {
    console.log("Brew history cache write skipped: " + error.message);
  }
  return result;
}

function brewingSheetAcidStyleAliases_(value) {
  const key = String(value || "").trim().toLowerCase().replace(/\\s+(משולש|כפול|בודד)$/, "");
  if (key === "חיטה" || key === "wheat") return ["חיטה", "wheat"];
  if (key === "פייל" || key === "pale" || key === "pale ale") return ["פייל", "pale", "pale ale"];
  if (key === "הופי" || key === "hoppy") return ["הופי", "hoppy"];
  if (key === "לאגר" || key === "lager") return ["לאגר", "lager"];
  if (key === "סטאוט" || key === "stout") return ["סטאוט", "stout"];
  return [key];
}

function brewingSheetAcidHistory_(data) {
  const style = String(data.style || "").trim().toLowerCase();
  const styleAliases = brewingSheetAcidStyleAliases_(style);
  const currentBatch = Number(String(data.currentBatchNumber || "").replace("#", ""));
  if (!style) throw new Error("Missing style");

  let candidates = [];
  if (typeof getBrewFolderCandidatesCached === "function") {
    candidates = getBrewFolderCandidatesCached() || [];
  }

  const byBatch = {};
  candidates.forEach(function (candidate) {
    const fileName = String(candidate.fileName || "");
    const lowerName = fileName.toLowerCase();
    if (!styleAliases.some(function (alias) { return lowerName.indexOf(alias) !== -1; })) return;

    const batch = Number(candidate.batch || brewingSheetBatchFromName_(fileName));
    if (!Number.isFinite(batch)) return;

    if (!byBatch[batch]) byBatch[batch] = candidate;
  });

  // Compare against the latest three batches, including the current
  // batch when it already has completed earlier brew blocks (A/B). The parser
  // below returns only blocks that actually contain acid/pH history, so the
  // currently active brew block is naturally excluded while earlier brews from
  // the same batch remain useful comparison data.
  const batches = Object.keys(byBatch)
    .map(Number)
    .sort(function (a, b) {
      if (a === currentBatch) return -1;
      if (b === currentBatch) return 1;
      return b - a;
    })
    .slice(0, 3);

  const rows = [];
  let batchesWithData = 0;

  for (let i = 0; i < batches.length && batchesWithData < 3; i++) {
    const batch = batches[i];
    const file = byBatch[batch];

    try {
      const sheet = SpreadsheetApp.openById(file.fileId).getSheets()[0];
      const values = sheet.getRange(1, 1, Math.min(150, sheet.getMaxRows()), 8).getDisplayValues();
      const layout = brewingSheetBlockLayout_(file.fileName);
      const batchRows = [];

      layout.bases.forEach(function (baseRow, index) {
        const parsed = brewingSheetParseHistoryBlock_(
          values,
          baseRow,
          layout.headers[index],
          ["A", "B", "C"][index],
          batch,
          file
        );
        if (parsed) batchRows.push(parsed);
      });

      if (batchRows.length) {
        batchesWithData++;
        Array.prototype.push.apply(rows, batchRows);
      }
    } catch (error) {
      logToSheet("BrewSheet history skipped " + file.fileId + ": " + error.message);
    }
  }

  return rows.slice(0, 9);
}


// ============================================================
// ACTIVE BREW SHEET EDIT TRIGGERS
// ============================================================

const BREWING_EDIT_TRIGGER_HANDLER_ = "brewingSheetOnEdit_";
const BREWING_EDIT_TANK_PREFIX_ = "brew_edit_tank:";

function brewingSheetRememberEditTank_(spreadsheetId, tankNumber) {
  const fileId = String(spreadsheetId || "").trim();
  const tank = String(tankNumber || "").trim();
  if (!fileId || !tank) return;
  PropertiesService.getScriptProperties().setProperty(BREWING_EDIT_TANK_PREFIX_ + fileId, tank);
}

function brewingSheetKnownEditTank_(spreadsheetId) {
  return String(
    PropertiesService.getScriptProperties().getProperty(
      BREWING_EDIT_TANK_PREFIX_ + String(spreadsheetId || "").trim()
    ) || ""
  ).trim();
}

function brewingSheetTriggerSourceId_(trigger) {
  try {
    return String(trigger.getTriggerSourceId() || "").trim();
  } catch (error) {
    return "";
  }
}

function brewingSheetEnsureEditTrigger_(data) {
  const fileId = brewingSheetAssertAllowedFile_(data.spreadsheetId || data.sheetUrl);
  if (data.tankNumber) brewingSheetRememberEditTank_(fileId, data.tankNumber);
  const triggers = ScriptApp.getProjectTriggers();
  const existing = triggers.find(function (trigger) {
    return (
      trigger.getHandlerFunction() === BREWING_EDIT_TRIGGER_HANDLER_ &&
      brewingSheetTriggerSourceId_(trigger) === fileId
    );
  });

  if (!existing) {
    ScriptApp.newTrigger(BREWING_EDIT_TRIGGER_HANDLER_)
      .forSpreadsheet(fileId)
      .onEdit()
      .create();
  }

  return {
    spreadsheetId: fileId,
    installed: !existing,
    active: true
  };
}

function brewingSheetRemoveEditTrigger_(data) {
  const fileId = brewingSheetAssertAllowedFile_(data.spreadsheetId || data.sheetUrl);
  let removed = 0;

  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (
      trigger.getHandlerFunction() === BREWING_EDIT_TRIGGER_HANDLER_ &&
      brewingSheetTriggerSourceId_(trigger) === fileId
    ) {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    }
  });

  PropertiesService.getScriptProperties().deleteProperty(BREWING_EDIT_TANK_PREFIX_ + fileId);

  return {
    spreadsheetId: fileId,
    removed: removed,
    active: false
  };
}

function brewingSheetReconcileEditTriggers_(fermentorEntries) {
  const activeSheetIds = new Set();

  (fermentorEntries || []).forEach(function (entry) {
    const fermentor = entry && entry.data ? entry.data : entry;
    if (!fermentor || parseAction(fermentor.action) !== 0 || !fermentor.sheetUrl) return;

    try {
      const fileId = brewingSheetExtractId_(fermentor.sheetUrl);
      if (!fileId) return;
      activeSheetIds.add(fileId);
      brewingSheetEnsureEditTrigger_({
        spreadsheetId: fileId,
        tankNumber: fermentor.tankNumber || (entry && entry.id) || ""
      });
    } catch (error) {
      Logger.log(
        "Failed ensuring brew edit trigger for tank " +
        String(fermentor.tankNumber || (entry && entry.id) || "?") +
        ": " +
        error.message
      );
    }
  });

  // Clean up only triggers owned by this feature. This also handles tanks that
  // moved out of ACTION 0 while the app was closed.
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() !== BREWING_EDIT_TRIGGER_HANDLER_) return;
    const fileId = brewingSheetTriggerSourceId_(trigger);
    if (fileId && !activeSheetIds.has(fileId)) {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  return { active: activeSheetIds.size };
}

function brewingSheetFindFermentorForSheet_(spreadsheetId) {
  const targetId = brewingSheetExtractId_(spreadsheetId);
  const fermentors = getAllFermentorsFromFirebase();

  return fermentors.find(function (fermentor) {
    return (
      brewingSheetExtractId_(fermentor.sheetUrl) === targetId &&
      parseAction(fermentor.action) === 0
    );
  }) || null;
}

function brewingSheetPublishEditRevision_(tankNumber, event) {
  const fermentorId = String(tankNumber || "").trim();
  if (!fermentorId) return;

  const range = event && event.range ? event.range.getA1Notation() : "";
  const sheetName = event && event.range ? event.range.getSheet().getName() : "";
  const revision = Date.now();
  const editedValue =
    event && Object.prototype.hasOwnProperty.call(event, "value")
      ? String(event.value == null ? "" : event.value)
      : event && event.range
        ? String(event.range.getDisplayValue() || "")
        : "";
  const oldValue =
    event && Object.prototype.hasOwnProperty.call(event, "oldValue")
      ? String(event.oldValue == null ? "" : event.oldValue)
      : "";
  const url =
    "https://firestore.googleapis.com/v1/projects/" +
    FIREBASE_PROJECT_ID +
    "/databases/(default)/documents/fermentors/" +
    encodeURIComponent(fermentorId) +
    "?updateMask.fieldPaths=brewSheetEditRevision" +
    "&updateMask.fieldPaths=brewSheetEditRange" +
    "&updateMask.fieldPaths=brewSheetEditValue" +
    "&updateMask.fieldPaths=brewSheetEditOldValue" +
    "&updateMask.fieldPaths=brewSheetEditSheetName";

  const response = UrlFetchApp.fetch(url, {
    method: "patch",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({
      fields: {
        brewSheetEditRevision: { integerValue: String(revision) },
        brewSheetEditRange: { stringValue: String(range || "") },
        brewSheetEditValue: { stringValue: editedValue },
        brewSheetEditOldValue: { stringValue: oldValue },
        brewSheetEditSheetName: { stringValue: sheetName }
      }
    }),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error(
      "Failed publishing Sheet edit revision for tank " +
      fermentorId + ": " + code + " " + response.getContentText()
    );
  }
}



function brewingSheetBackfill1597() {
  const batch = "1597";
  const fermentor = brewingSheetFindFermentorForBatch_(batch);
  if (!fermentor) throw new Error("Active fermentor for batch 1597 was not found");

  const spreadsheetId = brewingSheetExtractId_(fermentor.sheetUrl || fermentor.spreadsheetId || "");
  if (!spreadsheetId) throw new Error("Sheet id for batch 1597 was not found");

  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sheet = ss.getSheets()[0];
  const values = sheet.getDataRange().getDisplayValues();
  const starts = findBrewBlockStarts(values);
  if (!starts.length) throw new Error("No brew blocks found in batch 1597 Sheet");

  const execution = {
    batchNumber: batch,
    activeBlockIndex: 1,
    blocks: {},
    reviewedSteps: {},
    updatedAt: new Date().toISOString()
  };

  starts.forEach(function (start, idx) {
    const end = idx + 1 < starts.length ? starts[idx + 1] - 1 : values.length - 1;
    const fields = {};
    for (let r = start; r <= end; r++) {
      const row = values[r] || [];
      const label = String(row[3] || "").trim();
      const stagePatterns = [
        ["mashIn", /^הכנסת לתת$/i], ["rest1", /^השריה\\s*1$/i], ["heat1", /^חימום\\s*1$/i],
        ["rest2", /^השריה\\s*2$/i], ["heat2", /^חימום\\s*2$/i], ["rest3", /^השריה\\s*3$/i],
        ["heat3", /^חימום\\s*3$/i], ["transferLt", /^העברה\\s+ל.*L\\.?T\\.?/i],
        ["restLt", /^מנוחה\\s*L\\.?T\\.?/i], ["circulation", /^סחרור/i],
        ["outToBoil", /^הוצאה לבישול$/i], ["endTransfer", /^סוף העברה$/i],
        ["boil", /^(?:תחילת\\s+)?רתיחה(?:\\s+100°?C)?$/i],
        ["hop1", /^הוספת כ(?:שות|שת)\\s*1$/i], ["hop2", /^הוספת כ(?:שות|שת)\\s*2$/i],
        ["hop3", /^הוספת כ(?:שות|שת)\\s*3$/i], ["wp", /סוף רתיחה.*תחילת\\s*WP/i],
        ["outToFermentor", /^הוצאה לתסיסה$/i]
      ];
      stagePatterns.forEach(function (entry) {
        if (!entry[1].test(label)) return;
        if (row[4]) fields[entry[0] + ".start"] = String(row[4]).trim();
        if (row[5]) fields[entry[0] + ".end"] = String(row[5]).trim();
        if (row[6]) fields[entry[0] + ".temp"] = String(row[6]).trim().replace(/[^0-9.,-]/g, "");
        if (row[7]) fields[entry[0] + ".note"] = String(row[7]).trim();
        fields["__sheetRow.stage." + entry[0]] = String(r + 1);
      });
      const rinse = /^שטיפה\\s*(\\d+)$/i.exec(label);
      if (rinse) {
        const n = rinse[1];
        if (row[4]) fields["rinse" + n + ".time"] = String(row[4]).trim();
        if (row[5]) fields["rinse" + n + ".amount"] = String(row[5]).trim().replace(/[^0-9.,-]/g, "");
        if (row[6]) fields["rinse" + n + ".temp"] = String(row[6]).trim().replace(/[^0-9.,-]/g, "");
        if (row[7]) fields["rinse" + n + ".kettle"] = String(row[7]).trim().split("+")[0].replace(/[^0-9.,-]/g, "");
        fields["__sheetRow.rinse." + n] = String(r + 1);
      }
    }
    execution.blocks[String(idx + 1)] = { fields: fields };
    if (Object.keys(fields).some(function (k) { return k.indexOf("__sheetRow.") !== 0; })) {
      execution.activeBlockIndex = idx + 1;
    }
  });

  const url = "https://firestore.googleapis.com/v1/projects/" + FIREBASE_PROJECT_ID +
    "/databases/(default)/documents/brews/" + batch +
    "?updateMask.fieldPaths=brewingExecution&updateMask.fieldPaths=brewingExecutionUpdatedAt";

  const response = UrlFetchApp.fetch(url, {
    method: "patch",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({ fields: {
      brewingExecution: brewStageToFirestoreValue_(execution),
      brewingExecutionUpdatedAt: { timestampValue: new Date().toISOString() }
    }}),
    muteHttpExceptions: true
  });
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    throw new Error("1597 backfill failed: " + response.getResponseCode() + " " + response.getContentText());
  }
  console.log("1597 brewingExecution backfilled from Sheet");
  return execution;
}

function brewingSheetFindFermentorForBatch_(batchNumber) {
  const url = "https://firestore.googleapis.com/v1/projects/" + FIREBASE_PROJECT_ID +
    "/databases/(default)/documents/fermentors";
  const response = UrlFetchApp.fetch(url, {
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) return null;
  const body = JSON.parse(response.getContentText() || "{}");
  const docs = body.documents || [];
  for (let i = 0; i < docs.length; i++) {
    const fields = docs[i].fields || {};
    const rawBatch = fields.batchNumber && (fields.batchNumber.stringValue || fields.batchNumber.integerValue);
    if (String(rawBatch || "").replace("#", "").trim() !== String(batchNumber)) continue;
    return {
      tankNumber: String((fields.tankNumber && (fields.tankNumber.stringValue || fields.tankNumber.integerValue)) || ""),
      batchNumber: String(rawBatch || ""),
      sheetUrl: String((fields.sheetUrl && fields.sheetUrl.stringValue) || "")
    };
  }
  return null;
}

function brewingSheetFirestoreString_(value) {
  return { stringValue: String(value == null ? "" : value) };
}

function brewingSheetPersistExecutionCell_(fermentor, event) {
  if (!fermentor || !event || !event.range) return false;
  const batch = String(fermentor.batchNumber || "").replace("#", "").trim();
  if (!batch) return false;

  const range = event.range;
  // Single-cell edits are the normal fast path. Multi-cell pastes keep the
  // revision signal and are reconciled by the full parser instead of risking a
  // partial canonical write.
  if (range.getNumRows() !== 1 || range.getNumColumns() !== 1) return false;

  const row = range.getRow();
  const col = range.getColumn();
  const sheet = range.getSheet();
  const value = String(range.getDisplayValue() || "").trim();
  const data = sheet.getDataRange().getDisplayValues();

  // Find the nearest brew header above the edited row. Templates may move rows,
  // so block identity is discovered from labels, never absolute row numbers.
  const headers = findBrewBlockStarts(data);
  let blockIndex = 0;
  let blockStart = -1;
  headers.forEach(function (header, index) {
    if (header.row <= row - 1) {
      blockIndex = index + 1;
      blockStart = header.row;
    }
  });
  if (!blockIndex || blockStart < 0) return false;

  const label = String((data[row - 1] || [])[3] || "").trim();
  let key = "";

  const stagePatterns = [
    ["mashIn", /^הכנסת לתת$/i], ["rest1", /^השריה\s*1$/i],
    ["heat1", /^חימום\s*1$/i], ["rest2", /^השריה\s*2$/i],
    ["heat2", /^חימום\s*2$/i], ["rest3", /^השריה\s*3$/i],
    ["heat3", /^חימום\s*3$/i], ["transferLt", /^העברה\s+ל.*L\.?T\.?/i],
    ["restLt", /^מנוחה\s*L\.?T\.?/i], ["circulation", /^סחרור/i],
    ["outToBoil", /^הוצאה לבישול$/i], ["endTransfer", /^סוף העברה$/i],
    ["boil", /^(?:תחילת\s+)?רתיחה(?:\s+100°?C)?$/i],
    ["hop1", /^הוספת כ(?:שות|שת)\s*1$/i], ["hop2", /^הוספת כ(?:שות|שת)\s*2$/i],
    ["hop3", /^הוספת כ(?:שות|שת)\s*3$/i], ["wp", /סוף רתיחה.*תחילת\s*WP/i],
    ["outToFermentor", /^הוצאה לתסיסה$/i]
  ];
  for (let i = 0; i < stagePatterns.length && !key; i++) {
    if (!stagePatterns[i][1].test(label)) continue;
    if (col === 5) key = stagePatterns[i][0] + ".start";
    else if (col === 6) key = stagePatterns[i][0] + ".end";
    else if (col === 7) key = stagePatterns[i][0] + ".temp";
    else if (col === 8) key = stagePatterns[i][0] + ".note";
  }

  const rinse = /^שטיפה\s*(\d+)$/i.exec(label);
  if (!key && rinse) {
    if (col === 5) key = "rinse" + rinse[1] + ".time";
    else if (col === 6) key = "rinse" + rinse[1] + ".amount";
    else if (col === 7) key = "rinse" + rinse[1] + ".temp";
    else if (col === 8) key = "rinse" + rinse[1] + ".kettle";
  }
  if (!key) return false;

  const url =
    "https://firestore.googleapis.com/v1/projects/" + FIREBASE_PROJECT_ID +
    "/databases/(default)/documents/brews/" + encodeURIComponent(batch) +
    "?updateMask.fieldPaths=brewingExecution.blocks." + blockIndex + ".fields.%60" +
    encodeURIComponent(key) + "%60" +
    "&updateMask.fieldPaths=brewingExecution.batchNumber" +
    "&updateMask.fieldPaths=brewingExecution.updatedAt";

  const document = { fields: { brewingExecution: { mapValue: { fields: {
    batchNumber: brewingSheetFirestoreString_(batch),
    updatedAt: brewingSheetFirestoreString_(new Date().toISOString()),
    blocks: { mapValue: { fields: {} } }
  } } } } };
  const blockFields = {};
  blockFields[key] = brewingSheetFirestoreString_(value);
  document.fields.brewingExecution.mapValue.fields.blocks.mapValue.fields[String(blockIndex)] =
    { mapValue: { fields: { fields: { mapValue: { fields: blockFields } } } } };

  const response = UrlFetchApp.fetch(url, {
    method: "patch", contentType: "application/json",
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    payload: JSON.stringify(document), muteHttpExceptions: true
  });
  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error("Failed persisting brew execution cell for batch " + batch +
      ": " + code + " " + response.getContentText());
  }
  return true;
}

function brewingSheetOnEdit_(event) {
  if (!event || !event.source) return;

  const spreadsheetId = String(event.source.getId() || "").trim();
  if (!spreadsheetId) return;

  try {
    // Fast path: the reconciliation cycle remembers the tank for every active
    // brew Sheet. Publish the edit signal before doing the expensive full
    // fermentor lookup/stage parse, so an open app can react within seconds.
    const knownTank = brewingSheetKnownEditTank_(spreadsheetId);
    if (knownTank) brewingSheetPublishEditRevision_(knownTank, event);

    const fermentor = brewingSheetFindFermentorForSheet_(spreadsheetId);

    // The Sheet may still have a trigger briefly after the tank left ACTION 0.
    // Remove it lazily as well, so a missed client cleanup cannot leave stale
    // production triggers behind.
    if (!fermentor) {
      brewingSheetRemoveEditTrigger_({ spreadsheetId: spreadsheetId });
      return;
    }

    // Publish every manual edit immediately. The open app listens to the
    // fermentor document and reuses its canonical full-Sheet parser to pull the
    // changed value into brewingExecution/Firestore without waiting for the
    // hourly safety reconciliation.
    if (!knownTank) {
      brewingSheetRememberEditTank_(spreadsheetId, fermentor.tankNumber);
      brewingSheetPublishEditRevision_(fermentor.tankNumber, event);
    }

    // Persist the canonical execution even when no browser is open.
    brewingSheetPersistExecutionCell_(fermentor, event);

    const stageInfo = extractBrewStageInfo(spreadsheetId, fermentor);
    if (!stageInfo || !stageInfo.lastBlock) return;

    updateFermentorBrewProgress(fermentor.tankNumber, stageInfo);

    // Preserve the existing ACTION-0 completion semantics. A manual Sheet edit
    // can therefore finish the brew exactly like the scheduled reconciliation.
    if (stageInfo.beerVolume !== null && stageInfo.beerVolume !== undefined) {
      updateFermentorAction(fermentor.tankNumber, 1);
      brewingSheetRemoveEditTrigger_({ spreadsheetId: spreadsheetId });
      return;
    }

    if (stageInfo.hasUnstartedHeader) return;

    const outStage = stageInfo.lastBlock.stages.find(function (stage) {
      return stage.code === STAGE_CODE_OUT_TO_FERMENTOR;
    });

    if (
      outStage &&
      outStage.startDateTime &&
      Date.now() - outStage.startDateTime.getTime() >= ACTION_0_GRACE_MS
    ) {
      updateFermentorAction(fermentor.tankNumber, 1);
      brewingSheetRemoveEditTrigger_({ spreadsheetId: spreadsheetId });
    }
  } catch (error) {
    console.log(
      "brewingSheetOnEdit_ failed for " +
      spreadsheetId +
      ": " +
      (error && error.message ? error.message : error)
    );
  }
}


// Manual diagnostic: verifies the exact Drive write path used by brew creation.
// Creates a temporary copy of the single-brew template in the real destination
// folder and immediately trashes it. Does not touch Firestore or create a batch.
function diagnoseBrewingDriveCopy() {
  const config = brewingSheetConfig_();
  const templateId = config.templates && config.templates.single;
  const folderId = config.folderId;

  if (!templateId) throw new Error("Diagnostic: single template ID is missing");
  if (!folderId) throw new Error("Diagnostic: destination folder ID is missing");

  console.log("Diagnostic: resolving template");
  const template = DriveApp.getFileById(templateId);
  console.log("Diagnostic: template OK: " + template.getName());

  console.log("Diagnostic: resolving destination folder");
  const folder = DriveApp.getFolderById(folderId);
  console.log("Diagnostic: destination OK: " + folder.getName());

  let copy = null;
  try {
    console.log("Diagnostic: calling File.makeCopy");
    copy = template.makeCopy(
      "__BREWING_DRIVE_DIAGNOSTIC__ " + new Date().toISOString(),
      folder
    );
    console.log("Diagnostic: makeCopy OK: " + copy.getId());

    console.log("Diagnostic: trashing temporary copy");
    copy.setTrashed(true);
    console.log("Diagnostic: cleanup OK");
    return "BREWING DRIVE DIAGNOSTIC OK";
  } catch (error) {
    console.log(
      "Diagnostic FAILED" +
      (copy ? " after copy " + copy.getId() : " before copy completed") +
      ": " + (error && error.message ? error.message : error)
    );
    throw error;
  }
}
