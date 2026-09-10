// ============================================================
// UPDATE PACKAGING INFO (ריק? / ארגזים / חביות)
// ============================================================

function updatePackagingInfo(
  sheetUrl,
  isEmpty,
  kegs,
  crates,
  totalLiters,
  shrinkagePercent
) {

  if (!sheetUrl) throw new Error("Missing sheetUrl");

  const spreadsheetId = extractSpreadsheetId(sheetUrl);
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sheet = ss.getSheets()[0];

  if (!sheet) throw new Error("No sheet found");

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {

    Logger.log("========================================");
    Logger.log("UPDATE PACKAGING INFO");
    Logger.log("Spreadsheet: " + spreadsheetId);

    const range = sheet.getDataRange();
    const values = range.getDisplayValues();
    const validations = range.getDataValidations();

    let updatedEmpty = false;
    let updatedKegs = false;
    let updatedCrates = false;
    let updatedTotal = false;
    const warnings = [];

    const boolValue =
      (isEmpty === true || String(isEmpty).trim().toUpperCase() === "TRUE");

    // ----------------------------------------------------------
    // 1. ריק? -> checkbox (לא מפיל את שאר הפונקציה אם נכשל)
    // ----------------------------------------------------------

    if (isEmpty !== undefined && isEmpty !== null) {

      try {

        const emptyLabelPos = findLabelCell(values, ["ריק"]);

        if (!emptyLabelPos) {
          throw new Error('Label "ריק?" not found');
        }

        const checkboxPos = findNearestCheckbox(
          validations,
          emptyLabelPos.row,
          emptyLabelPos.col
        );

        if (!checkboxPos) {
          throw new Error('Checkbox near "ריק?" not found');
        }

        sheet
          .getRange(checkboxPos.row + 1, checkboxPos.col + 1)
          .setValue(boolValue);

        updatedEmpty = true;

        Logger.log("ריק? -> " + boolValue);

      } catch (error) {

        Logger.log("WARNING: failed to update checkbox: " + error.message);
        warnings.push("checkbox: " + error.message);
      }
    }

    // ----------------------------------------------------------
    // 2. חביות / ארגזים
    // ----------------------------------------------------------

    if (kegs !== undefined && kegs !== null && kegs !== "") {
      try {
        updatedKegs = writeValueBelowLabel(sheet, values, ["חביות"], kegs);
      } catch (error) {
        Logger.log("WARNING: failed to update kegs: " + error.message);
        warnings.push("kegs: " + error.message);
      }
    }

    if (crates !== undefined && crates !== null && crates !== "") {
      try {
        updatedCrates = writeValueBelowLabel(sheet, values, ["ארגזים"], crates);
      } catch (error) {
        Logger.log("WARNING: failed to update crates: " + error.message);
        warnings.push("crates: " + error.message);
      }
    }

    // ----------------------------------------------------------
    // 3. סה"כ / פחת
    // ----------------------------------------------------------

    if (boolValue === true && totalLiters !== undefined && totalLiters !== null) {

      try {

        const totalLabelPos = findLabelCell(values, ['סה"כ', "סהכ"]);

        if (totalLabelPos) {
          sheet
            .getRange(totalLabelPos.row + 1, totalLabelPos.col)
            .setValue(Number(totalLiters));
          updatedTotal = true;
        } else {
          warnings.push('Label "סה"כ" not found');
        }

        if (shrinkagePercent !== undefined && shrinkagePercent !== null) {

          const shrinkageLabelPos = findLabelCell(values, ["פחת"]);

          if (shrinkageLabelPos) {
            const cell = sheet.getRange(shrinkageLabelPos.row + 1, shrinkageLabelPos.col);
            cell.setValue(Number(shrinkagePercent) / 100);
            cell.setNumberFormat("0.00%");
          } else {
            warnings.push('Label "פחת" not found');
          }
        }

      } catch (error) {
        Logger.log("WARNING: failed to update total/shrinkage: " + error.message);
        warnings.push("total/shrinkage: " + error.message);
      }
    }

    SpreadsheetApp.flush();

    Logger.log("UPDATE PACKAGING INFO DONE. Warnings: " + JSON.stringify(warnings));

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

/** יוצר או מעדכן דוקומנט לפי docId קבוע (upsert - לא יוצר כפילויות בהרצות חוזרות) */

// ============================================================
// NORMALIZE LABEL TEXT
// ============================================================
// מסיר ":" "?" ורווחים כדי שההשוואה תעבוד גם אם הסימנים
// מסודרים אחרת (":ריק?" מול "ריק:?" וכו')
// ============================================================

function normalizeLabel(text) {
  return String(text || "")
    .replace(/[:?？׃\-–—"'״׳]/g, "")   // הוספנו מקפים, מירכאות/גרשיים
    .replace(/\s+/g, "")
    .trim();
}


// ============================================================
// FIND LABEL CELL ANYWHERE IN SHEET
// ============================================================

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


// ============================================================
// FIND NEAREST CHECKBOX TO A GIVEN CELL
// ============================================================
// בודק data validation מסוג CHECKBOX בטווח סביב הכותרת,
// ובוחר את הקרוב ביותר (מרחק מנהטן).
// ============================================================

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


// ============================================================
// WRITE VALUE ONE ROW BELOW A LABEL CELL
// ============================================================

function writeValueBelowLabel(sheet, values, patterns, value) {

  const pos = findLabelCell(values, patterns);

  if (!pos) {
    throw new Error('Label "' + patterns[0] + '" not found');
  }

  const targetRow = pos.row + 2; // מרחב 0-אינדקס -> שורה מתחת -> 1-אינדקס
  const targetCol = pos.col + 1;

  sheet
    .getRange(targetRow, targetCol)
    .setValue(formatMeasurementValue(value));

  Logger.log(
    patterns[0] + " -> " + value +
    " (row " + targetRow + ", col " + targetCol + ")"
  );

  return true;
}

// ============================================================
// CHECK LEGACY PACKAGING CELL (fallback - raw value only)
// ============================================================

function checkLegacyPackagingCell(sheetUrl, cellType) {

  if (!sheetUrl) throw new Error("Missing sheetUrl");

  const spreadsheetId = extractSpreadsheetId(sheetUrl);
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sheet = ss.getSheets()[0];

  if (!sheet) throw new Error("No sheet found");

  const values = sheet.getDataRange().getDisplayValues();

  const label = cellType === "kegs" ? "חביות" : "ארגזים";
  const pos = findLabelCell(values, [label]);

  if (!pos) {
    return { rawValue: null, reason: 'Label "' + label + '" not found' };
  }

  const targetRow = pos.row + 2;
  const targetCol = pos.col + 1;

  const rawText = String(
    sheet.getRange(targetRow, targetCol).getDisplayValue() || ""
  ).trim();

  const rawValue = Number(rawText.replace(",", "."));

  Logger.log(
    "checkLegacyPackagingCell: " + label +
    " (row " + targetRow + ", col " + targetCol + ") = " + rawText
  );

  return {
    rawValue: Number.isFinite(rawValue) ? rawValue : null,
    cellType: cellType,
    row: targetRow,
    col: targetCol
  };
}