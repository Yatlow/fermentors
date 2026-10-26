import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareDispatchManifests, sameDispatchManifest,
} from "../src/SERVICES/planning/shipmentDispatchVariance";

test("identical load matches even when pallet quantities are split or reordered", () => {
  const planned = [{ productId: "ipa-kegs", quantity: 25 }, { productId: "pale-crates", quantity: 84 }];
  const actual = [{ productId: "pale-crates", quantity: 84 }, { productId: "ipa-kegs", quantity: 20 },
    { productId: "ipa-kegs", quantity: 5 }];
  assert.deepEqual(compareDispatchManifests(planned, actual), []);
  assert.equal(sameDispatchManifest(planned, actual), true);
});

test("a partial planned truck displays exact shortages and surplus", () => {
  const variance = compareDispatchManifests(
    [{ productId: "ipa-kegs", quantity: 40 }, { productId: "pale-crates", quantity: 84 }],
    [{ productId: "ipa-kegs", quantity: 30 }, { productId: "pale-crates", quantity: 90 }],
  );
  assert.deepEqual(variance, [
    { productId: "ipa-kegs", planned: 40, actual: 30, difference: -10 },
    { productId: "pale-crates", planned: 84, actual: 90, difference: 6 },
  ]);
});

test("missing and extra SKUs remain visible even when totals happen to match", () => {
  const actual = [{ productId: "unknown-new-sku", quantity: 20 }];
  const expected = [{ productId: "ipa-kegs", quantity: 20 }];
  assert.deepEqual(compareDispatchManifests(expected, actual), [
    { productId: "ipa-kegs", planned: 20, actual: 0, difference: -20 },
    { productId: "unknown-new-sku", planned: 0, actual: 20, difference: 20 },
  ]);
  assert.equal(sameDispatchManifest(expected, actual), false);
});

test("changing the quantity of a planned trip invalidates its prior review", () => {
  const before = [{ productId: "ipa-kegs", quantity: 20 }];
  const changed = [{ productId: "ipa-kegs", quantity: 21 }];
  assert.equal(sameDispatchManifest(before, changed), false);
});

test("invalid input never silently compares equal", () => {
  assert.throws(() => compareDispatchManifests(
    [{ productId: "ipa", quantity: Number.NaN }], [],
  ), /אינם תקינים/);
  assert.throws(() => compareDispatchManifests(
    [{ productId: "", quantity: 1 }], [],
  ), /אינם תקינים/);
});
