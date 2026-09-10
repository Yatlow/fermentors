/*************************************************
 * BREW SEARCH SERVICE
 *
 * חיפוש בישול הבא לפי:
 *
 * 1. מספר אצווה מתוך שם הקובץ
 * 2. מספר גדול מהאצווה הנוכחית
 * 3. מספר מיכל מתוך השורות הראשונות בקובץ
 *
 * דוגמה לשם:
 *   IPA משולש 1568#
 *   1576# סטאוט
 *
 * אנחנו מתייחסים רק למספר.
 *************************************************/


/***********************
 * CONFIG
 ***********************/

const BREW_ROOT_FOLDER_ID =
  '0B6DbCIATIM92fm1KQkpVeTR3dXk1ZVRPOUttUVJGelMzcl9nUTR6SzM3ZEE3WjVvc0RvSVk';


/*************************************************
 * MAIN
 *************************************************/

function findNextBrewForTank(tankNumber, currentBatch) {

  tankNumber = String(tankNumber).trim();
  currentBatch = Number(currentBatch);

  Logger.log('========================================');
  Logger.log('SEARCHING NEXT BREW');
  Logger.log('Tank: ' + tankNumber);
  Logger.log('Current batch: ' + currentBatch);
  Logger.log('========================================');

  if (!tankNumber || isNaN(currentBatch)) {
    Logger.log('INVALID INPUT');
    return null;
  }


  /*************************************************
   * 1. מציאת כל הקבצים העתידיים
   *************************************************/

  const rootFolder =
    DriveApp.getFolderById(BREW_ROOT_FOLDER_ID);

  const candidates = [];

  collectBrewFiles(
    rootFolder,
    currentBatch,
    candidates
  );


  Logger.log('----------------------------------------');
  Logger.log(
    'Future candidates found: ' +
    candidates.length
  );


  if (candidates.length === 0) {

    Logger.log('NO FUTURE BREWS FOUND');

    return null;
  }


  /*************************************************
   * 2. מיון לפי מספר אצווה
   *************************************************/

  candidates.sort(function(a, b) {

    return a.batchNumber - b.batchNumber;

  });


  Logger.log('Candidates:');

  for (let i = 0; i < candidates.length; i++) {

    Logger.log(
      (i + 1) +
      '. ' +
      candidates[i].batchNumber +
      ' | ' +
      candidates[i].fileName
    );
  }


  Logger.log('----------------------------------------');


  /*************************************************
   * 3. בדיקת הקבצים לפי הסדר
   *************************************************/

  for (let i = 0; i < candidates.length; i++) {

    const candidate = candidates[i];

    Logger.log(
      'Checking candidate ' +
      candidate.batchNumber +
      ': ' +
      candidate.fileName
    );


    try {

      const info =
        readBrewHeader(candidate.fileId);


      Logger.log(
        '  -> Tank found: ' +
        info.found +
        ' | value: ' +
        info.tankNumber
      );


      /***********************************************
       * מיכל לא נמצא
       ***********************************************/

      if (!info.found) {

        Logger.log(
          '  -> Tank not found'
        );

        continue;
      }


      /***********************************************
       * מיכל לא מתאים
       ***********************************************/

      if (
        String(info.tankNumber).trim() !==
        tankNumber
      ) {

        Logger.log(
          '  -> Wrong tank. Brew tank: ' +
          info.tankNumber +
          ' | Requested: ' +
          tankNumber
        );

        continue;
      }


      /***********************************************
       * MATCH
       ***********************************************/

      Logger.log('  -> MATCH FOUND!');


      const result = {

        found: true,

        batchNumber:
          String(candidate.batchNumber),

        tankNumber:
          String(info.tankNumber),

        beerStyle:
          info.beerStyle || null,

        brewDate:
          info.brewDate || null,

        beerVolume:
          null,

        startingPlato:
          null,

        sheetUrl:
          'https://docs.google.com/spreadsheets/d/' +
          candidate.fileId +
          '/edit?usp=drivesdk',

        fileId:
          candidate.fileId,

        fileName:
          candidate.fileName,

        folderName:
          candidate.folderName,

        folderId:
          candidate.folderId
      };


      Logger.log('========================================');
      Logger.log('NEXT BREW FOUND');
      Logger.log(
        JSON.stringify(result, null, 2)
      );
      Logger.log('========================================');


      return result;
    }


    catch (error) {

      Logger.log(
        '  -> ERROR: ' +
        error.message
      );

      continue;
    }
  }


  /*************************************************
   * שום דבר לא נמצא
   *************************************************/

  Logger.log('========================================');
  Logger.log('NO NEXT BREW FOUND');
  Logger.log('========================================');

  return null;
}


/*************************************************
 * איסוף קבצי בישול
 *
 * סורק תיקייה + תיקיות משנה.
 *
 * לא פותח את הקבצים.
 * רק מסתכל על שמות הקבצים.
 *************************************************/

function collectBrewFiles(
  folder,
  currentBatch,
  candidates
) {

  /*************************************************
   * קבצים בתיקייה
   *************************************************/

  const files =
    folder.getFiles();

  while (files.hasNext()) {

    const file =
      files.next();


    /***********************************************
     * רק Google Sheets
     ***********************************************/

    if (
      file.getMimeType() !==
      MimeType.GOOGLE_SHEETS
    ) {

      continue;
    }


    const fileName =
      file.getName();


    /***********************************************
     * מספר אצווה משם הקובץ
     ***********************************************/

    const batchNumber =
      extractBatchNumberFromFileName(
        fileName
      );


    if (batchNumber === null) {

      continue;
    }


    /***********************************************
     * רק מספרים גדולים מהנוכחי
     ***********************************************/

    if (
      batchNumber <= currentBatch
    ) {

      continue;
    }


    /***********************************************
     * הוסף מועמד
     ***********************************************/

    candidates.push({

      batchNumber:
        batchNumber,

      fileId:
        file.getId(),

      fileName:
        fileName,

      folderName:
        folder.getName(),

      folderId:
        folder.getId()
    });
  }


  /*************************************************
   * תיקיות משנה
   *************************************************/

  const subFolders =
    folder.getFolders();

  while (subFolders.hasNext()) {

    const subFolder =
      subFolders.next();


    collectBrewFiles(
      subFolder,
      currentBatch,
      candidates
    );
  }
}


/*************************************************
 * חילוץ מספר אצווה משם הקובץ
 *
 * "IPA משולש 1568#"
 *          ↓
 *        1568
 *
 * "1576# סטאוט"
 *       ↓
 *      1576
 *************************************************/

function extractBatchNumberFromFileName(
  fileName
) {

  const match =
    String(fileName).match(
      /(\d+)\s*#/
    );


  if (!match) {

    return null;
  }


  const number =
    Number(match[1]);


  if (isNaN(number)) {

    return null;
  }


  return number;
}


/*************************************************
 * קריאת HEADER של קובץ הבישול
 *
 * אנחנו קוראים רק את האזור הראשון.
 *
 * המבנה שאנחנו יודעים שקיים:
 *
 * סוג:       פייל
 * מס' מיכל:  12
 * אצווה:     1583
 * תאריך:     
 *
 *************************************************/

function readBrewHeader(fileId) {

  const ss =
    SpreadsheetApp.openById(fileId);


  /*************************************************
   * ננסה את הגיליון הראשון.
   *
   * אין צורך לסרוק את כל הגיליונות.
   *************************************************/

  const sheet =
    ss.getSheets()[0];


  if (!sheet) {

    return {

      found: false,
      tankNumber: null,
      beerStyle: null,
      brewDate: null
    };
  }


  /*************************************************
   * קוראים רק 15 שורות ראשונות.
   *
   * זה החלק החשוב למהירות.
   *************************************************/

  const maxRows =
    Math.min(
      15,
      sheet.getMaxRows()
    );


  const maxColumns =
    Math.min(
      20,
      sheet.getMaxColumns()
    );


  const values =
    sheet
      .getRange(
        1,
        1,
        maxRows,
        maxColumns
      )
      .getDisplayValues();


  let tankNumber = null;
  let beerStyle = null;
  let brewDate = null;


  /*************************************************
   * חיפוש התוויות
   *************************************************/

  for (
    let r = 0;
    r < values.length;
    r++
  ) {

    const row =
      values[r];


    for (
      let c = 0;
      c < row.length;
      c++
    ) {

      const cell =
        String(row[c])
          .trim();


      if (!cell) {

        continue;
      }


      const normalized =
        normalizeLabel(cell);


      /***********************************************
       * סוג
       ***********************************************/

      if (
        beerStyle === null &&
        isBeerStyleLabel(normalized)
      ) {

        beerStyle =
          getValueToRight(
            row,
            c
          );
      }


      /***********************************************
       * מיכל
       ***********************************************/

      if (
        tankNumber === null &&
        isTankLabel(normalized)
      ) {

        const value =
          getValueToRight(
            row,
            c
          );


        if (
          value &&
          /^\d+$/.test(
            String(value).trim()
          )
        ) {

          tankNumber =
            String(value).trim();
        }
      }


      /***********************************************
       * תאריך
       ***********************************************/

      if (
        brewDate === null &&
        isDateLabel(normalized)
      ) {

        brewDate =
          getValueToRight(
            row,
            c
          );
      }
    }
  }


  return {

    found:
      tankNumber !== null,

    tankNumber:
      tankNumber,

    beerStyle:
      beerStyle,

    brewDate:
      brewDate
  };
}


/*************************************************
 * בדיקת label של מיכל
 *
 * תומך למשל:
 *
 * מס' מיכל:
 * מס' מיכל
 * מספר מיכל:
 * מספר מיכל
 * מיכל:
 * מיכל
 *************************************************/

function isTankLabel(label) {

  return (

    label === 'מס מיכל' ||

    label === 'מספר מיכל' ||

    label === 'מיכל'
  );
}


/*************************************************
 * בדיקת label של סוג
 *************************************************/

function isBeerStyleLabel(label) {

  return (

    label === 'סוג'
  );
}


/*************************************************
 * בדיקת label של תאריך
 *************************************************/

function isDateLabel(label) {

  return (

    label === 'תאריך'
  );
}


/*************************************************
 * קבלת התא מימין
 *************************************************/

function getValueToRight(
  row,
  col
) {

  if (
    col + 1 >= row.length
  ) {

    return null;
  }


  const value =
    String(
      row[col + 1]
    ).trim();


  return value || null;
}


/*************************************************
 * ניקוי label
 *************************************************/

function normalizeLabel(text) {

  return String(text)

    .replace(/:/g, '')

    .replace(/'/g, '')

    .replace(/"/g, '')

    .replace(/\s+/g, ' ')

    .trim();
}


/*************************************************
 * TEST
 *************************************************/

function testFindNextBrewForTank() {

  const tankNumber = 3;

  const currentBatch = 1565;


  const result =
    findNextBrewForTank(
      tankNumber,
      currentBatch
    );


  Logger.log('========================================');
  Logger.log('TEST RESULT');
  Logger.log(
    JSON.stringify(
      result,
      null,
      2
    )
  );
  Logger.log('========================================');
}


/*************************************************
 * DEBUG - קובץ ספציפי
 *
 * השתמש בזה אם רוצים לבדוק קובץ אחד.
 *************************************************/

function debugSpecificBrew() {

  const fileId =
    '1U9Rf-gvCxaTX1IgSXNrewtJeNnSo8hLI2z9iwSxNHJA';


  Logger.log('========================================');
  Logger.log('DEBUG SPECIFIC BREW');
  Logger.log('File ID: ' + fileId);
  Logger.log('========================================');


  const info =
    readBrewHeader(fileId);


  Logger.log(
    JSON.stringify(
      info,
      null,
      2
    )
  );


  Logger.log('========================================');
}