function addFermentationMeasurement(
  sheetUrl,
  temperature,
  pressure,
  sugar,
  pH,
  carbonation,
  notes,
  boldNotes
) {
  const startedAt = Date.now();

  if (!sheetUrl) {
    throw new Error("Missing sheetUrl");
  }

  const spreadsheetId = extractSpreadsheetId(sheetUrl);
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sheet = ss.getSheets()[0];

  if (!sheet) {
    throw new Error("No sheet found");
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    Logger.log("========================================");
    Logger.log("ADD FERMENTATION MEASUREMENT");
    Logger.log("Spreadsheet: " + spreadsheetId);
    Logger.log("Sheet: " + sheet.getName());

    // Read only the fermentation columns (A:H), never the whole DataRange.
    // Cache only the header row location. The cached row is validated on every
    // call, so a changed sheet layout automatically falls back to a full scan.
    const lastRow = Math.max(sheet.getLastRow(), 1);
    const headerCache = CacheService.getScriptCache();
    const headerCacheKey = "fermentation_header:" + spreadsheetId;
    const cachedHeaderRow = Number(headerCache.get(headerCacheKey));

    let readStartRow =
      Number.isFinite(cachedHeaderRow) &&
      cachedHeaderRow >= 1 &&
      cachedHeaderRow <= lastRow
        ? cachedHeaderRow
        : 1;

    let values = sheet
      .getRange(readStartRow, 1, lastRow - readStartRow + 1, 8)
      .getDisplayValues();

    function rowLooksLikeFermentationHeader_(row) {
      let hasDate = false;
      let hasTime = false;
      let hasTemperature = false;

      for (let c = 0; c < row.length; c++) {
        const cell = String(row[c] || "").trim();
        if (cell === "תאריך") hasDate = true;
        if (cell === "שעה") hasTime = true;
        if (cell === "טמפרטורה") hasTemperature = true;
      }

      return hasDate && hasTime && hasTemperature;
    }

    let headerRow = -1; // zero-based absolute sheet row index

    if (
      readStartRow > 1 &&
      values.length > 0 &&
      rowLooksLikeFermentationHeader_(values[0])
    ) {
      headerRow = readStartRow - 1;
      Logger.log("Fermentation header cache hit at row: " + readStartRow);
    } else {
      // Cached position is absent/stale: do one bounded A:H read and find it.
      if (readStartRow !== 1) {
        readStartRow = 1;
        values = sheet
          .getRange(1, 1, lastRow, 8)
          .getDisplayValues();
      }

      for (let r = 0; r < values.length; r++) {
        if (rowLooksLikeFermentationHeader_(values[r])) {
          headerRow = r;
          headerCache.put(headerCacheKey, String(r + 1), 21600); // 6 hours
          break;
        }
      }
    }

    if (headerRow === -1) {
      throw new Error("Fermentation table header not found");
    }

    Logger.log("Fermentation header found at row: " + (headerRow + 1));

    const snapshotStartZeroBased = readStartRow - 1;

    function getSnapshotRow_(absoluteZeroBasedRow) {
      const localIndex = absoluteZeroBasedRow - snapshotStartZeroBased;
      return localIndex >= 0 && localIndex < values.length
        ? values[localIndex]
        : null;
    }

    const now = new Date();
    const timezone = "Asia/Jerusalem";

    const jerusalemDateText = Utilities.formatDate(
      now,
      timezone,
      "yyyy-MM-dd"
    );

    const jerusalemTimeText = Utilities.formatDate(
      now,
      timezone,
      "HH:mm"
    );

    const dateParts = jerusalemDateText.split("-");
    const year = Number(dateParts[0]);
    const month = Number(dateParts[1]);
    const day = Number(dateParts[2]);

    const sheetDate =
      Math.floor(Date.UTC(year, month - 1, day) / 86400000) + 25569;

    const dateText =
      String(day).padStart(2, "0") + "/" +
      String(month).padStart(2, "0") + "/" +
      year;

    const timeText = jerusalemTimeText;
    const todayDateTextNormalized = dateText.replace(/[^\d/]/g, "");

    Logger.log(
      "Jerusalem date: " + dateText +
      " | Sheet serial: " + sheetDate
    );
    Logger.log("Time: " + timeText);

    let existingTodayRow = -1; // 1-based
    let existingTodayTime = "";
    let lastMeasurementRow = headerRow; // zero-based

    // One pass finds BOTH today's row and the last measurement row.
    for (let r = headerRow + 1; r < lastRow; r++) {
      const snapshotRow = getSnapshotRow_(r);
      if (!snapshotRow) continue;

      const cellDateTextRaw = String(snapshotRow[0] || "").trim();
      if (!cellDateTextRaw) continue;

      const cellDateParsed = parseIsraeliDate(cellDateTextRaw);
      if (cellDateParsed) {
        lastMeasurementRow = r;
      }

      const cellDateTextNormalized =
        cellDateTextRaw.replace(/[^\d/]/g, "");

      const stringMatch =
        cellDateTextNormalized !== "" &&
        cellDateTextNormalized === todayDateTextNormalized;

      const dateMatch =
        cellDateParsed &&
        cellDateParsed.getFullYear() === year &&
        cellDateParsed.getMonth() === month - 1 &&
        cellDateParsed.getDate() === day;

      if (stringMatch || dateMatch) {
        existingTodayRow = r + 1;
        existingTodayTime = String(snapshotRow[1] || "").trim();
      } else if (
        cellDateTextNormalized &&
        (
          cellDateTextNormalized.indexOf(todayDateTextNormalized) !== -1 ||
          todayDateTextNormalized.indexOf(cellDateTextNormalized) !== -1
        )
      ) {
        Logger.log(
          "Near-miss on row " + (r + 1) +
          ". Raw: " + JSON.stringify(cellDateTextRaw)
        );
      }
    }

    Logger.log(
      "Today-row search: headerRow=" + (headerRow + 1) +
      ", existingTodayRow=" + existingTodayRow +
      ", lastMeasurementRow=" + (lastMeasurementRow + 1)
    );

    let targetRow;
    let isOverwrite = false;

    if (existingTodayRow !== -1) {
      targetRow = existingTodayRow;
      isOverwrite = true;

      Logger.log(
        "Existing row found for today's date at row: " + targetRow +
        ". It will be overwritten (original time kept: " +
        existingTodayTime + ")."
      );
    } else {
      targetRow = lastMeasurementRow + 2;

      // Reuse the A:H snapshot while looking for a safe empty row instead
      // of issuing one Sheets call per row.
      while (targetRow <= lastRow) {
        const snapshotRow = getSnapshotRow_(targetRow - 1);
        const rowHasData =
          snapshotRow &&
          snapshotRow.some(function (value) {
            return String(value || "").trim() !== "";
          });

        if (!rowHasData) break;

        Logger.log(
          "Row " + targetRow +
          " contains data in snapshot. Moving to next row."
        );
        targetRow++;
      }

      Logger.log("Safe empty row found: " + targetRow);
    }

    const rowTimeText = isOverwrite ? existingTodayTime : timeText;

    let existingRawValues = null;

    if (isOverwrite) {
      existingRawValues =
        sheet.getRange(targetRow, 1, 1, 8).getValues()[0];
    }

    function mergeValue(newValue, colIndexZeroBased) {
      const hasNewValue =
        newValue !== undefined &&
        newValue !== null &&
        newValue !== "";

      if (hasNewValue) return formatMeasurementValue(newValue);

      return existingRawValues
        ? existingRawValues[colIndexZeroBased]
        : "";
    }

    const existingNotesText =
      existingRawValues
        ? String(existingRawValues[7] || "").trim()
        : "";

    const newNotesText =
      notes !== undefined && notes !== null
        ? String(notes).trim()
        : "";

    let notesValue;

    if (newNotesText && existingNotesText) {
      notesValue = existingNotesText + " | " + newNotesText;
    } else if (newNotesText) {
      notesValue = newNotesText;
    } else {
      notesValue = existingNotesText;
    }

    const rowValues = [
      sheetDate,
      rowTimeText,
      mergeValue(sugar, 2),
      mergeValue(temperature, 3),
      mergeValue(pressure, 4),
      mergeValue(pH, 5),
      mergeValue(carbonation, 6),
      notesValue
    ];

    Logger.log("Prepared row: " + JSON.stringify(rowValues));

    // Keep the final safety read for new rows. It protects against a manual
    // sheet edit that happened after our snapshot while still eliminating the
    // repeated row-by-row reads above.
    if (!isOverwrite) {
      const finalExistingRow =
        sheet.getRange(targetRow, 1, 1, 8).getDisplayValues()[0];

      const finalRowHasData = finalExistingRow.some(function (value) {
        return String(value || "").trim() !== "";
      });

      if (finalRowHasData) {
        throw new Error(
          "SAFETY STOP: Target row " + targetRow +
          " is not empty. Nothing was written."
        );
      }
    }

    let existingRichTextSnapshot = null;

    if (isOverwrite && boldNotes === true) {
      try {
        existingRichTextSnapshot =
          sheet.getRange(targetRow, 8).getRichTextValue();
      } catch (error) {
        existingRichTextSnapshot = null;
      }
    }

    // One value write + one formatting write instead of seven separate
    // setNumberFormat calls.
    sheet.getRange(targetRow, 1, 1, 8).setValues([rowValues]);

    sheet
      .getRange(targetRow, 1, 1, 7)
      .setNumberFormats([[
        "dd/MM/yyyy",
        "HH:mm",
        '0.00"°P"',
        '0.00"°C"',
        '0.00"Bar"',
        "0.00",
        "0.00"
      ]]);

    if (boldNotes === true) {
      const richText = buildMergedNotesRichText(
        existingRichTextSnapshot,
        isOverwrite ? existingNotesText : "",
        newNotesText,
        true
      );

      sheet.getRange(targetRow, 8).setRichTextValue(richText);
      Logger.log("Applied bold rich text to notes cell.");
    }

    // No explicit SpreadsheetApp.flush() here. Apps Script commits pending
    // spreadsheet writes before the execution completes; forcing a flush on
    // every tank only adds a synchronous round trip.
    Logger.log(
      (isOverwrite
        ? "Measurement successfully overwritten at row: "
        : "Measurement successfully written to row: ") +
      targetRow +
      " | total " + (Date.now() - startedAt) + "ms"
    );

    return {
      success: true,
      overwritten: isOverwrite,
      spreadsheetId: spreadsheetId,
      sheetName: sheet.getName(),
      row: targetRow,
      date: dateText,
      time: rowTimeText,
      sugar: rowValues[2],
      temperature: rowValues[3],
      pressure: rowValues[4],
      pH: rowValues[5],
      carbonation: rowValues[6],
      notes: rowValues[7],
      sheetUrl: ss.getUrl()
    };

  } finally {
    lock.releaseLock();
  }
}


// ============================================================
// FORMAT OPTIONAL MEASUREMENT VALUE
// ============================================================

function formatMeasurementValue(value) {

  if (value === undefined || value === null || value === "") return "";

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : "";
  }

  const text = String(value).trim();
  if (!text) return "";

  const normalized = text.replace(",", ".");
  const number = Number(normalized);
  if (Number.isFinite(number)) return number;

  const extracted = extractNumber(text);
  if (extracted !== null) return extracted;

  return text;
}


// ============================================================
// BUILD MERGED RICH TEXT FOR NOTES CELL
// ============================================================
//
// existingRichTextSnapshot - RichTextValue שכבר נקרא *לפני* הכתיבה
//                             (לא Range!), או null אם אין/לא רלוונטי.
// existingNotesText        - הטקסט הישן (ריק אם שורה חדשה).
// newText                  - רק החלק החדש שמתווסף.
// boldNewPart              - האם להדגיש את החלק החדש.
//
// ============================================================

function buildMergedNotesRichText(
  existingRichTextSnapshot,
  existingNotesText,
  newText,
  boldNewPart
) {

  const hasExisting = !!existingNotesText;
  const hasNew = !!newText;

  const fullText =
    hasExisting && hasNew
      ? existingNotesText + " | " + newText
      : hasExisting
        ? existingNotesText
        : newText;

  if (!fullText) {
    return SpreadsheetApp.newRichTextValue().setText("").build();
  }

  const builder = SpreadsheetApp.newRichTextValue().setText(fullText);

  // ----------------------------------------------------------
  // שחזור העיצוב של הטקסט הקיים (אם היה), ריצה-ריצה
  // ----------------------------------------------------------

  if (hasExisting && existingRichTextSnapshot) {

    const runs = existingRichTextSnapshot.getRuns();

    runs.forEach(function (run) {

      const runStart = run.getStartIndex();
      const runEnd = run.getEndIndex();
      const style = run.getTextStyle();

      if (runEnd <= existingNotesText.length) {
        builder.setTextStyle(runStart, runEnd, style);
      }
    });
  }

  // ----------------------------------------------------------
  // עיצוב החלק החדש
  // ----------------------------------------------------------

  if (hasNew) {

    const newStart = hasExisting ? existingNotesText.length + 3 : 0; // +3 = " | "
    const newEnd = fullText.length;

    const style = SpreadsheetApp.newTextStyle()
      .setBold(!!boldNewPart)
      .build();

    builder.setTextStyle(newStart, newEnd, style);
  }

  return builder.build();
}

function assignDryHopToHopsTable(sheetUrl, grams, hopType, aa) {

  if (!sheetUrl) throw new Error("Missing sheetUrl");
  if (!grams || !hopType) throw new Error("Missing grams or hopType");

  let cleanHopType = String(hopType || "").trim();
  let resolvedAa = Number(aa);

  // Compatibility bridge for the short period between frontend and
  // server deployment: aa may also be encoded in the third argument.
  const transportMatch = cleanHopType.match(/^(.*)::aa=([0-9]+(?:\.[0-9]+)?)$/);
  if (transportMatch) {
    cleanHopType = transportMatch[1].trim();
    if (!Number.isFinite(resolvedAa)) resolvedAa = Number(transportMatch[2]);
  }

  if (!cleanHopType) throw new Error("Missing hopType");
  if (!Number.isFinite(resolvedAa) || resolvedAa <= 0 || resolvedAa > 100) {
    throw new Error("Missing or invalid aa");
  }

  const spreadsheetId = extractSpreadsheetId(sheetUrl);
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sheet = ss.getSheets()[0];

  if (!sheet) throw new Error("No sheet found");

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {

    Logger.log("========================================");
    Logger.log("ASSIGN DRY HOP TO HOPS TABLE");
    Logger.log("Spreadsheet: " + spreadsheetId);

    const values = sheet.getDataRange().getDisplayValues();

    // ----------------------------------------------------------
    // FIND ALL כשות TABLE HEADERS, TAKE THE BOTTOM-MOST ONE
    // (בישול משולש = 3 טבלאות כשות, רוצים את זו של הבישול האחרון)
    // ----------------------------------------------------------

    let lastHeaderRow = -1;

    for (let r = 0; r < values.length; r++) {
      const colA = String(values[r][0] || "").trim();
      const colB = String(values[r][1] || "").trim();
      const colC = String(values[r][2] || "").trim();

      if (colA === "כמות" && colB === "אחוז אלפה" && colC === "סוג/אצווה") {
        lastHeaderRow = r; // לא break - ממשיכים כדי לתפוס את האחרון (הכי נמוך)
      }
    }

    if (lastHeaderRow === -1) {
      throw new Error("Hops table header not found");
    }

    Logger.log("Using hops table at header row: " + (lastHeaderRow + 1));

    // ----------------------------------------------------------
    // FIND FIRST EMPTY NUMBERED SLOT ("N)") IN THE HOPS TABLE
    // מחפשים שורה שמכילה רק "מספר)" ללא טקסט אחריו - זה המקום
    // הפנוי הראשון, בין אם זה 3), 4), 5) וכו', בהתאם למספר
    // הכשותים שכבר מוגדרים בסגנון הבירה הספציפי
    // ----------------------------------------------------------

    let targetRow = -1;
    let entryNumber = -1;
    const maxRowsToScan = 10;
    const emptySlotPattern = /^(\d+)\)\s*$/;
    const numberedPrefixPattern = /^(\d+)\)/;

    // Read a fixed-size block directly from the sheet so completely empty rows
    // are included even when they fall outside getDataRange().
    const slotStartRow = lastHeaderRow + 2; // first data row, 1-indexed
    const slotRows = sheet
      .getRange(slotStartRow, 1, maxRowsToScan, 3)
      .getDisplayValues();

    let firstCompletelyEmptyRow = -1;
    let highestEntryNumber = 0;

    // Prefer an explicitly prepared "N)" slot when one exists.
    // Otherwise remember the first truly empty A:C row and derive
    // the next number from the entries that are already in the table.
    for (let i = 0; i < slotRows.length; i++) {
      const colA = String(slotRows[i][0] || "").trim();
      const colB = String(slotRows[i][1] || "").trim();
      const colC = String(slotRows[i][2] || "").trim();

      const numberedMatch = colC.match(numberedPrefixPattern);
      if (numberedMatch) {
        highestEntryNumber = Math.max(
          highestEntryNumber,
          parseInt(numberedMatch[1], 10)
        );
      }

      const emptyNumberedMatch = colC.match(emptySlotPattern);
      if (targetRow === -1 && emptyNumberedMatch && !colA && !colB) {
        targetRow = slotStartRow + i;
        entryNumber = parseInt(emptyNumberedMatch[1], 10);
      }

      if (firstCompletelyEmptyRow === -1 && !colA && !colB && !colC) {
        firstCompletelyEmptyRow = slotStartRow + i;
      }
    }

    if (targetRow === -1 && firstCompletelyEmptyRow !== -1) {
      targetRow = firstCompletelyEmptyRow;
      entryNumber = highestEntryNumber + 1;
      Logger.log(
        "No prepared numbered hop slot found; using empty row " + targetRow +
        " as entry #" + entryNumber
      );
    }

    if (targetRow === -1) {
      throw new Error("No empty slot found in the first 10 rows of the hops table");
    }

    Logger.log("Target row for dry hop: " + targetRow + " (entry #" + entryNumber + ")");

    // ----------------------------------------------------------
    // SAFETY: לא לדרוס דרייהופ שכבר נרשם
    // ----------------------------------------------------------

    const existingAmount = String(
      sheet.getRange(targetRow, 1).getDisplayValue() || ""
    ).trim();

    if (existingAmount) {
      throw new Error(
        "Row " + entryNumber + ") already contains data (" + existingAmount +
        "g) — dry hop appears to already be recorded. Nothing was written."
      );
    }

    // ----------------------------------------------------------
    // WRITE HOP AMOUNT + aa + TYPE
    // ----------------------------------------------------------

    sheet.getRange(targetRow, 1).setValue(grams);                               // כמות
    sheet.getRange(targetRow, 2).setValue(resolvedAa).setNumberFormat('0.0"%aa"'); // אחוז אלפה
    sheet.getRange(targetRow, 3).setValue(entryNumber + ")" + cleanHopType);    // סוג/אצווה

    // ----------------------------------------------------------
    // FILL FIRST EMPTY "הוספת כשות N" TIMESTAMP CELL
    // זו מערכת מספור נפרדת מטבלת הכשות! מחפשים את כל התוויות
    // "הוספת כשות N" בגיליון - אבל ורק מ-lastHeaderRow ואילך,
    // כדי להישאר בתוך אזור הבישול האחרון בלבד (ולא לתפוס
    // תוויות מבישולים קודמים אם יש כמה בישולים באותו גיליון)
    // ----------------------------------------------------------

    const additionLabelPattern = /^הוספת כשות (\d+)$/;
    const additionCandidates = []; // {row, col, num}

    for (let r = lastHeaderRow; r < values.length; r++) {
      for (let c = 0; c < values[r].length; c++) {
        const cellVal = String(values[r][c] || "").trim();
        const m = cellVal.match(additionLabelPattern);
        if (m) {
          additionCandidates.push({
            row: r + 1,          // 1-indexed
            col: c + 1,          // 1-indexed - עמודת הכותרת עצמה
            num: parseInt(m[1], 10)
          });
        }
      }
    }

    // מיון לפי המספר N, כדי לתפוס את הריקה הראשונה בסדר הנכון
    additionCandidates.sort((a, b) => a.num - b.num);

    let additionRow = -1;
    let valueCol = -1;
    let additionNum = -1;

    for (const cand of additionCandidates) {
      // "משמאל" לכותרת = אינדקס עמודה גבוה יותר (הגיליון RTL, A מוצג בקצה הימני)
      const candValueCol = cand.col + 1;
      const existingTimestamp = String(
        sheet.getRange(cand.row, candValueCol).getDisplayValue() || ""
      ).trim();

      if (!existingTimestamp) {
        additionRow = cand.row;
        valueCol = candValueCol;
        additionNum = cand.num;
        break;
      }
    }

    if (additionRow === -1) {
      Logger.log('WARNING: no empty "הוספת כשות N" row found — timestamp not written');
    } else {
      const now = new Date();
      const timestamp = Utilities.formatDate(
        now,
        "Asia/Jerusalem",
        "(dd/MM/yyyy) HH:mm"
      );
      sheet.getRange(additionRow, valueCol).setValue(timestamp);
      Logger.log('Timestamp written to "הוספת כשות ' + additionNum + '": ' + timestamp);
    }

    SpreadsheetApp.flush();

    Logger.log(
      "Dry hop written to row " + targetRow + ": " +
      grams + "g " + cleanHopType + " (" + resolvedAa + "%aa)"
    );

    return {
      success: true,
      row: targetRow,
      headerRow: lastHeaderRow + 1,
      entryNumber: entryNumber,
      grams: grams,
      hopType: cleanHopType,
      aa: resolvedAa,
      additionLabelFilled: additionRow !== -1 ? ("הוספת כשות " + additionNum) : null,
      additionTimestampRow: additionRow !== -1 ? additionRow : null,
      additionTimestampCol: additionRow !== -1 ? valueCol : null
    };

  } finally {
    lock.releaseLock();
  }
}
