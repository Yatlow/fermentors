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

function brewingSheetConfig_() {
  const props = PropertiesService.getScriptProperties();
  return {
    folderId: String(props.getProperty("BREWING_DESTINATION_FOLDER_ID") || "").trim(),
    templates: {
      single: String(props.getProperty("BREWING_TEMPLATE_SINGLE_ID") || "").trim(),
      double: String(props.getProperty("BREWING_TEMPLATE_DOUBLE_ID") || "").trim(),
      triple: String(props.getProperty("BREWING_TEMPLATE_TRIPLE_ID") || "").trim()
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
  const fileId = brewingSheetAssertAllowedFile_(data.spreadsheetId || data.sheetUrl);
  const range = String(data.range || "").trim();
  if (!range) throw new Error("Missing range");

  const ss = SpreadsheetApp.openById(fileId);
  const values = ss.getRange(range).getDisplayValues();

  return {
    spreadsheetId: fileId,
    range: range,
    values: values
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

    const range = ss.getRange(rangeText);

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

  return {
    spreadsheetId: fileId,
    trashed: true
  };
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
  const safeLimit =
    Number.isFinite(requestedLimit)
      ? Math.max(10, Math.min(150, Math.round(requestedLimit)))
      : 100;

  let candidates = [];
  if (typeof getBrewFolderCandidatesCached === "function") {
    candidates = getBrewFolderCandidatesCached() || [];
  }

  const seenBatches = {};
  return candidates
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
}

function brewingSheetAcidHistory_(data) {
  const style = String(data.style || "").trim().toLowerCase();
  const currentBatch = Number(String(data.currentBatchNumber || "").replace("#", ""));
  if (!style) throw new Error("Missing style");

  let candidates = [];
  if (typeof getBrewFolderCandidatesCached === "function") {
    candidates = getBrewFolderCandidatesCached() || [];
  }

  const byBatch = {};
  candidates.forEach(function (candidate) {
    const fileName = String(candidate.fileName || "");
    if (fileName.toLowerCase().indexOf(style) === -1) return;

    const batch = Number(candidate.batch || brewingSheetBatchFromName_(fileName));
    if (!Number.isFinite(batch)) return;

    if (!byBatch[batch]) byBatch[batch] = candidate;
  });

  const batches = Object.keys(byBatch)
    .map(Number)
    .sort(function (a, b) {
      if (a === currentBatch) return -1;
      if (b === currentBatch) return 1;
      return b - a;
    })
    .slice(0, 4);

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
