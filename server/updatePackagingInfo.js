// ============================================================
// UPDATE PACKAGING INFO (ריק? / ארגזים / חביות)
// ============================================================

const PACKAGING_LAYOUT_CACHE_SECONDS = 21600; // 6 hours

function roundPackagingValue_(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  return Math.round((numeric + Number.EPSILON) * 100) / 100;
}

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
    sheetId: sheet.getSheetId(),
    sheetName: sheet.getName(),
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

function getPackagingLayout_(spreadsheetId) {
  const cache = CacheService.getScriptCache();
  const key = "packaging_layout:" + spreadsheetId;
  const cached = cache.get(key);

  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (
        parsed &&
        typeof parsed === "object" &&
        Number.isFinite(Number(parsed.sheetId))
      ) {
        Logger.log("Packaging layout cache hit");
        return parsed;
      }
    } catch (error) {
      // fall through to discovery
    }
  }

  // Layout discovery still uses SpreadsheetApp because data-validation lookup is
  // concise and reliable here. This happens only on a cold cache. Once the
  // positions are known, every actual value mutation below goes through ONE
  // Sheets API batchUpdate call instead of several SpreadsheetApp setValue calls.
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sheet = ss.getSheets()[0];
  if (!sheet) throw new Error("No sheet found");
  return discoverPackagingLayout_(sheet, spreadsheetId);
}

function packagingUserEnteredValue_(value) {
  if (typeof value === "boolean") {
    return { boolValue: value };
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return { numberValue: value };
  }

  const text = String(value ?? "");
  const normalized = text.trim().replace(",", ".");
  if (normalized !== "" && Number.isFinite(Number(normalized))) {
    return { numberValue: Number(normalized) };
  }

  return { stringValue: text };
}

function packagingUpdateCellRequest_(sheetId, target, value, numberFormat) {
  const cell = {
    userEnteredValue: packagingUserEnteredValue_(value)
  };
  let fields = "userEnteredValue";

  if (numberFormat) {
    cell.userEnteredFormat = {
      numberFormat: numberFormat
    };
    fields += ",userEnteredFormat.numberFormat";
  }

  return {
    updateCells: {
      range: {
        sheetId: Number(sheetId),
        startRowIndex: target.row - 1,
        endRowIndex: target.row,
        startColumnIndex: target.col - 1,
        endColumnIndex: target.col
      },
      rows: [{ values: [cell] }],
      fields: fields
    }
  };
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
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const layout = getPackagingLayout_(spreadsheetId);
    const requests = [];
    let updatedEmpty = false;
    let updatedKegs = false;
    let updatedCrates = false;
    let updatedTotal = false;
    const warnings = [];

    const boolValue =
      isEmpty === true || String(isEmpty).trim().toUpperCase() === "TRUE";

    if (isEmpty !== undefined && isEmpty !== null) {
      if (layout.checkbox) {
        requests.push(
          packagingUpdateCellRequest_(layout.sheetId, layout.checkbox, boolValue)
        );
        updatedEmpty = true;
      } else {
        warnings.push('checkbox: Checkbox near "ריק?" not found');
      }
    }

    if (kegs !== undefined && kegs !== null && kegs !== "") {
      if (layout.kegs) {
        requests.push(
          packagingUpdateCellRequest_(
            layout.sheetId,
            layout.kegs,
            roundPackagingValue_(formatMeasurementValue(kegs))
          )
        );
        updatedKegs = true;
      } else {
        warnings.push('kegs: Label "חביות" not found');
      }
    }

    if (crates !== undefined && crates !== null && crates !== "") {
      if (layout.crates) {
        requests.push(
          packagingUpdateCellRequest_(
            layout.sheetId,
            layout.crates,
            roundPackagingValue_(formatMeasurementValue(crates))
          )
        );
        updatedCrates = true;
      } else {
        warnings.push('crates: Label "ארגזים" not found');
      }
    }

    if (boolValue === true && totalLiters !== undefined && totalLiters !== null) {
      if (layout.total) {
        requests.push(
          packagingUpdateCellRequest_(
            layout.sheetId,
            layout.total,
            roundPackagingValue_(totalLiters),
            { type: "NUMBER", pattern: "0.00" }
          )
        );
        updatedTotal = true;
      } else {
        warnings.push('Label "סה"כ" not found');
      }

      if (shrinkagePercent !== undefined && shrinkagePercent !== null) {
        if (layout.shrinkage) {
          const roundedShrinkagePercent = roundPackagingValue_(shrinkagePercent);
          requests.push(
            packagingUpdateCellRequest_(
              layout.sheetId,
              layout.shrinkage,
              Number(roundedShrinkagePercent) / 100,
              { type: "PERCENT", pattern: "0.00%" }
            )
          );
        } else {
          warnings.push('Label "פחת" not found');
        }
      }
    }

    if (requests.length > 0) {
      Sheets.Spreadsheets.batchUpdate(
        { requests: requests },
        spreadsheetId
      );
    }

    const totalMs = Date.now() - startedAt;
    Logger.log(
      "UPDATE PACKAGING INFO via Sheets API DONE | total " +
      totalMs + "ms | warnings=" + JSON.stringify(warnings)
    );
    logToSheet(
      "Sheets API packaging info spreadsheet=" + spreadsheetId +
      " requests=" + requests.length +
      " total=" + totalMs + "ms"
    );

    return {
      success: true,
      updatedEmpty: updatedEmpty,
      updatedKegs: updatedKegs,
      updatedCrates: updatedCrates,
      updatedTotal: updatedTotal,
      warnings: warnings,
      spreadsheetId: spreadsheetId,
      sheetName: layout.sheetName || "",
      sheetUrl: sheetUrl,
      fastPath: "sheets-api-packaging",
      totalMs: totalMs
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
  sheet.getRange(targetRow, targetCol).setValue(roundPackagingValue_(formatMeasurementValue(value)));
  return true;
}

function checkLegacyPackagingCell(sheetUrl, cellType) {
  if (!sheetUrl) throw new Error("Missing sheetUrl");

  const spreadsheetId = extractSpreadsheetId(sheetUrl);
  const layout = getPackagingLayout_(spreadsheetId);
  const target = cellType === "kegs" ? layout.kegs : layout.crates;
  const label = cellType === "kegs" ? "חביות" : "ארגזים";

  if (!target) {
    return { rawValue: null, reason: 'Label "' + label + '" not found' };
  }

  const response = Sheets.Spreadsheets.Values.get(
    spreadsheetId,
    columnToLetter_(target.col) + target.row,
    { valueRenderOption: "FORMATTED_VALUE" }
  );
  const rawText = String(
    response.values && response.values[0] && response.values[0][0] || ""
  ).trim();
  const rawValue = Number(rawText.replace(",", "."));

  return {
    rawValue: Number.isFinite(rawValue) ? roundPackagingValue_(rawValue) : null,
    cellType: cellType,
    row: target.row,
    col: target.col
  };
}

function columnToLetter_(column) {
  let result = "";
  let n = Number(column);
  while (n > 0) {
    n -= 1;
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}
