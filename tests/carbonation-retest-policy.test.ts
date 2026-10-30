import assert from "node:assert/strict";
import test from "node:test";
import { carbonationRetestDueReason, carbonationRetestPolicy, carbonationRetestPressureContext, shouldRecommendCarbonationRetestOnDate } from "../src/SERVICES/cellering/carbonationRetestPolicy";

test("out-of-spec carbonation from two days ago is due today when untreated", () => {
  const policy = carbonationRetestPolicy(
    [
      { id: "2026-09-17_0915", carbonation: 2.01 },
      { id: "2026-09-18_0910", pressure: 1.2 } as any,
      { id: "2026-09-19_0905", pressure: 1.2 } as any,
    ],
    "2026-09-19",
  );

  assert.equal(policy.lastCarbonation, 2.01);
  assert.equal(policy.waitReason, "cadence");
  assert.equal(policy.daysSinceReference, 2);
  assert.equal(policy.due, true);
});

test("ordinary pressure correction after yesterday carbonation blocks next-day retest", () => {
  const policy = carbonationRetestPolicy(
    [
      {
        id: "2026-09-18_1010",
        carbonation: 2.26,
        notes: "העלאת לחץ ל1.3 bar",
      },
      { id: "2026-09-19_0900" },
    ],
    "2026-09-19",
  );

  assert.equal(policy.waitReason, "ordinary_pressure");
  assert.equal(policy.daysSinceReference, 1);
  assert.equal(policy.requiredWaitDays, 2);
  assert.equal(policy.due, false);
});

test("ordinary pressure correction becomes due after two full days", () => {
  const policy = carbonationRetestPolicy(
    [
      {
        id: "2026-09-17_1010",
        carbonation: 2.26,
        notes: "הורדת לחץ ל1.1 bar",
      },
      { id: "2026-09-18_0900" },
      { id: "2026-09-19_0900" },
    ],
    "2026-09-19",
  );

  assert.equal(policy.waitReason, "ordinary_pressure");
  assert.equal(policy.daysSinceReference, 2);
  assert.equal(policy.due, true);
});

test("completed bottom carbonation may be retested the next day", () => {
  const policy = carbonationRetestPolicy(
    [
      {
        id: "2026-09-18_1010",
        carbonation: 2.05,
        notes:
          "הורדת לחץ ל0.2 bar. תחילת גיזוז מלמטה בשעה 10:10 | " +
          "סגירת גיזוז מלמטה בשעה 10:55 על 0.8 bar.",
      },
      { id: "2026-09-19_0900" },
    ],
    "2026-09-19",
  );

  assert.equal(policy.waitReason, "bottom_carbonation");
  assert.equal(policy.daysSinceReference, 1);
  assert.equal(policy.requiredWaitDays, 1);
  assert.equal(policy.due, true);
});

test("today's carbonation never requests another test today", () => {
  const policy = carbonationRetestPolicy(
    [{ id: "2026-09-19_0900", carbonation: 2.05 }],
    "2026-09-19",
  );

  assert.equal(policy.waitReason, "tested_today");
  assert.equal(policy.due, false);
});


test("ordinary pressure retest uses calendar dates, not a 48-hour timer", () => {
  const policy = carbonationRetestPolicy(
    [
      {
        id: "2026-01-01_2359",
        carbonation: 2.26,
        notes: "העלאת לחץ ל1.3 bar",
      },
      { id: "2026-01-03_0000" },
    ],
    "2026-01-03",
  );

  assert.equal(policy.waitReason, "ordinary_pressure");
  assert.equal(policy.daysSinceReference, 2);
  assert.equal(policy.due, true);
});


test("bottom-carbonation retest wording uses the actual treatment age", () => {
  const nextDay = carbonationRetestPolicy(
    [
      {
        id: "2026-09-18_1010",
        carbonation: 2.01,
        notes: "סגירת גיזוז מלמטה בשעה 10:55 על 0.8 bar",
      },
    ],
    "2026-09-19",
  );

  const twoDaysLater = carbonationRetestPolicy(
    [
      {
        id: "2026-09-17_1010",
        carbonation: 2.01,
        notes: "סגירת גיזוז מלמטה בשעה 10:55 על 0.8 bar",
      },
    ],
    "2026-09-19",
  );

  assert.match(
    carbonationRetestDueReason(nextDay) ?? "",
    /^אתמול בוצע גיזוז מלמטה/,
  );
  assert.match(
    carbonationRetestDueReason(twoDaysLater) ?? "",
    /^לפני יומיים בוצע גיזוז מלמטה/,
  );
});

test("ordinary-pressure retest wording does not hardcode two days", () => {
  const policy = carbonationRetestPolicy(
    [
      {
        id: "2026-09-16_1010",
        carbonation: 2.26,
        notes: "העלאת לחץ ל1.3 bar",
      },
    ],
    "2026-09-19",
  );

  assert.equal(policy.daysSinceReference, 3);
  assert.match(
    carbonationRetestDueReason(policy) ?? "",
    /^לפני 3 ימים בוצע שינוי לחץ/,
  );
});


test("repeat-test context uses the preceding pressure reading, even if both are from today", () => {
  const readings = [
    { id: "2026-10-20_0800", pressure: 1.2 },
    { id: "2026-10-19_0900", pressure: 0.88 },
    { id: "2026-10-20_1100", pressure: 1.35 },
    { id: "2026-10-18_1000", pressure: 2.4 },
  ];
  assert.equal(
    carbonationRetestPressureContext(readings, "2026-10-20"),
    "לחץ היום: 1.35 bar · לחץ במדידה הקודמת היום: 1.2 bar · הפרש: עלייה של 0.15 bar",
  );
});

test("repeat-test context shows a pressure drop and skips unchanged difference", () => {
  assert.match(
    carbonationRetestPressureContext(
      [{ id: "2026-10-19_1200", pressure: 1.5 }, { id: "2026-10-20_0900", pressure: 1.25 }],
      "2026-10-20",
    ) ?? "",
    /הפרש: ירידה של 0.25 bar/,
  );
  assert.doesNotMatch(
    carbonationRetestPressureContext(
      [{ id: "2026-10-19_1200", pressure: 1.5 }, { id: "2026-10-20_0900", pressure: 1.5 }],
      "2026-10-20",
    ) ?? "",
    /הפרש:/,
  );
});

test("repeat-test context does not invent missing readings", () => {
  assert.equal(
    carbonationRetestPressureContext([{ id: "2026-10-19_1000", pressure: 1.5 }], "2026-10-20"),
    null,
  );
  assert.equal(
    carbonationRetestPressureContext(
      [{ id: "2026-10-18_1000", pressure: 1.5 }, { id: "2026-10-20_1000", pressure: 1.2 }],
      "2026-10-20",
    ),
    "לחץ היום: 1.2 bar · לחץ קודם (18/10/2026): 1.5 bar · הפרש: ירידה של 0.30 bar",
  );
  assert.equal(
    carbonationRetestPressureContext(
      [{ id: "2026-10-20_0900", pressure: null }, { id: "2026-10-19_1000", pressure: 1.5 }],
      "2026-10-20",
    ),
    null,
  );
});

test("repeat-test pressure context handles a month transition", () => {
  assert.match(
    carbonationRetestPressureContext(
      [{ id: "2026-09-30_1130", pressure: 1.3 }, { id: "2026-10-01_0900", pressure: 1.2 }],
      "2026-10-01",
    ) ?? "",
    /הפרש: ירידה של 0.10 bar/,
  );
});


test("compares today's reading to the latest prior day, even several days back", () => {
  assert.match(carbonationRetestPressureContext([
    { id: "2026-10-17_1000", pressure: 0.88 },
    { id: "2026-10-20_1000", pressure: 1.35 },
  ], "2026-10-20") ?? "", /לחץ קודם \(17\/10\/2026\): 0.88 bar.*עלייה של 0.47 bar/);
});

test("Friday leaves the underlying retest due, but defers moderate severity", () => {
  const history = [
    { id: "2026-10-28_0915", carbonation: 2.39 },
    { id: "2026-10-30_0700", pressure: 1.1 },
  ];
  const friday = carbonationRetestPolicy(history, "2026-10-30");
  assert.equal(friday.waitReason, "cadence");
  assert.equal(friday.daysSinceReference, 2);
  assert.equal(friday.due, true, "the waiting clock remains due independently of weekday");
  assert.equal(shouldRecommendCarbonationRetestOnDate("2026-10-30", 2), false);
  assert.equal(shouldRecommendCarbonationRetestOnDate("2026-10-31", 2), true);
  assert.equal(carbonationRetestPolicy(history, "2026-10-31").due, true);
});

test("Friday shows urgency 3 retests for all timing branches", () => {
  const histories = [
    { treatment: null, reason: "cadence", age: 2, start: "2026-10-28" },
    { treatment: "הורדת לחץ ל1.2 bar", reason: "ordinary_pressure", age: 2, start: "2026-10-28" },
    { treatment: "סגירת גיזוז מלמטה בשעה 13:00 על 0.8 bar", reason: "bottom_carbonation", age: 1, start: "2026-10-29" },
  ] as const;
  for (const { treatment, reason, age, start } of histories) {
    const history = [{ id: `${start}_0900`, carbonation: 2.1, notes: treatment }];
    const policy = carbonationRetestPolicy(history, "2026-10-30");
    assert.equal(policy.waitReason, reason);
    assert.equal(policy.daysSinceReference, age);
    assert.equal(policy.due, true);
    assert.equal(shouldRecommendCarbonationRetestOnDate("2026-10-30", 3), true);
    assert.match(carbonationRetestDueReason(policy) ?? "", /בדיקת גיזוז חוזרת/);
  }
});

test("Friday defers moderate retests regardless of treatment path", () => {
  const histories = [
    { id: "2026-10-28_1010", carbonation: 2.39 },
    { id: "2026-10-28_1010", carbonation: 2.39, notes: "העלאת לחץ ל1.5 bar" },
    { id: "2026-10-29_1010", carbonation: 2.39, notes: "סגירת גיזוז מלמטה בשעה 10:55 על 0.8 bar" },
  ];
  for (const row of histories) {
    const policy = carbonationRetestPolicy([row], "2026-10-30");
    assert.equal(policy.due, true);
    assert.equal(shouldRecommendCarbonationRetestOnDate("2026-10-30", 2), false);
    assert.equal(shouldRecommendCarbonationRetestOnDate("2026-10-30", 3), true);
  }
});

test("Friday severity boundary and adjacent weekdays are stable", () => {
  const friday = "2026-10-30";
  assert.equal(shouldRecommendCarbonationRetestOnDate(friday, 1), false);
  assert.equal(shouldRecommendCarbonationRetestOnDate(friday, 2), false);
  assert.equal(shouldRecommendCarbonationRetestOnDate(friday, 2.999), false);
  assert.equal(shouldRecommendCarbonationRetestOnDate(friday, 3), true);
  assert.equal(shouldRecommendCarbonationRetestOnDate("2026-10-29", 2), true);
  assert.equal(shouldRecommendCarbonationRetestOnDate("2026-10-31", 2), true);
  assert.equal(shouldRecommendCarbonationRetestOnDate("not-a-date", 3), false);
});

test("Friday severe retests still respect actual waiting periods and today's completed tests", () => {
  const notYetDue = carbonationRetestPolicy([
    { id: "2026-10-29_1010", carbonation: 2.1, notes: "הורדת לחץ ל1.2 bar" },
  ], "2026-10-30");
  assert.equal(notYetDue.due, false);
  assert.equal(notYetDue.waitReason, "ordinary_pressure");
  const testedToday = carbonationRetestPolicy([
    { id: "2026-10-30_0830", carbonation: 2.1 },
  ], "2026-10-30");
  assert.equal(testedToday.waitReason, "tested_today");
  assert.equal(testedToday.due, false);
});

test("live recommendation applies Friday severity only to retests, not first cooling test", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("src/SERVICES/cellering/calculateCelleringRecomendations.ts", "utf8");
  assert.match(source, /if \(retestPolicy\.due && shouldRecommendCarbonationRetestOnDate\(todayDate, lastCarbSpec\.importance\)\)/);
  assert.match(source, /!hasCarbonationAfterCooling/);
  assert.match(source, /CoolAge >= 1/);
});
