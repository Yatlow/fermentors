// ============================================================
// LOG PACKAGING TO MASTER SHEET (טבלת מעקב אריזה ראשית)
// https://docs.google.com/spreadsheets/d/13ONg8FJSy_5mHH8EbjNaVHph_nsTKdkVvoXMthJJPb8
//
// עמודות: A=חביות/ארגזים+סגנון | B=כמות | C=מס' אצווה | D=תאריך תוקף | E=תאריך ייצור
// ============================================================

const MASTER_PACKAGING_SPREADSHEET_ID = "13ONg8FJSy_5mHH8EbjNaVHph_nsTKdkVvoXMthJJPb8";
const MASTER_PACKAGING_SHEET_GID = 0;

function logPackagingToMasterSheet(payload) {
  const { productLabel, quantity, batchNumber, expiryDateStr, productionDateStr } = payload;

  if (!productLabel || quantity === undefined || quantity === null) {
    throw new Error("Missing productLabel/quantity for master sheet log");
  }

  const ss = SpreadsheetApp.openById(MASTER_PACKAGING_SPREADSHEET_ID);
  const sheet = getSheetByGid_(ss, MASTER_PACKAGING_SHEET_GID);

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const lastRow = sheet.getLastRow();

    // מוצאים את השורה הריקה הראשונה (עמודות A-E) החל משורה 2
    let targetRow = lastRow + 1;
    for (let r = 2; r <= lastRow + 1; r++) {
      const rowValues = sheet.getRange(r, 1, 1, 5).getDisplayValues()[0];
      const isRowEmpty = rowValues.every((v) => String(v).trim() === "");
      if (isRowEmpty) {
        targetRow = r;
        break;
      }
    }

    // ולידציה: תאריך הייצור החדש לא אמור להיות מוקדם מתאריך הייצור בשורה הקודמת.
    // לא חוסם את הכתיבה - רק מחזיר אזהרה, כדי לא לתקוע דיווח בגלל שעון/סדר לא צפוי.
    const warnings = [];
    if (targetRow > 2) {
      const prevProdDateStr = sheet.getRange(targetRow - 1, 5).getDisplayValue();
      const prevDate = parseDDMMYYYYDate_(prevProdDateStr);
      const newDate = parseDDMMYYYYDate_(productionDateStr);
      if (prevDate && newDate && newDate < prevDate) {
        warnings.push(
          "תאריך הייצור של הרשומה החדשה (" + productionDateStr +
          ") מוקדם מתאריך הייצור בשורה הקודמת בטבלה (" + prevProdDateStr + ")"
        );
      }
    }

    sheet
      .getRange(targetRow, 1, 1, 5)
      .setValues([[productLabel, quantity, batchNumber || "", expiryDateStr || "", productionDateStr || ""]]);

    SpreadsheetApp.flush();

    Logger.log("Master packaging sheet updated at row " + targetRow + ": " + JSON.stringify(payload));

    return { success: true, row: targetRow, warnings: warnings };

  } finally {
    lock.releaseLock();
  }
}

function getSheetByGid_(ss, gid) {
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    if (sheets[i].getSheetId() === gid) return sheets[i];
  }
  return ss.getSheets()[0];
}

function parseDDMMYYYYDate_(str) {
  if (!str) return null;
  const parts = String(str).split("/");
  if (parts.length !== 3) return null;
  const d = Number(parts[0]);
  const m = Number(parts[1]);
  const y = Number(parts[2]);
  if (!d || !m || !y) return null;
  return new Date(y, m - 1, d);
}

// ============================================================
// חיבור ל-doPost הקיים
// ============================================================
// אצלך כבר יש doPost שמנתב לפי data.action (כמו ל-"updatePackagingInfo").
// יש להוסיף שם ענף נוסף, לדוגמה:
//
// if (data.action === "logPackagingToMasterSheet") {
//   const result = logPackagingToMasterSheet(data);
//   return ContentService
//     .createTextOutput(JSON.stringify({ success: true, result: result }))
//     .setMimeType(ContentService.MimeType.JSON);
// }