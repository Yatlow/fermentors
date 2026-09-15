// ============================================================
// LOG PACKAGING TO MASTER SHEET (טבלת מעקב אריזה ראשית)
// https://docs.google.com/spreadsheets/d/13ONg8FJSy_5mHH8EbjNaVHph_nsTKdkVvoXMthJJPb8
//
// עמודות: A=חביות/ארגזים+סגנון | B=כמות | C=מס' אצווה | D=תאריך תוקף | E=תאריך ייצור
// ============================================================

const MASTER_PACKAGING_SPREADSHEET_ID = "13ONg8FJSy_5mHH8EbjNaVHph_nsTKdkVvoXMthJJPb8";
const MASTER_PACKAGING_SHEET_GID = 0;
const MASTER_PACKAGING_SHEET_CACHE_SECONDS = 21600;

// A POST can finish its side effect and still lose/corrupt the HTTP response
// on Google's redirect layer. The frontend therefore retries this specific
// action with the SAME requestId. ScriptProperties makes that retry idempotent.
const PACKAGING_REQUEST_CACHE_PREFIX = "packaging_request:";
const PACKAGING_REQUEST_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function logPackagingToMasterSheet(payload) {
  const startedAt = Date.now();
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

    const sheetTitle = getMasterPackagingSheetTitle_();
    const quotedTitle = quoteA1SheetName_(sheetTitle);

    // One Sheets API read replaces the old row-by-row SpreadsheetApp reads.
    // We still preserve holes: the first completely empty A:E row from row 2
    // is reused, otherwise we append after the last returned row.
    const response = Sheets.Spreadsheets.Values.get(
      MASTER_PACKAGING_SPREADSHEET_ID,
      quotedTitle + "!A:E",
      {
        valueRenderOption: "FORMATTED_VALUE",
        majorDimension: "ROWS"
      }
    );

    const rows = response.values || [];
    let targetRow = Math.max(rows.length + 1, 2);

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i] || [];
      let isEmpty = true;
      for (let c = 0; c < 5; c++) {
        if (String(row[c] || "").trim() !== "") {
          isEmpty = false;
          break;
        }
      }

      if (isEmpty) {
        targetRow = i + 1;
        break;
      }
    }

    const warnings = [];
    if (targetRow > 2) {
      const previousRow = rows[targetRow - 2] || [];
      const prevProdDateStr = String(previousRow[4] || "").trim();
      const prevDate = parseDDMMYYYYDate_(prevProdDateStr);
      const newDate = parseDDMMYYYYDate_(productionDateStr);
      if (prevDate && newDate && newDate < prevDate) {
        warnings.push(
          "תאריך הייצור של הרשומה החדשה (" + productionDateStr +
          ") מוקדם מתאריך הייצור בשורה הקודמת בטבלה (" + prevProdDateStr + ")"
        );
      }
    }

    Sheets.Spreadsheets.Values.update(
      {
        majorDimension: "ROWS",
        values: [[
          productLabel,
          quantity,
          batchNumber || "",
          expiryDateStr || "",
          productionDateStr || ""
        ]]
      },
      MASTER_PACKAGING_SPREADSHEET_ID,
      quotedTitle + "!A" + targetRow + ":E" + targetRow,
      { valueInputOption: "USER_ENTERED" }
    );

    const totalMs = Date.now() - startedAt;
    const result = {
      success: true,
      row: targetRow,
      warnings: warnings,
      requestId: normalizedRequestId || null,
      duplicate: false,
      fastPath: "sheets-api-master-packaging",
      totalMs: totalMs
    };

    // Save the idempotency result BEFORE returning the HTTP response. If Google
    // later serves a broken HTML response, the client's retry won't append again.
    if (normalizedRequestId) {
      savePackagingRequestResult_(normalizedRequestId, result);
    }

    Logger.log(
      "Master packaging sheet updated via Sheets API at row " + targetRow +
      " | total " + totalMs + "ms"
    );
    logToSheet(
      "Sheets API master packaging row=" + targetRow +
      " total=" + totalMs + "ms"
    );

    return result;

  } finally {
    lock.releaseLock();
  }
}

function getMasterPackagingSheetTitle_() {
  const cache = CacheService.getScriptCache();
  const key = "master_packaging_sheet_title:" + MASTER_PACKAGING_SPREADSHEET_ID;
  const cached = cache.get(key);
  if (cached) return cached;

  const metadata = Sheets.Spreadsheets.get(
    MASTER_PACKAGING_SPREADSHEET_ID,
    { fields: "sheets.properties" }
  );
  const sheets = metadata.sheets || [];
  let selected = null;

  for (let i = 0; i < sheets.length; i++) {
    const properties = sheets[i].properties || {};
    if (Number(properties.sheetId) === MASTER_PACKAGING_SHEET_GID) {
      selected = properties;
      break;
    }
  }

  if (!selected && sheets.length > 0) {
    selected = sheets[0].properties || null;
  }

  const title = selected && String(selected.title || "").trim();
  if (!title) throw new Error("Master packaging sheet tab not found");

  cache.put(key, title, MASTER_PACKAGING_SHEET_CACHE_SECONDS);
  return title;
}

function quoteA1SheetName_(name) {
  return "'" + String(name || "").replace(/'/g, "''") + "'";
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
  // Generic POST idempotency already handles the common case. Keep this legacy
  // cache tidy occasionally instead of scanning every ScriptProperty on every
  // packaging report.
  if (Math.random() > 0.02) return;

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
