// ============================================================
// BACKFILL: packagingMasterSheet -> Firestore (packagingLog)
//
// הרצה חד-פעמית מתוך עורך ה-Apps Script:
// backfillPackagingLogToFirestore()
//
// לפני ההרצה יש לוודא:
// 1. SHEET_ID
// 2. TAB_NAME
// 3. מספרי העמודות
// 4. BREWS_LOOKUP_CONFIG - שמות השדות במסמכי ה-brews (ראה הערה למטה!)
// ============================================================

const PACKAGING_BACKFILL_CONFIG = {
  SHEET_ID: "13ONg8FJSy_5mHH8EbjNaVHph_nsTKdkVvoXMthJJPb8",
  TAB_NAME: "Sheet1",

  // שורת הנתונים הראשונה
  FIRST_DATA_ROW: 2,

  // 1 = A, 2 = B וכו'
  //
  // מוצר | כמות ארגזים/חביות | מספר אצוה |
  // תאריך תוקף | תאריך יצור | תאריך יציאה | ליטרים
  COL_PRODUCT_LABEL: 1,
  COL_QUANTITY: 2,
  COL_BATCH_NUMBER: 3,
  COL_EXPIRY_DATE: 4,
  COL_PRODUCTION_DATE: 5,
};


// ============================================================
// BREWS LOOKUP CONFIG
//
// !! חשוב !! - ודא שהשמות האלה תואמים בפועל למסמכים
// בקולקציית brews לפני הרצת הבקפיל. אפשר לבדוק בקונסולת
// Firebase -> Firestore -> brews -> לפתוח מסמך ולראות את שמות השדות.
// ============================================================

const BREWS_LOOKUP_CONFIG = {
  COLLECTION: "brews",
  BATCH_NUMBER_FIELD: "batchNumber", // TODO: ודא מול הקונסולה
  TANK_NUMBER_FIELD: "tankNumber",   // TODO: ודא מול הקונסולה
};


// ============================================================
// זיהוי סוג אריזה
// ============================================================

const PACKAGING_CONTAINER_TOKENS = [
  "ארגזים",
  "ארגזי",
  "ארגז",

  "חביות",
  "חבית",

  "בקבוקים",
  "בקבוקי",
  "בקבוק",
];

const KEG_TOKENS = [
  "חביות",
  "חבית",
];


// ============================================================
// MAIN BACKFILL
// ============================================================

function backfillPackagingLogToFirestore() {
  const cfg = PACKAGING_BACKFILL_CONFIG;

  const ss = SpreadsheetApp.openById(cfg.SHEET_ID);
  const sheet = ss.getSheetByName(cfg.TAB_NAME);

  if (!sheet) {
    throw new Error(
      "Tab not found: " + cfg.TAB_NAME
    );
  }

  const lastRow = sheet.getLastRow();

  if (lastRow < cfg.FIRST_DATA_ROW) {
    Logger.log("No data rows found.");
    return;
  }

  const numRows =
    lastRow -
    cfg.FIRST_DATA_ROW +
    1;

  /*
   * קוראים A:G.
   * כרגע משתמשים רק בעמודות שהוגדרו למעלה.
   */
  const values = sheet
    .getRange(
      cfg.FIRST_DATA_ROW,
      1,
      numRows,
      7
    )
    .getValues();

  // --------------------------------------------------------
  // טוענים את מפת batchNumber -> tankNumber פעם אחת בלבד,
  // לפני הלולאה על השורות. ככה אין query נפרד לכל שורה.
  // --------------------------------------------------------
  const batchToTankMap = loadBrewsBatchToTankMap_();

  let written = 0;
  let skipped = 0;
  let tankMatched = 0;
  let tankMissing = 0;

  values.forEach(function (row, idx) {

    const rowNumber =
      cfg.FIRST_DATA_ROW + idx;

    try {

      // --------------------------------------------------------
      // קריאת נתוני השורה
      // --------------------------------------------------------

      const productLabelRaw =
        String(
          row[cfg.COL_PRODUCT_LABEL - 1] || ""
        ).trim();

      const quantityRaw =
        row[cfg.COL_QUANTITY - 1];

      const batchNumber =
        row[cfg.COL_BATCH_NUMBER - 1];

      const expiryDateRaw =
        row[cfg.COL_EXPIRY_DATE - 1];

      const productionDateRaw =
        row[cfg.COL_PRODUCTION_DATE - 1];


      // --------------------------------------------------------
      // בדיקות בסיס
      // --------------------------------------------------------

      if (
        !productLabelRaw ||
        !productionDateRaw
      ) {
        Logger.log(
          "Skipping row " +
          rowNumber +
          " - missing product or production date"
        );

        skipped++;
        return;
      }


      // --------------------------------------------------------
      // כמות
      // --------------------------------------------------------

      const quantity =
        extractLeadingNumber_(quantityRaw);

      if (
        quantity === null ||
        quantity <= 0
      ) {
        Logger.log(
          "Skipping row " +
          rowNumber +
          " - could not extract quantity from: " +
          quantityRaw
        );

        skipped++;
        return;
      }


      if (
        typeof quantityRaw !== "number"
      ) {
        Logger.log(
          "Row " +
          rowNumber +
          ' had free-text quantity "' +
          quantityRaw +
          '" - used ' +
          quantity
        );
      }


      // --------------------------------------------------------
      // תאריכים
      // --------------------------------------------------------

      const productionDateStr =
        formatCellAsDDMMYYYY_(
          productionDateRaw
        );

      const expiryDateStr =
        formatCellAsDDMMYYYY_(
          expiryDateRaw
        );

      if (!productionDateStr) {
        Logger.log(
          "Skipping row " +
          rowNumber +
          " - invalid production date: " +
          productionDateRaw
        );

        skipped++;
        return;
      }


      const productionDate =
        productionDateRaw instanceof Date
          ? productionDateRaw
          : parseDDMMYYYY_(
              productionDateStr
            );


      if (!productionDate) {
        Logger.log(
          "Skipping row " +
          rowNumber +
          " - could not resolve production date: " +
          productionDateRaw
        );

        skipped++;
        return;
      }


      // --------------------------------------------------------
      // פירוק שם המוצר
      // --------------------------------------------------------

      const parsed =
        parseProductLabel_(
          productLabelRaw
        );


      if (!parsed.beerStyle) {
        Logger.log(
          "Skipping row " +
          rowNumber +
          " - could not extract beer style from: \"" +
          productLabelRaw +
          "\""
        );

        skipped++;
        return;
      }


      const packagingType =
        parsed.packagingType;

      const beerStyle =
        parsed.beerStyle;

      const unit =
        packagingType === "kegs"
          ? "חביות"
          : "ארגזים";


      // --------------------------------------------------------
      // Title
      // --------------------------------------------------------

      const title =
        packagingType === "kegs"
          ? "אריזת חביות " +
            beerStyle +
            " - " +
            quantity +
            " חביות"
          : "אריזת " +
            beerStyle +
            " - " +
            quantity +
            " ארגזים";


      // --------------------------------------------------------
      // tankNumber - לפי מספר אצווה, מתוך המפה שנטענה מ-brews
      // --------------------------------------------------------

      const tankNumberFromBrews =
        batchNumber != null && String(batchNumber).trim() !== ""
          ? batchToTankMap[normalizeBatchKey_(batchNumber)]
          : undefined;

      if (
        tankNumberFromBrews !== undefined &&
        tankNumberFromBrews !== null
      ) {
        tankMatched++;
      } else {
        tankMissing++;

        Logger.log(
          "Row " +
          rowNumber +
          " - no tankNumber found in brews for batch \"" +
          batchNumber +
          "\""
        );
      }


      // --------------------------------------------------------
      // Firestore fields
      // --------------------------------------------------------

      const fields = {

        source: {
          stringValue: "actual"
        },

        packagingType: {
          stringValue: packagingType
        },

        beerStyle: {
          stringValue: beerStyle
        },

        quantity: {
          integerValue:
            String(
              Math.round(quantity)
            )
        },

        unit: {
          stringValue: unit
        },

        batchNumber: {
          stringValue:
            String(
              batchNumber || ""
            )
        },

        productionDateStr: {
          stringValue:
            productionDateStr
        },

        expiryDateStr: {
          stringValue:
            expiryDateStr
        },

        date: {
          stringValue:
            productionDateStr
        },

        timestamp: {
          integerValue:
            String(
              productionDate.getTime()
            )
        },

        title: {
          stringValue: title
        },

        /*
         * שומרים את הערך המקורי מהגיליון.
         * זה שימושי מאוד אם בעתיד נגלה
         * בעיית parsing.
         */
        sourceProductLabel: {
          stringValue:
            productLabelRaw
        },

        backfilled: {
          booleanValue: true
        }
      };


      // מוסיפים tankNumber רק אם נמצא במפה
      if (
        tankNumberFromBrews !== undefined &&
        tankNumberFromBrews !== null
      ) {
        fields.tankNumber =
          typeof tankNumberFromBrews === "number"
            ? { integerValue: String(Math.round(tankNumberFromBrews)) }
            : { stringValue: String(tankNumberFromBrews) };
      }


      // --------------------------------------------------------
      // Stable Document ID
      //
      // אותו row תמיד יעדכן את אותו document.
      // לכן הרצה חוזרת לא יוצרת כפילויות.
      // --------------------------------------------------------

      const docId =
        "backfill_row_" +
        rowNumber;


      firestoreUpsertDocument_(
        "packagingLog",
        docId,
        fields
      );


      written++;


      // --------------------------------------------------------
      // Rate limiting קטן
      // --------------------------------------------------------

      if (
        written > 0 &&
        written % 50 === 0
      ) {
        Utilities.sleep(300);
      }

    } catch (err) {

      Logger.log(
        "Failed to process row " +
        rowNumber +
        ": " +
        (err && err.message
          ? err.message
          : err)
      );

      skipped++;
    }
  });


  Logger.log(
    "Backfill done. Written: " +
    written +
    ", Skipped: " +
    skipped +
    ", tankNumber matched: " +
    tankMatched +
    ", tankNumber missing: " +
    tankMissing
  );
}


// ============================================================
// BREWS CACHE - batchNumber -> tankNumber
//
// נטען פעם אחת בתחילת ה-backfill (לא query בלולאה).
// ============================================================

function loadBrewsBatchToTankMap_() {
  const map = {};

  const docs =
    firestoreListAllDocuments_(
      BREWS_LOOKUP_CONFIG.COLLECTION
    );

  docs.forEach(function (doc) {

    const fields =
      doc.fields || {};

    const batchValue =
      extractFirestoreFieldValue_(
        fields[
          BREWS_LOOKUP_CONFIG
            .BATCH_NUMBER_FIELD
        ]
      );

    const tankValue =
      extractFirestoreFieldValue_(
        fields[
          BREWS_LOOKUP_CONFIG
            .TANK_NUMBER_FIELD
        ]
      );

    if (
      batchValue === null ||
      tankValue === null
    ) {
      return;
    }

    const key =
      normalizeBatchKey_(batchValue);

    if (!key) {
      return;
    }

    /*
     * אם יש יותר ממסמך brew אחד לאותה אצווה
     * (לא אמור לקרות, אבל ליתר ביטחון) -
     * המסמך האחרון שנקרא "מנצח".
     */
    map[key] = tankValue;
  });

  Logger.log(
    "Loaded brews batch->tank map: " +
    Object.keys(map).length +
    " batches (from " +
    docs.length +
    " brew docs)"
  );

  return map;
}

function normalizeBatchKey_(value) {
  return String(value).trim();
}

/** ממיר ערך typed של Firestore (stringValue/integerValue/...) לערך JS פשוט */
function extractFirestoreFieldValue_(fieldObj) {
  if (!fieldObj) {
    return null;
  }

  if (fieldObj.stringValue !== undefined) {
    return fieldObj.stringValue;
  }

  if (fieldObj.integerValue !== undefined) {
    return Number(fieldObj.integerValue);
  }

  if (fieldObj.doubleValue !== undefined) {
    return Number(fieldObj.doubleValue);
  }

  if (fieldObj.booleanValue !== undefined) {
    return fieldObj.booleanValue;
  }

  return null;
}

/**
 * מביא את כל המסמכים בקולקציה נתונה, עם pagination.
 * שימוש כללי - לא תלוי בשאילתה, מביא הכל.
 */
function firestoreListAllDocuments_(collectionPath) {

  const baseUrl =
    "https://firestore.googleapis.com/v1/projects/" +
    FIREBASE_PROJECT_ID +
    "/databases/(default)/documents/" +
    collectionPath;

  const allDocs = [];
  let pageToken = null;

  do {

    let url =
      baseUrl + "?pageSize=300";

    if (pageToken) {
      url +=
        "&pageToken=" +
        encodeURIComponent(pageToken);
    }

    const response =
      UrlFetchApp.fetch(url, {
        method: "get",
        headers: {
          Authorization:
            "Bearer " +
            ScriptApp.getOAuthToken()
        },
        muteHttpExceptions: true
      });

    const code =
      response.getResponseCode();

    if (
      code < 200 ||
      code >= 300
    ) {
      throw new Error(
        "Firestore list failed (" +
        collectionPath +
        "): " +
        code +
        " " +
        response.getContentText()
      );
    }

    const data =
      JSON.parse(
        response.getContentText()
      );

    (data.documents || []).forEach(
      function (doc) {
        allDocs.push(doc);
      }
    );

    pageToken =
      data.nextPageToken || null;

  } while (pageToken);

  return allDocs;
}


// ============================================================
// PARSE PRODUCT LABEL
// ============================================================

/**
 * דוגמאות:
 *
 * "ארגזים ניו לאגר חייות"
 * -> bottles
 * -> "ניו לאגר חייות"
 *
 * "פייל חביות בניס"
 * -> kegs
 * -> "פייל בניס"
 *
 * "חבית בניס 20 ליטר IPA"
 * -> kegs
 * -> "בניס 20 ליטר IPA"
 *
 * מסיר רק מילים שלמות.
 */
function parseProductLabel_(rawLabel) {

  const tokens =
    String(rawLabel)
      .trim()
      .split(/\s+/);

  let packagingType =
    "bottles";

  const remainingTokens = [];


  tokens.forEach(function (token) {

    const isContainerToken =
      PACKAGING_CONTAINER_TOKENS.indexOf(
        token
      ) !== -1;


    if (isContainerToken) {

      if (
        KEG_TOKENS.indexOf(token) !== -1
      ) {
        packagingType = "kegs";
      }

      return;
    }


    remainingTokens.push(token);
  });


  const beerStyle =
    remainingTokens
      .join(" ")
      .trim();


  return {
    packagingType: packagingType,
    beerStyle: beerStyle
  };
}


// ============================================================
// EXTRACT QUANTITY
// ============================================================

/**
 * מספר:
 * 53 -> 53
 *
 * טקסט:
 * "53 ארגזים ו8 בקבוקים" -> 53
 *
 * "241 ארגז ו 1 בקבוק" -> 241
 */
function extractLeadingNumber_(value) {

  if (
    typeof value === "number" &&
    Number.isFinite(value)
  ) {
    return value;
  }


  const str =
    String(value || "").trim();


  const match =
    str.match(
      /-?\d+(\.\d+)?/
    );


  if (!match) {
    return null;
  }


  const num =
    Number(match[0]);


  return Number.isFinite(num)
    ? num
    : null;
}


// ============================================================
// CLEANUP
// ============================================================

/**
 * מוחק את כל הרשומות שנוצרו על ידי backfill.
 *
 * לא מוחק רשומות רגילות שנכתבו מהאפליקציה.
 */
function deleteBackfilledPackagingLogDocs() {

  const PAGE_SIZE = 100;

  let deleted = 0;
  let failed = 0;


  while (true) {

    const docs =
      firestoreRunQuery_(
        "packagingLog",
        "backfilled",
        true,
        PAGE_SIZE
      );


    if (docs.length === 0) {
      break;
    }


    let deletedThisRound = 0;


    docs.forEach(function (docName) {

      try {

        firestoreDeleteDocument_(
          docName
        );

        deleted++;
        deletedThisRound++;

      } catch (err) {

        failed++;

        Logger.log(
          "Failed to delete " +
          docName +
          ": " +
          (err && err.message
            ? err.message
            : err)
        );
      }
    });


    Logger.log(
      "Deleted so far: " +
      deleted +
      ", Failed: " +
      failed
    );


    /*
     * אם שום דבר לא נמחק,
     * אין טעם להמשיך שוב ושוב.
     */
    if (
      deletedThisRound === 0
    ) {
      throw new Error(
        "Cleanup stopped because no documents could be deleted."
      );
    }


    Utilities.sleep(300);
  }


  Logger.log(
    "Cleanup done. Total deleted: " +
    deleted +
    ", Failed: " +
    failed
  );
}


// ============================================================
// FIRESTORE QUERY
// ============================================================

/**
 * WHERE field == booleanValue
 *
 * מחזיר full document names.
 */
function firestoreRunQuery_(
  collectionPath,
  fieldName,
  boolValue,
  limit
) {

  const url =
    "https://firestore.googleapis.com/v1/projects/" +
    FIREBASE_PROJECT_ID +
    "/databases/(default)/documents:runQuery";


  const body = {

    structuredQuery: {

      from: [
        {
          collectionId:
            collectionPath
        }
      ],

      where: {

        fieldFilter: {

          field: {
            fieldPath:
              fieldName
          },

          op: "EQUAL",

          value: {
            booleanValue:
              boolValue
          }
        }
      },

      limit: limit
    }
  };


  const response =
    UrlFetchApp.fetch(
      url,
      {
        method: "post",

        contentType:
          "application/json",

        headers: {
          Authorization:
            "Bearer " +
            ScriptApp.getOAuthToken()
        },

        payload:
          JSON.stringify(body),

        muteHttpExceptions:
          true
      }
    );


  const code =
    response.getResponseCode();


  if (
    code < 200 ||
    code >= 300
  ) {
    throw new Error(
      "Firestore runQuery failed: " +
      code +
      " " +
      response.getContentText()
    );
  }


  const results =
    JSON.parse(
      response.getContentText()
    );


  return results
    .filter(function (r) {
      return (
        r.document &&
        r.document.name
      );
    })
    .map(function (r) {
      return r.document.name;
    });
}


// ============================================================
// FIRESTORE DELETE
// ============================================================

function firestoreDeleteDocument_(
  fullDocName
) {

  const url =
    "https://firestore.googleapis.com/v1/" +
    fullDocName;


  const response =
    UrlFetchApp.fetch(
      url,
      {
        method: "delete",

        headers: {
          Authorization:
            "Bearer " +
            ScriptApp.getOAuthToken()
        },

        muteHttpExceptions:
          true
      }
    );


  const code =
    response.getResponseCode();


  if (
    code < 200 ||
    code >= 300
  ) {
    throw new Error(
      "Firestore delete failed: " +
      code +
      " " +
      response.getContentText()
    );
  }
}


// ============================================================
// FIRESTORE UPSERT
// ============================================================

/**
 * יוצר או מעדכן document לפי ID קבוע.
 *
 * PATCH (ללא updateMask) מחליף את כל המסמך לפי השדות שסופקו.
 * לכן חשוב שה-fields שאנחנו שולחים כאן יכללו את כל מה שרוצים
 * שיישאר במסמך (זה כבר המצב הקיים בקוד המקורי).
 *
 * כך אפשר להריץ את ה-backfill
 * כמה פעמים בלי ליצור כפילויות.
 */
function firestoreUpsertDocument_(
  collectionPath,
  docId,
  fields
) {

  const url =
    "https://firestore.googleapis.com/v1/projects/" +
    FIREBASE_PROJECT_ID +
    "/databases/(default)/documents/" +
    collectionPath +
    "/" +
    encodeURIComponent(docId);


  const response =
    UrlFetchApp.fetch(
      url,
      {
        method: "patch",

        contentType:
          "application/json",

        headers: {
          Authorization:
            "Bearer " +
            ScriptApp.getOAuthToken()
        },

        payload:
          JSON.stringify({
            fields: fields
          }),

        muteHttpExceptions:
          true
      }
    );


  const code =
    response.getResponseCode();


  if (
    code < 200 ||
    code >= 300
  ) {

    throw new Error(
      "Firestore upsert failed: " +
      code +
      " " +
      response.getContentText()
    );
  }


  return JSON.parse(
    response.getContentText()
  );
}


// ============================================================
// DATE HELPERS
// ============================================================

/**
 * הופך תא גיליון ל-dd/mm/yyyy.
 *
 * תומך ב:
 * - Date אמיתי
 * - טקסט dd/mm/yyyy
 */
function formatCellAsDDMMYYYY_(
  cellValue
) {

  if (!cellValue) {
    return "";
  }


  if (
    cellValue instanceof Date
  ) {

    const dd =
      String(
        cellValue.getDate()
      ).padStart(2, "0");


    const mm =
      String(
        cellValue.getMonth() + 1
      ).padStart(2, "0");


    const yyyy =
      cellValue.getFullYear();


    return (
      dd +
      "/" +
      mm +
      "/" +
      yyyy
    );
  }


  const str =
    String(cellValue).trim();


  const parsed =
    parseDDMMYYYY_(str);


  return parsed
    ? str
    : "";
}


// ============================================================
// PARSE DATE
// ============================================================

/**
 * ממיר dd/mm/yyyy ל-Date.
 *
 * תומך גם בשנה דו-ספרתית:
 * 02/09/26 -> 02/09/2026
 */
function parseDDMMYYYY_(
  str
) {

  const match =
    String(str)
      .trim()
      .match(
        /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/
      );


  if (!match) {
    return null;
  }


  const day =
    Number(match[1]);

  const month =
    Number(match[2]);

  let year =
    Number(match[3]);


  if (year < 100) {
    year += 2000;
  }


  const d =
    new Date(
      year,
      month - 1,
      day
    );


  /*
   * בדיקה שהתאריך באמת קיים.
   * למשל 31/02/2026 לא יעבור.
   */
  if (
    d.getFullYear() !== year ||
    d.getMonth() !== month - 1 ||
    d.getDate() !== day
  ) {
    return null;
  }


  return d;
}