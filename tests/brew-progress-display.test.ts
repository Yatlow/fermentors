import test from "node:test";
import assert from "node:assert/strict";
import { hasCredibleLiveBrewProgress } from "../src/SERVICES/brewing/brewProgressDisplay";

test("new batch does not display stale out-to-fermentor label without timing evidence", () => {
  assert.equal(hasCredibleLiveBrewProgress({
    blockIndex: 1,
    stageCode: 120,
    stageName: "הוצאה לתסיסה",
    stageStartTimeText: null,
    stageEndTimeText: null,
  }), false);
});

test("out-to-fermentor remains visible when it has an actual start time", () => {
  assert.equal(hasCredibleLiveBrewProgress({
    blockIndex: 1,
    stageCode: 120,
    stageName: "הוצאה לתסיסה",
    stageStartTimeText: "14:20",
  }), true);
});

test("normal live stages remain visible with canonical stage code", () => {
  assert.equal(hasCredibleLiveBrewProgress({
    blockIndex: 1,
    stageCode: 10,
    stageName: "הכנסת לתת",
  }), true);
});
