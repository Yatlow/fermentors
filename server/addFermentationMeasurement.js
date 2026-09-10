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

    const values = sheet.getDataRange().getDisplayValues();

    // ... (איתור headerRow - זהה למקור, לא נגעתי) ...
    let headerRow = -1;

    for (let r = 0; r < values.length; r++) {
      const row = values[r];
      let hasDate = false;
      let hasTime = false;
      let hasTemperature = false;

      for (let c = 0; c < row.length; c++) {
        const cell = String(row[c] || "").trim();
        if (cell === "תאריך") hasDate = true;
        if (cell === "שעה") hasTime = true;
        if (cell === "טמפרטורה") hasTemperature = true;
      }

      if (hasDate && hasTime && hasTemperature) {
        headerRow = r;
        break;
      }
    }

    if (headerRow === -1) {
      throw new Error("Fermentation table header not found");
    }

    Logger.log("Fermentation header found at row: " + (headerRow + 1));

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

    // Create a Date object based on Jerusalem's local calendar date.
    // This prevents Sheets from shifting the date backward because of UTC.
    const dateParts = jerusalemDateText.split("-");

    const year = Number(dateParts[0]);
    const month = Number(dateParts[1]);
    const day = Number(dateParts[2]);

    // Google Sheets date serial number.
    // Using UTC here prevents any timezone conversion from changing the day.
    const sheetDate =
      Math.floor(Date.UTC(year, month - 1, day) / 86400000) + 25569;

    const dateText =
      String(day).padStart(2, "0") + "/" +
      String(month).padStart(2, "0") + "/" +
      year;

    Logger.log(
      "Jerusalem date: " + dateText +
      " | Sheet serial: " + sheetDate
    );

    const timeText = jerusalemTimeText;

    Logger.log("Date: " + dateText);
    Logger.log("Time: " + timeText);

    let existingTodayRow = -1;
    let existingTodayTime = "";

    for (let r = headerRow + 1; r < values.length; r++) {

      const cellDateTextRaw = String(values[r][0] || "").trim();
      if (!cellDateTextRaw) continue;

      const cellDateTextNormalized = cellDateTextRaw.replace(/[^\d/]/g, "");
      const todayDateTextNormalized = dateText.replace(/[^\d/]/g, "");

      const stringMatch =
        cellDateTextNormalized !== "" &&
        cellDateTextNormalized === todayDateTextNormalized;

      const cellDateParsed = parseIsraeliDate(cellDateTextRaw);

      const dateMatch =
        cellDateParsed &&
        cellDateParsed.getFullYear() === now.getFullYear() &&
        cellDateParsed.getMonth() === now.getMonth() &&
        cellDateParsed.getDate() === now.getDate();

      if (stringMatch || dateMatch) {
        existingTodayRow = r + 1;
        existingTodayTime = String(values[r][1] || "").trim();
      } else if (
        cellDateTextNormalized.indexOf(todayDateTextNormalized) !== -1 ||
        todayDateTextNormalized.indexOf(cellDateTextNormalized) !== -1
      ) {
        Logger.log(
          "Near-miss on row " + (r + 1) +
          ". Raw: " + JSON.stringify(cellDateTextRaw) +
          " | codes: " + cellDateTextRaw.split("").map(function (ch) {
            return ch.charCodeAt(0);
          }).join(",")
        );
      }
    }

    Logger.log(
      "Today-row search: headerRow=" + (headerRow + 1) +
      ", scanned rows " + (headerRow + 2) + " to " + values.length +
      ", existingTodayRow=" + existingTodayRow
    );

    let targetRow;
    let isOverwrite = false;

    if (existingTodayRow !== -1) {

      targetRow = existingTodayRow;
      isOverwrite = true;

      Logger.log(
        "Existing row found for today's date at row: " + targetRow +
        ". It will be overwritten (original time kept: " + existingTodayTime + ")."
      );

    } else {

      let lastMeasurementRow = headerRow;

      for (let r = headerRow + 1; r < values.length; r++) {
        const dText = String(values[r][0] || "").trim();
        const d = parseIsraeliDate(dText);
        if (d) lastMeasurementRow = r;
      }

      Logger.log("Last measurement row: " + (lastMeasurementRow + 1));

      targetRow = lastMeasurementRow + 2;

      while (true) {
        const existingRow =
          sheet.getRange(targetRow, 1, 1, 8).getDisplayValues()[0];

        const rowHasData = existingRow.some(function (value) {
          return String(value || "").trim() !== "";
        });

        if (!rowHasData) break;

        Logger.log("Row " + targetRow + " contains data. Moving to next row.");
        targetRow++;
      }

      Logger.log("Safe empty row found: " + targetRow);
    }

    const rowTimeText = isOverwrite ? existingTodayTime : timeText;

    let existingRawValues = null;

    if (isOverwrite) {
      existingRawValues = sheet.getRange(targetRow, 1, 1, 8).getValues()[0];
    }

    function mergeValue(newValue, colIndexZeroBased) {
      const hasNewValue =
        newValue !== undefined && newValue !== null && newValue !== "";

      if (hasNewValue) return formatMeasurementValue(newValue);

      return existingRawValues ? existingRawValues[colIndexZeroBased] : "";
    }

    const existingNotesText =
      existingRawValues ? String(existingRawValues[7] || "").trim() : "";

    const newNotesText =
      (notes !== undefined && notes !== null) ? String(notes).trim() : "";

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

    Logger.log("Prepared row:");
    Logger.log(JSON.stringify(rowValues));

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

    // ========================================================
    // CAPTURE OLD NOTES RICH TEXT — BEFORE the write happens!
    // ========================================================
    //
    // Range.getRichTextValue() must be called BEFORE setValues(),
    // otherwise it returns the NEW content, not the old one.
    // We store the actual RichTextValue snapshot, not the Range.
    //
    // ========================================================

    let existingRichTextSnapshot = null;

    if (isOverwrite) {
      try {
        existingRichTextSnapshot =
          sheet.getRange(targetRow, 8).getRichTextValue();
      } catch (error) {
        existingRichTextSnapshot = null;
      }
    }

    // ========================================================
    // WRITE ONLY A:H
    // ========================================================

    sheet.getRange(targetRow, 1, 1, 8).setValues([rowValues]);

    sheet.getRange(targetRow, 1).setNumberFormat("dd/MM/yyyy");
    sheet.getRange(targetRow, 2).setNumberFormat("HH:mm");
    sheet.getRange(targetRow, 3).setNumberFormat("0.00\"°P\"");
    sheet.getRange(targetRow, 4).setNumberFormat("0.00\"°C\"");
    sheet.getRange(targetRow, 5).setNumberFormat("0.00\"Bar\"");
    sheet.getRange(targetRow, 6).setNumberFormat("0.00");
    sheet.getRange(targetRow, 7).setNumberFormat("0.00");

    SpreadsheetApp.flush();

    Logger.log(
      (isOverwrite
        ? "Measurement successfully overwritten at row: "
        : "Measurement successfully written to row: ") + targetRow
    );

    // ========================================================
    // APPLY BOLD RICH TEXT TO NOTES CELL (if requested)
    // ========================================================
    //
    // Runs AFTER setValues (which would otherwise wipe rich text
    // formatting), and uses the snapshot captured BEFORE the write.
    //
    // ========================================================

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

    return {
      success: true,
      overwritten: isOverwrite,
      spreadsheetId: spreadsheetId,
      sheetName: sheet.getName(),
      row: targetRow,
      date: dateText,
      time: rowTimeText,
      // מחזירים לפרונט את השורה הסופית והמאוחדת שנשמרה בפועל.
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

function assignDryHopToHopsTable(sheetUrl, grams, hopType) {

  if (!sheetUrl) throw new Error("Missing sheetUrl");
  if (!grams || !hopType) throw new Error("Missing grams or hopType");

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

    for (let r = lastHeaderRow + 1; r < Math.min(lastHeaderRow + 1 + maxRowsToScan, values.length); r++) {
      const colC = String(values[r][2] || "").trim();
      const match = colC.match(emptySlotPattern);
      if (match) {
        targetRow = r + 1; // 1-indexed ל-Range
        entryNumber = parseInt(match[1], 10);
        break;
      }
    }

    if (targetRow === -1) {
      throw new Error("No empty numbered slot (e.g. '4)') found in hops table");
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
    // WRITE HOP AMOUNT + TYPE
    // ----------------------------------------------------------

    sheet.getRange(targetRow, 1).setValue(grams);                          // כמות
    sheet.getRange(targetRow, 3).setValue(entryNumber + ")" + hopType);    // סוג/אצווה

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
      grams + "g " + hopType
    );

    return {
      success: true,
      row: targetRow,
      headerRow: lastHeaderRow + 1,
      entryNumber: entryNumber,
      grams: grams,
      hopType: hopType,
      additionLabelFilled: additionRow !== -1 ? ("הוספת כשות " + additionNum) : null,
      additionTimestampRow: additionRow !== -1 ? additionRow : null,
      additionTimestampCol: additionRow !== -1 ? valueCol : null
    };

  } finally {
    lock.releaseLock();
  }
}