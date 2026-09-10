const CALENDAR_ID = 'shapirobeer@gmail.com';

function syncCalendarToFirestore() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;

  try {
    const now = new Date();
    const timeMin = new Date(
      now.getFullYear(),
      now.getMonth() - 1,
      now.getDate()
    ).toISOString();

    const timeMax = new Date(
      now.getFullYear(),
      now.getMonth() + 2,
      now.getDate()
    ).toISOString();

    const response = Calendar.Events.list(CALENDAR_ID, {
      timeMin: timeMin,
      timeMax: timeMax,
      singleEvents: true,
      orderBy: 'startTime'
    });

    const events = response.items || [];
    const parsedEvents = [];

    // =====================================================
    // שלב 1: Parsing של אירועי היומן
    // =====================================================
    events.forEach(event => {
      const summary = event.summary || '';
      const parsedData = parseCalendarSummary_(summary);

      if (parsedData) {
        const eventDateStr = event.start.date || event.start.dateTime;
        const eventDate = new Date(eventDateStr);

        const normalizedStyle =
          normalizeBeerStyle_(parsedData.itemType) ||
          detectBeerStyleFromText_(summary) ||
          null;

        parsedEvents.push({
          eventId: event.id,
          title: summary,
          date: eventDateStr.split('T')[0],
          timestamp: eventDate.getTime(),

          actionType: parsedData.actionType,
          tankNumber: parsedData.tankNumber,
          itemType: parsedData.itemType,
          unit: parsedData.unit,
          beerStyle: normalizedStyle, 

          // הכמות כפי שנמצאה בטקסט.
          // אם אין כמות -> null.
          quantity: parsedData.quantity,

          // נשמר לצורך debugging / בדיקות
          rawQuantity: parsedData.quantity
        });
      }
    });

    // =====================================================
    // שלב 2: חישוב כמויות חסרות
    // =====================================================
    const adjustedEvents = processAndValidateTankTotals_(
      parsedEvents,
      FIREBASE_PROJECT_ID
    );

    // =====================================================
    // שלב 3: כתיבה ל-Firestore
    // =====================================================
    let savedCount = 0;

    adjustedEvents.forEach(payload => {
      const cacheKey = "cal_event:" + payload.eventId;

      delete payload.rawQuantity;

      // זמנית: מאפשר דחיפה מחודשת ל-Firestore
      // ללא חסימת Cache
      if (false && !hasChangedLocally_(cacheKey, payload)) {
        Logger.log(`[דילוג - ללא שינוי] "${payload.title}"`);
        return;
      }

      writeCalendarEventToFirestore_(
        FIREBASE_PROJECT_ID,
        payload.eventId,
        payload
      );

      savedCount++;

      Logger.log(
        `[נכתב בהצלחה] "${payload.title}" -> ` +
        `כמות: ${payload.quantity} ${payload.unit}`
      );
    });

    Logger.log(`סיכום: סונכרנו ${savedCount} אירועים.`);

  } finally {
    lock.releaseLock();
  }
}


/**
 * =========================================================
 * עיבוד אירועים וחישוב כמויות
 * =========================================================
 *
 * כל Batch:
 * - אותו מיכל
 * - חלון של 14 יום בין אירוע לאירוע
 *
 * בתוך Batch יכולים להיות:
 *
 * 1. אירוע חביות בלבד
 * 2. אירוע בקבוקים/ארגזים בלבד
 * 3. אירוע חביות + אירוע בקבוקים/ארגזים
 *
 * לא אמורים להיות:
 * - שני אירועי חביות
 * - שני אירועי בקבוקים/ארגזים
 *
 * כלל חשוב:
 *
 * אם קיימת כמות בטקסט האירוע -> לא משנים אותה.
 *
 * ה-Fallback משמש רק כאשר quantity === null.
 *
 * =========================================================
 */
function processAndValidateTankTotals_(events, projectId) {

  // -------------------------------------------------------
  // מיון מהישן לחדש
  // -------------------------------------------------------
  events.sort((a, b) => a.timestamp - b.timestamp);

  const FOURTEEN_DAYS_MS =
    14 * 24 * 60 * 60 * 1000;

  const tankBatches = [];


  // =======================================================
  // יצירת Batches
  // =======================================================
  events.forEach(ev => {

    if (!ev.tankNumber) {
      return;
    }

    const tankNumber =
      Number(ev.tankNumber);

    let existingBatch =
      tankBatches.find(batch => {

        if (
          Number(batch.tankNumber) !== tankNumber
        ) {
          return false;
        }

        const lastEvent =
          batch.events[
          batch.events.length - 1
          ];

        return (
          ev.timestamp -
          lastEvent.timestamp
        ) <= FOURTEEN_DAYS_MS;
      });


    if (existingBatch) {

      existingBatch.events.push(ev);

    } else {

      tankBatches.push({
        tankNumber: tankNumber,
        events: [ev]
      });
    }
  });


  // =======================================================
  // עיבוד כל Batch
  // =======================================================
  tankBatches.forEach(batch => {

    const tankNum =
      Number(batch.tankNumber);

    const groupEvents =
      batch.events;


    // -----------------------------------------------------
    // זיהוי סגנון
    // -----------------------------------------------------
    const beerStyle =
      detectBeerStyleFromBatch_(groupEvents);


    // -----------------------------------------------------
    // בדיקה האם יש אירוע חביות
    // -----------------------------------------------------
    const kegEvents =
      groupEvents.filter(ev =>
        isKegUnit_(ev.unit)
      );


    // -----------------------------------------------------
    // בדיקה האם יש אירוע בקבוקים / ארגזים
    // -----------------------------------------------------
    const bottleEvents =
      groupEvents.filter(ev =>
        isBoxUnit_(ev.unit)
      );


    const hasKegs =
      kegEvents.length > 0;

    const hasBottles =
      bottleEvents.length > 0;


    // -----------------------------------------------------
    // מספר אירועי האריזה
    // -----------------------------------------------------
    const packagingEventCount =
      (hasKegs ? 1 : 0) +
      (hasBottles ? 1 : 0);


    Logger.log(
      `[Batch] מיכל ${tankNum} | ` +
      `סגנון: ${beerStyle || 'לא ידוע'} | ` +
      `חביות: ${hasKegs ? 'כן' : 'לא'} | ` +
      `בקבוקים/ארגזים: ${hasBottles ? 'כן' : 'לא'} | ` +
      `אירועי אריזה: ${packagingEventCount}`
    );


    // =====================================================
    // אם יש beerVolume אמיתי ב-Firestore
    //
    // שומרים על הלוגיקה הישנה.
    // ה-Fallback החדש משמש רק כשאין beerVolume.
    // =====================================================


    // =====================================================
    // אין beerVolume -> Fallback
    // =====================================================

    /*
     * קביעת היעדים.
     *
     * חשוב:
     *
     * hasBottles = האם יש אירוע בקבוקים/ארגזים.
     *
     * זה מה שקובע האם משתמשים ביעד:
     *
     * רגיל
     *
     * או:
     *
     * יעד משולב עם ביקבוק.
     *
     * עצם קיום אירוע חביות לא הופך את זה ל"יש ביקבוק".
     */
    const hasBottling =
      hasBottles;


    const fallbackTargets =
      getFallbackTargets_(
        tankNum,
        beerStyle,
        hasBottling
      );


    if (!fallbackTargets) {

      Logger.log(
        `[Fallback] לא נמצא יעד עבור מיכל ${tankNum}, ` +
        `סגנון "${beerStyle || 'לא ידוע'}"`
      );

      return;
    }


    Logger.log(
      `[Fallback] מיכל ${tankNum} | ` +
      `סגנון: ${beerStyle || 'לא ידוע'} | ` +
      `ביקבוק: ${hasBottling ? 'כן' : 'לא'} | ` +
      `יעד ארגזים: ${fallbackTargets.boxes} | ` +
      `יעד חביות: ${fallbackTargets.kegs}`
    );


    // =====================================================
    // חשוב מאוד:
    //
    // לא נוגעים בכמויות קיימות.
    //
    // קודם מחשבים כמה כבר קיים בפועל.
    // =====================================================
    let existingKegs = 0;
    let existingBoxes = 0;


    groupEvents.forEach(ev => {

      if (
        ev.quantity === null ||
        ev.quantity === undefined ||
        ev.quantity === ''
      ) {
        return;
      }


      const quantity =
        Number(ev.quantity);


      if (!Number.isFinite(quantity)) {
        return;
      }


      if (isKegUnit_(ev.unit)) {

        existingKegs += quantity;

      } else if (isBoxUnit_(ev.unit)) {

        existingBoxes += quantity;
      }
    });


    Logger.log(
      `[Batch totals] מיכל ${tankNum} | ` +
      `קיים: ${existingBoxes} ארגזים, ` +
      `${existingKegs} חביות`
    );


    // =====================================================
    // השלמת אירועים שאין בהם כמות
    // =====================================================
    groupEvents.forEach(ev => {

      const hasQuantity =
        ev.quantity !== null &&
        ev.quantity !== undefined &&
        ev.quantity !== '';


      // ---------------------------------------------------
      // כמות קיימת -> לא נוגעים!
      // ---------------------------------------------------
      if (hasQuantity) {
        return;
      }


      // ---------------------------------------------------
      // אין יחידה
      //
      // ברירת מחדל:
      // חביות
      // ---------------------------------------------------
      if (!ev.unit) {

        ev.unit = 'ארגזים';

        Logger.log(
          `[Fallback] "${ev.title}" ` +
          `ללא יחידה -> נבחר ארגזים`
        );
      }


      // ---------------------------------------------------
      // אירוע חביות
      // ---------------------------------------------------
      if (isKegUnit_(ev.unit)) {

        const remainingKegs =
          fallbackTargets.kegs -
          existingKegs;


        if (remainingKegs > 0) {

          ev.quantity =
            remainingKegs;

          existingKegs +=
            remainingKegs;

          Logger.log(
            `[השלמת חביות] מיכל ${tankNum} | ` +
            `"${ev.title}" -> ` +
            `${ev.quantity} חביות`
          );

        } else {

          ev.quantity = 0;

          Logger.log(
            `[השלמת חביות] מיכל ${tankNum} | ` +
            `"${ev.title}" -> ` +
            `0 חביות (אין יתרה)`
          );
        }

        return;
      }


      // ---------------------------------------------------
      // אירוע בקבוקים / ארגזים
      // ---------------------------------------------------
      if (isBoxUnit_(ev.unit)) {

        const remainingBoxes =
          fallbackTargets.boxes -
          existingBoxes;


        if (remainingBoxes > 0) {

          ev.quantity =
            remainingBoxes;

          existingBoxes +=
            remainingBoxes;

          Logger.log(
            `[השלמת ארגזים] מיכל ${tankNum} | ` +
            `"${ev.title}" -> ` +
            `${ev.quantity} ארגזים`
          );

        } else {

          ev.quantity = 0;

          Logger.log(
            `[השלמת ארגזים] מיכל ${tankNum} | ` +
            `"${ev.title}" -> ` +
            `0 ארגזים (אין יתרה)`
          );
        }

        return;
      }


      Logger.log(
        `[Fallback] יחידה לא מזוהה עבור "${ev.title}": ` +
        `"${ev.unit}"`
      );
    });
  });


  return events;
}



/**
 * =========================================================
 * זיהוי סגנון מתוך כל אירועי הבאץ'
 * =========================================================
 */
function detectBeerStyleFromBatch_(events) {

  // קודם itemType
  for (const ev of events) {

    if (!ev.itemType) {
      continue;
    }

    const style =
      normalizeBeerStyle_(
        ev.itemType
      );

    if (style) {
      return style;
    }
  }


  // אחר כך title
  for (const ev of events) {

    const style =
      detectBeerStyleFromText_(
        ev.title || ''
      );

    if (style) {
      return style;
    }
  }


  return null;
}


/**
 * =========================================================
 * נרמול סגנון
 * =========================================================
 */
function normalizeBeerStyle_(itemType) {

  if (!itemType) {
    return null;
  }


  const text =
    String(itemType)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');


  if (text.includes('ipa')) {
    return 'IPA';
  }


  if (text.includes('פייל')) {
    return 'פייל';
  }


  if (text.includes('הופי לאגר')) {
    return 'הופי לאגר';
  }


  if (text.includes('לאגר')) {
    return 'לאגר';
  }


  if (text.includes('חיטה')) {
    return 'חיטה';
  }


  if (text.includes('סטאוט')) {
    return 'סטאוט';
  }


  return null;
}


/**
 * =========================================================
 * זיהוי סגנון מתוך טקסט
 * =========================================================
 */
function detectBeerStyleFromText_(text) {

  if (!text) {
    return null;
  }


  const normalized =
    String(text)
      .toLowerCase()
      .replace(/\s+/g, ' ');


  if (normalized.includes('ipa')) {
    return 'IPA';
  }


  if (normalized.includes('פייל')) {
    return 'פייל';
  }


  if (normalized.includes('הופי לאגר')) {
    return 'הופי לאגר';
  }


  if (normalized.includes('לאגר')) {
    return 'לאגר';
  }


  if (normalized.includes('חיטה')) {
    return 'חיטה';
  }


  if (normalized.includes('סטאוט')) {
    return 'סטאוט';
  }


  return null;
}


/**
 * =========================================================
 * האם זו יחידת חביות
 * =========================================================
 */
function isKegUnit_(unit) {

  if (!unit) {
    return false;
  }

  return String(unit).includes('חביות');
}


/**
 * =========================================================
 * האם זו יחידת בקבוקים / ארגזים
 * =========================================================
 */
function isBoxUnit_(unit) {

  if (!unit) {
    return false;
  }

  const text =
    String(unit);

  return (
    text.includes('ארגז') ||
    text.includes('בקבוק')
  );
}


/**
 * =========================================================
 * יעדי FALLBACK
 * =========================================================
 *
 * hasBottling = true רק כאשר יש אירוע
 * בקבוקים/ארגזים באותו Batch.
 *
 * ---------------------------------------------------------
 * מיכלים קטנים 1-4
 *
 * 135 ארגזים
 * 56 חביות
 *
 * ---------------------------------------------------------
 * מיכלים בינוניים 5-8
 *
 * ללא ביקבוק:
 *
 * IPA          245 ארגזים / 98 חביות
 * פייל         285 ארגזים / 110 חביות
 * הופי לאגר   325 ארגזים / 125 חביות
 * לאגר         325 ארגזים / 125 חביות
 * חיטה         265 ארגזים / 105 חביות
 *
 * עם ביקבוק:
 *
 * IPA          168 ארגזים / 30 חביות
 * פייל         168 ארגזים / 45 חביות
 * הופי לאגר   168 ארגזים / 60 חביות
 * לאגר         168 ארגזים / 60 חביות
 * חיטה         168 ארגזים / 40 חביות
 *
 * ---------------------------------------------------------
 * מיכלים גדולים 9-18
 *
 * ללא ביקבוק:
 *
 * IPA          150 ארגזים / 252 חביות
 * פייל         252 ארגזים / 160 חביות
 * הופי לאגר   252 ארגזים / 180 חביות
 * לאגר         252 ארגזים / 185 חביות
 * חיטה         252 ארגזים / 170 חביות
 *
 * עם ביקבוק:
 *
 * IPA          252 ארגזים / 50 חביות
 * פייל         252 ארגזים / 60 חביות
 * הופי לאגר   252 ארגזים / 80 חביות
 * לאגר         252 ארגזים / 85 חביות
 * חיטה         252 ארגזים / 70 חביות
 *
 * =========================================================
 */
function getFallbackTargets_(
  tankNum,
  beerStyle,
  hasBottling
) {

  tankNum =
    Number(tankNum);


  // =======================================================
  // מיכלים קטנים
  // =======================================================
  if (
    tankNum >= 1 &&
    tankNum <= 4
  ) {

    return {
      boxes: 135,
      kegs: 56
    };
  }


  // =======================================================
  // מיכלים בינוניים
  // =======================================================
  if (
    tankNum >= 5 &&
    tankNum <= 8
  ) {

    // -----------------------------------------------------
    // עם ביקבוק
    // -----------------------------------------------------
    if (hasBottling) {

      switch (beerStyle) {

        case 'IPA':
          return {
            boxes: 168,
            kegs: 30
          };

        case 'פייל':
          return {
            boxes: 168,
            kegs: 45
          };

        case 'הופי לאגר':
        case 'לאגר':
          return {
            boxes: 168,
            kegs: 60
          };

        case 'חיטה':
          return {
            boxes: 168,
            kegs: 40
          };

        default:
          return null;
      }
    }


    // -----------------------------------------------------
    // ללא ביקבוק
    // -----------------------------------------------------
    switch (beerStyle) {

      case 'IPA':
        return {
          boxes: 245,
          kegs: 98
        };

      case 'פייל':
        return {
          boxes: 285,
          kegs: 110
        };

      case 'הופי לאגר':
      case 'לאגר':
        return {
          boxes: 325,
          kegs: 125
        };

      case 'חיטה':
        return {
          boxes: 265,
          kegs: 105
        };

      default:
        return null;
    }
  }


  // =======================================================
  // מיכלים גדולים
  // =======================================================
  if (
    tankNum >= 9 &&
    tankNum <= 19
  ) {

    // -----------------------------------------------------
    // עם ביקבוק
    // -----------------------------------------------------
    if (hasBottling) {

      switch (beerStyle) {

        case 'IPA':
          return {
            boxes: 252,
            kegs: 50
          };

        case 'פייל':
          return {
            boxes: 252,
            kegs: 60
          };

        case 'הופי לאגר':
          return {
            boxes: 252,
            kegs: 80
          };

        case 'לאגר':
          return {
            boxes: 252,
            kegs: 85
          };

        case 'חיטה':
          return {
            boxes: 252,
            kegs: 70
          };

        default:
          return null;
      }
    }


    // -----------------------------------------------------
    // ללא ביקבוק
    // -----------------------------------------------------
    switch (beerStyle) {

      case 'IPA':
        return {
          boxes: 150,
          kegs: 252
        };

      case 'פייל':
        return {
          boxes: 252,
          kegs: 160
        };

      case 'הופי לאגר':
        return {
          boxes: 252,
          kegs: 180
        };

      case 'לאגר':
        return {
          boxes: 252,
          kegs: 185
        };

      case 'חיטה':
        return {
          boxes: 252,
          kegs: 170
        };

      default:
        return null;
    }
  }


  return null;
}


/**
 * =========================================================
 * Parsing לחילוץ נתונים מתיאור האירוע
 * =========================================================
 *
 * דוגמאות:
 *
 * "סיום 80 חביות פייל 18"
 * "סיום 50 ארגזים IPA9"
 * "ביקבוק 168 ארגזים פייל 6"
 * "סיום חביות פייל 18"
 *
 * מחזיר:
 *
 * actionType
 * tankNumber
 * itemType
 * unit
 * quantity
 *
 * כלל חשוב:
 * מספר שמופיע לפני/אחרי יחידת האריזה הוא quantity.
 * מספר שמופיע בתוך שם הסגנון הוא tankNumber.
 * =========================================================
 */
function parseCalendarSummary_(text) {

  if (!text) {
    return null;
  }

  const originalText = String(text).trim();

  // -------------------------------------------------------
  // 1. זיהוי פעולה
  // -------------------------------------------------------
  //
  // מפורש ולא באמצעות "סיו?ם", כדי למנוע פספוס.
  //
  let actionType = null;

  if (/הורדת/.test(originalText)) {
    actionType = 'הורדה';

  } else if (/ביקבוק/.test(originalText)) {
    actionType = 'ביקבוק';

  } else if (/סיום/.test(originalText)) {
    actionType = 'סיום';

  } else if (/אריזה/.test(originalText)) {
    actionType = 'אריזה';
  }

  // אם אין פעולה מוכרת -> לא אירוע שאנחנו רוצים לסנכרן
  if (!actionType) {
    Logger.log(
      `[Parser - דילוג] פעולה לא מזוהה: "${originalText}"`
    );

    return null;
  }


  // -------------------------------------------------------
  // 2. זיהוי יחידת האריזה
  // -------------------------------------------------------
  //
  // חשוב לבדוק חביות לפני בקבוק/ארגז.
  //
  let unit = null;

  const unitMatch = originalText.match(
    /(חביות|בקבוקים|בקבוק|ארגזים|ארגז|בזאר)/
  );

  if (unitMatch) {
    unit = unitMatch[1];
  }
  if (!unit && actionType === 'ביקבוק') {
    unit = 'ארגזים';
  }

  // -------------------------------------------------------
  // 3. זיהוי סגנון + מספר מיכל
  // -------------------------------------------------------
  //
  // תומך:
  //
  // פייל 18
  // פייל18
  // פייל מ18
  // IPA 9
  // IPA9
  // חיטה 12
  // סטאוט 5
  // הופי לאגר 10
  // לאגר 15
  //
  // חשוב:
  // קודם הופי לאגר ורק אחר כך לאגר.
  //
  const itemMatch = originalText.match(
    /(הופי\s+לאגר\s*מ?\d+|פייל\s*מ?\d+|IPA\s*מ?\d+|חיטה\s*מ?\d+|סטאוט\s*מ?\d+|לאגר\s*מ?\d+|ביר בזאר)/i
  );

  const itemType = itemMatch
    ? itemMatch[1]
    : null;


  // -------------------------------------------------------
  // 4. חילוץ מספר המיכל
  // -------------------------------------------------------
  let tankNumber = null;

  if (itemType) {

    const tankMatch = itemType.match(/\d+/);

    if (tankMatch) {

      const num = parseInt(
        tankMatch[0],
        10
      );

      if (
        num >= 2 &&
        num <= 19
      ) {
        tankNumber = num;
      }
    }
  }


  // -------------------------------------------------------
  // 5. חילוץ QUANTITY
  // -------------------------------------------------------
  //
  // קודם מחפשים מספר שצמוד ליחידת האריזה.
  //
  // לדוגמה:
  //
  // "סיום 80 חביות פייל 18"
  //
  // => 80
  //
  // ולא 18 !!!
  //
  let quantity = null;

  const directQtyMatch =
    originalText.match(
      /(\d+)\s*(?:חביות|בקבוקים|בקבוק|ארגזים|ארגז|בזאר)/
    ) ||
    originalText.match(
      /(?:חביות|בקבוקים|בקבוק|ארגזים|ארגז|בזאר)\s*(\d+)/
    );


  if (directQtyMatch) {

    quantity = parseInt(
      directQtyMatch[1],
      10
    );

  } else {

    // -----------------------------------------------------
    // אין מספר ליד יחידת האריזה.
    //
    // ננסה למצוא מספר אחר שאינו מספר המיכל.
    // -----------------------------------------------------

    let cleanedText =
      originalText;


    // הסרת שם הסגנון + מספר המיכל
    if (itemType) {

      cleanedText =
        cleanedText.replace(
          itemType,
          ''
        );
    }


    // הסרת הפעולה
    cleanedText =
      cleanedText.replace(
        /(?:הורדת|הורדה|ביקבוק|סיום|אריזה)/g,
        ''
      );


    // הסרת מספרים שליליים/מיותרים לא רלוונטיים
    const possibleNumbers =
      cleanedText.match(/\d+/g);


    if (possibleNumbers) {

      for (const numberText of possibleNumbers) {

        const num =
          parseInt(numberText, 10);


        // לא להשתמש במספר המיכל כ-quantity
        if (
          num !== tankNumber
        ) {

          quantity = num;
          break;
        }
      }
    }
  }


  // -------------------------------------------------------
  // 6. יצירת התוצאה
  // -------------------------------------------------------
  const result = {
    actionType: actionType,
    tankNumber: tankNumber,
    itemType: itemType,
    unit: unit,
    quantity: quantity
  };


  // -------------------------------------------------------
  // 7. לוג לצורך בדיקה
  // -------------------------------------------------------
  Logger.log(
    `[Parser] "${originalText}" -> ` +
    `פעולה=${actionType}, ` +
    `סגנון=${itemType || 'לא זוהה'}, ` +
    `מיכל=${tankNumber || 'לא זוהה'}, ` +
    `יחידה=${unit || 'לא זוהתה'}, ` +
    `כמות=${quantity !== null ? quantity : 'חסרה'}`
  );


  return result;
}




/**
 * =========================================================
 * שליפת beerVolume מתוך Firestore
 * =========================================================
 */
function getBeerVolumeFromFirestore_(
  projectId,
  tankNumber
) {

  if (!tankNumber) {
    return null;
  }


  const url =
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/fermentors/${tankNumber}`;


  try {

    const response =
      UrlFetchApp.fetch(
        url,
        {
          method: "GET",

          headers: {
            Authorization:
              "Bearer " +
              ScriptApp.getOAuthToken()
          },

          muteHttpExceptions: true
        }
      );


    if (
      response.getResponseCode() === 200
    ) {

      const data =
        JSON.parse(
          response.getContentText()
        );


      if (
        data.fields &&
        data.fields.beerVolume
      ) {

        return parseFloat(
          data.fields.beerVolume.doubleValue ||
          data.fields.beerVolume.integerValue ||
          0
        );
      }
    }

  } catch (e) {

    Logger.log(
      `לא ניתן היה לשלוף נפח עבור מיכל ${tankNumber}: ${e.message}`
    );
  }


  return null;
}


/**
 * =========================================================
 * כתיבה ל-Firestore API
 * =========================================================
 */
function writeCalendarEventToFirestore_(
  projectId,
  eventId,
  data
) {

  const url =
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/calendar_events/${encodeURIComponent(eventId)}`;


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
            fields:
              toFirestoreFields_(data)
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
      `נכשלה כתיבה ל-Firestore עבור אירוע ${eventId}: ` +
      `${code} ${response.getContentText()}`
    );
  }
}


/**
 * =========================================================
 * Cache
 * =========================================================
 */
function hasChangedLocally_(
  cacheKey,
  data
) {

  const cache =
    CacheService.getScriptCache();


  const jsonString =
    JSON.stringify(data);


  const cached =
    cache.get(cacheKey);


  if (
    cached === jsonString
  ) {

    return false;
  }


  cache.put(
    cacheKey,
    jsonString,
    21600
  );


  return true;
}


/**
 * =========================================================
 * המרה ל-Firestore fields
 * =========================================================
 */
function toFirestoreFields_(obj) {

  const fields = {};


  for (const key in obj) {

    const val =
      obj[key];


    if (
      val === null ||
      val === undefined
    ) {

      fields[key] = {
        nullValue: null
      };

    } else if (
      typeof val === 'number'
    ) {

      fields[key] =
        Number.isInteger(val)
          ? {
            integerValue: val
          }
          : {
            doubleValue: val
          };

    } else if (
      typeof val === 'boolean'
    ) {

      fields[key] = {
        booleanValue: val
      };

    } else {

      fields[key] = {
        stringValue:
          String(val)
      };
    }
  }


  return fields;
}


/**
 * =========================================================
 * ניקוי אירועים ישנים
 * =========================================================
 */
function cleanOldCalendarEvents() {

  const now =
    new Date();


  const sixtyDaysAgo =
    new Date(
      now.getTime() -
      (60 * 24 * 60 * 60 * 1000)
    );


  const cutoffTimestamp =
    sixtyDaysAgo.getTime();


  const queryUrl =
    `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`;


  const queryPayload = {

    structuredQuery: {

      from: [
        {
          collectionId:
            "calendar_events"
        }
      ],

      where: {

        fieldFilter: {

          field: {
            fieldPath:
              "timestamp"
          },

          op:
            "LESS_THAN",

          value: {
            integerValue:
              cutoffTimestamp
          }
        }
      }
    }
  };


  const response =
    UrlFetchApp.fetch(
      queryUrl,
      {
        method: "POST",

        contentType:
          "application/json",

        headers: {
          Authorization:
            "Bearer " +
            ScriptApp.getOAuthToken()
        },

        payload:
          JSON.stringify(queryPayload),

        muteHttpExceptions:
          true
      }
    );


  if (
    response.getResponseCode() !== 200
  ) {

    Logger.log(
      "שגיאה בביצוע שאילתת מחיקה: " +
      response.getContentText()
    );

    return;
  }


  const results =
    JSON.parse(
      response.getContentText()
    );


  const writes = [];


  results.forEach(res => {

    if (
      res.document &&
      res.document.name
    ) {

      writes.push({
        delete:
          res.document.name
      });
    }
  });


  if (
    writes.length === 0
  ) {

    Logger.log(
      "לא נמצאו אירועים ישנים למחיקה."
    );

    return;
  }


  const commitUrl =
    `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents:commit`;


  const commitResponse =
    UrlFetchApp.fetch(
      commitUrl,
      {
        method: "POST",

        contentType:
          "application/json",

        headers: {
          Authorization:
            "Bearer " +
            ScriptApp.getOAuthToken()
        },

        payload:
          JSON.stringify({
            writes:
              writes
          }),

        muteHttpExceptions:
          true
      }
    );


  if (
    commitResponse.getResponseCode() === 200
  ) {

    Logger.log(
      `נמחקו בהצלחה ${writes.length} אירועים ישנים מעל חודשיים.`
    );

  } else {

    Logger.log(
      "שגיאה בביצוע מחיקה מרוכזת: " +
      commitResponse.getContentText()
    );
  }
}


/**
 * =========================================================
 * יצירת Triggers
 * =========================================================
 */
function createTriggers() {

  // מחיקת טריגרים קיימים
  const triggers =
    ScriptApp.getProjectTriggers();


  triggers.forEach(
    t =>
      ScriptApp.deleteTrigger(t)
  );


  // סנכרון כל שעה
  ScriptApp
    .newTrigger(
      'syncCalendarToFirestore'
    )
    .timeBased()
    .everyHours(1)
    .create();


  // ניקוי פעם בשבוע
  ScriptApp
    .newTrigger(
      'cleanOldCalendarEvents'
    )
    .timeBased()
    .onWeekDay(
      ScriptApp.WeekDay.SUNDAY
    )
    .atHour(0)
    .create();


  Logger.log(
    "הטריגרים הוגדרו בהצלחה!"
  );
}