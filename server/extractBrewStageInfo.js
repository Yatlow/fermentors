// ============================================================
// BREW STAGE SERVICE
// ============================================================
//
// שירות נפרד לחילוץ "באיזה בישול ובאיזה שלב" נמצא מיכל
// שעדיין ב-ACTION 0 (בישול פעיל, טרם תסיסה).
//
// לא נוגע ב-extractBrew() הקיים - זהו חילוץ משלים.
//
// ============================================================
//
// CHANGES IN THIS VERSION:
//
// 1) BUG FIX - "midnight rollover" false positive:
//    The cursor-date logic used to treat ANY backward jump in
//    clock time (e.g. stage B starts earlier than stage A) as
//    "we must have crossed midnight" and pushed the whole rest
//    of the block a day forward. A small backward jump caused
//    by a typo in the sheet (e.g. "20:58" instead of "20:08")
//    was enough to trigger this and misdate every later stage
//    in that block by a full day - which made "current stage"
//    get stuck on a stale stage until real midnight passed and
//    "fixed" it by accident.
//    Now only a backward jump larger than
//    MIDNIGHT_ROLLOVER_MIN_GAP_MINUTES counts as a real
//    midnight crossing; small backward jumps are treated as
//    same-day (and logged as a probable sheet typo).
//
// 2) extractBrewStageInfo() now accepts an optional second
//    argument, `fermentorHint` - the fermentor object already
//    fetched in bulk by brewActionService(). When provided, the
//    anchor-date fallback chain uses it instead of doing its
//    own getFermentorFromFirebase() Firestore GET.
//
// ============================================================


// ----------------------------------------------------------
// STAGE DEFINITIONS
// ----------------------------------------------------------

const STAGE_DEFS = [
  { code: 10, name: "הכנסת לתת", regex: /הכנסת\s*לתת/ },
  { code: 20, name: "השריה", regex: /השריה\s*(\d+)/, indexed: true },
  { code: 30, name: "חימום", regex: /חימום\s*(\d+)/, indexed: true },
  { code: 40, name: "העברה ל-L.T.", regex: /העברה\s*ל[\s\.]*L\.?\s*T\.?/i },
  { code: 50, name: "מנוחה L.T.", regex: /מנוחה\s*L\.?\s*T\.?/i },
  { code: 60, name: "סחרור", regex: /סחרור/ },
  { code: 70, name: "הוצאה לבישול", regex: /הוצאה\s*לבישול/ },
  { code: 80, name: "שטיפה", regex: /שטיפה\s*(\d+)/, indexed: true },
  { code: 90, name: "סוף העברה", regex: /סוף\s*העברה/ },
  { code: 100, name: "רתיחה", regex: /רתיחה\s*100/ },
  { code: 110, name: "סוף רתיחה", regex: /סוף\s*רתיחה/ },
  { code: 120, name: "הוצאה לתסיסה", regex: /הוצאה\s*לתסיסה/ }
];

const STAGE_CODE_OUT_TO_FERMENTOR = 120;

// NEW: minimum backward gap (in minutes) required before we treat
// a backward time jump as a real midnight crossing rather than a
// typo in the sheet. A real crossing (e.g. 23:19 -> 0:15) jumps
// back by hours; a typo (e.g. 20:58 -> 20:31) jumps back by minutes.
const MIDNIGHT_ROLLOVER_MIN_GAP_MINUTES = 6 * 60; // 6 hours


function formatHHMM(date) {

  if (!date) return null;

  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");

  return h + ":" + m;
}


// ----------------------------------------------------------
// TIME / DATE HELPERS
// ----------------------------------------------------------

function extractTimeFromCell(text) {

  if (!text) return null;

  const m = String(text).match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;

  const h = Number(m[1]);
  const mi = Number(m[2]);

  if (h > 23 || mi > 59) return null;

  return h * 60 + mi;
}

function extractDateFromText(text) {

  if (!text) return null;

  const m = String(text).match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;

  const day = Number(m[1]);
  const month = Number(m[2]) - 1;
  let year = Number(m[3]);

  if (year < 100) year += 2000;

  const d = new Date(year, month, day);
  if (isNaN(d.getTime())) return null;

  return d;
}


// ----------------------------------------------------------
// BLOCK DETECTION (header-based anchor)
// ----------------------------------------------------------
//
// כותרת בלוק אמיתית מכילה שלושה תאים: "סוג:", "אצווה:",
// ותא בשם "תאריך" (בלי נקודתיים!).
//
// שים לב שזה שונה מ:
// - השורה העליונה בגיליון: יש בה "תאריך:" (עם נקודתיים)
// - שורת "דף תסיסה" (סיכום אריזה): אין בה תא "תאריך" בכלל,
//   יש "מספר מיכל:" במקום.
// ----------------------------------------------------------

function findBrewBlockStarts(values) {

  const starts = [];

  for (let r = 1; r < values.length; r++) { // מתחילים מ-1, לא מ-0

    const row = values[r];
    let hasType = false;
    let hasBatch = false;
    let hasDateLabel = false;

    for (let c = 0; c < row.length; c++) {

      const cell = String(row[c] || "").trim();

      if (cell === "סוג:") hasType = true;
      if (cell === "אצווה:") hasBatch = true;
      if (cell === "תאריך") hasDateLabel = true; // בלי נקודתיים!
    }

    if (hasType && hasBatch && hasDateLabel) starts.push(r);
  }

  return starts;
}


// ----------------------------------------------------------
// MAIN: EXTRACT CURRENT BREW STAGE
// ----------------------------------------------------------
//
// מחזיר רק את מה שצריך בפועל להחלטת ACTION:
// - lastBlock (כדי לבדוק "הוצאה לתסיסה" בבלוק האחרון)
// - currentStage (השלב הנוכחי, לתצוגה ב-GUI)
// - beerVolume
//
// `fermentorHint` (NEW, optional): the fermentor object already
// fetched in bulk by brewActionService(). If provided and it has
// a brewDate, it's used in the anchor-date fallback chain instead
// of an extra getFermentorFromFirebase() Firestore GET.
// ----------------------------------------------------------

// function extractBrewStageInfo(spreadSheetId, fermentorHint) {

//   const spreadsheetId = extractSpreadsheetId(spreadSheetId);
//   const ss = SpreadsheetApp.openById(spreadsheetId);
//   const sheet = ss.getSheets()[0];
//   const values = sheet.getDataRange().getDisplayValues();

//   const batchHeader = values[0] || [];
//   const tankNumber = String(batchHeader[3] || "").trim() || null;

//   // ------------------------------------------------------
//   // ANCHOR DATE - שרשרת fallback עם בדיקת "תאריך תקוע"
//   // ------------------------------------------------------

//   let dateAssumed = false;
//   let anchorDate = extractDateFromText(batchHeader[7]);

//   const blockStarts = findBrewBlockStarts(values);

//   let firstBlockHeaderDate = null;

//   if (blockStarts.length > 0) {

//     const r = blockStarts[0];

//     for (let c = 0; c < values[r].length; c++) {

//       if (String(values[r][c]).trim() === "תאריך") {

//         firstBlockHeaderDate = extractDateFromText(values[r][c + 1]);
//         break;
//       }
//     }
//   }

//   // מזהים אם התאריך בכותרת העליונה תקוע (יותר מ-10 ימים מהיום)
//   let topHeaderDateWasStale = false;

//   if (anchorDate) {

//     const todayCheck = new Date();
//     todayCheck.setHours(0, 0, 0, 0);

//     const anchorCheck = new Date(anchorDate.getTime());
//     anchorCheck.setHours(0, 0, 0, 0);

//     const diffDays =
//       Math.abs(todayCheck.getTime() - anchorCheck.getTime()) /
//       (1000 * 60 * 60 * 24);

//     if (diffDays > 10) {

//       Logger.log(
//         "anchorDate from top header looks stale (" +
//         diffDays + " days off) - discarding: " +
//         batchHeader[7]
//       );

//       topHeaderDateWasStale = true;
//       anchorDate = null;
//     }
//   }

//   if (!anchorDate && firstBlockHeaderDate) {
//     anchorDate = firstBlockHeaderDate;
//   }

//   if (!anchorDate && tankNumber) {

//     try {

//       // CHANGED: prefer the already-fetched fermentor object over
//       // a fresh Firestore GET.
//       const existing = fermentorHint || getFermentorFromFirebase(tankNumber);

//       if (existing && existing.brewDate) {
//         anchorDate = extractDateFromText(existing.brewDate);
//       }

//     } catch (e) {
//       // best effort
//     }
//   }

//   if (!anchorDate) {

//     anchorDate = new Date();
//     anchorDate.setHours(0, 0, 0, 0);
//     dateAssumed = true;

//   } else {

//     anchorDate.setHours(0, 0, 0, 0);
//   }

//   // אם זוהה תאריך תקוע בכותרת העליונה ומצאנו תאריך תקין שמחליף
//   // אותו - כותבים אותו בחזרה לתא בגיליון, כדי שבפעם הבאה לא
//   // נצטרך את כל שרשרת ה-fallback הזו שוב.
//   if (topHeaderDateWasStale) {

//     try {

//       const dateCell = findCell(values, "תאריך:");

//       if (dateCell) {

//         const targetRow = dateCell.row + 1;       // 1-indexed
//         const targetCol = dateCell.col + 2;        // התא מימין לתווית, 1-indexed
//         const day = String(anchorDate.getDate()).padStart(2, "0");
//         const month = String(anchorDate.getMonth() + 1).padStart(2, "0");
//         const year = String(anchorDate.getFullYear());

//         sheet
//           .getRange(targetRow, targetCol)
//           .setNumberFormat("@")
//           .setValue(`${day}/${month}/${year}`);

//         Logger.log(
//           "Fixed stale top-header date in sheet -> " +
//           `${day}/${month}`
//         );

//       } else {

//         Logger.log(
//           "Could not locate top header date cell to fix - label 'תאריך:' not found."
//         );
//       }

//     } catch (error) {

//       // כתיבה לגיליון תלויה בהרשאות ה-deploy ("execute as") -
//       // אם הן לא מאפשרות כתיבה, לא נכשיל את כל התהליך.
//       Logger.log(
//         "Failed to write corrected date back to sheet: " + error.message
//       );
//     }
//   }

//   // ------------------------------------------------------
//   // WALK ALL ROWS, SPLIT INTO BLOCKS
//   // ------------------------------------------------------

//   const fermentationRow = findRowContaining(values, "דף תסיסה");
//   const headerStarts = new Set(blockStarts);

//   const scanStart = blockStarts.length ? blockStarts[0] : 0;
//   const scanEnd = (fermentationRow !== -1 ? fermentationRow : values.length) - 1;

//   const blocks = [];
//   let currentStages = [];
//   let sawOutToFermentInCurrentBlock = false;
//   let cursorMinutes = null;
//   const cursorDate = new Date(anchorDate.getTime());

//   function closeCurrentBlock() {
//     if (currentStages.length > 0) {
//       blocks.push({
//         blockIndex: blocks.length + 1,
//         stages: currentStages
//       });
//     }
//     currentStages = [];
//     sawOutToFermentInCurrentBlock = false;
//   }

//   rowLoop:
//   for (let r = scanStart; r <= scanEnd; r++) {

//     const row = values[r] || [];
//     const rowText = row.map(c => String(c || "").trim());

//     if (headerStarts.has(r) && r !== scanStart) {
//       closeCurrentBlock();
//     }

//     for (let s = 0; s < STAGE_DEFS.length; s++) {

//       const def = STAGE_DEFS[s];

//       for (let c = 0; c < rowText.length; c++) {

//         const cellText = rowText[c];
//         if (!cellText) continue;

//         const match = cellText.match(def.regex);
//         if (!match) continue;

//         const subIndex = def.indexed ? Number(match[1]) : null;
//         const code = def.indexed ? def.code + (subIndex - 1) : def.code;
//         const name = def.indexed ? (def.name + " " + subIndex) : def.name;

//         if (code === 10 && sawOutToFermentInCurrentBlock) {
//           closeCurrentBlock();
//         }

//         let startMin = null;
//         let endMin = null;

//         for (let cc = c + 1; cc < rowText.length; cc++) {

//           const t = extractTimeFromCell(rowText[cc]);
//           if (t === null) continue;

//           if (startMin === null) {
//             startMin = t;
//           } else {
//             endMin = t;
//             break;
//           }
//         }

//         if (startMin === null) continue;

//         // ----------------------------------------------------
//         // FIXED: only treat a LARGE backward jump as a real
//         // midnight crossing. A small backward jump is far more
//         // likely to be a typo in the sheet (e.g. "20:58" meant
//         // to be "20:08") than an actual day rollover.
//         // ----------------------------------------------------
//         if (
//           cursorMinutes !== null &&
//           startMin < cursorMinutes &&
//           (cursorMinutes - startMin) > MIDNIGHT_ROLLOVER_MIN_GAP_MINUTES
//         ) {
//           cursorDate.setDate(cursorDate.getDate() + 1);
//         } else if (cursorMinutes !== null && startMin < cursorMinutes) {
//           Logger.log(
//             "Small backward time jump at stage '" + name +
//             "' (row " + (r + 1) + "): " +
//             cursorMinutes + "min -> " + startMin + "min. " +
//             "Treating as same-day (likely a typo in the sheet), not midnight."
//           );
//         }

//         cursorMinutes = startMin;

//         const startDateTime = new Date(cursorDate.getTime());
//         startDateTime.setHours(0, startMin, 0, 0);

//         let endDateTime = null;

//         if (endMin !== null) {

//           if (
//             endMin < startMin &&
//             (startMin - endMin) > MIDNIGHT_ROLLOVER_MIN_GAP_MINUTES
//           ) {
//             cursorDate.setDate(cursorDate.getDate() + 1);
//           }

//           cursorMinutes = endMin;

//           endDateTime = new Date(cursorDate.getTime());
//           endDateTime.setHours(0, endMin, 0, 0);
//         }

//         currentStages.push({
//           code: code,
//           name: name,
//           row: r,
//           startDateTime: startDateTime,
//           endDateTime: endDateTime
//         });

//         if (code === STAGE_CODE_OUT_TO_FERMENTOR) {
//           sawOutToFermentInCurrentBlock = true;
//         }

//         continue rowLoop;
//       }
//     }
//   }

//   closeCurrentBlock();

//   // ------------------------------------------------------
//   // CURRENT STAGE
//   // ------------------------------------------------------

//   const now = new Date();
//   let currentStage = null;
//   let currentBlockIndex = null;

//   for (let bi = blocks.length - 1; bi >= 0 && !currentStage; bi--) {

//     const stages = blocks[bi].stages;

//     for (let si = stages.length - 1; si >= 0; si--) {

//       if (stages[si].startDateTime.getTime() <= now.getTime()) {

//         currentStage = stages[si];
//         currentBlockIndex = blocks[bi].blockIndex;
//         break;
//       }
//     }
//   }

//   // ------------------------------------------------------
//   // VOLUME
//   // ------------------------------------------------------

//   let beerVolume = null;
//   const volumeLocation = findCell(values, "נפח:");

//   if (volumeLocation) {
//     beerVolume = extractNumber(values[volumeLocation.row][volumeLocation.col + 1]);
//   }

//   const headerCount = blockStarts.length;
//   const hasUnstartedHeader = headerCount > blocks.length;

//   return {

//     tankNumber: tankNumber,
//     dateAssumed: dateAssumed,

//     blockCount: blocks.length,
//     headerCount: headerCount,
//     hasUnstartedHeader: hasUnstartedHeader,

//     lastBlock: blocks.length ? blocks[blocks.length - 1] : null,

//     currentBlockIndex: currentBlockIndex,
//     currentStage: currentStage,

//     beerVolume: beerVolume
//   };
// }


// ----------------------------------------------------------
// PERSIST CURRENT STAGE TO FIREBASE
// ----------------------------------------------------------

// ----------------------------------------------------------
// PERSIST CURRENT STAGE TO FIREBASE
// ----------------------------------------------------------

// function updateFermentorBrewProgress(tankNumber, stageInfo) {

//   const fermentorId = String(tankNumber).trim();

//   const stage = stageInfo.currentStage;

//   const progress = {

//     blockIndex: stageInfo.currentBlockIndex || null,
//     blockCount: stageInfo.blockCount || null,

//     stageCode: stage ? stage.code : null,
//     stageName: stage ? stage.name : null,

//     // ISO מלא - שימושי למיון/חישובים עתידיים בפרונט אם יידרש
//     stageStartTime: stage ? stage.startDateTime : null,
//     stageEndTime: stage ? stage.endDateTime : null, // null מפורש אם עוד לא הסתיים

//     // HH:MM מוכן לתצוגה - לא צריך parsing בפרונט
//     stageStartTimeText: stage ? formatHHMM(stage.startDateTime) : null,
//     stageEndTimeText: stage ? formatHHMM(stage.endDateTime) : null, // null מפורש

//     dateAssumed: !!stageInfo.dateAssumed
//   };

//   // ----------------------------------------------------------
//   // NEW: local change-detection, אותו דפוס בדיוק כמו packaging/
//   // fermentor sync ב-runFermentorCycle. אם ה-progress לא השתנה
//   // מהמחזור הקודם - מדלגים על ה-PATCH ל-Firestore לגמרי.
//   // שימו לב: זה לא חוסך את קריאת ה-Sheet עצמה (extractBrewStageInfo
//   // עדיין רץ בכל מחזור) - רק את הכתיבה המיותרת.
//   // ----------------------------------------------------------

//   const progressCacheKey = "brewProgress:" + fermentorId;

//   if (!hasChangedLocally_(progressCacheKey, progress)) {

//     Logger.log(
//       "Brew progress unchanged for tank " +
//       fermentorId +
//       " - skipping Firestore write."
//     );

//     return;
//   }

//   const url =
//     "https://firestore.googleapis.com/v1/projects/" + FIREBASE_PROJECT_ID +
//     "/databases/(default)/documents/fermentors/" + encodeURIComponent(fermentorId) +
//     "?updateMask.fieldPaths=brewProgress";

//   const document = {
//     fields: {
//       brewProgress: toFirestoreValue(progress)
//     }
//   };

//   const response = UrlFetchApp.fetch(url, {

//     method: "patch",
//     contentType: "application/json",

//     headers: {
//       Authorization: "Bearer " + ScriptApp.getOAuthToken()
//     },

//     payload: JSON.stringify(document),
//     muteHttpExceptions: true
//   });

//   const code = response.getResponseCode();

//   if (code < 200 || code >= 300) {

//     throw new Error(
//       "Failed to update brewProgress for tank " + fermentorId +
//       ": " + code + " " + response.getContentText()
//     );
//   }
// }


// ----------------------------------------------------------
// TEST
// ----------------------------------------------------------

function testExtractStageInfo() {

  const url = "https://docs.google.com/spreadsheets/d/1eT7aP7zbhqSk6gDzhqN-Tp2Wvt3Y4dqGsRyqyNftrB8/edit";
  const info = extractBrewStageInfo(url);

  Logger.log(JSON.stringify(info, null, 2));
}