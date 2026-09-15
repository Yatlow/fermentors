// ============================================================
// LOG PACKAGING TO MASTER SHEET (טבלת מעקב אריזה ראשית)
// https://docs.google.com/spreadsheets/d/13ONg8FJSy_5mHH8EbjNaVHph_nsTKdkVvoXMthJJPb8
//
// עמודות: A=חביות/ארגזים+סגנון | B=כמות | C=מס' אצווה | D=תאריך תוקף | E=תאריך ייצור
// ============================================================

const MASTER_PACKAGING_SPREADSHEET_ID = "13ONg8FJSy_5mHH8EbjNaVHph_nsTKdkVvoXMthJJPb8";
const MASTER_PACKAGING_SHEET_GID = 0;

// A POST can finish its side effect and still lose/corrupt the HTTP response
// on Google's redirect layer. The frontend therefore retries this specific
// action with the SAME requestId. ScriptProperties makes that retry idempotent.
const PACKAGING_REQUEST_CACHE_PREFIX = "packaging_request:";
const PACKAGING_REQUEST_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function logPackagingToMasterSheet(payload) {
  const {
    productLabel,
    quantity,
    batchNumber,
    expiryDateStr,
    productionDateStr,
    requestId
  } = payload;

  if (!productLabel || quantity === undefined || quantity === null) {
    throw new Error("Missing productLabel/quantity for master sheet log");
  }

  const normalizedRequestId = String(requestId || "").trim();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    cleanupPackagingRequestCache_();

    if (normalizedRequestId) {
      const cached = getPackagingRequestResult_(normalizedRequestId);
      if (cached) {
        Logger.log(
          "Duplicate packaging request ignored: " + normalizedRequestId +
          " -> row " + cached.row
        );

        return Object.assign({}, cached, {
          duplicate: true,
          requestId: normalizedRequestId
        });
      }
    }

    const ss = SpreadsheetApp.openById(MASTER_PACKAGING_SPREADSHEET_ID);
    const sheet = getSheetByGid_(ss, MASTER_PACKAGING_SHEET_GID);
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

    const result = {
      success: true,
      row: targetRow,
      warnings: warnings,
      requestId: normalizedRequestId || null,
      duplicate: false
    };

    // Save the idempotency result BEFORE returning the HTTP response. If Google
    // later serves a broken HTML response, the client's retry won't append again.
    if (normalizedRequestId) {
      savePackagingRequestResult_(normalizedRequestId, result);
    }

    Logger.log(
      "Master packaging sheet updated at row " + targetRow +
      ": " + JSON.stringify(payload)
    );

    return result;

  } finally {
    lock.releaseLock();
  }
}

function getPackagingRequestResult_(requestId) {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(PACKAGING_REQUEST_CACHE_PREFIX + requestId);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    const savedAt = Number(parsed.savedAt || 0);

    if (!savedAt || Date.now() - savedAt > PACKAGING_REQUEST_CACHE_TTL_MS) {
      props.deleteProperty(PACKAGING_REQUEST_CACHE_PREFIX + requestId);
      return null;
    }

    return parsed.result || null;
  } catch (error) {
    props.deleteProperty(PACKAGING_REQUEST_CACHE_PREFIX + requestId);
    return null;
  }
}

function savePackagingRequestResult_(requestId, result) {
  PropertiesService.getScriptProperties().setProperty(
    PACKAGING_REQUEST_CACHE_PREFIX + requestId,
    JSON.stringify({
      savedAt: Date.now(),
      result: result
    })
  );
}

function cleanupPackagingRequestCache_() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const now = Date.now();

  Object.keys(all).forEach(function (key) {
    if (key.indexOf(PACKAGING_REQUEST_CACHE_PREFIX) !== 0) return;

    try {
      const parsed = JSON.parse(all[key]);
      const savedAt = Number(parsed.savedAt || 0);
      if (!savedAt || now - savedAt > PACKAGING_REQUEST_CACHE_TTL_MS) {
        props.deleteProperty(key);
      }
    } catch (error) {
      props.deleteProperty(key);
    }
  });
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
// post.js routes data.action === "logPackagingToMasterSheet" here and returns
// the result as JSON. Keep all idempotency logic in this service so doPost stays
// a thin router.
