/* Weekly Saturday-night shipment reservation reconciliation.
 * Runs only in the existing 5-minute fermentor maintenance cycle.
 * Operator/legacy flags (without autoReservationWeek) are never cleared.
 */
var SR_WEEK_KEY_PREFIX_ = "shipment_reconciled_week_v1:";
function srDocValue_(v) {
  if (!v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(srDocValue_);
  if ("mapValue" in v) {
    var result = {};
    Object.keys(v.mapValue.fields || {}).forEach(function(k) { result[k] = srDocValue_(v.mapValue.fields[k]); });
    return result;
  }
  return null;
}
function srDecode_(doc) {
  var result = {name: doc.name, updateTime: doc.updateTime};
  Object.keys(doc.fields || {}).forEach(function(k) { result[k] = srDocValue_(doc.fields[k]); });
  return result;
}
function srFetch_(url, method, payload) {
  var opts = {method: method || "get", muteHttpExceptions: true,
    headers: {Authorization: "Bearer " + ScriptApp.getOAuthToken()}};
  if (payload) { opts.contentType = "application/json"; opts.payload = JSON.stringify(payload); }
  var resp = UrlFetchApp.fetch(url, opts);
  var status = resp.getResponseCode();
  if (status < 200 || status >= 300) throw new Error("Shipment weekly Firestore " + status + ": " + resp.getContentText().slice(0,300));
  return JSON.parse(resp.getContentText() || "{}");
}
function srRoot_() {
  return "https://firestore.googleapis.com/v1/projects/" +
    encodeURIComponent(FIREBASE_PROJECT_ID) + "/databases/(default)/documents";
}
function srListPallets_() {
  var url = srRoot_() + "/pallets?pageSize=500", docs = [];
  do {
    var page = srFetch_(url);
    docs = docs.concat((page.documents || []).map(srDecode_));
    url = page.nextPageToken ? srRoot_() + "/pallets?pageSize=500&pageToken=" + encodeURIComponent(page.nextPageToken) : "";
  } while (url);
  return docs;
}
function srStyle_(raw) {
  var s = String(raw || "").toLowerCase();
  if (s.indexOf("אגסים") >= 0) return "pears";
  if (s.indexOf("מהדורת חורף") >= 0 || s.indexOf("בירת חורף") >= 0) return "winter";
  if (s.indexOf("סאוור") >= 0 || s.indexOf("סאואר") >= 0) return "sour";
  if (s.indexOf("הופי") >= 0 && s.indexOf("לאגר") >= 0) return "hoppy";
  if (s.indexOf("דאבל") >= 0 && s.indexOf("ipa") >= 0) return "doubleipa";
  if (s.indexOf("סשן") >= 0 && s.indexOf("ipa") >= 0) return "sessionipa";
  if (s.indexOf("ipa") >= 0) return "ipa";
  if (s.indexOf("פייל") >= 0) return "pale";
  if (s.indexOf("חיטה") >= 0) return "wheat";
  if (s.indexOf("סטאוט") >= 0) return "stout";
  if (s.indexOf("לאגר") >= 0) return "lager";
  return "";
}
var SR_SKUS_ = {
  "ipa__kegs":"7009940", "ipa__crates":"7009676",
  "pale__kegs":"7009939", "pale__crates":"7009670",
  "wheat__kegs":"7009941", "wheat__crates":"7009677",
  "lager__kegs":"7009942", "lager__crates":"7009678",
  "hoppy__kegs":"7013781", "hoppy__crates":"7013782",
  "stout__crates":"7009679", "winter__crates":"7009876",
  "pears__crates":"7014515", "sour__crates":"7009682",
  "sessionipa__kegs":"7010951",
  "sessionipa__crates":"7010892", "doubleipa__crates":"7009681"
};
function srSku_(p, catalog) { return catalog[srStyle_(p.beerStyle) + "__" + p.itemType] || ""; }
function srActiveCatalog_() {
  var catalog = JSON.parse(JSON.stringify(SR_SKUS_));
  var url = srRoot_() + "/productCatalog?pageSize=500";
  do {
    var page = srFetch_(url);
    (page.documents || []).map(srDecode_).forEach(function(entry) {
      var style = srStyle_(entry.styleKey || entry.beerStyle);
      if (!style || ["crates", "kegs"].indexOf(entry.itemType) < 0) return;
      var key = style + "__" + entry.itemType;
      if (entry.enabled === false) delete catalog[key];
      else if (entry.sku) catalog[key] = String(entry.sku);
    });
    url = page.nextPageToken ? srRoot_() + "/productCatalog?pageSize=500&pageToken=" +
      encodeURIComponent(page.nextPageToken) : "";
  } while (url);
  return catalog;
}
function srExpiry_(value) {
  var s = String(value || "").trim(), m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? m[3]+"-"+("0"+m[2]).slice(-2)+"-"+("0"+m[1]).slice(-2) : s;
}
function srPatch_(p, fields) {
  var encoded = {}, masks = [];
  Object.keys(fields).forEach(function(k) {
    var v = fields[k];
    encoded[k] = v === null ? {nullValue: null} :
      typeof v === "boolean" ? {booleanValue: v} : {stringValue: String(v)};
    masks.push("updateMask.fieldPaths=" + encodeURIComponent(k));
  });
  // updateTime precondition prevents overwriting a simultaneous manual decision.
  var url = "https://firestore.googleapis.com/v1/" + p.name + "?" +
    masks.join("&") + "&currentDocument.updateTime=" + encodeURIComponent(p.updateTime);
  srFetch_(url, "patch", {fields: encoded});
}
function srStackOrder_(p) {
  if (p.orderInCell != null) return Number(p.orderInCell);
  if (p.slotIndex != null) return Number(p.slotIndex);
  if (p.cellOrder != null) return Number(p.cellOrder);
  return null;
}
function srBlockedInCell_(candidate, physical, selected) {
  if (!candidate.cell) return false;
  var order = srStackOrder_(candidate);
  if (order == null) return false;
  return physical.some(function(other) {
    if (other.name === candidate.name || !other.cell || other.zone !== candidate.zone) return false;
    if (selected[other.name]) return false;
    return other.cell.side === candidate.cell.side &&
      other.cell.row === candidate.cell.row &&
      other.cell.col === candidate.cell.col &&
      srStackOrder_(other) != null && srStackOrder_(other) < order;
  });
}
function srSaturdayReconcile_() {
  var timezone = "Asia/Jerusalem", now = new Date();
  var localDay = Utilities.formatDate(now, timezone, "yyyy-MM-dd");
  var weekday = Number(Utilities.formatDate(now, timezone, "u")); // 6=Saturday
  var hour = Number(Utilities.formatDate(now, timezone, "H"));
  // Sunday-before-shift fallback recovers failures on Saturday night.
  if (!((weekday === 6 && hour >= 20) || (weekday === 7 && hour < 5))) return;
  var date = new Date(localDay + "T12:00:00Z");
  if (weekday === 6) date.setUTCDate(date.getUTCDate() + 1);
  var targetWeek = date.toISOString().slice(0,10);
  var props = PropertiesService.getScriptProperties();
  var marker = SR_WEEK_KEY_PREFIX_ + targetWeek;
  if (props.getProperty(marker) === "complete") return;
  var queueUrl = srRoot_() + "/shipmentPlanningQueue/" + targetWeek, plan;
  try { plan = srDecode_(srFetch_(queueUrl)); }
  catch (e) {
    if (String(e).indexOf(" 404:") >= 0) plan = {deliveries: []};
    else throw e;
  }
  // No legacy projections and no unidentified decisions.
  var deliveries = Number(plan.projectionVersion) === 1 ? (plan.deliveries || []) : [];
  var open = deliveries.filter(function(d) {
    return Number(d.quantity) > 0 && String(d.dispatchDate || "").slice(0,10) >= targetWeek &&
      String(d.dispatchDate || "").slice(0,10) < srAddDays_(targetWeek, 7);
  }).sort(function(a,b) {
    return String(a.dispatchDate).localeCompare(String(b.dispatchDate)) ||
      String(a.truckId || "").localeCompare(String(b.truckId || ""));
  });
  var first = open[0], truck = first ? String(first.truckId || "date:" + first.dispatchDate) : "";
  var lines = {};
  open.filter(function(d) { return String(d.truckId || "date:" + d.dispatchDate) === truck; })
    .forEach(function(d) { lines[d.productId] = (lines[d.productId] || 0) + Number(d.quantity); });
  var catalog = srActiveCatalog_();
  var pallets = srListPallets_(), tagged = [];
  pallets.forEach(function(p) {
    if (p.markedForShipment === true && p.autoReservationWeek) tagged.push(p);
  });
  var staleIds = {};
  tagged.forEach(function(p) { staleIds[p.name] = true; });
  var selected = {};
  var reservedSlots = pallets.filter(function(p) {
    return p.markedForShipment && !staleIds[p.name] && p.zone !== "shipped";
  }).length;
  Object.keys(lines).forEach(function(sku) {
    var matches = pallets.filter(function(p) {
      return p.zone !== "shipped" && Number(p.quantity) > 0 && srSku_(p, catalog) === sku;
    });
    var size = matches.length && matches[0].itemType === "crates" ? 84 : 20;
    var already = matches.filter(function(p) { return p.markedForShipment && !staleIds[p.name]; }).length;
    var missing = Math.max(0, lines[sku] - Math.min(lines[sku], already * size));
    var candidates = matches.filter(function(p) {
      return (!p.markedForShipment || staleIds[p.name]) &&
        ["cooler","pending","bottleRoom"].indexOf(p.zone) >= 0 &&
        srExpiry_(p.expiryDateStr) >= localDay;
    }).map(function(p) {
      return Object.assign({}, p, {
        id: p.name,
        // Reuse precisely the same picker contract as the React app.
        expiryDateStr: p.expiryDateStr,
        heightUnits: Number(p.heightUnits || 0),
        quantity: Number(p.quantity || 0)
      });
    });
    if (missing <= 0 || !candidates.length) return;
    var options = SharedShipmentPicking.shipmentDecisionPickOptions(candidates, missing, size);
    var best = options.filter(function(o) {
      return Number.isFinite(o.slots) && o.slots + reservedSlots <= 12;
    }).sort(function(a,b) {
      return a.missingNominal-b.missingNominal ||
        a.fefoScore-b.fefoScore || a.slots-b.slots || a.overage-b.overage;
    })[0];
    if (!best) return;
    (best.selected || []).forEach(function(p) { selected[p.name] = p; });
    reservedSlots += best.slots;
  });
  // Only changed documents are patched; retries after partial failure are safe.
  tagged.forEach(function(p) {
    if (!selected[p.name]) srPatch_(p, {markedForShipment:false, autoReservationWeek:null, autoReservationTruckId:null});
  });
  Object.keys(selected).forEach(function(id) {
    var p = selected[id];
    if (p.markedForShipment && p.autoReservationWeek === targetWeek && p.autoReservationTruckId === truck) return;
    srPatch_(p, {markedForShipment:true, autoReservationWeek:targetWeek,autoReservationTruckId:truck});
  });
  props.setProperty(marker, "complete");
  Logger.log("Saturday shipment reconciliation complete: " + targetWeek +
    ", truck=" + truck + ", released=" + tagged.length + ", selected=" + Object.keys(selected).length);
}
function srAddDays_(day, n) {
  var d = new Date(day+"T12:00:00Z");
  d.setUTCDate(d.getUTCDate()+n);
  return d.toISOString().slice(0,10);
}
