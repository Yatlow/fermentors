// ============================================================
// UPDATE PACKAGING INFO (ריק? / ארגזים / חביות)
// ============================================================

const PACKAGING_LAYOUT_CACHE_SECONDS = 21600; // 6 hours

function normalizeLabel(text) {
  return String(text || "")
    .replace(/[:?？׃\-–—"'״׳]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function findLabelCell(values, patterns) {
  const normalizedPatterns = patterns.map(normalizeLabel);

  for (let r = 0; r < values.length; r++) {
    for (let c = 0; c < values[r].length; c++) {
      const cellNorm = normalizeLabel(values[r][c]);
      if (!cellNorm) continue;
      if (normalizedPatterns.indexOf(cellNorm) !== -1) {
        return { row: r, col: c };
      }
    }
  }

  return null;
}

function findNearestCheckbox(validations, row, col) {
  let best = null;
  let bestDist = Infinity;
  const radius = 3;
  const rStart = Math.max(0, row - radius);
  const rEnd = Math.min(validations.length, row + radius + 1);

  for (let r = rStart; r < rEnd; r++) {
    const cStart = Math.max(0, col - radius);
    const cEnd = Math.min(validations[r].length, col + radius + 1);

    for (let c = cStart; c < cEnd; c++) {
      const rule = validations[r][c];
      if (!rule) continue;

      if (rule.getCriteriaType() === SpreadsheetApp.DataValidationCriteria.CHECKBOX) {
        const dist = Math.abs(r - row) + Math.abs(c - col);
        if (dist < bestDist) {
          bestDist = dist;
          best = { row: r, col: c };
        }
      }
    }
  }

  return best;
}

function packagingTargetBelowLabel_(pos) {
  return pos ? { row: pos.row + 2, col: pos.col + 1 } : null;
}

function packagingTargetLeftOfLabel_(pos) {
  // Existing sheet convention: value is one displayed cell to the left in RTL,
  // which is the same 1-based column number as the label's zero-based col.
  return pos ? { row: pos.row + 1, col: pos.col } : null;
}

function discoverPackagingLayout_(sheet, spreadsheetId) {
  const lastRow = Math.max(sheet.getLastRow(), 1);
  // Current brew templates use at most A:J for these fields. Reading only A:J
  // avoids pulling unrelated formatted columns from large sheets.
  const width = Math.max(1, Math.min(Math.max(sheet.getLastColumn(), 1), 10));
  const range = sheet.getRange(1, 1, lastRow, width);
  const values = range.getDisplayValues();
  const validations = range.getDataValidations();

  const emptyLabel = findLabelCell(values, ["ריק"]);
  const kegsLabel = findLabelCell(values, ["חביות"]);
  const cratesLabel = findLabelCell(values, ["ארגזים"]);
  const totalLabel = findLabelCell(values, ['סה"כ', "סהכ"]);
  const shrinkageLabel = findLabelCell(values, ["פחת"]);
  const checkbox = emptyLabel
    ? findNearestCheckbox(validations, emptyLabel.row, emptyLabel.col)
    : null;

  const layout = {
    checkbox: checkbox ? { row: checkbox.row + 1, col: checkbox.col + 1 } : null,
    kegs: packagingTargetBelowLabel_(kegsLabel),
    crates: packagingTargetBelowLabel_(cratesLabel),
    total: packagingTargetLeftOfLabel_(totalLabel),
    shrinkage: packagingTargetLeftOfLabel_(shrinkageLabel)
  };

  CacheService.getScriptCache().put(
    "packaging_layout:" + spreadsheetId,
    JSON.stringify(layout),
    PACKAGING_LAYOUT_CACHE_SECONDS
  );

  return layout;
}

function getPackagingLayout_(sheet, spreadsheetId) {
  const cache = CacheService.getScriptCache();
  const key = "packaging_layout:" + spreadsheetId;
  const cached = cache.get(key);

  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed && typeof parsed === "object") {
        Logger.log("Packaging layout cache hit");
        return parsed;
      }
    } catch (error) {
      // fall through to discovery
    }
  }

  return discoverPackagingLayout_(sheet, spreadsheetId);
}

function updatePackagingInfo(
  sheetUrl,
  isEmpty,
  kegs,
  crates,
  totalLiters,
  shrinkagePercent
) {
  const startedAt = Date.now();

  if (!sheetUrl) throw new Error("Missing sheetUrl");

  const spreadsheetId = extractSpreadsheetId(sheetUrl);
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sheet = ss.getSheets()[0];
  if (!sheet) throw new Error("No sheet found");

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const layout = getPackagingLayout_(sheet, spreadsheetId);
    let updatedEmpty = false;
    let updatedKegs = false;
    let updatedCrates = false;
    let updatedTotal = false;
    const warnings = [];

    const boolValue =
      isEmpty === true || String(isEmpty).trim().toUpperCase() === "TRUE";

    if (isEmpty !== undefined && isEmpty !== null) {
      if (layout.checkbox) {
        sheet.getRange(layout.checkbox.row, layout.checkbox.col).setValue(boolValue);
        updatedEmpty = true;
      } else {
        warnings.push('checkbox: Checkbox near "ריק?" not found');
      }
    }

    if (kegs !== undefined && kegs !== null && kegs !== "") {
      if (layout.kegs) {
        sheet
          .getRange(layout.kegs.row, layout.kegs.col)
          .setValue(formatMeasurementValue(kegs));
        updatedKegs = true;
      } else {
        warnings.push('kegs: Label "חביות" not found');
      }
    }

    if (crates !== undefined && crates !== null && crates !== "") {
      if (layout.crates) {
        sheet
          .getRange(layout.crates.row, layout.crates.col)
          .setValue(formatMeasurementValue(crates));
        updatedCrates = true;
      } else {
        warnings.push('crates: Label "ארגזים" not found');
      }
    }

    if (boolValue === true && totalLiters !== undefined && totalLiters !== null) {
      if (layout.total) {
        sheet
          .getRange(layout.total.row, layout.total.col)
          .setValue(Number(totalLiters));
        updatedTotal = true;
      } else {
        warnings.push('Label "סה"כ" not found');
      }

      if (shrinkagePercent !== undefined && shrinkagePercent !== null) {
        if (layout.shrinkage) {
          sheet
            .getRange(layout.shrinkage.row, layout.shrinkage.col)
            .setValue(Number(shrinkagePercent) / 100)
            .setNumberFormat("0.00%");
        } else {
          warnings.push('Label "פחת" not found');
        }
      }
    }

    // No SpreadsheetApp.flush(): Apps Script commits pending changes when the
    // execution completes. A forced flush adds a synchronous Sheets round trip.
    Logger.log(
      "UPDATE PACKAGING INFO DONE | total " +
      (Date.now() - startedAt) + "ms | warnings=" + JSON.stringify(warnings)
    );

    return {
      success: true,
      updatedEmpty: updatedEmpty,
      updatedKegs: updatedKegs,
      updatedCrates: updatedCrates,
      updatedTotal: updatedTotal,
      warnings: warnings,
      spreadsheetId: spreadsheetId,
      sheetName: sheet.getName(),
      sheetUrl: ss.getUrl()
    };
  } finally {
    lock.releaseLock();
  }
}

// Kept for legacy callers.
function writeValueBelowLabel(sheet, values, patterns, value) {
  const pos = findLabelCell(values, patterns);
  if (!pos) {
    throw new Error('Label "' + patterns[0] + '" not found');
  }

  const targetRow = pos.row + 2;
  const targetCol = pos.col + 1;
  sheet.getRange(targetRow, targetCol).setValue(formatMeasurementValue(value));
  return true;
}

function checkLegacyPackagingCell(sheetUrl, cellType) {
  if (!sheetUrl) throw new Error("Missing sheetUrl");

  const spreadsheetId = extractSpreadsheetId(sheetUrl);
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sheet = ss.getSheets()[0];
  if (!sheet) throw new Error("No sheet found");

  const layout = getPackagingLayout_(sheet, spreadsheetId);
  const target = cellType === "kegs" ? layout.kegs : layout.crates;
  const label = cellType === "kegs" ? "חביות" : "ארגזים";

  if (!target) {
    return { rawValue: null, reason: 'Label "' + label + '" not found' };
  }

  const rawText = String(
    sheet.getRange(target.row, target.col).getDisplayValue() || ""
  ).trim();
  const rawValue = Number(rawText.replace(",", "."));

  return {
    rawValue: Number.isFinite(rawValue) ? rawValue : null,
    cellType: cellType,
    row: target.row,
    col: target.col
  };
}
