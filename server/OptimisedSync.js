// ================================================================
// OPTIMIZED FERMENTOR SYNC — SHARED RUNTIME HELPERS
// ================================================================
//
// This file intentionally owns ONLY:
//   - computeHash_ / hasChangedLocally_
//   - ACTION 5 snapshot key constants
//   - runActionFlow_
//
// The actual 5-minute cycle lives in fermentor-cycle-optimization.js.
// ACTION 0/1/5 and Drive candidate logic live in BREW_ACTION_SERVICE.js.
// Keeping one owner per global function is mandatory in Apps Script because
// every .js/.gs file is loaded into the same global namespace.
// ================================================================

// Preserve the existing ScriptProperties keys used by ACTION 5.
const BREW_CANDIDATES_SNAPSHOT_KEY = "brew_drive_snapshot_v2";
const BREW_DRIVE_CHANGE_TOKEN_KEY = "brew_drive_change_token_v2";

function computeHash_(value) {
  const json = JSON.stringify(value);

  const digestBytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5,
    json,
    Utilities.Charset.UTF_8
  );

  return digestBytes
    .map(function (b) {
      return ((b < 0 ? b + 256 : b).toString(16)).padStart(2, "0");
    })
    .join("");
}

function hasChangedLocally_(key, value) {
  const props = PropertiesService.getScriptProperties();
  const newHash = computeHash_(value);
  const oldHash = props.getProperty(key);

  if (oldHash === newHash) {
    return false;
  }

  props.setProperty(key, newHash);
  return true;
}

// ================================================================
// ACTION FLOW — called by runFermentorCycle()
// ================================================================

function runActionFlow_(fermentors) {
  let a0 = 0;
  let a1 = 0;
  let a5 = 0;

  // Shared ACTION-5 context for the complete cycle. pendingBrews is loaded
  // lazily once; the Drive fallback is scanned only if a tank has no matching
  // Firestore pending brew. extractBrew results are also shared across tanks.
  const action5Context = {
    pendingBrews: null,
    candidates: null,
    brewExtractCache: {}
  };

  fermentors.forEach(function (fermentorEntry) {
    const fermentor = Object.assign(
      { uid: fermentorEntry.id },
      fermentorEntry.data
    );

    const action = parseAction(fermentor.action);

    try {
      if (action === 0) {
        a0++;
        processAction0(fermentor);
        return;
      }

      if (action === 1) {
        a1++;
        processAction1(fermentor);
        return;
      }

      if (action === 5) {
        a5++;
        processAction5(
          fermentor,
          action5Context
        );
      }

      // ACTION 3 / 4 are GUI-controlled.

    } catch (error) {
      Logger.log(
        "ACTION FLOW ERROR tank " +
        (fermentor.tankNumber || fermentor.uid || "?") +
        ": " +
        error.message
      );

      if (error && error.stack) {
        Logger.log(error.stack);
      }
    }
  });

  try {
    // One owner for brew edit triggers. This also removes legacy, stale and
    // duplicate handlers instead of letting ACTION 0 create them ad hoc.
    brewingSheetReconcileEditTriggers_(fermentors);
  } catch (error) {
    Logger.log("BREW EDIT TRIGGER RECONCILE ERROR: " + error.message);
  }

  try {
    ensureAsyncLogTrigger_();
  } catch (error) {
    Logger.log("ASYNC LOG TRIGGER ERROR: " + error.message);
  }

  return {
    a0: a0,
    a1: a1,
    a5: a5
  };
}
