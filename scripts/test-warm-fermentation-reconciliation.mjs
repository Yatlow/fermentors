import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createHash } from "node:crypto";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
function sheetRows(name) {
  if (name === "1606") return [
    ["סוג:", "סטאוט", "מס' מיכל:", "3", "אצווה:", "1606"],
    ["תאריך", "שעה", "סוכר", "טמפרטורה", "לחץ", "pH", "גיזוז", "פעולה"],
    ["23/10/2026", "14:40", "4.20°P", "18.9°C", "1.47Bar", "4.26", "", "קירור מיכל ל0.3°"],
    ["09/11/2026", "06:51", null, "0.5°C", "0.72Bar", null, null, "הורדת 3034 בקבוקים"],
    [],
    ["15/11/26", null, null, null, null, null, null, "pH 4.41 ,  בדיקת תסיסה חמה, סוכר 4.1°"],
  ];
  return [
    ["סוג:", "הופי לאגר", "מס' מיכל:", "18", "אצווה:", "1612"],
    ["תאריך", "שעה", "סוכר", "טמפרטורה", "לחץ", "pH", "גיזוז", "פעולה"],
    ["03/11/2026", "15:22", "", "", "", "", "", "נלקחה בדיקת תסיסה חמה לשייקר"],
    ["08/11/2026", "9:07", "7.10°P", "10.1°C", "0.00Bar", "4.39", "", "בדיקת תסיסה חמה על 2.6 p | חימום מיכל ל14° למנוחת דיאציטיל"],
    ["15/11/2026", "8:39", "2.80°P", "13.9°C", "1.04Bar", "4.38", "", "הורדת 8 דליי שמרים"],
  ];
}
function context() {
  const propsData = new Map();
  const commits = [];
  const filesRead = [];
  const propertyStore = {
    getProperty: k => propsData.get(k) ?? null,
    setProperty: (k,v) => {propsData.set(k, String(v));},
    deleteProperty: k => {propsData.delete(k);},
  };
  const dateFmt = (date, _zone, fmt) => {
    const p = v => String(v).padStart(2, "0");
    return fmt === "dd/MM/yyyy" ? p(date.getDate()) + "/" + p(date.getMonth() + 1) + "/" + date.getFullYear() : "x";
  };
  const valuesById = { s1606: sheetRows("1606"), s1612: sheetRows("1612") };
  const scope = {
    console, Date, String, Number, Boolean, Array, Object, Math, JSON, Error, isFinite, encodeURIComponent,
    BREW_FOLDER_ID: "root-brew-folder", FIREBASE_PROJECT_ID: "demo",
    WFR_TEST_VALUES: valuesById,
    FC_CYCLE_CONTEXT_: { io: {firestoreWrites: 0} },
    PropertiesService: {getScriptProperties: () => propertyStore},
    Utilities: {
      DigestAlgorithm: {SHA_256: "sha256"}, Charset: {UTF_8:"UTF8"},
      computeDigest: (_alg, v) => Array.from(createHash("sha256").update(v).digest()),
      formatDate: dateFmt,
    },
    parseIsraeliDate: str => {
      const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(str);
      if (!m) return null;
      const year = Number(m[3]) + (Number(m[3]) < 100 ? 2000 : 0);
      return new Date(year, Number(m[2])-1, Number(m[1]));
    },
    extractSpreadsheetId: s => String(s).replace(/^.*?\/d\//, "").replace(/\/edit.*/, ""),
    toFirestoreFields: obj => obj,
    ScriptApp: {getOAuthToken: () => "test-token"},
    UrlFetchApp: { fetch: (_url, options) => {
      assert.equal(options.method, "post");
      commits.push(JSON.parse(options.payload));
      return {getResponseCode:()=>200, getContentText:()=>""};
    } },
    fcSheetSnapshot_: id => {
      filesRead.push(id);
      return {values: valuesById[id]};
    },
    DriveApp: {getFileById: () => ({getLastUpdated:()=>new Date("2026-11-15T10:00:00Z")})},
    Drive: {Files: {list: () => ({
      files: [
        {id:"s1606", modifiedTime:"2026-11-15T09:30:00Z"},
        {id:"s1612", modifiedTime:"2026-11-15T09:20:00Z"}
      ]
    })}},
    Logger: {log: () => {}},
  };
  runInNewContext(read("../server/warmFermentationReconciliation.js"), scope);
  return {scope,propsData,commits,filesRead};
}

test("1606: archived warm test parses both sugar and explicit incubator pH", () => {
  const {scope} = context();
  const parsed = scope.wfrParseNote_("pH 4.41 ,  בדיקת תסיסה חמה, סוכר 4.1°");
  assert.equal(parsed.plato,4.1);
  assert.equal(parsed.pH,4.41);
  const events = scope.wfrSheetEvents_(sheetRows("1606"),"s1606","1606");
  assert.equal(events.length,1);
  assert.equal(events[0].plato,4.1);
  assert.equal(events[0].pH,4.41);
  assert.equal(events[0].coolingPlato,4.2);
  assert.equal(events[0].packaged,true);
  assert.equal(events[0].recordedDate,"15/11/2026");
  assert.equal(events[0].recordedTime,null);
});

test("1612: incubator 2.6P is recognized; routine pH 4.39 is NOT misattributed", () => {
  const {scope} = context();
  const events = scope.wfrSheetEvents_(sheetRows("1612"),"s1612","1612");
  assert.equal(events.length,1);
  assert.equal(events[0].plato,2.6);
  assert.equal(events[0].pH,null);
  assert.equal(events[0].packaged,false);
  assert.equal(events[0].recordedTime,"09:07");
  assert.equal(scope.wfrParseNote_("נלקחה בדיקת תסיסה חמה לשייקר"),null);
  assert.equal(scope.wfrParseNote_("בדיקת תסיסה חמה 2.6°P, pH 4.39 [בדיקת-תסיסה:warm-test-123]").receiptId,"warm-test-123");
});

test("reconcile uses fixed source-based ID, never reads Firestore and is idempotent across sheet changes", () => {
  const {scope,commits,filesRead} = context();
  const active = {id:"tank18",updateTime:"2026-11-15T08:00:00Z",data:{action:1,batchNumber:"1612"}};
  const s1 = scope.wfrReconcileSheet_("demo","s1612","1612",active,"111");
  assert.equal(s1.wrote,1);
  assert.equal(commits.length,1);
  assert.equal(commits[0].writes.length,2); // batch history + active snapshot
  assert.match(commits[0].writes[0].update.name,/brews\/1612\/warmFermentationTests\/sheet-/);
  assert.match(commits[0].writes[1].update.name,/fermentors\/tank18/);
  assert.equal(commits[0].writes[1].currentDocument.updateTime,"2026-11-15T08:00:00Z");
  assert.equal(active.data.warmFermentationTest.plato,2.6);
  assert.equal(scope.wfrReconcileSheet_("demo","s1612","1612",active,"111").skipped,true);
  assert.equal(scope.wfrReconcileSheet_("demo","s1612","1612",active,"222").wrote,0);
  assert.equal(commits.length,1);
  assert.equal(filesRead.length,2, "one in-memory Sheet access per changed revision; no extra Firebase reads");
});

test("historical discovery runs once hourly using Drive metadata and writes only real events", () => {
  const {scope,commits,filesRead} = context();
  const first = scope.wfrRecentSheetsMaintenance_("demo",[],new Date("2026-11-15T10:00:00Z"));
  assert.equal(first.due,true);
  assert.equal(commits.length,2);
  assert.equal(commits[0].writes.length,1);
  assert.equal(commits[1].writes.length,1);
  assert.deepEqual(filesRead,["s1606","s1612"]);
  assert.equal(scope.wfrRecentSheetsMaintenance_("demo",[],new Date("2026-11-15T10:05:00Z")).due,false);
  assert.equal(commits.length,2);
});

test("two incubator reports appended to one day's notes remain distinct, timestamped and reversible", () => {
  const {scope,commits}=context();
  const sheet=scope.WFR_TEST_VALUES.s1612;
  const id1="warm-fermentation-test-one";
  const id2="warm-fermentation-test-two";
  sheet.push(["15/11/2026","08:00",null,null,null,null,null,
    "בדיקת תסיסה חמה 2.8°P, pH 4.20 [בדיקת-תסיסה:" + id1 + "] (בשעה 09:10)" +
    " | בדיקת תסיסה חמה 2.6°P, pH 4.30 [בדיקת-תסיסה:" + id2 + "] (בשעה 12:40)"]);
  const events=scope.wfrSheetEvents_(sheet,"s1612","1612");
  assert.equal(events.length,3);
  const one=events.find(e=>e.eventId===id1);
  const two=events.find(e=>e.eventId===id2);
  assert.equal(one.plato,2.8);
  assert.equal(two.pH,4.3);
  assert.equal(one.recordedTime,"09:10");
  assert.equal(two.recordedTime,"12:40");
  scope.wfrRememberWrittenTest_("s1612",id1);
  scope.wfrRememberWrittenTest_("s1612",id2);
  const active={
    id:"tank18",updateTime:"2026-11-15T13:00:00Z",
    data:{action:1,batchNumber:"1612",warmFermentationTest:{
      requestId:id2,recordedAt:"2026-11-15T12:40:00.000Z",plato:2.6,batchNumber:"1612"}}
  };
  scope.wfrReconcileSheet_("demo","s1612","1612",active,"multi-1");
  assert.equal(commits.length,1, "only historic 1612 result needs importing");
  // Remove ONLY second report; first report must survive.
  sheet.at(-1)[7]=sheet.at(-1)[7].split(" | ")[0];
  active.updateTime="2026-11-15T13:01:00Z";
  const removed=scope.wfrReconcileSheet_("demo","s1612","1612",active,"multi-2");
  assert.equal(removed.removed,1);
  assert.equal(commits.at(-1).writes.length,2);
  assert.match(commits.at(-1).writes[0].delete,/warm-fermentation-test-two$/);
  assert.equal(active.data.warmFermentationTest.requestId,id1);
  assert.equal(active.data.warmFermentationTest.plato,2.8);
});

test("later app test replaces active value; deleting Sheet note restores previous test", () => {
  const {scope,commits} = context();
  const active = {
    id:"tank18", updateTime:"2026-11-15T08:00:00Z",
    data:{action:1,batchNumber:"1612"}
  };
  // First import the legacy handwritten result (2.6 P).
  scope.wfrReconcileSheet_("demo","s1612","1612",active,"rev1");
  const oldId = active.data.warmFermentationTest.eventId;
  assert.equal(active.data.warmFermentationTest.plato,2.6);
  assert.equal(commits.length,1);

  // The app writes a newer result and the Sheet note is tagged with the
  // SAME requestId as the existing Firestore document.
  const testId = "warm-fermentation-test-123";
  scope.wfrRememberWrittenTest_("s1612",testId);
  const sheet = scope.WFR_TEST_VALUES.s1612;
  const note = "בדיקת תסיסה חמה 2.5°P, pH 4.44 [בדיקת-תסיסה:" + testId + "]";
  sheet.push(["15/11/2026","12:00",null,null,null,null,null,note]);
  active.data.warmFermentationTest = {requestId:testId,recordedAt:"2026-11-15T12:00:29.000Z",plato:2.5,pH:4.44,batchNumber:"1612"};
  active.updateTime="2026-11-15T12:00:30.000Z";
  const append = scope.wfrReconcileSheet_("demo","s1612","1612",active,"rev2");
  assert.equal(append.wrote,0, "same tagged app test must not create duplicate Firestore record");
  assert.equal(commits.length,1);

  // The operator removes that note from the Sheet. Next changed-revision
  // maintenance deletes the app document AND restores the old test (2.6).
  sheet.pop();
  active.updateTime="2026-11-15T12:05:00.000Z";
  const removed=scope.wfrReconcileSheet_("demo","s1612","1612",active,"rev3");
  assert.equal(removed.removed,1);
  const last=commits.at(-1).writes;
  assert.equal(last.length,2);
  assert.match(last[0].delete,new RegExp("warmFermentationTests/" + testId + "$"));
  assert.equal(active.data.warmFermentationTest.plato,2.6);
  assert.equal(active.data.warmFermentationTest.eventId,oldId);

  // After deleting the remaining manual test, no result should influence
  // cooling. The field is deleted with an updateTime precondition.
  sheet[3][7]="";
  active.updateTime="2026-11-15T12:08:00.000Z";
  const final=scope.wfrReconcileSheet_("demo","s1612","1612",active,"rev4");
  assert.equal(final.removed,1);
  assert.equal(active.data.warmFermentationTest,undefined);
  const clear=commits.at(-1).writes.at(-1);
  assert.deepEqual(Array.from(clear.updateMask.fieldPaths),["warmFermentationTest","warmFermentationTestUpdatedAt"]);
  assert.equal(clear.currentDocument.updateTime,"2026-11-15T12:08:00.000Z");
});

test("immediate delete before the first maintenance pass still clears app result", () => {
  const {scope,commits}=context();
  const id="warm-fermentation-test-quick";
  scope.wfrRememberWrittenTest_("s1612",id);
  const active={
    id:"tank18",updateTime:"2026-11-15T13:00:00.000Z",
    data:{action:1,batchNumber:"1612",
      warmFermentationTest:{requestId:id,batchNumber:"1612",plato:1.2,recordedAt:"2026-11-15T12:59:00.000Z"}}
  };
  const result=scope.wfrReconcileSheet_("demo","s1612","1612",active,"revA");
  assert.equal(result.removed,1);
  assert.equal(commits.length,1);
  assert.equal(active.data.warmFermentationTest.plato,2.6);
});

test("optional pH remains separate from currentData and Sheet daily pH column", () => {
  const ui = read("../src/components/cellering/WarmFermentationTest.tsx");
  assert.match(ui,/pH לאחר הדגרה \(לא חובה\)/);
  assert.match(ui,/pH: testPH/);
  const script = read("../server/warmFermentationTest.js");
  assert.match(script,/test\.pH/);
  assert.match(script,/\[בדיקת-תסיסה:/);
  const store = read("../src/SERVICES/cellering/warmFermentationTestStore.ts");
  assert.match(store,/pH: input\.pH \?\? null/);
  assert.doesNotMatch(store,/currentData\.pH\s*=/);
  const cycle = read("../server/fermentor-cycle-optimization.js");
  assert.match(cycle,/wfrReconcileSheet_\(/);
  assert.match(cycle,/wfrRecentSheetsMaintenance_\(/);
  const rules = read("../firestore.rules");
  assert.match(rules,/request\.resource\.data\.pH is number/);
});
