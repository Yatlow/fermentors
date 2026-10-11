import test from "node:test";
import assert from "node:assert/strict";
import { reviewedStepsForPosition, laterValidationPosition } from "../src/SERVICES/brewing/brewValidationProgress";

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
