import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldShowWednesdayPackagingCarb } from "../src/SERVICES/dashboard/weeklyCarbRoutine";

test("Wednesday's planned packaging test survives a competing repeat-carbonation recommendation", () => {
  assert.equal(shouldShowWednesdayPackagingCarb({
    day: 3, stageName: "קר", tankNumber: 3, plannedNextWeekTankNumbers: [3, 8, 14],
  }), true);
});
test("the independent weekly check is not invented for warm, unscheduled or other-day tanks", () => {
  for (const input of [
    { day: 2, stageName: "קר", tankNumber: 3, plannedNextWeekTankNumbers: [3] },
    { day: 3, stageName: "בתסיסה", tankNumber: 3, plannedNextWeekTankNumbers: [3] },
    { day: 3, stageName: "קר", tankNumber: 9, plannedNextWeekTankNumbers: [3] },
  ]) assert.equal(shouldShowWednesdayPackagingCarb(input), false);
});
