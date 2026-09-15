// ============================================================
// CALENDAR -> FIRESTORE SERVICE
// ============================================================
// Production entry points:
//   - syncCalendarToFirestore
//   - cleanOldCalendarEvents
//
// All internal helpers are calendar-prefixed on purpose. Apps Script
// shares one global namespace across every .js/.gs file, so generic helper
// names here must not shadow fermentor-cycle helpers.
// ============================================================

const CALENDAR_ID = "shapirobeer@gmail.com";

function syncCalendarToFirestore() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    Logger.log("Calendar sync skipped: script lock is busy.");
    return { skipped: true, reason: "script_lock_busy" };
  }

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
      orderBy: "startTime"
    });

    const events = response.items || [];
    const parsedEvents = [];

    events.forEach(function (event) {
      const summary = event.summary || "";
      const parsed = calendarParseSummary_(summary);
      if (!parsed) return;

      const eventDateStr = event.start.date || event.start.dateTime;
      const eventDate = new Date(eventDateStr);

      const normalizedStyle =
        calendarNormalizeBeerStyle_(parsed.itemType) ||
        calendarDetectBeerStyleFromText_(summary) ||
        null;

      parsedEvents.push({
        eventId: event.id,
        title: summary,
        date: eventDateStr.split("T")[0],
        timestamp: eventDate.getTime(),
        actionType: parsed.actionType,
        tankNumber: parsed.tankNumber,
        itemType: parsed.itemType,
        unit: parsed.unit,
        beerStyle: normalizedStyle,
        quantity: parsed.quantity
      });
    });

    const adjustedEvents = calendarProcessTankTotals_(parsedEvents);
    let savedCount = 0;

    adjustedEvents.forEach(function (payload) {
      calendarWriteEventToFirestore_(
        FIREBASE_PROJECT_ID,
        payload.eventId,
        payload
      );
      savedCount++;

      Logger.log(
        "[Calendar saved] \"" + payload.title + "\" -> " +
        payload.quantity + " " + (payload.unit || "")
      );
    });

    Logger.log("Calendar sync complete: " + savedCount + " event(s).");
    return { savedCount: savedCount };

  } finally {
    lock.releaseLock();
  }
}

function calendarProcessTankTotals_(events) {
  events.sort(function (a, b) {
    return a.timestamp - b.timestamp;
  });

  const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
  const batches = [];

  events.forEach(function (event) {
    if (!event.tankNumber) return;

    const tankNumber = Number(event.tankNumber);
    let existingBatch = batches.find(function (batch) {
      if (Number(batch.tankNumber) !== tankNumber) return false;
      const lastEvent = batch.events[batch.events.length - 1];
      return event.timestamp - lastEvent.timestamp <= FOURTEEN_DAYS_MS;
    });

    if (existingBatch) {
      existingBatch.events.push(event);
    } else {
      batches.push({ tankNumber: tankNumber, events: [event] });
    }
  });

  batches.forEach(function (batch) {
    const tankNumber = Number(batch.tankNumber);
    const groupEvents = batch.events;
    const beerStyle = calendarDetectBeerStyleFromBatch_(groupEvents);

    const kegEvents = groupEvents.filter(function (event) {
      return calendarIsKegUnit_(event.unit);
    });

    const bottleEvents = groupEvents.filter(function (event) {
      return calendarIsBoxUnit_(event.unit);
    });

    const targets = calendarFallbackTargets_(
      tankNumber,
      beerStyle,
      bottleEvents.length > 0
    );

    if (!targets) {
      Logger.log(
        "[Calendar fallback] no target for tank " + tankNumber +
        ", style=" + (beerStyle || "unknown")
      );
      return;
    }

    let existingKegs = 0;
    let existingBoxes = 0;

    groupEvents.forEach(function (event) {
      if (
        event.quantity === null ||
        event.quantity === undefined ||
        event.quantity === ""
      ) return;

      const quantity = Number(event.quantity);
      if (!Number.isFinite(quantity)) return;

      if (calendarIsKegUnit_(event.unit)) existingKegs += quantity;
      else if (calendarIsBoxUnit_(event.unit)) existingBoxes += quantity;
    });

    groupEvents.forEach(function (event) {
      const hasQuantity =
        event.quantity !== null &&
        event.quantity !== undefined &&
        event.quantity !== "";

      if (hasQuantity) return;

      if (!event.unit) event.unit = "ארגזים";

      if (calendarIsKegUnit_(event.unit)) {
        const remaining = targets.kegs - existingKegs;
        event.quantity = remaining > 0 ? remaining : 0;
        if (remaining > 0) existingKegs += remaining;
        return;
      }

      if (calendarIsBoxUnit_(event.unit)) {
        const remaining = targets.boxes - existingBoxes;
        event.quantity = remaining > 0 ? remaining : 0;
        if (remaining > 0) existingBoxes += remaining;
      }
    });
  });

  return events;
}

function calendarDetectBeerStyleFromBatch_(events) {
  for (let i = 0; i < events.length; i++) {
    const style = calendarNormalizeBeerStyle_(events[i].itemType);
    if (style) return style;
  }

  for (let i = 0; i < events.length; i++) {
    const style = calendarDetectBeerStyleFromText_(events[i].title || "");
    if (style) return style;
  }

  return null;
}

function calendarNormalizeBeerStyle_(value) {
  if (!value) return null;

  const text = String(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

  if (text.includes("ipa")) return "IPA";
  if (text.includes("פייל")) return "פייל";
  if (text.includes("הופי לאגר")) return "הופי לאגר";
  if (text.includes("לאגר")) return "לאגר";
  if (text.includes("חיטה")) return "חיטה";
  if (text.includes("סטאוט")) return "סטאוט";
  return null;
}

function calendarDetectBeerStyleFromText_(text) {
  return calendarNormalizeBeerStyle_(text);
}

function calendarIsKegUnit_(unit) {
  return !!unit && String(unit).includes("חביות");
}

function calendarIsBoxUnit_(unit) {
  if (!unit) return false;
  const text = String(unit);
  return text.includes("ארגז") || text.includes("בקבוק");
}

function calendarFallbackTargets_(tankNumber, beerStyle, hasBottling) {
  tankNumber = Number(tankNumber);

  if (tankNumber >= 1 && tankNumber <= 4) {
    return { boxes: 135, kegs: 56 };
  }

  if (tankNumber >= 5 && tankNumber <= 8) {
    if (hasBottling) {
      switch (beerStyle) {
        case "IPA": return { boxes: 168, kegs: 30 };
        case "פייל": return { boxes: 168, kegs: 45 };
        case "הופי לאגר":
        case "לאגר": return { boxes: 168, kegs: 60 };
        case "חיטה": return { boxes: 168, kegs: 40 };
        default: return null;
      }
    }

    switch (beerStyle) {
      case "IPA": return { boxes: 245, kegs: 98 };
      case "פייל": return { boxes: 285, kegs: 110 };
      case "הופי לאגר":
      case "לאגר": return { boxes: 325, kegs: 125 };
      case "חיטה": return { boxes: 265, kegs: 105 };
      default: return null;
    }
  }

  if (tankNumber >= 9 && tankNumber <= 19) {
    if (hasBottling) {
      switch (beerStyle) {
        case "IPA": return { boxes: 252, kegs: 50 };
        case "פייל": return { boxes: 252, kegs: 60 };
        case "הופי לאגר": return { boxes: 252, kegs: 80 };
        case "לאגר": return { boxes: 252, kegs: 85 };
        case "חיטה": return { boxes: 252, kegs: 70 };
        default: return null;
      }
    }

    switch (beerStyle) {
      case "IPA": return { boxes: 150, kegs: 252 };
      case "פייל": return { boxes: 252, kegs: 160 };
      case "הופי לאגר": return { boxes: 252, kegs: 180 };
      case "לאגר": return { boxes: 252, kegs: 185 };
      case "חיטה": return { boxes: 252, kegs: 170 };
      default: return null;
    }
  }

  return null;
}

function calendarParseSummary_(text) {
  if (!text) return null;

  const original = String(text).trim();
  let actionType = null;

  if (/הורדת/.test(original)) actionType = "הורדה";
  else if (/ביקבוק/.test(original)) actionType = "ביקבוק";
  else if (/סיום/.test(original)) actionType = "סיום";
  else if (/אריזה/.test(original)) actionType = "אריזה";

  if (!actionType) return null;

  let unit = null;
  const unitMatch = original.match(/(חביות|בקבוקים|בקבוק|ארגזים|ארגז|בזאר)/);
  if (unitMatch) unit = unitMatch[1];
  if (!unit && actionType === "ביקבוק") unit = "ארגזים";

  const itemMatch = original.match(
    /(הופי\s+לאגר\s*מ?\d+|פייל\s*מ?\d+|IPA\s*מ?\d+|חיטה\s*מ?\d+|סטאוט\s*מ?\d+|לאגר\s*מ?\d+|ביר בזאר)/i
  );

  const itemType = itemMatch ? itemMatch[1] : null;
  let tankNumber = null;

  if (itemType) {
    const tankMatch = itemType.match(/\d+/);
    if (tankMatch) {
      const parsedTank = parseInt(tankMatch[0], 10);
      if (parsedTank >= 2 && parsedTank <= 19) tankNumber = parsedTank;
    }
  }

  let quantity = null;
  const directQtyMatch =
    original.match(/(\d+)\s*(?:חביות|בקבוקים|בקבוק|ארגזים|ארגז|בזאר)/) ||
    original.match(/(?:חביות|בקבוקים|בקבוק|ארגזים|ארגז|בזאר)\s*(\d+)/);

  if (directQtyMatch) {
    quantity = parseInt(directQtyMatch[1], 10);
  } else {
    let cleaned = original;
    if (itemType) cleaned = cleaned.replace(itemType, "");
    cleaned = cleaned.replace(/(?:הורדת|הורדה|ביקבוק|סיום|אריזה)/g, "");

    const numbers = cleaned.match(/\d+/g);
    if (numbers) {
      for (let i = 0; i < numbers.length; i++) {
        const number = parseInt(numbers[i], 10);
        if (number !== tankNumber) {
          quantity = number;
          break;
        }
      }
    }
  }

  return {
    actionType: actionType,
    tankNumber: tankNumber,
    itemType: itemType,
    unit: unit,
    quantity: quantity
  };
}

function calendarWriteEventToFirestore_(projectId, eventId, data) {
  const url =
    "https://firestore.googleapis.com/v1/projects/" + projectId +
    "/databases/(default)/documents/calendar_events/" +
    encodeURIComponent(eventId);

  const response = UrlFetchApp.fetch(url, {
    method: "patch",
    contentType: "application/json",
    headers: {
      Authorization: "Bearer " + ScriptApp.getOAuthToken()
    },
    payload: JSON.stringify({
      fields: calendarToFirestoreFields_(data)
    }),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error(
      "Calendar Firestore write failed for event " + eventId +
      ": " + code + " " + response.getContentText()
    );
  }
}

function calendarToFirestoreFields_(obj) {
  const fields = {};

  Object.keys(obj || {}).forEach(function (key) {
    const value = obj[key];

    if (value === null || value === undefined) {
      fields[key] = { nullValue: null };
    } else if (typeof value === "number") {
      fields[key] = Number.isInteger(value)
        ? { integerValue: value }
        : { doubleValue: value };
    } else if (typeof value === "boolean") {
      fields[key] = { booleanValue: value };
    } else {
      fields[key] = { stringValue: String(value) };
    }
  });

  return fields;
}

function cleanOldCalendarEvents() {
  const cutoffTimestamp =
    Date.now() - (60 * 24 * 60 * 60 * 1000);

  const queryUrl =
    "https://firestore.googleapis.com/v1/projects/" + FIREBASE_PROJECT_ID +
    "/databases/(default)/documents:runQuery";

  const response = UrlFetchApp.fetch(queryUrl, {
    method: "post",
    contentType: "application/json",
    headers: {
      Authorization: "Bearer " + ScriptApp.getOAuthToken()
    },
    payload: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "calendar_events" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "timestamp" },
            op: "LESS_THAN",
            value: { integerValue: cutoffTimestamp }
          }
        }
      }
    }),
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    throw new Error(
      "Calendar cleanup query failed: " + response.getContentText()
    );
  }

  const results = JSON.parse(response.getContentText());
  const writes = [];

  results.forEach(function (result) {
    if (result.document && result.document.name) {
      writes.push({ delete: result.document.name });
    }
  });

  if (!writes.length) {
    Logger.log("Calendar cleanup: no events older than 60 days.");
    return { deletedCount: 0 };
  }

  const commitUrl =
    "https://firestore.googleapis.com/v1/projects/" + FIREBASE_PROJECT_ID +
    "/databases/(default)/documents:commit";

  const commitResponse = UrlFetchApp.fetch(commitUrl, {
    method: "post",
    contentType: "application/json",
    headers: {
      Authorization: "Bearer " + ScriptApp.getOAuthToken()
    },
    payload: JSON.stringify({ writes: writes }),
    muteHttpExceptions: true
  });

  const code = commitResponse.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error(
      "Calendar cleanup commit failed: " + code + " " +
      commitResponse.getContentText()
    );
  }

  Logger.log("Calendar cleanup deleted " + writes.length + " event(s).");
  return { deletedCount: writes.length };
}
