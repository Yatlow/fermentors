// ============================================================
// BREW STAGE SERVICE
// ============================================================
//
// ACTION-0 runtime stage extraction.
//
// Date strategy:
//   1. A persisted brewProgress.blockStarts timestamp is the
//      primary source of truth for each brew block (A/B/C...).
//   2. An explicit date in that block header is the next source.
//   3. Other known block dates / fermentor brewDate / top header
//      are used only to seed or backfill legacy in-progress brews.
//   4. If absolutely nothing is known, today is used temporarily.
//
// When a new block is first observed as started, its startedAt is
// persisted through updateFermentorBrewProgress(). Once stored it
// is never changed.
//
// Immediately before ACTION 0 is expected to become ACTION 1
// (volume exists, or final "out to fermentor" is >2h old), missing
// Sheet dates are filled from those block timestamps. Existing
// dates are never overwritten.
// ============================================================

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
const MIDNIGHT_ROLLOVER_MIN_GAP_MINUTES = 6 * 60;
const ACTION_0_GRACE_MS = 2 * 60 * 60 * 1000;
const LIVE_BLOCK_DETECTION_WINDOW_MS = 30 * 60 * 1000;


// ----------------------------------------------------------
// BASIC HELPERS
// ----------------------------------------------------------

function brewStageFormatHHMM_(date) {
  if (!date) return null;
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return h + ":" + m;
}

function brewStageExtractTime_(text) {
  if (text === null || text === undefined || text === "") return null;

  const m = String(text).match(/(?:^|\s)(\d{1,2}):(\d{2})(?:\s|$)/);
  if (!m) return null;

  const h = Number(m[1]);
  const mi = Number(m[2]);

  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

function brewStageExtractDate_(value) {
  if (!value) return null;

  if (value instanceof Date && !isNaN(value.getTime())) {
    return new Date(value.getTime());
  }

  if (typeof value === "object") {
    if (typeof value.toDate === "function") {
      try {
        const d = value.toDate();
        if (d && !isNaN(d.getTime())) return d;
      } catch (e) {}
    }

    if (value.seconds !== undefined) {
      const seconds = Number(value.seconds);
      if (Number.isFinite(seconds)) return new Date(seconds * 1000);
    }

    if (value._seconds !== undefined) {
      const seconds = Number(value._seconds);
      if (Number.isFinite(seconds)) return new Date(seconds * 1000);
    }
  }

  const text = String(value).trim();
  if (!text) return null;

  const israeli = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (israeli) {
    const day = Number(israeli[1]);
    const month = Number(israeli[2]) - 1;
    let year = Number(israeli[3]);
    if (year < 100) year += 2000;

    const d = new Date(year, month, day);
    if (
      d.getFullYear() === year &&
      d.getMonth() === month &&
      d.getDate() === day
    ) {
      return d;
    }
  }

  const parsed = new Date(text);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function brewStageStartOfDay_(date) {
  if (!date) return null;
  const d = new Date(date.getTime());
  d.setHours(0, 0, 0, 0);
  return d;
}

function brewStageAddDays_(date, days) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

function brewStageDateWithMinutes_(date, minutes) {
  const d = brewStageStartOfDay_(date);
  d.setMinutes(minutes);
  return d;
}

function brewStageFormatDate_(date) {
  if (!date) return "";
  return (
    String(date.getDate()).padStart(2, "0") +
    "/" +
    String(date.getMonth() + 1).padStart(2, "0") +
    "/" +
    String(date.getFullYear())
  );
}

function brewStageExtractNumber_(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;

  const m = String(value).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;

  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function brewStageFindRowContaining_(values, needle) {
  for (let r = 0; r < values.length; r++) {
    for (let c = 0; c < (values[r] || []).length; c++) {
      if (String(values[r][c] || "").trim().includes(needle)) return r;
    }
  }
  return -1;
}

function brewStageFindExactCell_(values, needle) {
  for (let r = 0; r < values.length; r++) {
    for (let c = 0; c < (values[r] || []).length; c++) {
      if (String(values[r][c] || "").trim() === needle) {
        return { row: r, col: c };
      }
    }
  }
  return null;
}


// ----------------------------------------------------------
// BLOCK HEADERS
// ----------------------------------------------------------

function findBrewBlockStarts(values) {
  const starts = [];

  for (let r = 1; r < values.length; r++) {
    const row = values[r] || [];
    let hasType = false;
    let hasBatch = false;
    let hasDateLabel = false;

    for (let c = 0; c < row.length; c++) {
      const cell = String(row[c] || "").trim();
      if (cell === "סוג:") hasType = true;
      if (cell === "אצווה:") hasBatch = true;
      if (cell === "תאריך") hasDateLabel = true;
    }

    if (hasType && hasBatch && hasDateLabel) starts.push(r);
  }

  return starts;
}

function brewStageReadHeaderDate_(values, rowIndex) {
  const row = values[rowIndex] || [];

  for (let c = 0; c < row.length; c++) {
    if (String(row[c] || "").trim() === "תאריך") {
      return {
        labelCol: c,
        valueCol: c + 1,
        date: brewStageExtractDate_(row[c + 1])
      };
    }
  }

  return { labelCol: null, valueCol: null, date: null };
}

function brewStageReadTopHeaderDate_(values) {
  const searchRows = Math.min(values.length, 3);

  for (let r = 0; r < searchRows; r++) {
    const row = values[r] || [];

    for (let c = 0; c < row.length; c++) {
      if (String(row[c] || "").trim() === "תאריך:") {
        return {
          row: r,
          labelCol: c,
          valueCol: c + 1,
          date: brewStageExtractDate_(row[c + 1])
        };
      }
    }
  }

  return { row: null, labelCol: null, valueCol: null, date: null };
}


// ----------------------------------------------------------
// SAVED BLOCK STARTS
// ----------------------------------------------------------

function brewStageNormalizeSavedStarts_(fermentorHint) {
  const result = {};
  if (!fermentorHint) return result;

  const progress = fermentorHint.brewProgress || {};
  const raw = progress.blockStarts || fermentorHint.brewBlockStarts;

  if (!raw) return result;

  if (Array.isArray(raw)) {
    raw.forEach(function (entry, index) {
      if (!entry) return;
      const blockIndex = Number(entry.blockIndex || index + 1);
      const date = brewStageExtractDate_(entry.startedAt || entry.timestamp || entry.date);
      if (Number.isFinite(blockIndex) && date) result[blockIndex] = date;
    });
    return result;
  }

  if (typeof raw === "object") {
    Object.keys(raw).forEach(function (key) {
      const entry = raw[key];
      const blockIndex = Number(key);
      const date = brewStageExtractDate_(
        entry && typeof entry === "object"
          ? (entry.startedAt || entry.timestamp || entry.date || entry)
          : entry
      );
      if (Number.isFinite(blockIndex) && date) result[blockIndex] = date;
    });
  }

  return result;
}


// ----------------------------------------------------------
// RAW STAGE EXTRACTION PER BLOCK
// ----------------------------------------------------------

function brewStageExtractRawStages_(values, startRow, endRow) {
  const stages = [];

  rowLoop:
  for (let r = startRow; r <= endRow; r++) {
    const row = values[r] || [];

    for (let s = 0; s < STAGE_DEFS.length; s++) {
      const def = STAGE_DEFS[s];

      for (let c = 0; c < row.length; c++) {
        const label = String(row[c] || "").trim();
        const match = label.match(def.regex);
        if (!match) continue;

        let startMinutes = null;
        let endMinutes = null;

        // Template normally keeps start/end immediately to the
        // right of the operation label. Look a few cells right so
        // minor merged-cell layout changes do not break extraction.
        for (let offset = 1; offset <= 3; offset++) {
          const minutes = brewStageExtractTime_(row[c + offset]);
          if (minutes === null) continue;

          if (startMinutes === null) startMinutes = minutes;
          else if (endMinutes === null) {
            endMinutes = minutes;
            break;
          }
        }

        if (startMinutes === null) continue;

        const indexedSuffix = def.indexed && match[1] ? " " + match[1] : "";

        stages.push({
          code: def.code,
          name: def.name + indexedSuffix,
          row: r,
          startMinutes: startMinutes,
          endMinutes: endMinutes
        });

        continue rowLoop;
      }
    }
  }

  return stages;
}

function brewStageFirstStartMinutes_(rawStages) {
  if (!rawStages || !rawStages.length) return null;
  return rawStages[0].startMinutes;
}


// ----------------------------------------------------------
// RESOLVE ONE DATE PER BLOCK
// ----------------------------------------------------------

function brewStageResolveBlockDates_(blocks, savedStarts, fallbackDate) {
  const resolved = new Array(blocks.length).fill(null);
  const source = new Array(blocks.length).fill(null);

  // Primary: persisted timestamp. Secondary: explicit block date.
  for (let i = 0; i < blocks.length; i++) {
    const blockIndex = i + 1;

    if (savedStarts[blockIndex]) {
      resolved[i] = brewStageStartOfDay_(savedStarts[blockIndex]);
      source[i] = "runtime";
      continue;
    }

    if (blocks[i].explicitDate) {
      resolved[i] = brewStageStartOfDay_(blocks[i].explicitDate);
      source[i] = "sheet";
    }
  }

  let knownIndex = -1;
  for (let i = 0; i < resolved.length; i++) {
    if (resolved[i]) {
      knownIndex = i;
      break;
    }
  }

  if (knownIndex === -1 && fallbackDate) {
    resolved[0] = brewStageStartOfDay_(fallbackDate);
    source[0] = "fallback";
    knownIndex = 0;
  }

  if (knownIndex === -1) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    resolved[0] = today;
    source[0] = "assumed";
    knownIndex = 0;
  }

  // Propagate forward. A large backwards clock jump between the
  // first stage of adjacent blocks means the next block is next day.
  for (let i = knownIndex + 1; i < blocks.length; i++) {
    if (resolved[i]) continue;

    let previous = i - 1;
    while (previous >= 0 && !resolved[previous]) previous--;
    if (previous < 0) continue;

    let date = brewStageStartOfDay_(resolved[previous]);
    const prevMinutes = brewStageFirstStartMinutes_(blocks[previous].rawStages);
    const thisMinutes = brewStageFirstStartMinutes_(blocks[i].rawStages);

    if (
      prevMinutes !== null &&
      thisMinutes !== null &&
      prevMinutes - thisMinutes > MIDNIGHT_ROLLOVER_MIN_GAP_MINUTES
    ) {
      date = brewStageAddDays_(date, 1);
    }

    resolved[i] = date;
    source[i] = "inferred";
  }

  // Propagate backwards from the first known date. Useful for a
  // legacy sheet such as A(no date), B(14/9), C(no date).
  for (let i = knownIndex - 1; i >= 0; i--) {
    if (resolved[i]) continue;

    let next = i + 1;
    while (next < blocks.length && !resolved[next]) next++;
    if (next >= blocks.length) continue;

    let date = brewStageStartOfDay_(resolved[next]);
    const thisMinutes = brewStageFirstStartMinutes_(blocks[i].rawStages);
    const nextMinutes = brewStageFirstStartMinutes_(blocks[next].rawStages);

    if (
      thisMinutes !== null &&
      nextMinutes !== null &&
      thisMinutes - nextMinutes > MIDNIGHT_ROLLOVER_MIN_GAP_MINUTES
    ) {
      date = brewStageAddDays_(date, -1);
    }

    resolved[i] = date;
    source[i] = "inferred";
  }

  // If there were several explicit/runtime anchors, fill any holes
  // left between them from the previous resolved block.
  for (let i = 1; i < blocks.length; i++) {
    if (resolved[i]) continue;

    let date = brewStageStartOfDay_(resolved[i - 1]);
    const prevMinutes = brewStageFirstStartMinutes_(blocks[i - 1].rawStages);
    const thisMinutes = brewStageFirstStartMinutes_(blocks[i].rawStages);

    if (
      prevMinutes !== null &&
      thisMinutes !== null &&
      prevMinutes - thisMinutes > MIDNIGHT_ROLLOVER_MIN_GAP_MINUTES
    ) {
      date = brewStageAddDays_(date, 1);
    }

    resolved[i] = date;
    source[i] = "inferred";
  }

  return { dates: resolved, sources: source };
}


// ----------------------------------------------------------
// BUILD DATED STAGES WITH MIDNIGHT ROLLOVER
// ----------------------------------------------------------

function brewStageBuildDatedStages_(rawStages, blockDate) {
  const stages = [];
  if (!rawStages || !rawStages.length || !blockDate) return stages;

  let cursorDate = brewStageStartOfDay_(blockDate);
  let cursorMinutes = null;

  rawStages.forEach(function (raw) {
    let startDateTime;

    if (
      cursorMinutes !== null &&
      cursorMinutes - raw.startMinutes > MIDNIGHT_ROLLOVER_MIN_GAP_MINUTES
    ) {
      cursorDate = brewStageAddDays_(cursorDate, 1);
    }

    startDateTime = brewStageDateWithMinutes_(cursorDate, raw.startMinutes);
    cursorMinutes = raw.startMinutes;

    let endDateTime = null;

    if (raw.endMinutes !== null) {
      let endDate = brewStageStartOfDay_(cursorDate);

      if (
        raw.startMinutes - raw.endMinutes > MIDNIGHT_ROLLOVER_MIN_GAP_MINUTES
      ) {
        endDate = brewStageAddDays_(endDate, 1);
      }

      endDateTime = brewStageDateWithMinutes_(endDate, raw.endMinutes);
      cursorDate = brewStageStartOfDay_(endDateTime);
      cursorMinutes = raw.endMinutes;
    }

    stages.push({
      code: raw.code,
      name: raw.name,
      row: raw.row,
      startDateTime: startDateTime,
      endDateTime: endDateTime
    });
  });

  return stages;
}


// ----------------------------------------------------------
// REGISTER NEW BLOCK STARTS
// ----------------------------------------------------------

function brewStageRegisterBlockStarts_(blocks, resolvedDates, sources, savedStarts) {
  const now = new Date();
  const result = {};

  Object.keys(savedStarts).forEach(function (key) {
    result[Number(key)] = new Date(savedStarts[key].getTime());
  });

  blocks.forEach(function (block, index) {
    const blockIndex = index + 1;
    if (result[blockIndex]) return;
    if (!block.rawStages || !block.rawStages.length) return;

    const firstMinutes = brewStageFirstStartMinutes_(block.rawStages);
    const blockDate = resolvedDates[index];
    if (firstMinutes === null || !blockDate) return;

    const reconstructedStart = brewStageDateWithMinutes_(blockDate, firstMinutes);

    // For a block that just started, keep the actual detection
    // timestamp. For a legacy block already in progress when this
    // version is deployed, seed from the reconstructed start so we
    // do not incorrectly stamp yesterday's brew as "today".
    if (
      Math.abs(now.getTime() - reconstructedStart.getTime()) <=
      LIVE_BLOCK_DETECTION_WINDOW_MS
    ) {
      result[blockIndex] = new Date(now.getTime());
    } else {
      result[blockIndex] = reconstructedStart;
    }

    Logger.log(
      "Registered brew block " +
      blockIndex +
      " startedAt=" +
      result[blockIndex].toISOString() +
      " source=" +
      sources[index]
    );
  });

  return result;
}

function brewStageBlockStartsArray_(blockStarts) {
  return Object.keys(blockStarts)
    .map(Number)
    .filter(function (n) { return Number.isFinite(n); })
    .sort(function (a, b) { return a - b; })
    .map(function (blockIndex) {
      return {
        blockIndex: blockIndex,
        startedAt: blockStarts[blockIndex]
      };
    });
}


// ----------------------------------------------------------
// VOLUME
// ----------------------------------------------------------

function brewStageFindBeerVolume_(values) {
  const location = brewStageFindExactCell_(values, "נפח:");
  if (!location) return null;

  const row = values[location.row] || [];

  // Prefer the next cell, but tolerate merged/template variations.
  for (let c = location.col + 1; c < Math.min(row.length, location.col + 4); c++) {
    const n = brewStageExtractNumber_(row[c]);
    if (n !== null) return n;
  }

  return null;
}


// ----------------------------------------------------------
// SHEET DATE RECONCILIATION
// ----------------------------------------------------------

function brewStageFillMissingDates_(sheet, values, blocks, blockStarts, topHeaderInfo) {
  let writes = 0;

  blocks.forEach(function (block, index) {
    const blockIndex = index + 1;
    if (block.explicitDate) return;
    if (block.headerDateValueCol === null) return;

    const startedAt = blockStarts[blockIndex];
    if (!startedAt) return;

    sheet
      .getRange(block.headerRow + 1, block.headerDateValueCol + 1)
      .setNumberFormat("@")
      .setValue(brewStageFormatDate_(startedAt));

    writes++;
  });

  // The top batch date represents the beginning of block A.
  if (
    topHeaderInfo &&
    !topHeaderInfo.date &&
    topHeaderInfo.row !== null &&
    topHeaderInfo.valueCol !== null &&
    blockStarts[1]
  ) {
    sheet
      .getRange(topHeaderInfo.row + 1, topHeaderInfo.valueCol + 1)
      .setNumberFormat("@")
      .setValue(brewStageFormatDate_(blockStarts[1]));

    writes++;
  }

  if (writes > 0) {
    Logger.log("Filled " + writes + " missing brew date cell(s) before ACTION 1.");
  }

  return writes;
}


// ----------------------------------------------------------
// MAIN EXTRACTOR
// ----------------------------------------------------------

function extractBrewStageInfo(spreadSheetId, fermentorHint) {
  const spreadsheetId = extractSpreadsheetId(spreadSheetId);
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sheet = ss.getSheets()[0];
  const values = sheet.getDataRange().getDisplayValues();

  const topHeaderInfo = brewStageReadTopHeaderDate_(values);
  const blockStartsRows = findBrewBlockStarts(values);
  const fermentationRow = brewStageFindRowContaining_(values, "דף תסיסה");
  const scanEnd = (fermentationRow !== -1 ? fermentationRow : values.length) - 1;

  const blocks = blockStartsRows.map(function (headerRow, index) {
    const nextHeader =
      index + 1 < blockStartsRows.length
        ? blockStartsRows[index + 1] - 1
        : scanEnd;

    const headerInfo = brewStageReadHeaderDate_(values, headerRow);
    const rawStages = brewStageExtractRawStages_(values, headerRow + 1, nextHeader);

    return {
      blockIndex: index + 1,
      headerRow: headerRow,
      headerDateValueCol: headerInfo.valueCol,
      explicitDate: headerInfo.date,
      rawStages: rawStages,
      stages: []
    };
  });

  const savedStarts = brewStageNormalizeSavedStarts_(fermentorHint);

  const fermentorDate =
    fermentorHint && fermentorHint.brewDate
      ? brewStageExtractDate_(fermentorHint.brewDate)
      : null;

  // If the top header is stale it must not override a more useful
  // fermentor/explicit block date. Explicit block dates are resolved
  // inside brewStageResolveBlockDates_ and therefore win naturally.
  let fallbackDate = fermentorDate || topHeaderInfo.date || null;

  const resolution = brewStageResolveBlockDates_(
    blocks,
    savedStarts,
    fallbackDate
  );

  const blockStarts = brewStageRegisterBlockStarts_(
    blocks,
    resolution.dates,
    resolution.sources,
    savedStarts
  );

  // Re-resolve using newly registered runtime timestamps so the
  // exact same run already treats them as primary truth.
  const runtimeResolution = brewStageResolveBlockDates_(
    blocks,
    blockStarts,
    fallbackDate
  );

  blocks.forEach(function (block, index) {
    block.stages = brewStageBuildDatedStages_(
      block.rawStages,
      runtimeResolution.dates[index]
    );
  });

  const startedBlocks = blocks.filter(function (block) {
    return block.stages && block.stages.length > 0;
  });

  const now = new Date();
  let currentStage = null;
  let currentBlockIndex = null;

  for (let bi = startedBlocks.length - 1; bi >= 0 && !currentStage; bi--) {
    const stages = startedBlocks[bi].stages;

    for (let si = stages.length - 1; si >= 0; si--) {
      if (stages[si].startDateTime.getTime() <= now.getTime()) {
        currentStage = stages[si];
        currentBlockIndex = startedBlocks[bi].blockIndex;
        break;
      }
    }
  }

  const headerCount = blocks.length;
  const blockCount = startedBlocks.length;
  const hasUnstartedHeader = headerCount > blockCount;
  const lastBlock = blockCount ? startedBlocks[startedBlocks.length - 1] : null;
  const beerVolume = brewStageFindBeerVolume_(values);

  const outStage =
    lastBlock
      ? lastBlock.stages.find(function (stage) {
          return stage.code === STAGE_CODE_OUT_TO_FERMENTOR;
        })
      : null;

  const finalOutPastGrace =
    !!(
      !hasUnstartedHeader &&
      outStage &&
      outStage.startDateTime &&
      now.getTime() - outStage.startDateTime.getTime() >= ACTION_0_GRACE_MS
    );

  const readyForAction1 =
    beerVolume !== null && beerVolume !== undefined
      ? true
      : finalOutPastGrace;

  // Reconcile dates immediately before processAction0 is expected
  // to set ACTION=1. Existing dates are left untouched.
  if (readyForAction1) {
    try {
      brewStageFillMissingDates_(
        sheet,
        values,
        blocks,
        blockStarts,
        topHeaderInfo
      );
    } catch (error) {
      Logger.log("Failed filling missing brew dates: " + error.message);
    }
  }

  const dateAssumed = runtimeResolution.sources.some(function (source) {
    return source === "assumed";
  });

  return {
    tankNumber:
      fermentorHint && fermentorHint.tankNumber
        ? String(fermentorHint.tankNumber).trim()
        : null,

    dateAssumed: dateAssumed,
    blockCount: blockCount,
    headerCount: headerCount,
    hasUnstartedHeader: hasUnstartedHeader,
    lastBlock: lastBlock,
    currentBlockIndex: currentBlockIndex,
    currentStage: currentStage,
    beerVolume: beerVolume,
    blockStarts: brewStageBlockStartsArray_(blockStarts)
  };
}


// ----------------------------------------------------------
// FIRESTORE PROGRESS PERSISTENCE
// ----------------------------------------------------------

function brewStageToFirestoreValue_(value) {
  if (value === null || value === undefined) return { nullValue: null };

  if (value instanceof Date) {
    return { timestampValue: value.toISOString() };
  }

  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map(brewStageToFirestoreValue_)
      }
    };
  }

  if (typeof value === "object") {
    const fields = {};
    Object.keys(value).forEach(function (key) {
      fields[key] = brewStageToFirestoreValue_(value[key]);
    });
    return { mapValue: { fields: fields } };
  }

  if (typeof value === "boolean") return { booleanValue: value };

  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }

  return { stringValue: String(value) };
}

function updateFermentorBrewProgress(tankNumber, stageInfo) {
  const fermentorId = String(tankNumber).trim();
  const stage = stageInfo.currentStage;

  const progress = {
    blockIndex: stageInfo.currentBlockIndex || null,
    blockCount: stageInfo.blockCount || null,
    headerCount: stageInfo.headerCount || null,

    stageCode: stage ? stage.code : null,
    stageName: stage ? stage.name : null,
    stageStartTime: stage ? stage.startDateTime : null,
    stageEndTime: stage ? stage.endDateTime : null,
    stageStartTimeText: stage ? brewStageFormatHHMM_(stage.startDateTime) : null,
    stageEndTimeText: stage ? brewStageFormatHHMM_(stage.endDateTime) : null,

    dateAssumed: !!stageInfo.dateAssumed,
    blockStarts: stageInfo.blockStarts || []
  };

  const progressCacheKey = "brewProgress:" + fermentorId;

  if (
    typeof hasChangedLocally_ === "function" &&
    !hasChangedLocally_(progressCacheKey, progress)
  ) {
    Logger.log(
      "Brew progress unchanged for tank " +
      fermentorId +
      " - skipping Firestore write."
    );
    return;
  }

  const url =
    "https://firestore.googleapis.com/v1/projects/" +
    FIREBASE_PROJECT_ID +
    "/databases/(default)/documents/fermentors/" +
    encodeURIComponent(fermentorId) +
    "?updateMask.fieldPaths=brewProgress";

  const document = {
    fields: {
      brewProgress: brewStageToFirestoreValue_(progress)
    }
  };

  const response = UrlFetchApp.fetch(url, {
    method: "patch",
    contentType: "application/json",
    headers: {
      Authorization: "Bearer " + ScriptApp.getOAuthToken()
    },
    payload: JSON.stringify(document),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();

  if (code < 200 || code >= 300) {
    throw new Error(
      "Failed to update brewProgress for tank " +
      fermentorId +
      ": " +
      code +
      " " +
      response.getContentText()
    );
  }
}


// ----------------------------------------------------------
// MANUAL TEST
// ----------------------------------------------------------

function testExtractStageInfo() {
  const url =
    "https://docs.google.com/spreadsheets/d/1eT7aP7zbhqSk6gDzhqN-Tp2Wvt3Y4dqGsRyqyNftrB8/edit";

  const info = extractBrewStageInfo(url);
  Logger.log(JSON.stringify(info, null, 2));
}
