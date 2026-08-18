function addFermentationMeasurement(
  sheetUrl,
  temperature,
  pressure,
  sugar,
  pH,
  carbonation,
  notes
) {

  // ==========================================================
  // VALIDATE URL
  // ==========================================================

  if (!sheetUrl) {

    throw new Error(
      "Missing sheetUrl"
    );
  }


  // ==========================================================
  // EXTRACT SPREADSHEET ID
  // ==========================================================

  const spreadsheetId =
    extractSpreadsheetId(
      sheetUrl
    );


  // ==========================================================
  // OPEN SPREADSHEET
  // ==========================================================

  const ss =
    SpreadsheetApp.openById(
      spreadsheetId
    );


  // ==========================================================
  // USE FIRST SHEET
  // ==========================================================

  const sheet =
    ss.getSheets()[0];


  if (!sheet) {

    throw new Error(
      "No sheet found"
    );
  }


  // ==========================================================
  // LOCK
  // ==========================================================
  //
  // Prevent two POST requests from finding
  // the same empty row at the same time.
  //
  // ==========================================================

  const lock =
    LockService.getScriptLock();


  lock.waitLock(30000);


  try {

    Logger.log(
      "========================================"
    );

    Logger.log(
      "ADD FERMENTATION MEASUREMENT"
    );

    Logger.log(
      "Spreadsheet: " +
      spreadsheetId
    );

    Logger.log(
      "Sheet: " +
      sheet.getName()
    );


    // ========================================================
    // READ CURRENT SHEET DATA
    // ========================================================

    const values =
      sheet
        .getDataRange()
        .getDisplayValues();


    // ========================================================
    // FIND FERMENTATION HEADER
    // ========================================================
    //
    // We specifically look for the row that contains:
    //
    // תאריך
    // שעה
    // טמפרטורה
    //
    // This prevents accidentally finding another
    // "טמפרטורה" elsewhere in the brew sheet.
    //
    // ========================================================

    let headerRow =
      -1;


    for (
      let r = 0;
      r < values.length;
      r++
    ) {

      const row =
        values[r];


      let hasDate =
        false;

      let hasTime =
        false;

      let hasTemperature =
        false;


      for (
        let c = 0;
        c < row.length;
        c++
      ) {

        const cell =
          String(
            row[c] || ""
          ).trim();


        if (
          cell === "תאריך"
        ) {

          hasDate = true;
        }


        if (
          cell === "שעה"
        ) {

          hasTime = true;
        }


        if (
          cell === "טמפרטורה"
        ) {

          hasTemperature = true;
        }
      }


      if (
        hasDate &&
        hasTime &&
        hasTemperature
      ) {

        headerRow =
          r;

        break;
      }
    }


    // ========================================================
    // HEADER NOT FOUND
    // ========================================================

    if (
      headerRow === -1
    ) {

      throw new Error(
        "Fermentation table header not found"
      );
    }


    Logger.log(
      "Fermentation header found at row: " +
      (headerRow + 1)
    );


    // ========================================================
    // FIND LAST REAL MEASUREMENT
    // ========================================================
    //
    // A valid date in column A identifies a real
    // fermentation measurement row.
    //
    // We deliberately do NOT use "any data in the row"
    // as the definition of a measurement.
    //
    // This avoids accidentally treating random notes
    // or formatting as fermentation measurements.
    //
    // ========================================================

    let lastMeasurementRow =
      headerRow;


    for (
      let r = headerRow + 1;
      r < values.length;
      r++
    ) {

      const dateText =
        String(
          values[r][0] || ""
        ).trim();


      const date =
        parseIsraeliDate(
          dateText
        );


      if (date) {

        lastMeasurementRow =
          r;
      }
    }


    Logger.log(
      "Last measurement row: " +
      (lastMeasurementRow + 1)
    );


    // ========================================================
    // FIND SAFE EMPTY ROW
    // ========================================================
    //
    // Start immediately after the last measurement.
    //
    // If that row contains ANYTHING, move downward.
    //
    // This guarantees that we never overwrite existing
    // information.
    //
    // ========================================================

    let targetRow =
      lastMeasurementRow + 2;


    while (true) {

      const existingRow =
        sheet
          .getRange(
            targetRow,
            1,
            1,
            8
          )
          .getDisplayValues()[0];


      const rowHasData =
        existingRow.some(
          function(value) {

            return String(
              value || ""
            ).trim() !== "";

          }
        );


      if (!rowHasData) {

        break;
      }


      Logger.log(
        "Row " +
        targetRow +
        " contains data. Moving to next row."
      );


      targetRow++;
    }


    Logger.log(
      "Safe empty row found: " +
      targetRow
    );


    // ========================================================
    // CURRENT DATE / TIME
    // ========================================================
    //
    // IMPORTANT:
    // Always use Israel timezone.
    //
    // This avoids the 15:23 vs 01:23 problem caused
    // by the spreadsheet/script timezone.
    //
    // ========================================================

    const now =
      new Date();


    const timezone =
      "Asia/Jerusalem";


    const dateText =
      Utilities.formatDate(
        now,
        timezone,
        "dd/MM/yyyy"
      );


    const timeText =
      Utilities.formatDate(
        now,
        timezone,
        "HH:mm"
      );


    Logger.log(
      "Date: " +
      dateText
    );

    Logger.log(
      "Time: " +
      timeText
    );


    // ========================================================
    // PREPARE ROW
    // ========================================================

    const rowValues = [

      dateText,

      timeText,

      formatMeasurementValue(
        sugar
      ),

      formatMeasurementValue(
        temperature
      ),

      formatMeasurementValue(
        pressure
      ),

      formatMeasurementValue(
        pH
      ),

      formatMeasurementValue(
        carbonation
      ),

      notes !== undefined &&
      notes !== null
        ? String(notes)
        : ""

    ];


    Logger.log(
      "Prepared row:"
    );

    Logger.log(
      JSON.stringify(
        rowValues
      )
    );


    // ========================================================
    // FINAL SAFETY CHECK
    // ========================================================
    //
    // Check the row AGAIN immediately before writing.
    //
    // If anything appeared there, STOP.
    //
    // NEVER overwrite.
    //
    // ========================================================

    const finalExistingRow =
      sheet
        .getRange(
          targetRow,
          1,
          1,
          8
        )
        .getDisplayValues()[0];


    const finalRowHasData =
      finalExistingRow.some(
        function(value) {

          return String(
            value || ""
          ).trim() !== "";

        }
      );


    if (
      finalRowHasData
    ) {

      throw new Error(
        "SAFETY STOP: Target row " +
        targetRow +
        " is not empty. " +
        "Nothing was written."
      );
    }


    // ========================================================
    // WRITE ONLY A:H
    // ========================================================

    sheet
      .getRange(
        targetRow,
        1,
        1,
        8
      )
      .setValues([
        rowValues
      ]);


    // ========================================================
    // FORMAT DATE
    // ========================================================

    sheet
      .getRange(
        targetRow,
        1
      )
      .setNumberFormat(
        "dd/MM/yyyy"
      );


    // ========================================================
    // FORMAT TIME
    // ========================================================

    sheet
      .getRange(
        targetRow,
        2
      )
      .setNumberFormat(
        "HH:mm"
      );


    // ========================================================
    // FLUSH
    // ========================================================

    SpreadsheetApp.flush();


    Logger.log(
      "Measurement successfully written to row: " +
      targetRow
    );


    // ========================================================
    // RETURN RESULT
    // ========================================================

    return {

      success:
        true,

      spreadsheetId:
        spreadsheetId,

      sheetName:
        sheet.getName(),

      row:
        targetRow,

      date:
        dateText,

      time:
        timeText,

      sugar:
        formatMeasurementValue(
          sugar
        ),

      temperature:
        formatMeasurementValue(
          temperature
        ),

      pressure:
        formatMeasurementValue(
          pressure
        ),

      pH:
        formatMeasurementValue(
          pH
        ),

      carbonation:
        formatMeasurementValue(
          carbonation
        ),

      notes:
        notes !== undefined &&
        notes !== null
          ? String(notes)
          : "",

      sheetUrl:
        ss.getUrl()
    };


  } finally {

    // ========================================================
    // ALWAYS RELEASE LOCK
    // ========================================================

    lock.releaseLock();
  }
}


// ============================================================
// FORMAT OPTIONAL MEASUREMENT VALUE
// ============================================================

function formatMeasurementValue(
  value
) {

  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {

    return "";
  }


  // ==========================================================
  // NUMBER
  // ==========================================================

  if (
    typeof value === "number"
  ) {

    if (
      Number.isFinite(value)
    ) {

      return value;
    }

    return "";
  }


  // ==========================================================
  // STRING
  // ==========================================================

  const text =
    String(value)
      .trim();


  if (!text) {

    return "";
  }


  // ==========================================================
  // DIRECT NUMBER
  // ==========================================================

  const normalized =
    text.replace(
      ",",
      "."
    );


  const number =
    Number(
      normalized
    );


  if (
    Number.isFinite(number)
  ) {

    return number;
  }


  // ==========================================================
  // NUMBER INSIDE TEXT
  //
  // Examples:
  //
  // 1.3°C
  // 0.75Bar
  // 2.5°P
  //
  // ==========================================================

  const extracted =
    extractNumber(
      text
    );


  if (
    extracted !== null
  ) {

    return extracted;
  }


  // ==========================================================
  // KEEP ORIGINAL TEXT
  // ==========================================================

  return text;
}