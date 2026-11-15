/**
 * Warm-incubator tests are append-only action notes in the ORIGINAL batch
 * fermentation table. They deliberately do not populate the daily sugar column
 * and never overwrite an existing daily measurement, even on the same date.
 *
 * The POST idempotency receipt and the stable recordedAt+note provide two
 * safeguards against duplicate rows on maintenance retries.
 */
function appendWarmFermentationTest_(test, requestId) {
  if (!test || !/^\d+$/.test(String(test.batchNumber || ""))) {
    throw new Error("Warm test missing valid batch number");
  }
  var value = Number(test.plato);
  if (!isFinite(value) || value < 0 || value > 40) {
    throw new Error("Warm test Plato out of range");
  }
  if (!/^https:\/\//.test(String(test.sheetUrl || ""))) {
    throw new Error("Warm test missing Sheet URL");
  }
  var recordedAt = new Date(String(test.recordedAt || ""));
  if (isNaN(recordedAt.getTime())) throw new Error("Warm test missing timestamp");
  var timezone = "Asia/Jerusalem";
  var dateText = Utilities.formatDate(recordedAt, timezone, "dd/MM/yyyy");
  var timeText = Utilities.formatDate(recordedAt, timezone, "HH:mm");
  var note = "בדיקת תסיסה חמה " + (test.packaged === true ? "לאחר אריזה " : "") +
    String(value) + "°P";
  var spreadsheetId = extractSpreadsheetId(test.sheetUrl);
  var ss = SpreadsheetApp.openById(spreadsheetId);
  var sheet = ss.getSheets()[0];
  if (!sheet) throw new Error("Warm test fermentation sheet unavailable");
  if (test.packaged !== true) {
    // A batch still in a tank uses the existing safe same-day notes writer;
    // appending an extra today's row could become the latest cellar
    // measurement and accidentally hide actual daily Plato / pressure.
    var inTankResult = addFermentationNoteFast_(ss, sheet, spreadsheetId, note, Date.now());
    return {
      success: true, batchNumber: String(test.batchNumber),
      row: inTankResult.row, date: inTankResult.date, time: inTankResult.time,
      notes: inTankResult.notes, sheetUrl: ss.getUrl(), requestId: String(requestId || "")
    };
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var lastRow = Math.max(sheet.getLastRow(), 1);
    var headerRow = getCachedFermentationHeaderRow_(sheet, spreadsheetId, lastRow);
    var count = Math.max(lastRow - headerRow, 0);
    var rows = count > 0
      ? sheet.getRange(headerRow + 1, 1, count, 8).getDisplayValues() : [];
    var lastFermentationRow = headerRow;
    for (var i = 0; i < rows.length; i++) {
      var date = String(rows[i][0] || "").trim();
      var time = String(rows[i][1] || "").trim();
      var existingNote = String(rows[i][7] || "").trim();
      // Repeating the same request after an interrupted response must not
      // insert a second note line. Legitimate later tests have a new timestamp.
      if (date === dateText && time === timeText && existingNote === note) {
        return { success: true, row: headerRow + i + 1, date: dateText,
          time: timeText, notes: note, duplicate: true };
      }
      if (parseIsraeliDate(date)) {
        lastFermentationRow = headerRow + i + 1;
      } else if (lastFermentationRow > headerRow &&
                 rows[i].some(function (cell) { return String(cell || "").trim() !== ""; })) {
        break; // Do not scan into later hop/packaging sections.
      }
    }
    var targetRow = lastFermentationRow + 1;
    if (targetRow > sheet.getMaxRows()) {
      sheet.insertRowsAfter(sheet.getMaxRows(), targetRow - sheet.getMaxRows());
    } else {
      var occupied = sheet.getRange(targetRow, 1, 1, 8).getDisplayValues()[0]
        .some(function (cell) { return String(cell || "").trim() !== ""; });
      if (occupied) sheet.insertRowsBefore(targetRow, 1);
    }
    sheet.getRange(targetRow, 1, 1, 8).setValues([[
      dateText, timeText, "", "", "", "", "", note
    ]]);
    sheet.getRange(targetRow, 1, 1, 2).setNumberFormats([["dd/MM/yyyy", "HH:mm"]]);
    return {
      success: true, batchNumber: String(test.batchNumber), row: targetRow,
      date: dateText, time: timeText, notes: note, requestId: String(requestId || "")
    };
  } finally {
    lock.releaseLock();
  }
}
