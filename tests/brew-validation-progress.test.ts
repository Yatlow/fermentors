import test from "node:test";
import assert from "node:assert/strict";
import { reviewedStepsForPosition, laterValidationPosition, recordedBrewPosition, brewStepFromStageName, reviewedStepsFromRecordedWork } from "../src/SERVICES/brewing/brewValidationProgress";

const steps = ["water", "mash", "lautering", "boil", "transfer", "summary"];

test("on opening brew A at boil, only earlier A stages are reviewed", () => {
  const result = reviewedStepsForPosition({blockIndex:1,stepIndex:3},steps);
  assert.equal(result["1:water"],true);
  assert.equal(result["1:lautering"],true);
  assert.equal(result["1:boil"],undefined);
  assert.equal(result["1:transfer"],undefined);
  assert.equal(result["2:water"],undefined);
});

test("opening C at boil reviews all earlier A/B stages but not current or future stages", () => {
  const result = reviewedStepsForPosition({blockIndex:3,stepIndex:3},steps);
  for (const block of [1,2]) for (const step of steps.slice(0,5))
    assert.equal(result[`${block}:${step}`],true);
  assert.equal(result["3:lautering"],true);
  assert.equal(result["3:boil"],undefined);
  assert.equal(result["3:transfer"],undefined);
  assert.equal(result["3:summary"],undefined);
});

test("older persisted checks are never supplied or carried into a new session",()=>{
  const result = reviewedStepsForPosition({blockIndex:1,stepIndex:0},steps);
  assert.deepEqual(result,{});
});

test("going backward preserves the existing progress ceiling",()=>{
  const frontier = laterValidationPosition({blockIndex:3,stepIndex:3},{blockIndex:1,stepIndex:0});
  assert.deepEqual(frontier,{blockIndex:3,stepIndex:3});
  assert.deepEqual(laterValidationPosition(frontier,{blockIndex:3,stepIndex:4}),{blockIndex:3,stepIndex:4});
});

test("manual review marks current stage without reviewing future stages",()=>{
 const result=reviewedStepsForPosition({blockIndex:2,stepIndex:2},steps,{"2:lautering":true});
 assert.equal(result["2:lautering"],true);
 assert.equal(result["2:boil"],undefined);
 assert.equal(result["3:water"],undefined);
});

test("peeking at B transfer cannot move the resume point or validation past recorded A transfer", () => {
  // Previously saved activeBlockIndex: 2, activeStepIndex: 4 were merely UI tabs.
  const actual = recordedBrewPosition(
    { blockIndex: 1, stageName: "WP", stageStartTimeText: "06:22" },
    { "1": { fields: { "wp.start": "06:22", materialsConfirmed: "yes", lauterWaterTemp: "74" } },
      "2": { fields: {} } },
    3,
  );
  assert.deepEqual(actual, { blockIndex: 1, stepIndex: 4 });
  const reviewed = reviewedStepsFromRecordedWork(
    { blockIndex: 1, stageName: "WP", stageStartTimeText: "06:22" },
    { "1": { fields: { "wp.start": "06:22" } }, "2": { fields: {} } },
    3, steps,
  );
  assert.equal(reviewed["1:water"], true);
  assert.equal(reviewed["1:boil"], true);
  assert.equal(reviewed["1:transfer"], undefined);
  assert.equal(reviewed["2:water"], undefined);
  assert.equal(reviewed["2:transfer"], undefined);
});

test("recorded B progress, not a visit, expands validation to completed A and earlier B", () => {
  const actual = recordedBrewPosition(
    { blockIndex: 2, stageName: "רתיחה", stageStartTimeText: "11:45" },
    { "1": { fields: { "outToFermentor.start": "10:00" } },
      "2": { fields: { "boil.start": "11:45" } } },
    3,
  );
  assert.deepEqual(actual, { blockIndex: 2, stepIndex: 3 });
  const reviewed = reviewedStepsFromRecordedWork(
    { blockIndex: 2, stageName: "רתיחה", stageStartTimeText: "11:45" },
    { "1": { fields: { "outToFermentor.start": "10:00" } },
      "2": { fields: { "boil.start": "11:45" } } },
    3, steps,
  );
  // B can be boiling while A's transfer is still incomplete.
  assert.equal(reviewed["1:transfer"], undefined);
  assert.equal(reviewed["2:lautering"], true);
  assert.equal(reviewed["2:boil"], undefined);
  assert.equal(reviewed["3:water"], undefined);
});

test("legacy brews resume at latest recorded timestamp, not last opened B/C screen", () => {
  assert.deepEqual(recordedBrewPosition(null, {
    "1": { fields: { "wp.start": "09:30" } },
    "2": { fields: {} },
  }, 3), { blockIndex: 1, stepIndex: 4 });
  assert.deepEqual(recordedBrewPosition(null, {
    "1": { fields: { "wp.start": "09:30" } },
    "2": { fields: { "mashIn.start": "11:00" } },
  }, 3), { blockIndex: 1, stepIndex: 4 }, "B mash can overlap A transfer");
  assert.deepEqual(recordedBrewPosition(
    { blockIndex: 3, stageName: "WP" }, {},
    3,
  ), { blockIndex: 1, stepIndex: 0 }, "a stage label without real time must not count");
  assert.equal(brewStepFromStageName("L.T"), 2);
  assert.equal(brewStepFromStageName("הוצאה לתסיסה"), 4);
});

test("overlapping A/B/C runs validate each recorded stage independently", () => {
  const blocks = {
    "1": { fields: { "wp.start": "09:30", materialsConfirmed: "yes" } },
    "2": { fields: { "mashIn.start": "10:00" } },
    "3": { fields: {} },
  };
  const reviewed = reviewedStepsFromRecordedWork(
    { blockIndex: 1, stageName: "WP", stageStartTimeText: "09:30" },
    blocks, 3, steps,
  );
  assert.equal(reviewed["1:boil"], true);
  assert.equal(reviewed["1:transfer"], undefined);
  assert.equal(reviewed["2:water"], true);
  assert.equal(reviewed["2:mash"], undefined);
  assert.equal(reviewed["2:transfer"], undefined);
  assert.equal(reviewed["3:water"], undefined);
  const explicit = reviewedStepsFromRecordedWork(null, blocks, 3, steps, { "2:mash": true });
  assert.equal(explicit["2:mash"], true);
  assert.equal(explicit["2:transfer"], undefined);
});
