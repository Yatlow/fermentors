import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  automaticIgnoredRecommendationsForTank,
  partitionAutomaticallyIgnoredRecommendations,
} from "../src/SERVICES/cellering/autoIgnoredCellarRecommendations";

const friday = "2026-10-30";
const fridayReason = "התעלמות אוטומטית - יום שישי";
const saturdayReason = "התעלמות אוטומטית - יום שבת";

test("weekend-suppressed retest and neglect are visible as dated auto-ignored entries", () => {
  const rows = automaticIgnoredRecommendationsForTank({
    tankNumber: 17,
    batchNumber: "#1621",
    ignoredDate: friday,
    recommendations: {
      requiresCarbTest: { req: false, importance: 2, reason: "יש לבצע בדיקת גיזוז חוזרת", autoIgnoredReason: fridayReason },
      neglectedStatus: { req: false, importance: 3, reason: "המיכל מוזנח", autoIgnoredReason: fridayReason },
    },
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.recommendationKey), ["carbTest", "neglectedStatus"]);
  assert.deepEqual(rows.map((row) => row.autoReason), [fridayReason, fridayReason]);
  assert.deepEqual(rows.map((row) => row.importance), [2, 3]);
  assert.equal(rows[0].detail, "יש לבצע בדיקת גיזוז חוזרת");
  assert.equal(rows[0].batchNumber, "1621");
  assert.equal(rows[0].ignoredDate, friday);
  assert.match(rows[0].id, /^auto:2026-10-30:17:1621:carbTest$/);
});

test("Saturday neglected tank is auto-ignored, but ordinary recommendations are not", () => {
  const rows = automaticIgnoredRecommendationsForTank({
    tankNumber: 19,
    batchNumber: 1602,
    ignoredDate: "2026-10-31",
    recommendations: {
      requiresCarbTest: { req: true, importance: 3, reason: "מומלץ גיזוז", autoIgnoredReason: null },
      neglectedStatus: { req: false, importance: 2, reason: "נדרש טיפול", autoIgnoredReason: saturdayReason },
    },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].recommendationKey, "neglectedStatus");
  assert.equal(rows[0].autoReason, saturdayReason);
  assert.deepEqual(automaticIgnoredRecommendationsForTank({
    tankNumber: 19, batchNumber: "1602", ignoredDate: friday, recommendations: null,
  }), []);
});

test("operator restoring an automatic ignore exposes it without treating it as performed", () => {
  const rows = automaticIgnoredRecommendationsForTank({
    tankNumber: 3,
    batchNumber: 1601,
    ignoredDate: friday,
    recommendations: {
      requiresCarbTest: { importance: 2, reason: "בדיקת גיזוז חוזרת", autoIgnoredReason: fridayReason },
      neglectedStatus: { importance: 3, reason: "הזנחת מיכל", autoIgnoredReason: fridayReason },
    },
  });
  assert.deepEqual(partitionAutomaticallyIgnoredRecommendations(rows, new Set()), {
    ignored: rows, restored: [],
  });
  const { ignored, restored } = partitionAutomaticallyIgnoredRecommendations(rows, new Set([rows[0].id]));
  assert.deepEqual(ignored, [rows[1]]);
  assert.deepEqual(restored, [rows[0]]);
  assert.equal(restored[0].importance, 2);
  assert.equal(restored[0].detail, "בדיקת גיזוז חוזרת");
});

test("restoring in the dashboard makes the normal actionable alert and updates KPI", () => {
  const source = readFileSync("src/components/dashboard/HealthDashboard.tsx", "utf8");
  assert.match(source, /partitionAutomaticallyIgnoredRecommendations\(autoCandidates, restoredAutoIds\)/);
  assert.match(source, /\.\.\.autoRestored\.map\(\(row\) => \(\{/);
  assert.match(source, /autoRestored\.some\(\(row\) => row\.recommendationKey === "carbTest"\)/);
  assert.match(source, /onClick=\{\(\) => row\.autoReason \? restoreAutomatic\(row\) : void restoreIgnored\(row\)\}/);
  assert.match(source, /row\.ignoredDate !== today/);
  assert.match(source, /sessionStorage\.setItem/);
  // A manual ignore remains a Firestore write; the automatic path must not be one.
  const autoModule = readFileSync("src/SERVICES/cellering/autoIgnoredCellarRecommendations.ts", "utf8");
  assert.doesNotMatch(autoModule, /setDoc|updateDoc|deleteDoc|firebase\/firestore/);
});

test("Friday severity 3 remains actionable while moderate retests enter auto-ignore", () => {
  const source = readFileSync("src/SERVICES/cellering/calculateCelleringRecomendations.ts", "utf8");
  assert.match(source, /if \(retestPolicy\.due && shouldRecommendCarbonationRetestOnDate\(todayDate, lastCarbSpec\.importance\)\)/);
  assert.match(source, /retestPolicy\.due && !shouldRecommendCarbonationRetestOnDate\(todayDate, lastCarbSpec\.importance\)/);
  assert.match(source, /autoIgnoredReason: coldNeglect !== null && \(today === 5 \|\| today === 6\)/);
});
