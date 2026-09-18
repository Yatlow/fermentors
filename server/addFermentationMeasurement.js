function hasFermentationValue_(value) {
  return value !== undefined && value !== null && value !== "";
}

function getJerusalemMeasurementClock_() {
  const now = new Date();
  const timezone = "Asia/Jerusalem";
  const dateKey = Utilities.formatDate(now, timezone, "yyyy-MM-dd");
  const timeText = Utilities.formatDate(now, timezone, "HH:mm");
  const parts = dateKey.split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const dateText =
    String(day).padStart(2, "0") + "/" +
    String(month).padStart(2, "0") + "/" +
    year;
  const sheetDate =
    Math.floor(Date.UTC(year, month - 1, day) / 86400000) + 25569;

  return {
    now: now,
    dateKey: dateKey,
    timeText: timeText,
    dateText: dateText,
    sheetDate: sheetDate,
    year: year,
    month: month,
    day: day,
    normalizedDate: dateText.replace(/[^\d/]/g, "")
  };
}

function fermentationDateMatchesToday_(raw, clock) {
  const text = String(raw || "").trim();
  if (!text) return false;

  const normalized = text.replace(/[^\d/]/g, "");
  if (normalized === clock.normalizedDate) return true;

  const parsed = parseIsraeliDate(text);
  return !!parsed &&
    parsed.getFullYear() === clock.year &&
    parsed.getMonth() === clock.month - 1 &&
    parsed.getDate() === clock.day;
}

function getCachedFermentationHeaderRow_(sheet, spreadsheetId, lastRow) {
  const cache = CacheService.getScriptCache();
  const key = "fermentation_header:" + spreadsheetId;
  const cachedRow = Number(cache.get(key));

  if (
    Number.isFinite(cachedRow) &&
    cachedRow >= 1 &&
    cachedRow <= lastRow
  ) {
    const row = sheet.getRange(cachedRow, 1, 1, 8).getDisplayValues()[0];
    const labels = row.map(function (v) { return String(v || "").trim(); });
    if (
      labels.indexOf("תאריך") !== -1 &&
      labels.indexOf("שעה") !== -1 &&
      labels.indexOf("טמפרטורה") !== -1
    ) {
      return cachedRow;
    }
  }

  const values = sheet.getRange(1, 1, lastRow, 8).getDisplayValues();
  for (let r = 0; r < values.length; r++) {
    const labels = values[r].map(function (v) { return String(v || "").trim(); });
    if (
      labels.indexOf("תאריך") !== -1 &&
      labels.indexOf("שעה") !== -1 &&
      labels.indexOf("טמפרטורה") !== -1
    ) {
      cache.put(key, String(r + 1), 21600);
      return r + 1;
    }
  }

  throw new Error("Fermentation table header not found");
}

function addFermentationNoteFast_(ss, sheet, spreadsheetId, notes, startedAt) {
  const clock = getJerusalemMeasurementClock_();
  const cache = CacheService.getScriptCache();
  const todayKey = "fermentation_today:" + spreadsheetId + ":" + clock.dateKey;
  const cachedTodayRow = Number(cache.get(todayKey));
  const lastRow = Math.max(sheet.getLastRow(), 1);
  let targetRow = -1;
  let rowDisplay = null;

  if (
    Number.isFinite(cachedTodayRow) &&
    cachedTodayRow >= 1 &&
    cachedTodayRow <= Math.max(lastRow, cachedTodayRow)
  ) {
    const cachedDisplay = sheet
      .getRange(cachedTodayRow, 1, 1, 8)
      .getDisplayValues()[0];

    if (fermentationDateMatchesToday_(cachedDisplay[0], clock)) {
      targetRow = cachedTodayRow;
      rowDisplay = cachedDisplay;
      Logger.log("Fast note: today-row cache hit at row " + targetRow);
    }
  }

  if (targetRow === -1) {
    const headerRow = getCachedFermentationHeaderRow_(
      sheet,
      spreadsheetId,
      lastRow
    );

    const dataRowCount = Math.max(lastRow - headerRow, 0);
    const dateTimeValues = dataRowCount > 0
      ? sheet.getRange(headerRow + 1, 1, dataRowCount, 2).getDisplayValues()
      : [];

    let lastMeasurementRow = headerRow;

    for (let i = 0; i < dateTimeValues.length; i++) {
      const absoluteRow = headerRow + 1 + i;
      const rawDate = String(dateTimeValues[i][0] || "").trim();
      if (!rawDate) continue;

      if (parseIsraeliDate(rawDate)) {
        lastMeasurementRow = absoluteRow;
      }

      if (fermentationDateMatchesToday_(rawDate, clock)) {
        targetRow = absoluteRow;
      }
    }

    if (targetRow !== -1) {
      rowDisplay = sheet
        .getRange(targetRow, 1, 1, 8)
        .getDisplayValues()[0];
    } else {
      targetRow = lastMeasurementRow + 1;
      const existing = sheet
        .getRange(targetRow, 1, 1, 8)
        .getDisplayValues()[0];

      if (existing.some(function (v) { return String(v || "").trim() !== ""; })) {
        throw new Error(
          "SAFETY STOP: Fast-note target row " + targetRow +
          " is not empty. Nothing was written."
        );
      }

      const newRow = [
        clock.sheetDate,
        clock.timeText,
        "",
        "",
        "",
        "",
        "",
        String(notes || "").trim()
      ];

      sheet.getRange(targetRow, 1, 1, 8).setValues([newRow]);
      sheet
        .getRange(targetRow, 1, 1, 2)
        .setNumberFormats([["dd/MM/yyyy", "HH:mm"]]);

      cache.put(todayKey, String(targetRow), 21600);

      Logger.log(
        "Fast note: created today's row " + targetRow +
        " | total " + (Date.now() - startedAt) + "ms"
      );

      return {
        success: true,
        overwritten: false,
        spreadsheetId: spreadsheetId,
        sheetName: sheet.getName(),
        row: targetRow,
        date: clock.dateText,
        time: clock.timeText,
        sugar: "",
        temperature: "",
        pressure: "",
        pH: "",
        carbonation: "",
        notes: newRow[7],
        sheetUrl: ss.getUrl(),
        fastPath: "notes"
      };
    }
  }

  const oldNotes = String((rowDisplay && rowDisplay[7]) || "").trim();
  const newNotes = String(notes || "").trim();
  const mergedNotes = oldNotes && newNotes
    ? oldNotes + " | " + newNotes
    : (newNotes || oldNotes);

  sheet.getRange(targetRow, 8).setValue(mergedNotes);
  cache.put(todayKey, String(targetRow), 21600);

  Logger.log(
    "Fast note: updated row " + targetRow +
    " | total " + (Date.now() - startedAt) + "ms"
  );

  return {
    success: true,
    overwritten: true,
    spreadsheetId: spreadsheetId,
    sheetName: sheet.getName(),
    row: targetRow,
    date: clock.dateText,
    time: String((rowDisplay && rowDisplay[1]) || clock.timeText).trim(),
    sugar: rowDisplay ? rowDisplay[2] : "",
    temperature: rowDisplay ? rowDisplay[3] : "",
    pressure: rowDisplay ? rowDisplay[4] : "",
    pH: rowDisplay ? rowDisplay[5] : "",
    carbonation: rowDisplay ? rowDisplay[6] : "",
    notes: mergedNotes,
    sheetUrl: ss.getUrl(),
    fastPath: "notes"
  };
}

function addFermentationCarbonationFast_(
  ss,
  sheet,
  spreadsheetId,
  carbonation,
  startedAt
) {
  const clock = getJerusalemMeasurementClock_();
  const cache = CacheService.getScriptCache();
  const todayKey = "fermentation_today:" + spreadsheetId + ":" + clock.dateKey;
  const cachedTodayRow = Number(cache.get(todayKey));
  const lastRow = Math.max(sheet.getLastRow(), 1);
  let targetRow = -1;
  let rowDisplay = null;

  if (
    Number.isFinite(cachedTodayRow) &&
    cachedTodayRow >= 1 &&
    cachedTodayRow <= Math.max(lastRow, cachedTodayRow)
  ) {
    const cachedDisplay = sheet
      .getRange(cachedTodayRow, 1, 1, 8)
      .getDisplayValues()[0];

    if (fermentationDateMatchesToday_(cachedDisplay[0], clock)) {
      targetRow = cachedTodayRow;
      rowDisplay = cachedDisplay;
      Logger.log("Fast carbonation: today-row cache hit at row " + targetRow);
    }
  }

  if (targetRow === -1) {
    const headerRow = getCachedFermentationHeaderRow_(
      sheet,
      spreadsheetId,
      lastRow
    );

    const dataRowCount = Math.max(lastRow - headerRow, 0);
    const dateTimeValues = dataRowCount > 0
      ? sheet.getRange(headerRow + 1, 1, dataRowCount, 2).getDisplayValues()
      : [];

    let lastMeasurementRow = headerRow;

    for (let i = 0; i < dateTimeValues.length; i++) {
      const absoluteRow = headerRow + 1 + i;
      const rawDate = String(dateTimeValues[i][0] || "").trim();
      if (!rawDate) continue;

      if (parseIsraeliDate(rawDate)) {
        lastMeasurementRow = absoluteRow;
      }

      if (fermentationDateMatchesToday_(rawDate, clock)) {
        targetRow = absoluteRow;
      }
    }

    if (targetRow !== -1) {
      rowDisplay = sheet
        .getRange(targetRow, 1, 1, 8)
        .getDisplayValues()[0];
    } else {
      targetRow = lastMeasurementRow + 1;
      const existing = sheet
        .getRange(targetRow, 1, 1, 8)
        .getDisplayValues()[0];

      if (existing.some(function (value) {
        return String(value || "").trim() !== "";
      })) {
        throw new Error(
          "SAFETY STOP: Fast-carbonation target row " + targetRow +
          " is not empty. Nothing was written."
        );
      }

      const carbonationValue = formatMeasurementValue(carbonation);
      const newRow = [
        clock.sheetDate,
        clock.timeText,
        "",
        "",
        "",
        "",
        carbonationValue,
        ""
      ];

      sheet.getRange(targetRow, 1, 1, 8).setValues([newRow]);
      sheet.getRange(targetRow, 1, 1, 2)
        .setNumberFormats([["dd/MM/yyyy", "HH:mm"]]);
      sheet.getRange(targetRow, 7).setNumberFormat("0.00");

      cache.put(todayKey, String(targetRow), 21600);

      Logger.log(
        "Fast carbonation: created today's row " + targetRow +
        " | total " + (Date.now() - startedAt) + "ms"
      );

      return {
        success: true,
        overwritten: false,
        spreadsheetId: spreadsheetId,
        sheetName: sheet.getName(),
        row: targetRow,
        date: clock.dateText,
        time: clock.timeText,
        sugar: "",
        temperature: "",
        pressure: "",
        pH: "",
        carbonation: carbonationValue,
        notes: "",
        sheetUrl: ss.getUrl(),
        fastPath: "carbonation"
      };
    }
  }

  const carbonationValue = formatMeasurementValue(carbonation);
  sheet.getRange(targetRow, 7)
    .setValue(carbonationValue)
    .setNumberFormat("0.00");
  cache.put(todayKey, String(targetRow), 21600);

  Logger.log(
    "Fast carbonation: updated row " + targetRow +
    " | total " + (Date.now() - startedAt) + "ms"
  );

  return {
    success: true,
    overwritten: true,
    spreadsheetId: spreadsheetId,
    sheetName: sheet.getName(),
    row: targetRow,
    date: clock.dateText,
    time: String((rowDisplay && rowDisplay[1]) || clock.timeText).trim(),
    sugar: rowDisplay ? rowDisplay[2] : "",
    temperature: rowDisplay ? rowDisplay[3] : "",
    pressure: rowDisplay ? rowDisplay[4] : "",
    pH: rowDisplay ? rowDisplay[5] : "",
    carbonation: carbonationValue,
    notes: rowDisplay ? rowDisplay[7] : "",
    sheetUrl: ss.getUrl(),
    fastPath: "carbonation"
  };
}


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

    const hasNumericMeasurement = [
      temperature,
      pressure,
      sugar,
      pH,
      carbonation
    ].some(hasFermentationValue_);
    const hasNotes = hasFermentationValue_(notes) && String(notes).trim() !== "";

    // Most cellar actions (yeast drop, cooling, diacetyl rest, etc.) are only
    // appending a note to today's measurement. Do not rescan/rewrite A:H for
    // those actions. Packaging uses boldNotes and intentionally stays on the
    // full path so its rich-text formatting is preserved.
    if (!hasNumericMeasurement && hasNotes && boldNotes !== true) {
      return addFermentationNoteFast_(
        ss,
        sheet,
        spreadsheetId,
        notes,
        startedAt
      );
    }

    // A carbonation test is usually reported later in the day, after the
    // morning pressure/temperature row already exists. The old numeric path
    // rescanned and rewrote the whole fermentation table just to change column
    // G, which is why this specific report could hit the 15-second browser
    // timeout. Use the cached today row when possible and update only G.
    const carbonationOnly =
      hasFermentationValue_(carbonation) &&
      !hasFermentationValue_(temperature) &&
      !hasFermentationValue_(pressure) &&
      !hasFermentationValue_(sugar) &&
      !hasFermentationValue_(pH) &&
      !hasNotes &&
      boldNotes !== true;

    if (carbonationOnly) {
      return addFermentationCarbonationFast_(
        ss,
        sheet,
        spreadsheetId,
        carbonation,
        startedAt
      );
    }

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

    let headerRow = -1;

    if (
      readStartRow > 1 &&
      values.length > 0 &&
      rowLooksLikeFermentationHeader_(values[0])
    ) {
      headerRow = readStartRow - 1;
      Logger.log("Fermentation header cache hit at row: " + readStartRow);
    } else {
      if (readStartRow !== 1) {
        readStartRow = 1;
        values = sheet.getRange(1, 1, lastRow, 8).getDisplayValues();
      }

      for (let r = 0; r < values.length; r++) {
        if (rowLooksLikeFermentationHeader_(values[r])) {
          headerRow = r;
          headerCache.put(headerCacheKey, String(r + 1), 21600);
          break;
        }
      }
    }

    if (headerRow === -1) {
      throw new Error("Fermentation table header not found");
    }

    const snapshotStartZeroBased = readStartRow - 1;

    function getSnapshotRow_(absoluteZeroBasedRow) {
      const localIndex = absoluteZeroBasedRow - snapshotStartZeroBased;
      return localIndex >= 0 && localIndex < values.length
        ? values[localIndex]
        : null;
    }

    const clock = getJerusalemMeasurementClock_();
    let existingTodayRow = -1;
    let existingTodayTime = "";
    let lastMeasurementRow = headerRow;

    for (let r = headerRow + 1; r < lastRow; r++) {
      const snapshotRow = getSnapshotRow_(r);
      if (!snapshotRow) continue;

      const cellDateTextRaw = String(snapshotRow[0] || "").trim();
      if (!cellDateTextRaw) continue;

      if (parseIsraeliDate(cellDateTextRaw)) {
        lastMeasurementRow = r;
      }

      if (fermentationDateMatchesToday_(cellDateTextRaw, clock)) {
        existingTodayRow = r + 1;
        existingTodayTime = String(snapshotRow[1] || "").trim();
      }
    }

    let targetRow;
    let isOverwrite = false;

    if (existingTodayRow !== -1) {
      targetRow = existingTodayRow;
      isOverwrite = true;
    } else {
      targetRow = lastMeasurementRow + 2;

      while (targetRow <= lastRow) {
        const snapshotRow = getSnapshotRow_(targetRow - 1);
        const rowHasData = snapshotRow && snapshotRow.some(function (value) {
          return String(value || "").trim() !== "";
        });
        if (!rowHasData) break;
        targetRow++;
      }
    }

    const rowTimeText = isOverwrite ? existingTodayTime : clock.timeText;
    let existingRawValues = null;

    if (isOverwrite) {
      existingRawValues = sheet.getRange(targetRow, 1, 1, 8).getValues()[0];
    }

    function mergeValue(newValue, colIndexZeroBased) {
      if (hasFermentationValue_(newValue)) {
        return formatMeasurementValue(newValue);
      }
      return existingRawValues ? existingRawValues[colIndexZeroBased] : "";
    }

    const existingNotesText = existingRawValues
      ? String(existingRawValues[7] || "").trim()
      : "";
    const newNotesText = notes !== undefined && notes !== null
      ? String(notes).trim()
      : "";
    const notesValue = newNotesText && existingNotesText
      ? existingNotesText + " | " + newNotesText
      : (newNotesText || existingNotesText);

    const rowValues = [
      clock.sheetDate,
      rowTimeText,
      mergeValue(sugar, 2),
      mergeValue(temperature, 3),
      mergeValue(pressure, 4),
      mergeValue(pH, 5),
      mergeValue(carbonation, 6),
      notesValue
    ];

    if (!isOverwrite) {
      const finalExistingRow = sheet
        .getRange(targetRow, 1, 1, 8)
        .getDisplayValues()[0];
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
        existingRichTextSnapshot = sheet.getRange(targetRow, 8).getRichTextValue();
      } catch (error) {
        existingRichTextSnapshot = null;
      }
    }

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
    }

    CacheService.getScriptCache().put(
      "fermentation_today:" + spreadsheetId + ":" + clock.dateKey,
      String(targetRow),
      21600
    );

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
      date: clock.dateText,
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

  if (hasExisting && existingRichTextSnapshot) {
    existingRichTextSnapshot.getRuns().forEach(function (run) {
      const runStart = run.getStartIndex();
      const runEnd = run.getEndIndex();
      if (runEnd <= existingNotesText.length) {
        builder.setTextStyle(runStart, runEnd, run.getTextStyle());
      }
    });
  }

  if (hasNew) {
    const newStart = hasExisting ? existingNotesText.length + 3 : 0;
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
  const transportMatch = cleanHopType.match(/^(.*)::aa=([0-9]+(?:\.[0-9]+)?)$/);

  if (transportMatch) {
    cleanHopType = transportMatch[1].trim();
    if (!Number.isFinite(resolvedAa)) resolvedAa = Number(transportMatch[2]);
  }

  if (!cleanHopType) throw new Error("Missing hopType");
  if (!Number.isFinite(resolvedAa) || resolvedAa <= 0 || resolvedAa > 100) {
    throw new Error("Missing or invalid aa");
  }

  const startedAt = Date.now();
  const spreadsheetId = extractSpreadsheetId(sheetUrl);
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sheet = ss.getSheets()[0];
  if (!sheet) throw new Error("No sheet found");

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const lastRow = Math.max(sheet.getLastRow(), 1);
    const lastCol = Math.max(3, Math.min(sheet.getLastColumn(), 10));
    const values = sheet.getRange(1, 1, lastRow, lastCol).getDisplayValues();

    let lastHeaderRow = -1;
    for (let r = 0; r < values.length; r++) {
      const colA = String(values[r][0] || "").trim();
      const colB = String(values[r][1] || "").trim();
      const colC = String(values[r][2] || "").trim();
      if (colA === "כמות" && colB === "אחוז אלפה" && colC === "סוג/אצווה") {
        lastHeaderRow = r;
      }
    }

    if (lastHeaderRow === -1) {
      throw new Error("Hops table header not found");
    }

    let targetRow = -1;
    let entryNumber = -1;
    const maxRowsToScan = 10;
    const emptySlotPattern = /^(\d+)\)\s*$/;
    const numberedPrefixPattern = /^(\d+)\)/;
    const slotStartRow = lastHeaderRow + 2;
    const slotRows = sheet
      .getRange(slotStartRow, 1, maxRowsToScan, 3)
      .getDisplayValues();

    let firstCompletelyEmptyRow = -1;
    let highestEntryNumber = 0;

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
    }

    if (targetRow === -1) {
      throw new Error("No empty slot found in the first 10 rows of the hops table");
    }

    const existingAmount = String(
      sheet.getRange(targetRow, 1).getDisplayValue() || ""
    ).trim();

    if (existingAmount) {
      throw new Error(
        "Row " + entryNumber + ") already contains data (" + existingAmount +
        "g) — dry hop appears to already be recorded. Nothing was written."
      );
    }

    // Write A:C in one values call, then format the aa cell.
    sheet.getRange(targetRow, 1, 1, 3).setValues([[
      grams,
      resolvedAa,
      entryNumber + ")" + cleanHopType
    ]]);
    sheet.getRange(targetRow, 2).setNumberFormat('0.0"%aa"');

    const additionLabelPattern = /^הוספת כשות (\d+)$/;
    const additionCandidates = [];

    for (let r = lastHeaderRow; r < values.length; r++) {
      for (let c = 0; c < values[r].length; c++) {
        const cellVal = String(values[r][c] || "").trim();
        const m = cellVal.match(additionLabelPattern);
        if (m) {
          additionCandidates.push({
            row: r + 1,
            col: c + 1,
            num: parseInt(m[1], 10)
          });
        }
      }
    }

    additionCandidates.sort(function (a, b) { return a.num - b.num; });

    let additionRow = -1;
    let valueCol = -1;
    let additionNum = -1;

    for (let i = 0; i < additionCandidates.length; i++) {
      const cand = additionCandidates[i];
      const candValueCol = cand.col + 1;
      const snapshotValue =
        values[cand.row - 1] && values[cand.row - 1][candValueCol - 1] !== undefined
          ? String(values[cand.row - 1][candValueCol - 1] || "").trim()
          : String(sheet.getRange(cand.row, candValueCol).getDisplayValue() || "").trim();

      if (!snapshotValue) {
        additionRow = cand.row;
        valueCol = candValueCol;
        additionNum = cand.num;
        break;
      }
    }

    if (additionRow !== -1) {
      const timestamp = Utilities.formatDate(
        new Date(),
        "Asia/Jerusalem",
        "(dd/MM/yyyy) HH:mm"
      );
      sheet.getRange(additionRow, valueCol).setValue(timestamp);
    }

    Logger.log(
      "Dry hop written to row " + targetRow +
      " | total " + (Date.now() - startedAt) + "ms"
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
