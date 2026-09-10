// ============================================================
// MANUAL STATUS ASSIGNMENT
// ============================================================
//
// This mirrors manualBatch's "check before you leap" approach,
// but for changing a tank's ACTION/tankStatus WITHOUT swapping
// its currently-assigned brew sheet.
//
// IMPORTANT DESIGN NOTE:
// The matrix has a "2- קר" row/column, but "קר" is NOT a real
// stored ACTION value anywhere in brewActionService.gs or
// updateTankStatus(). It's a DISPLAY-ONLY stage, derived in
// getTankStage() (client side) from action===1 plus the sheet's
// latest temperature / cooling note. So this tool only ever
// lets you target the 5 real ACTION values: 0, 1, 3, 4, 5
// (same set as STATUS_OPTIONS in ManualBatchAssignment.tsx).
//
// Because of that, the only transitions this tool needs to
// warn about are:
//   0 <-> 1                (within "active" group)
//   {0,1} -> {3,4,5}       (active  -> empty group)
//   {3,4,5} -> {0,1}       (empty   -> active group)
// Transitions within {3,4,5} need no warning at all (already
// true today via the free <select> in TankCard.tsx).
//
// HOOK-UP REQUIRED in doGet(): add this branch alongside the
// existing "CheckBatchAssignment" / "FindNextBatchForTank"
// branches (see block marked HOOK INTO doGet BELOW).
// ============================================================


// ============================================================
// PUBLIC ENTRY POINT
// ============================================================
//
// tankNumber : string  - the fermentor id / tank number
// toAction   : number  - desired ACTION value (0,1,3,4,5)
//
// Returns everything the client needs to render a confirmation
// screen: the CURRENT authoritative sheet state (re-read live,
// exactly like manualBatch does — Firebase can lag ~5 min
// behind the sheet) plus a list of warnings for this specific
// transition.
// ============================================================

function checkStatusTransition(tankNumber, toAction) {

  const tankID = normalizeTankNumber(tankNumber);
  const targetAction = Number(toAction);

  if (!tankID) {
    throw new Error("Missing tankID");
  }

  if (![0, 1, 3, 4, 5].includes(targetAction)) {
    throw new Error("Invalid target status: " + toAction);
  }

  logToSheet("CheckStatusTransition - Tank: " + tankID + ", target action: " + targetAction);

  const fermentor = getFermentorFromFirebase(tankID);

  if (!fermentor) {
    throw new Error("Fermentor not found: " + tankID);
  }

  const fromAction = Number(fermentor.action);

  if (!fermentor.sheetUrl) {
    throw new Error(
      "אין גיליון בישול משויך למיכל " + tankID + ". יש לשבץ אצווה תחילה."
    );
  }

  if (fromAction === targetAction) {
    throw new Error("המיכל כבר נמצא בסטטוס המבוקש.");
  }

  let brew;

  try {
    brew = extractBrew(fermentor.sheetUrl);
  } catch (error) {
    logToSheet("checkStatusTransition extractBrew FAILED: " + error.message);
    throw new Error("לא ניתן לקרוא את גיליון המיכל: " + error.message);
  }

  if (!brew) {
    throw new Error("לא נמצאו נתונים בגיליון המיכל " + tankID);
  }

  const warnings = getStatusTransitionWarnings(fromAction, targetAction, brew);

  logToSheet(
    "CheckStatusTransition result - warnings: " + warnings.length
  );

  return {

    tankNumber: tankID,
    fromAction: fromAction,
    toAction: targetAction,

    batchNumber: brew.batchNumber,
    beerStyle: brew.beerStyle,
    brewDate: brew.brewDate,

    sheetMarkedEmpty: brew.tankStatus === "TRUE",
    currentTemp: brew.currentData ? brew.currentData.temp : null,
    currentNotes: brew.currentData ? brew.currentData.notes : null,

    sheetUrl: brew.sheetUrl || fermentor.sheetUrl,

    warnings: warnings
  };
}


// ============================================================
// TRANSITION RULES ENGINE
// ============================================================
//
// Pure function -> easy to test / tweak independently from the
// HTTP plumbing. Each pushed warning has:
//   level   : "info" | "warning"   (info = FYI, warning = "⚠")
//   message : Hebrew text shown to the user
//
// This is a best-effort translation of the spec matrix into
// code. The matrix's exact wording per-cell wasn't fully
// machine-parseable (merged cells / RTL table export), so this
// groups the intent rather than reproducing every cell
// verbatim. Treat the messages as a first draft to refine.
// ============================================================

function getStatusTransitionWarnings(fromAction, toAction, brew) {

  const warnings = [];

  const ACTIVE = [0, 1];
  const EMPTY = [3, 4, 5];

  const isActive = function (a) { return ACTIVE.indexOf(a) !== -1; };
  const isEmptyGroup = function (a) { return EMPTY.indexOf(a) !== -1; };

  const sheetMarkedEmpty = brew.tankStatus === "TRUE";
  const hasBrewDate = !!(brew.brewDate && String(brew.brewDate).trim());

  const temp = brew.currentData ? brew.currentData.temp : null;
  const notes = brew.currentData ? String(brew.currentData.notes || "") : "";
  const looksCold = (temp !== null && temp !== undefined && Number(temp) < 9) ||
    notes.indexOf("קירור") !== -1;


  // ----------------------------------------------------------
  // ACTIVE -> EMPTY   (0/1 -> 3/4/5)
  // "לבדוק האם מסמן V בריק"
  // ----------------------------------------------------------

  if (isActive(fromAction) && isEmptyGroup(toAction)) {

    if (sheetMarkedEmpty) {

      warnings.push({
        level: "info",
        message:
          "בגיליון כבר מסומן V בשדה \"ריק\". כדאי לבדוק מדוע השיבוץ " +
          "האוטומטי טרם העביר את המיכל למצב הזה בעצמו, לפני שממשיכים ידנית."
      });

    } else {

      warnings.push({
        level: "warning",
        message:
          "בגיליון הבישול לא מסומן V בשדה \"ריק\". מומלץ לסמן שם V כדי " +
          "שהמעבר הזה יקרה אוטומטית מעכשיו והלאה, בלי צורך בהתערבות ידנית. " +
          "אפשר להמשיך גם ידנית בכל זאת."
      });
    }
  }


  // ----------------------------------------------------------
  // EMPTY -> ACTIVE   (3/4/5 -> 0/1)
  // ----------------------------------------------------------

  if (isEmptyGroup(fromAction) && isActive(toAction)) {

    if (sheetMarkedEmpty) {

      warnings.push({
        level: "warning",
        message:
          "⚠ בגיליון עדיין מסומן V בשדה \"ריק\". כל עוד הסימון הזה קיים, " +
          "בעדכון האוטומטי הבא מהשרת (כ-5 דקות) המיכל עלול לחזור לבד " +
          "למצב \"מלוכלך\"."
      });
    }

    if (toAction === 0) {

      if (hasBrewDate) {

        warnings.push({
          level: "warning",
          message:
            "⚠ יש תאריך בישול רשום בגיליון הנוכחי. שים לב: החלפת אצווה " +
            "מתבצעת אוטומטית לפי הגיליון המשויך למיכל — אם ברצונך לשייך " +
            "אצווה חדשה, יש להשתמש בכלי \"שיבוץ אצווה ידני\" ולא בכלי זה."
        });
      }

    } else if (toAction === 1) {

      if (!hasBrewDate) {

        warnings.push({
          level: "warning",
          message:
            "⚠ לא נמצא תאריך בישול בגיליון הנוכחי. כל עוד אין תאריך, " +
            "המיכל עלול לא להתעדכן כראוי באוטומציה בעתיד — כדאי לבדוק " +
            "ולעדכן בשיטס."
        });
      }

      if (looksCold) {

        warnings.push({
          level: "info",
          message:
            "לתשומת לבך: לפי הטמפ' הנוכחית" +
            (temp !== null && temp !== undefined ? " (" + temp + "°C)" : "") +
            (notes.indexOf("קירור") !== -1 ? " / הערת קירור בגיליון" : "") +
            ", הדשבורד יציג את המיכל כ\"קר\" גם אם הסטטוס בפועל הוא \"מלא\"."
        });
      }
    }
  }


  // ----------------------------------------------------------
  // WITHIN ACTIVE GROUP   (0 <-> 1)
  // ----------------------------------------------------------

  if (isActive(fromAction) && isActive(toAction) && fromAction !== toAction) {

    if (toAction === 1 && !hasBrewDate) {

      warnings.push({
        level: "warning",
        message:
          "בדרך כלל המעבר הזה קורה אוטומטית ברגע שקיים תאריך בישול " +
          "בגיליון. לא נמצא תאריך בישול בגיליון הנוכחי — כדאי לוודא " +
          "בשיטס לפני שממשיכים."
      });
    }

    if (toAction === 0) {

      if (hasBrewDate) {

        warnings.push({
          level: "warning",
          message:
            "⚠ יש תאריך בישול רשום בגיליון. כל עוד הוא קיים, המיכל " +
            "עשוי לחזור אוטומטית למצב \"מלא\" בעדכון הבא. שים לב שהחלפת " +
            "אצווה מתבצעת אוטומטית — אם ברצונך לשנות אצווה, זה לא הכלי " +
            "המתאים."
        });
      }
    }
  }

  return warnings;
}


// ============================================================
// HOOK INTO doGet BELOW
// ============================================================
//
// Add this branch inside doGet(), alongside the existing
// "CheckBatchAssignment" / "FindNextBatchForTank" branches,
// BEFORE the final `throw new Error("Unknown action: " + action);`
//
// if (action === "CheckStatusTransition") {
//
//   const tankID = String(e.parameter.tankID || "").trim();
//   const toAction = Number(e.parameter.toAction);
//
//   if (!tankID) {
//     throw new Error("Missing tankID");
//   }
//
//   logToSheet("CheckStatusTransition - Tank: " + tankID + ", toAction: " + toAction);
//
//   const result = checkStatusTransition(tankID, toAction);
//
//   return jsonResponse({ success: true, result: result });
// }
//
// No new doPost branch is needed — the confirm step reuses the
// existing "AssignAndRefreshTank" action, since it already
// takes (fermentorID, sheetUrl, desiredAction, desiredTankStatus)
// and doesn't require picking a new file.
// ============================================================