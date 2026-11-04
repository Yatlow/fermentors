// ================================================================
// HOURLY ACTIVE-BREW SHEET RECONCILIATION
// ================================================================
// Runs inside the EXISTING five-minute maintenance cycle, at most hourly.
// Sources: authoritative saved brewingExecution in brews/{batch} and the
// matching fermentor action=0. No new trigger, browser, manual confirmation,
// or separate Google Sheet is required.
//
// Safety contract:
// - Only an actually started ACTION-0 batch, validated against the LIVE tank.
// - Verify the live spreadsheet's batch/tank and A/B/C block heading.
// - Discover target cells by semantic labels, never legacy row offsets.
// - Fill ONLY blank, formula-free cells; NEVER overwrite a manual value.
// - Verify each repaired cell after flush. Unresolved fields retry next hour.
// - Budget work by tanks and cells so fermentation sync stays responsive.
// ================================================================

const BREW_SHEET_HOURLY_LAST_AT_KEY_ = "brew_sheet_hourly_reconcile_last_at_v1";
const BREW_SHEET_HOURLY_INTERVAL_MS_ = 60 * 60 * 1000;
const BREW_SHEET_HOURLY_MAX_TANKS_ = 18; // all operational tanks; no starvation
const BREW_SHEET_HOURLY_MAX_CELLS_ = 80;

function brewSheetReconcileText_(value) {
  return String(value == null ? "" : value).replace(/[\u200e\u200f\u202a-\u202e]/g, "").trim();
}
function brewSheetReconcileBatch_(value) {
  return brewSheetReconcileText_(value).replace(/^#/, "").replace(/[A-C]$/i, "").trim();
}
function brewSheetReconcileLabel_(value) {
  return brewSheetReconcileText_(value).replace(/\s+/g, "").toUpperCase();
}
function brewSheetReconcileDateKey_(value) {
  var text = brewSheetReconcileText_(value);
  var match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (match) return match[3] + match[2].padStart(2, "0") + match[1].padStart(2, "0");
  match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  return match ? match[1] + match[2] + match[3] : "";
}
function brewSheetReconcileHasStarted_(tank, execution) {
  var progress = tank.brewProgress || {};
  if (progress.stageStartTime || progress.stageStartTimeText ||
      progress.stageEndTime || progress.stageEndTimeText) return true;
  // A default recipe, water amount or material approval does NOT mean the
  // physical brew started. At least one real process timestamp is required.
  return Object.keys(execution.blocks || {}).some(function (key) {
    var fields = execution.blocks[key] && execution.blocks[key].fields || {};
    return Object.keys(fields).some(function (field) {
      return /^(?:mashIn|rest[123]|heat[123]|transferLt|restLt|circulation|outToBoil|endTransfer|boil|hop[1-4]|wp|outToFermentor)\.(?:start|end)$/.test(field) &&
        /^\d{1,2}:\d{2}(?::\d{2})?$/.test(brewSheetReconcileText_(fields[field]));
    });
  });
}

function brewSheetReconcileReadExecution_(projectId, batch) {
  const url = "https://firestore.googleapis.com/v1/projects/" +
    encodeURIComponent(projectId) + "/databases/(default)/documents/brews/" +
    encodeURIComponent(batch);
  const response = UrlFetchApp.fetch(url, {
    method: "get",
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });
  if (FC_CYCLE_CONTEXT_ && FC_CYCLE_CONTEXT_.io) FC_CYCLE_CONTEXT_.io.firestoreReads++;
  if (response.getResponseCode() === 404) return null;
  if (response.getResponseCode() !== 200) {
    throw new Error("Brew execution read failed: " + response.getResponseCode());
  }
  const document = JSON.parse(response.getContentText());
  const field = document.fields && document.fields.brewingExecution;
  return field ? normalizeFirestoreValue(field) : null;
}

function brewSheetReconcileNumber_(text, min, max) {
  const raw = brewSheetReconcileText_(text).replace(",", ".");
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) return null;
  const numeric = Number(raw);
  return Number.isFinite(numeric) && numeric >= min && numeric <= max ? numeric : null;
}

function brewSheetReconcilePlan_(values, execution, batch) {
  const rows = Array.isArray(values) ? values : [];
  const headers = [];
  rows.forEach(function (row, index) {
    if (brewSheetReconcileLabel_(row[1]) === "סוג:" &&
        brewSheetReconcileLabel_(row[3]) === "אצווה:") {
      headers.push(index);
    }
  });
  if (!headers.length || headers.length > 3) throw new Error("Ambiguous brew block headers");

  const candidates = [];
  let unmapped = 0;
  function add(field, fields, row, column, labelColumn, pattern, formatted, maxRow) {
    const source = brewSheetReconcileText_(fields[field]);
    if (!source) return;
    if (row < 0 || row >= maxRow || !pattern.test(brewSheetReconcileText_(rows[row][labelColumn]))) {
      unmapped++;
      return;
    }
    const range = rows[row] || [];
    if (brewSheetReconcileText_(range[column])) return;
    candidates.push({
      field: field,
      row: row + 1,
      column: column + 1,
      a1: String.fromCharCode(65 + column) + String(row + 1),
      value: formatted,
      guardColumn: labelColumn + 1,
      guardPattern: pattern,
      blockIndex: Number(fields.__blockIndex),
    });
  }

  const stageSpecs = [
    ["mashIn", /^הכנסת לתת$/i],
    ["rest1", /^השריה\s*1$/i],
    ["heat1", /^חימום\s*1$/i],
    ["rest2", /^השריה\s*2$/i],
    ["heat2", /^חימום\s*2$/i],
    ["rest3", /^השריה\s*3$/i],
    ["heat3", /^חימום\s*3$/i],
    ["transferLt", /^העברה\s+ל.*L\.?T\.?/i],
    ["restLt", /^מנוחה\s*L\.?T\.?/i],
    ["circulation", /^סחרור/i],
    ["outToBoil", /^(?:הוצאה|יציאה)\s+לבישול$/i],
    ["endTransfer", /^סוף העברה$/i],
    ["boil", /^(?:תחילת\s+)?רתיחה(?:\s+100°?C)?$/i],
    ["hop1", /^הוספת כ(?:שות|שת)\s*1$/i],
    ["hop2", /^הוספת כ(?:שות|שת)\s*2$/i],
    ["hop3", /^הוספת כ(?:שות|שת)\s*3$/i],
    ["hop4", /^הוספת כ(?:שות|שת)\s*4$/i],
    ["wp", /סוף רתיחה.*תחילת\s*WP/i],
    ["outToFermentor", /^הוצאה לתסיסה$/i]
  ];
  const sugarSpecs = [
    ["frPlato", /^F\.R\.?\s*$/i, null],
    ["lrPlato", /^L\.R\.?\s*$/i, null],
    ["kettlePlato", /^סיר בישול/i, "kettleVolume"],
    ["endBoilPlato", /^סוף רתיחה$/i, "endBoilVolume"],
    ["fermentorSamplePlato", /^תחילת תסיסה$/i, "cumulativeTankVolume"]
  ];

  headers.forEach(function (header, index) {
    const end = headers[index + 1] == null ? rows.length : headers[index + 1];
    const expectedLetter = "ABC"[index];
    const headerBatch = brewSheetReconcileText_(rows[header][4]);
    if (brewSheetReconcileBatch_(headerBatch) !== batch ||
        !new RegExp(expectedLetter + "$", "i").test(headerBatch)) {
      // A wrong or missing heading is a hard stop for this block.
      unmapped++;
      return;
    }
    const existingBlock = execution.blocks && execution.blocks[String(index + 1)];
    const originalFields = existingBlock && existingBlock.fields || {};
    const fields = Object.assign({ __blockIndex: String(index + 1) }, originalFields);

    function uniqueRow(column, pattern) {
      const matching = [];
      for (let row = header + 1; row < end; row++) {
        if (pattern.test(brewSheetReconcileText_((rows[row] || [])[column]))) matching.push(row);
      }
      return matching.length === 1 ? matching[0] : -1;
    }
    const waterSpecs = [
      ["hltWaterAmount", /^HLT$/i, 1],
      ["hltWaterTemp", /^HLT$/i, 2],
      ["lauterWaterAmount", /^MASH\s*IN$/i, 1],
      ["lauterWaterTemp", /^MASH\s*IN$/i, 2]
    ];
    waterSpecs.forEach(function (spec) {
      const value = brewSheetReconcileNumber_(fields[spec[0]], 0, spec[0].endsWith("Temp") ? 105 : 6000);
      if (value === null) return;
      const row = uniqueRow(0, spec[1]);
      add(spec[0], fields, row, spec[2], 0, spec[1], value, end);
    });

    stageSpecs.forEach(function (spec) {
      const row = uniqueRow(3, spec[1]);
      ["start", "end"].forEach(function (suffix) {
        const field = spec[0] + "." + suffix;
        const value = brewSheetReconcileText_(fields[field]);
        if (!/^\d{1,2}:\d{2}$/.test(value)) return;
        add(field, fields, row, suffix === "start" ? 4 : 5, 3, spec[1], value, end);
      });
      const field = spec[0] + ".temp";
      const value = brewSheetReconcileNumber_(fields[field], 0, 105);
      if (value !== null && row >= 0) {
        add(field, fields, row, 6, 3, spec[1], value + "°C", end);
      }
    });

    for (let i = 1; i <= 7; i++) {
      const pattern = new RegExp("^שטיפה\\s*" + i + "$", "i");
      const row = uniqueRow(3, pattern);
      const prefix = "rinse" + i;
      const time = brewSheetReconcileText_(fields[prefix + ".time"]);
      if (/^\d{1,2}:\d{2}$/.test(time)) {
        add(prefix + ".time", fields, row, 4, 3, pattern, time, end);
      }
      const amount = brewSheetReconcileNumber_(fields[prefix + ".amount"], 0, 10000);
      if (amount !== null) add(prefix + ".amount", fields, row, 5, 3, pattern, amount, end);
      const temperature = brewSheetReconcileNumber_(fields[prefix + ".temp"], 0, 105);
      if (temperature !== null) add(prefix + ".temp", fields, row, 6, 3, pattern, temperature + "°C", end);
      const kettle = brewSheetReconcileNumber_(fields[prefix + ".kettle"], 0, 20000);
      const grant = brewSheetReconcileNumber_(fields[prefix + ".grant"], 0, 20000);
      if (kettle !== null) {
        // Never repair a composite formula unless both values are already
        // explicitly saved; avoid inventing an unmeasured grant quantity.
        const combined = grant === null ? String(kettle) : String(kettle) + "+" + String(grant);
        add(prefix + ".kettle", fields, row, 7, 3, pattern, combined, end);
      }
    }

    sugarSpecs.forEach(function (spec) {
      const row = uniqueRow(0, spec[1]);
      const gravity = brewSheetReconcileNumber_(fields[spec[0]], 0, 40);
      if (gravity !== null) add(spec[0], fields, row, 1, 0, spec[1], gravity, end);
      if (spec[2]) {
        const volume = brewSheetReconcileNumber_(fields[spec[2]], 0, 20000);
        if (volume !== null) add(spec[2], fields, row, 2, 0, spec[1], volume, end);
      }
    });

    const boilRow = uniqueRow(3, /^(?:תחילת\s+)?רתיחה(?:\s+100°?C)?$/i);
    const boilPh = brewSheetReconcileNumber_(fields.boilPh, 0, 14);
    if (boilPh !== null) add("boilPh", fields, boilRow, 5, 3,
      /^(?:תחילת\s+)?רתיחה(?:\s+100°?C)?$/i, "pH " + boilPh, end);

    const outRow = uniqueRow(3, /^הוצאה לתסיסה$/i);
    const outPh = brewSheetReconcileNumber_(fields.outToFermentorPh, 0, 14);
    if (outPh !== null) add("outToFermentorPh", fields, outRow, 7, 3,
      /^הוצאה לתסיסה$/i, "pH " + outPh, end);
    const toBoilRow = uniqueRow(3, /^(?:הוצאה|יציאה)\s+לבישול$/i);
    const toBoilPh = brewSheetReconcileNumber_(fields.outToBoilPh, 0, 14);
    if (toBoilPh !== null) add("outToBoilPh", fields, toBoilRow, 7, 3,
      /^(?:הוצאה|יציאה)\s+לבישול$/i, "pH " + toBoilPh, end);

    const mashRow = uniqueRow(3, /^הכנסת לתת$/i);
    const mashVolume = brewSheetReconcileNumber_(fields.mashVolume, 0, 20000);
    const mashPh = brewSheetReconcileNumber_(fields.mashPh, 0, 14);
    if (mashVolume !== null || mashPh !== null) {
      const text = [
        mashVolume !== null ? "נפח מאש " + mashVolume : "",
        mashPh !== null ? "pH " + mashPh : ""
      ].filter(Boolean).join("   ");
      add("mashVolume", { mashVolume: text, __blockIndex: String(index + 1) },
        mashRow, 7, 3, /^הכנסת לתת$/i, text, end);
    }
  });

  // Skip ambiguous mappings where two different fields point to one cell.
  const byCell = {};
  const conflicts = {};
  candidates.forEach(function (candidate) {
    const key = candidate.a1;
    if (byCell[key] && String(byCell[key].value) !== String(candidate.value)) {
      conflicts[key] = true;
    } else {
      byCell[key] = candidate;
    }
  });
  return {
    candidates: Object.keys(byCell).filter(function (key) { return !conflicts[key]; })
      .map(function (key) { return byCell[key]; }),
    unmapped: unmapped + Object.keys(conflicts).length
  };
}

function brewSheetReconcileApply_(sheet, plan, maxCells) {
  const stats = { repaired: 0, verified: 0, conflicts: 0, unmapped: plan.unmapped, errors: 0 };
  const candidates = plan.candidates;
  const changed = [];
  candidates.forEach(function (item) {
    // Limit physical writes rather than first N *candidates*. A formula or a
    // manually protected blank near the beginning must not starve a later
    // valid HLT/temperature candidate forever.
    if (stats.repaired >= maxCells) return;
    try {
      // Revalidate semantic label and value on the LIVE Sheet immediately
      // before writing; the planning snapshot might be stale.
      const actualLabel = sheet.getRange(item.row, item.guardColumn).getDisplayValue();
      if (!item.guardPattern.test(brewSheetReconcileText_(actualLabel))) {
        stats.unmapped++;
        return;
      }
      const target = sheet.getRange(item.row, item.column);
      const current = brewSheetReconcileText_(target.getDisplayValue());
      if (current || target.getFormula()) {
        stats.conflicts++;
        return;
      }
      target.setValue(item.value);
      changed.push(item);
      stats.repaired++;
    } catch (error) {
      stats.errors++;
      Logger.log("BREW HOURLY RECONCILE cell " + item.a1 + " ERROR: " + error.message);
    }
  });
  if (changed.length) SpreadsheetApp.flush();
  changed.forEach(function (item) {
    try {
      const checked = sheet.getRange(item.row, item.column);
      const actual = brewSheetReconcileText_(checked.getDisplayValue());
      const expected = brewSheetReconcileText_(item.value);
      // Google Sheets can display a rounded value or add a custom °C/unit
      // while retaining the correct numeric value. Prefer exact underlying
      // numbers over the formatting used in getDisplayValue().
      const stored = typeof checked.getValue === "function" ? checked.getValue() : actual;
      const expectedNumber = typeof item.value === "number" ? item.value : NaN;
      const matchingNumber = Number.isFinite(expectedNumber) &&
        typeof stored === "number" && Number.isFinite(stored) &&
        stored === expectedNumber;
      const leadingNumber = function (value) {
        const text = brewSheetReconcileText_(value).replace(/\s/g, "");
        const match = /^-?\d+(?:\.\d+)?/.exec(text);
        return match ? Number(match[0]) : NaN;
      };
      if (actual === expected || matchingNumber ||
          (Number.isFinite(expectedNumber) && Number.isFinite(leadingNumber(actual)) &&
           leadingNumber(actual) === expectedNumber)) {
        stats.verified++;
      } else {
        stats.errors++;
        Logger.log("BREW HOURLY RECONCILE read-back mismatch " + item.a1);
      }
    } catch (error) {
      stats.errors++;
    }
  });
  return stats;
}

function brewSheetReconcileSingle_(entry, projectId, now) {
  const tank = entry.data || {};
  const batch = brewSheetReconcileBatch_(tank.batchNumber);
  const execution = brewSheetReconcileReadExecution_(projectId, batch);
  if (!execution || brewSheetReconcileBatch_(execution.batchNumber) !== batch ||
      !brewSheetReconcileHasStarted_(tank, execution)) {
    return { skipped: 1, repaired: 0, verified: 0, conflicts: 0, errors: 0, unmapped: 0 };
  }

  // Refresh the LIVE fermentor document immediately before writing. This
  // protects a brew that just changed ACTION/batch/Sheet and also exposes
  // the latest manual Sheet edit, including an intentional blanking.
  const liveTank = getFermentorFromFirestore(projectId, entry.id);
  if (FC_CYCLE_CONTEXT_ && FC_CYCLE_CONTEXT_.io) FC_CYCLE_CONTEXT_.io.firestoreReads++;
  if (!liveTank || Number(liveTank.action) !== 0 ||
      brewSheetReconcileBatch_(liveTank.batchNumber) !== batch ||
      brewSheetReconcileText_(liveTank.sheetUrl) !== brewSheetReconcileText_(tank.sheetUrl)) {
    return { skipped: 1, repaired: 0, verified: 0, conflicts: 0, errors: 0, unmapped: 0 };
  }
  const fileId = extractSpreadsheetId(tank.sheetUrl);
  if (!fileId) throw new Error("Missing validated spreadsheet ID");
  const spreadsheet = SpreadsheetApp.openById(fileId);
  const sheet = spreadsheet.getSheets()[0];
  if (!sheet) throw new Error("No brew sheet");
  const values = sheet.getDataRange().getDisplayValues();
  const header = values[0] || [];
  const sheetBatch = brewSheetReconcileBatch_(header[5]);
  const sheetTank = brewSheetReconcileText_(header[3]);
  const tankNumber = brewSheetReconcileText_(tank.tankNumber);
  if (sheetBatch !== batch || sheetTank !== tankNumber) {
    throw new Error("Brew sheet identity mismatch for tank " + tankNumber +
      ", batch " + batch + " (Sheet " + sheetTank + "/" + sheetBatch + ")");
  }

  const plan = brewSheetReconcilePlan_(values, execution, batch);
  const manualEditRange = brewSheetReconcileText_(liveTank.brewSheetEditRange)
    .replace(/^[^!]+!/, "").replace(/\\$/g, "").toUpperCase();
  // A deliberate manual clear must not be resurrected from an older
  // Firestore execution snapshot if the Sheet onEdit handler is delayed.
  // Even if that handler fails to update the execution, its revision
  // record is sufficient to conservatively suppress this one cell.
  const manualCleared = Number(liveTank.brewSheetEditRevision) > 0 &&
    liveTank.brewSheetEditValue !== undefined &&
    brewSheetReconcileText_(liveTank.brewSheetEditValue) === "";
  const safePlan = {
    candidates: manualCleared
      ? plan.candidates.filter(function (item) { return item.a1.toUpperCase() !== manualEditRange; })
      : plan.candidates,
    unmapped: plan.unmapped
  };
  const result = brewSheetReconcileApply_(sheet, safePlan, BREW_SHEET_HOURLY_MAX_CELLS_);
  result.skipped = 0;
  return result;
}

function brewSheetHourlyMaintenance_(fermentors, now) {
  now = now || new Date();
  const props = PropertiesService.getScriptProperties();
  const lastAt = Number(props.getProperty(BREW_SHEET_HOURLY_LAST_AT_KEY_) || 0);
  if (Number.isFinite(lastAt) && lastAt > 0 &&
      now.getTime() - lastAt < BREW_SHEET_HOURLY_INTERVAL_MS_) {
    return { due: false };
  }

  const today = Utilities.formatDate(now, "Asia/Jerusalem", "yyyyMMdd");
  const eligible = (fermentors || []).filter(function (entry) {
    const tank = entry.data || {};
    const number = Number(tank.tankNumber);
    const brewDay = brewSheetReconcileDateKey_(tank.brewDate);
    return Number(tank.action) === 0 &&
      number >= 2 && number <= 19 &&
      tank.tankStatus !== true &&
      !!tank.sheetUrl && !!brewSheetReconcileBatch_(tank.batchNumber) &&
      // Future scheduled brews must never be modified by this job.
      (!brewDay || brewDay <= today);
  }).slice(0, BREW_SHEET_HOURLY_MAX_TANKS_);

  const summary = { due: true, candidates: eligible.length, processed: 0,
    skipped: 0, repaired: 0, verified: 0, conflicts: 0, unmapped: 0, errors: 0 };
  eligible.forEach(function (entry) {
    try {
      const result = brewSheetReconcileSingle_(entry, FIREBASE_PROJECT_ID, now);
      summary.processed += result.skipped ? 0 : 1;
      ["skipped", "repaired", "verified", "conflicts", "unmapped", "errors"].forEach(function (name) {
        summary[name] += Number(result[name] || 0);
      });
    } catch (error) {
      summary.errors++;
      Logger.log("BREW HOURLY RECONCILE tank " +
        String(entry.data && entry.data.tankNumber || entry.id) +
        " FAILED: " + error.message);
    }
  });

  // The next five-minute cycle should remain cheap. Any unresolved empty
  // cells remain eligible for the following hourly run.
  props.setProperty(BREW_SHEET_HOURLY_LAST_AT_KEY_, String(now.getTime()));
  Logger.log("BREW HOURLY RECONCILE: " + JSON.stringify(summary));
  return summary;
}
