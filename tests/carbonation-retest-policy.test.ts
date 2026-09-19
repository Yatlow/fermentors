import assert from "node:assert/strict";
import test from "node:test";
import { carbonationRetestPolicy } from "../src/SERVICES/cellering/carbonationRetestPolicy";

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
