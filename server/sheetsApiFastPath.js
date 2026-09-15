// ============================================================
// SHEETS API FAST PATHS
// ============================================================
//
// SpreadsheetApp is convenient but relatively expensive for tiny mutations.
// Cellar actions such as yeast drop / cooling usually only append text to the
// notes cell of today's fermentation row. For those writes we use the Sheets
// Advanced Service directly and avoid SpreadsheetApp.openById() entirely.
//
// Returning null means "fall back to the existing SpreadsheetApp path".
// ============================================================

function isNoteOnlyFermentationReading_(reading) {
  if (!reading) return false;

  const hasNumericMeasurement = [
    reading.temp,
    reading.pressure,
    reading.plato,
    reading.pH,
    reading.carbonation
  ].some(function (value) {
    return value !== undefined && value !== null && value !== "";
  });

  const hasNotes =
    reading.notes !== undefined &&
    reading.notes !== null &&
    String(reading.notes).trim() !== "";

  // Packaging intentionally remains on the full path because boldNotes keeps
  // its RichText formatting semantics.
  return !hasNumericMeasurement && hasNotes && reading.boldNotes !== true;
}

function addFermentationNoteViaSheetsApi_(sheetUrl, notes) {
  const startedAt = Date.now();

  if (!sheetUrl) throw new Error("Missing sheetUrl");

  const spreadsheetId = extractSpreadsheetId(sheetUrl);
  const clock = getJerusalemMeasurementClock_();
  const cache = CacheService.getScriptCache();
  const todayKey = "fermentation_today:" + spreadsheetId + ":" + clock.dateKey;
  const cachedTodayRow = Number(cache.get(todayKey));

  let targetRow = -1;
  let rowValues = null;
  let createdTodayRow = false;

  // Best case: a measurement earlier today already populated this cache. Read
  // only that one row, validate the date, then update H in one API write.
  if (Number.isFinite(cachedTodayRow) && cachedTodayRow >= 1) {
    const cachedResponse = Sheets.Spreadsheets.Values.get(
      spreadsheetId,
      "A" + cachedTodayRow + ":H" + cachedTodayRow,
      { valueRenderOption: "FORMATTED_VALUE", majorDimension: "ROWS" }
    );

    const cachedRows = cachedResponse.values || [];
    const cachedRow = cachedRows[0] || [];

    if (fermentationDateMatchesToday_(cachedRow[0], clock)) {
      targetRow = cachedTodayRow;
      rowValues = cachedRow;
      Logger.log("Sheets API note: today-row cache hit at row " + targetRow);
    }
  }

  // Cache miss/stale cache: one API read of A:H. Find the fermentation header,
  // then search rows below it. If today's row does not exist yet, create it via
  // Sheets API as well instead of falling back to SpreadsheetApp.openById().
  if (targetRow === -1) {
    const response = Sheets.Spreadsheets.Values.get(
      spreadsheetId,
      "A:H",
      { valueRenderOption: "FORMATTED_VALUE", majorDimension: "ROWS" }
    );

    const rows = response.values || [];
    let headerIndex = -1;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] || [];
      const labels = row.map(function (value) {
        return String(value || "").trim();
      });

      if (
        labels.indexOf("תאריך") !== -1 &&
        labels.indexOf("שעה") !== -1 &&
        labels.indexOf("טמפרטורה") !== -1
      ) {
        headerIndex = i;
        break;
      }
    }

    if (headerIndex === -1) {
      Logger.log("Sheets API note: fermentation header not found; falling back");
      return null;
    }

    let lastMeasurementRow = headerIndex + 1;

    for (let i = headerIndex + 1; i < rows.length; i++) {
      const row = rows[i] || [];
      const rawDate = String(row[0] || "").trim();

      if (rawDate && parseIsraeliDate(rawDate)) {
        lastMeasurementRow = i + 1;
      }

      if (fermentationDateMatchesToday_(rawDate, clock)) {
        targetRow = i + 1; // API arrays are zero-based; Sheets rows are 1-based.
        rowValues = row;
      }
    }

    if (targetRow === -1) {
      targetRow = lastMeasurementRow + 1;
      const existingTarget = rows[targetRow - 1] || [];
      const occupied = existingTarget.some(function (value) {
        return String(value || "").trim() !== "";
      });

      if (occupied) {
        throw new Error(
          "SAFETY STOP: Sheets API note target row " + targetRow +
          " is not empty. Nothing was written."
        );
      }

      const newNotes = String(notes || "").trim();
      const newRow = [
        clock.dateText,
        clock.timeText,
        "",
        "",
        "",
        "",
        "",
        newNotes
      ];

      // USER_ENTERED preserves the spreadsheet's normal date/time semantics and
      // existing column formatting while still avoiding SpreadsheetApp entirely.
      Sheets.Spreadsheets.Values.update(
        {
          majorDimension: "ROWS",
          values: [newRow]
        },
        spreadsheetId,
        "A" + targetRow + ":H" + targetRow,
        { valueInputOption: "USER_ENTERED" }
      );

      rowValues = newRow;
      createdTodayRow = true;
      cache.put(todayKey, String(targetRow), 21600);

      const createTotalMs = Date.now() - startedAt;
      Logger.log(
        "Sheets API note: created row " + targetRow +
        " | total " + createTotalMs + "ms"
      );
      logToSheet(
        "Sheets API fermentation note row=" + targetRow +
        " created=true total=" + createTotalMs + "ms"
      );

      return {
        success: true,
        overwritten: false,
        spreadsheetId: spreadsheetId,
        row: targetRow,
        date: clock.dateText,
        time: clock.timeText,
        sugar: "",
        temperature: "",
        pressure: "",
        pH: "",
        carbonation: "",
        notes: newNotes,
        sheetUrl: sheetUrl,
        fastPath: "sheets-api-note-create",
        totalMs: createTotalMs
      };
    }
  }

  while (rowValues.length < 8) rowValues.push("");

  const oldNotes = String(rowValues[7] || "").trim();
  const newNotes = String(notes || "").trim();
  const mergedNotes = oldNotes && newNotes
    ? oldNotes + " | " + newNotes
    : (newNotes || oldNotes);

  if (!createdTodayRow) {
    Sheets.Spreadsheets.Values.update(
      {
        majorDimension: "ROWS",
        values: [[mergedNotes]]
      },
      spreadsheetId,
      "H" + targetRow,
      { valueInputOption: "RAW" }
    );
  }

  cache.put(todayKey, String(targetRow), 21600);

  const totalMs = Date.now() - startedAt;
  Logger.log(
    "Sheets API note: updated H" + targetRow +
    " | total " + totalMs + "ms"
  );
  logToSheet(
    "Sheets API fermentation note row=" + targetRow +
    " total=" + totalMs + "ms"
  );

  return {
    success: true,
    overwritten: true,
    spreadsheetId: spreadsheetId,
    row: targetRow,
    date: clock.dateText,
    time: String(rowValues[1] || clock.timeText).trim(),
    sugar: rowValues[2] || "",
    temperature: rowValues[3] || "",
    pressure: rowValues[4] || "",
    pH: rowValues[5] || "",
    carbonation: rowValues[6] || "",
    notes: mergedNotes,
    sheetUrl: sheetUrl,
    fastPath: "sheets-api-note",
    totalMs: totalMs
  };
}
