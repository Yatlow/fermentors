import { test } from "node:test";
import assert from "node:assert/strict";
import { weeklyBrewDraftCapacity } from "../src/SERVICES/planning/weeklyBrewDraftCapacity";

test("week 45: three committed brews and two free triple tanks permit two additional brews", () => {
  const capacity = weeklyBrewDraftCapacity(
    ["משולש", "משולש", "בודד"],
    ["משולש", "משולש"],
  );
  assert.equal(capacity.total, 5);
  assert.equal(capacity.bySize("משולש"), 4);
  assert.equal(capacity.bySize("בודד"), 1);
  assert.ok(3 < capacity.total, "add button enabled with existing plans");
  assert.ok(2 < capacity.bySize("משולש"), "a third triple brew may be added");
  assert.equal(4 < capacity.bySize("משולש"), false);
  assert.equal(5 >= capacity.total, true, "button disabled after two additions");
});

test("removing all existing brews is not required to expose the same free tank slots", () => {
  const full = weeklyBrewDraftCapacity(["משולש", "משולש", "בודד"], ["משולש", "משולש"]);
  const empty = weeklyBrewDraftCapacity([], ["משולש", "משולש"]);
  assert.equal(full.total - 3, empty.total);
  assert.equal(full.bySize("משולש") - 2, empty.bySize("משולש"));
});

test("no remaining free tanks means no additional capacity", () => {
  const capacity = weeklyBrewDraftCapacity(["משולש"], []);
  assert.equal(capacity.total, 1);
  assert.equal(capacity.bySize("משולש"), 1);
});
