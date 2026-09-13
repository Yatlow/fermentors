import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pallet } from "../src/SERVICES/cooler/Pallettypes ";
import { palletSelectionOptions } from "../src/SERVICES/planning/shipmentPicking";

function pallet(
  id: string,
  quantity: number,
  expiryDateStr: string,
  row: number,
  orderInCell = 0,
  col = 1,
): Pallet {
  return {
    id,
    quantity,
    itemType: "crates",
    beerStyle: "IPA",
    zone: "cooler",
    expiryDateStr,
    heightUnits: 1,
    cell: { side: "left", row, col },
    orderInCell,
  };
}

test("FEFO is strict: earlier expiry wins before distance from the door", () => {
  const earlierFar = pallet("earlier-far", 84, "10/01/2027", 1);
  const laterNear = pallet("later-near", 84, "10/02/2027", 5);

  const choice = palletSelectionOptions([laterNear, earlierFar], 84)[0];

  assert.ok(choice);
  assert.deepEqual(choice.selected.map((p) => p.id), ["earlier-far"]);
});

test("same expiry: a pallet on top is preferred to the pallet below it", () => {
  const top = pallet("top", 84, "10/01/2027", 3, 0, 2);
  const below = pallet("below", 84, "10/01/2027", 3, 1, 2);

  const choice = palletSelectionOptions([below, top], 84)[0];

  assert.ok(choice);
  assert.deepEqual(choice.selected.map((p) => p.id), ["top"]);
});

test("identical pallets are picked as the preferred access prefix after skipping an unusable partial pallet", () => {
  const partial = pallet("partial-4", 4, "10/01/2027", 5, 0, 1);
  const first = pallet("first", 20, "10/01/2027", 4, 0, 1);
  const second = pallet("second", 20, "10/01/2027", 3, 0, 1);
  const third = pallet("third", 20, "10/01/2027", 2, 0, 1);
  const fourth = pallet("fourth", 20, "10/01/2027", 1, 0, 1);

  const choice = palletSelectionOptions(
    [third, partial, fourth, first, second],
    60,
  )[0];

  assert.ok(choice);
  assert.equal(choice.total, 60);
  assert.deepEqual(choice.selected.map((p) => p.id), ["first", "second", "third"]);
  assert.equal(choice.selected.some((p) => p.id === "partial-4"), false);
});

test("subset search may skip an early pallet only when required to reach the exact target", () => {
  const first = pallet("first-60", 60, "10/01/2027", 5);
  const second = pallet("second-50", 50, "10/01/2027", 4);
  const third = pallet("third-34", 34, "10/01/2027", 3);

  const choice = palletSelectionOptions([first, second, third], 84)[0];

  assert.ok(choice);
  assert.deepEqual(choice.selected.map((p) => p.id), ["second-50", "third-34"]);
});
