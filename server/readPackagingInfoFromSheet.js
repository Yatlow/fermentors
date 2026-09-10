// ============================================================
// READ PACKAGING INFO FROM SHEET (mirror of updatePackagingInfo)
// ============================================================
//
// קוראת בדיוק מאותם תאים ש-updatePackagingInfo כותבת אליהם,
// כדי לתפוס גם דיווחי אריזה שנעשו ידנית בגיליון ולא דרך הפרונט.
// ============================================================

// function readPackagingInfoFromSheet(sheetUrl) {

//   if (!sheetUrl) return null;

//   const spreadsheetId = extractSpreadsheetId(sheetUrl);
//   const ss = SpreadsheetApp.openById(spreadsheetId);
//   const sheet = ss.getSheets()[0];
//   if (!sheet) return null;

//   const values = sheet.getDataRange().getDisplayValues();

//   const result = {
//     kegs: null,
//     crates: null,
//     totalLiters: null,
//     shrinkagePercent: null
//   };

//   // --- חביות: שורה אחת מתחת לתווית, אותה עמודה ---
//   const kegsPos = findLabelCell(values, ["חביות"]);
//   if (kegsPos && values[kegsPos.row + 1]) {
//     result.kegs = extractNumber(values[kegsPos.row + 1][kegsPos.col]);
//   }

//   // --- ארגזים: שורה אחת מתחת לתווית, אותה עמודה ---
//   const cratesPos = findLabelCell(values, ["ארגזים"]);
//   if (cratesPos && values[cratesPos.row + 1]) {
//     result.crates = extractNumber(values[cratesPos.row + 1][cratesPos.col]);
//   }

//   // --- סה"כ: אותה שורה, עמודה אחת ימינה מהתווית ---
//   const totalPos = findLabelCell(values, ['סה"כ', "סהכ"]);
//   if (totalPos && values[totalPos.row]) {
//     result.totalLiters = extractNumber(values[totalPos.row][totalPos.col + 1]);
//   }

//   // --- פחת: אותה שורה, עמודה אחת ימינה מהתווית ---
//   const shrinkagePos = findLabelCell(values, ["פחת"]);
//   if (shrinkagePos && values[shrinkagePos.row]) {
//     result.shrinkagePercent = extractNumber(values[shrinkagePos.row][shrinkagePos.col + 1]);
//   }

//   return result;
// }

function testReadPackaging4() {
  const fermentor = getFermentorFromFirebase("4");
  const result = readPackagingInfoFromSheet(fermentor.sheetUrl);
  Logger.log(JSON.stringify(result, null, 2));
}
// ============================================================
// CLEAR PACKAGING CACHE ONLY (monthly reset)
// ============================================================
//
// מוחק אך ורק את מפתחות ה-cache שקשורים לנתוני אריזה
// ("packaging:<fermentorId>"), בלי לגעת ב-cache של
// fermentor:* או measurement:*.
//
// שימושי לאתחול תקופתי (למשל פעם בחודש), כדי לוודא
// שהמערכת תקרא מחדש את נתוני האריזה מהגיליון ותכתוב אותם
// שוב ל-Firestore גם אם מבחינת ה-hash "כלום לא השתנה"
// (למשל אם מישהו שינה ידנית ב-Firestore בלי לגעת בגיליון).
// ============================================================

function clearPackagingCache() {

  const props = PropertiesService.getScriptProperties();
  const allProps = props.getProperties();

  const keysToDelete = Object.keys(allProps)
    .filter(function (key) {
      return key.indexOf("packaging:") === 0;
    });

  keysToDelete.forEach(function (key) {
    props.deleteProperty(key);
  });

  Logger.log(
    "Cleared packaging cache. Deleted " +
    keysToDelete.length +
    " key(s)."
  );

  return {
    deletedCount: keysToDelete.length,
    deletedKeys: keysToDelete
  };
}


// ============================================================
// MONTHLY TRIGGER FOR PACKAGING CACHE RESET
// ============================================================

