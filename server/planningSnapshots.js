// ============================================================
// PLANNING CHECKPOINT SNAPSHOTS — APPS SCRIPT / FREE TIER
// ============================================================
// Replaces the Firebase scheduled functions that require a Blaze billing plan.
// The existing five-minute Apps Script maintenance trigger calls
// runDuePlanningSnapshots_(). Snapshot IDs are immutable/idempotent, so running
// the check every five minutes is cheap: outside the due windows it returns
// immediately; after a successful checkpoint a ScriptProperty suppresses work.
//
// Semantics intentionally match the former Firebase Functions implementation:
// - Friday 12:00 Asia/Jerusalem -> lead1..lead4 snapshots.
// - Sunday 00:00 Asia/Jerusalem -> opening snapshot.
// - The snapshot uses the exact scheduled cutoff, not the later polling time.
// - A historical revision at/before the cutoff wins over a newer live document.
// ============================================================

const PLANNING_SNAPSHOT_TIME_ZONE_ = "Asia/Jerusalem";
const PLANNING_SNAPSHOT_PROPERTY_PREFIX_ = "planning_snapshot_v3:";

function planningDateKey_(date) {
  return Utilities.formatDate(date, PLANNING_SNAPSHOT_TIME_ZONE_, "yyyy-MM-dd");
}

function planningTimeKey_(date) {
  return Utilities.formatDate(date, PLANNING_SNAPSHOT_TIME_ZONE_, "HH:mm");
}

function planningWeekday_(dateKey) {
  return new Date(dateKey + "T12:00:00Z").getUTCDay();
}

function planningAddDays_(dateKey, days) {
  const value = new Date(dateKey + "T12:00:00Z");
  value.setUTCDate(value.getUTCDate() + Number(days || 0));
  return value.toISOString().slice(0, 10);
}

// Convert a Jerusalem wall-clock time to its UTC instant without hard-coding
// +02/+03, so checkpoint cutoffs stay correct across Israeli DST transitions.
function planningJerusalemInstant_(dateKey, hour, minute) {
  const parts = String(dateKey).split("-").map(Number);
  if (parts.length !== 3 || parts.some(function (part) { return !Number.isFinite(part); })) {
    throw new Error("Invalid planning date: " + dateKey);
  }

  const wallUtc = Date.UTC(parts[0], parts[1] - 1, parts[2], hour, minute, 0, 0);
  let instant = wallUtc;

  for (let i = 0; i < 3; i++) {
    const local = Utilities.formatDate(
      new Date(instant),
      PLANNING_SNAPSHOT_TIME_ZONE_,
      "yyyy-MM-dd-HH-mm-ss"
    ).split("-").map(Number);

    const representedAsUtc = Date.UTC(
      local[0],
      local[1] - 1,
      local[2],
      local[3],
      local[4],
      local[5],
      0
    );

    const offset = representedAsUtc - instant;
    const next = wallUtc - offset;
    if (next === instant) break;
    instant = next;
  }

  return new Date(instant);
}

function planningSnapshotTargets_(dateKey, opening) {
  const weekday = planningWeekday_(dateKey);

  if (opening) {
    if (weekday !== 0) throw new Error("Opening checkpoint must be Sunday");
    return [{ targetWeek: dateKey, checkpoint: "opening" }];
  }

  if (weekday !== 5) throw new Error("Advance checkpoint must be Friday");
  return [1, 2, 3, 4].map(function (lead) {
    return {
      targetWeek: planningAddDays_(dateKey, 2 + (lead - 1) * 7),
      checkpoint: "lead" + lead
    };
  });
}

function planningFirestoreBase_(projectId) {
  return "https://firestore.googleapis.com/v1/projects/" +
    encodeURIComponent(projectId) +
    "/databases/(default)/documents";
}

function planningFirestoreFetch_(url, options) {
  const request = Object.assign({}, options || {});
  request.headers = Object.assign({}, request.headers || {}, {
    Authorization: "Bearer " + ScriptApp.getOAuthToken()
  });
  request.muteHttpExceptions = true;
  return UrlFetchApp.fetch(url, request);
}

function planningDecodeValue_(value) {
  if (!value || typeof value !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(value, "nullValue")) return null;
  if (Object.prototype.hasOwnProperty.call(value, "stringValue")) return value.stringValue;
  if (Object.prototype.hasOwnProperty.call(value, "booleanValue")) return value.booleanValue === true;
  if (Object.prototype.hasOwnProperty.call(value, "integerValue")) return Number(value.integerValue);
  if (Object.prototype.hasOwnProperty.call(value, "doubleValue")) return Number(value.doubleValue);
  if (Object.prototype.hasOwnProperty.call(value, "timestampValue")) return new Date(value.timestampValue);
  if (Object.prototype.hasOwnProperty.call(value, "arrayValue")) {
    return ((value.arrayValue || {}).values || []).map(planningDecodeValue_);
  }
  if (Object.prototype.hasOwnProperty.call(value, "mapValue")) {
    return planningDecodeFields_((value.mapValue || {}).fields || {});
  }
  return null;
}

function planningDecodeFields_(fields) {
  const result = {};
  Object.keys(fields || {}).forEach(function (key) {
    result[key] = planningDecodeValue_(fields[key]);
  });
  return result;
}

function planningEncodeValue_(value) {
  if (value === undefined || value === null) return { nullValue: null };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { nullValue: null };
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (typeof value === "string") return { stringValue: value };
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(planningEncodeValue_) } };
  }
  if (typeof value === "object") {
    return { mapValue: { fields: planningEncodeFields_(value) } };
  }
  return { stringValue: String(value) };
}

function planningEncodeFields_(object) {
  const fields = {};
  Object.keys(object || {}).forEach(function (key) {
    if (object[key] === undefined) return;
    fields[key] = planningEncodeValue_(object[key]);
  });
  return fields;
}

function planningGetDocument_(projectId, collectionName, documentId) {
  const url = planningFirestoreBase_(projectId) +
    "/" + encodeURIComponent(collectionName) +
    "/" + encodeURIComponent(documentId);
  const response = planningFirestoreFetch_(url, { method: "get" });
  const code = response.getResponseCode();
  if (code === 404) return null;
  if (code < 200 || code >= 300) {
    throw new Error(
      "Planning Firestore get failed " + collectionName + "/" + documentId +
      ": HTTP " + code + " " + response.getContentText()
    );
  }
  const document = JSON.parse(response.getContentText());
  return planningDecodeFields_(document.fields || {});
}

function planningListRevisions_(projectId, collectionName, documentId) {
  const rows = [];
  let pageToken = "";

  do {
    let url = planningFirestoreBase_(projectId) +
      "/" + encodeURIComponent(collectionName) +
      "/" + encodeURIComponent(documentId) +
      "/revisions?pageSize=100";
    if (pageToken) url += "&pageToken=" + encodeURIComponent(pageToken);

    const response = planningFirestoreFetch_(url, { method: "get" });
    const code = response.getResponseCode();
    if (code === 404) return rows;
    if (code < 200 || code >= 300) {
      throw new Error(
        "Planning revisions list failed " + collectionName + "/" + documentId +
        ": HTTP " + code + " " + response.getContentText()
      );
    }

    const parsed = JSON.parse(response.getContentText() || "{}");
    (parsed.documents || []).forEach(function (document) {
      rows.push(planningDecodeFields_(document.fields || {}));
    });
    pageToken = parsed.nextPageToken || "";
  } while (pageToken);

  return rows;
}

function planningMillis_(value) {
  if (value instanceof Date) return value.getTime();
  if (value && typeof value === "object" && typeof value.seconds === "number") {
    return value.seconds * 1000;
  }
  if (typeof value === "string") {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

function planningSelectVersion_(revisions, live, cutoff) {
  const cutoffMs = cutoff.getTime();
  const eligible = (revisions || [])
    .filter(function (revision) {
      const updated = planningMillis_(revision.updatedAt);
      return Number.isFinite(updated) && updated <= cutoffMs;
    })
    .sort(function (a, b) {
      const timeDiff = planningMillis_(b.updatedAt) - planningMillis_(a.updatedAt);
      if (timeDiff !== 0) return timeDiff;
      return Number(b.revision || 0) - Number(a.revision || 0);
    });

  if (eligible.length > 0) return { state: "captured", value: eligible[0] };
  if (!live) return { state: "no-plan", value: null };

  const liveUpdated = planningMillis_(live.updatedAt);
  if (Number.isFinite(liveUpdated) && liveUpdated <= cutoffMs) {
    return { state: "captured", value: live };
  }

  const liveCreated = planningMillis_(live.createdAt);
  if (Number.isFinite(liveCreated) && liveCreated > cutoffMs) {
    return { state: "no-plan", value: null };
  }

  return { state: "history-unavailable", value: null };
}

function planningAsOf_(projectId, collectionName, documentId, cutoff) {
  const revisions = planningListRevisions_(projectId, collectionName, documentId);
  const live = planningGetDocument_(projectId, collectionName, documentId);
  return planningSelectVersion_(revisions, live, cutoff);
}

function planningCreateSnapshotIfMissing_(projectId, snapshotId, payload) {
  const url = planningFirestoreBase_(projectId) +
    "/planningSnapshots/" + encodeURIComponent(snapshotId) +
    "?currentDocument.exists=false";
  const response = planningFirestoreFetch_(url, {
    method: "patch",
    contentType: "application/json",
    payload: JSON.stringify({ fields: planningEncodeFields_(payload) })
  });
  const code = response.getResponseCode();

  // Another retry/execution already created the immutable checkpoint.
  if (code === 409 || code === 412) return false;
  if (code < 200 || code >= 300) {
    throw new Error(
      "Planning snapshot create failed " + snapshotId +
      ": HTTP " + code + " " + response.getContentText()
    );
  }
  return true;
}

function planningCaptureCheckpoint_(projectId, dateKey, opening, cutoff) {
  const targets = planningSnapshotTargets_(dateKey, opening);
  const settings = planningAsOf_(projectId, "planningSettings", "main", cutoff);
  const stats = { created: 0, existing: 0, points: targets.length };

  targets.forEach(function (point) {
    const snapshotId = point.targetWeek + "__" + point.checkpoint;

    // Cheap idempotency check before loading a potentially long revision history.
    if (planningGetDocument_(projectId, "planningSnapshots", snapshotId)) {
      stats.existing++;
      return;
    }

    const plan = planningAsOf_(projectId, "planningWeeks", point.targetWeek, cutoff);
    const created = planningCreateSnapshotIfMissing_(projectId, snapshotId, {
      targetWeek: point.targetWeek,
      checkpoint: point.checkpoint,
      state: plan.state,
      plan: plan.value,
      settings: settings.value,
      settingsState: settings.state,
      scheduledFor: cutoff,
      capturedAt: new Date(),
      schemaVersion: 2
    });

    if (created) stats.created++;
    else stats.existing++;
  });

  return stats;
}

function runDuePlanningSnapshots_(projectId, now) {
  projectId = projectId || FIREBASE_PROJECT_ID;
  now = now instanceof Date ? now : new Date();

  const dateKey = planningDateKey_(now);
  const weekday = planningWeekday_(dateKey);
  const timeKey = planningTimeKey_(now);
  let opening = null;
  let advance = null;
  const props = PropertiesService.getScriptProperties();

  if (weekday === 0) {
    const propertyKey = PLANNING_SNAPSHOT_PROPERTY_PREFIX_ + "opening:" + dateKey;
    if (props.getProperty(propertyKey) !== "1") {
      const cutoff = planningJerusalemInstant_(dateKey, 0, 0);
      opening = planningCaptureCheckpoint_(projectId, dateKey, true, cutoff);
      props.setProperty(propertyKey, "1");
      Logger.log("Planning opening snapshot: " + JSON.stringify(opening));
    }
  }

  if (weekday === 5 && timeKey >= "12:00") {
    const propertyKey = PLANNING_SNAPSHOT_PROPERTY_PREFIX_ + "advance:" + dateKey;
    if (props.getProperty(propertyKey) !== "1") {
      const cutoff = planningJerusalemInstant_(dateKey, 12, 0);
      advance = planningCaptureCheckpoint_(projectId, dateKey, false, cutoff);
      props.setProperty(propertyKey, "1");
      Logger.log("Planning lead snapshots: " + JSON.stringify(advance));
    }
  }

  return { date: dateKey, opening: opening, advance: advance };
}
