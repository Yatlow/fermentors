import { test } from "node:test";
import assert from "node:assert/strict";
import { materializeWeeklyBrewDraft, weeklyBrewDraftCapacity } from "../src/SERVICES/planning/weeklyBrewDraftCapacity";

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

test("adding week 45 brew leaves saved IPA/Pale/Wheat assignments and identities untouched", () => {
  const existing = [
    { id: "ipa-1610", style: "IPA", liters: 3000, tankId: "tank-12",
      date: "2026-11-02", batchNumber: "1610", tankAssignmentStatus: "confirmed" as const },
    { id: "pale-1611", style: "פייל", liters: 3200, tankId: "tank-18",
      date: "2026-11-03", batchNumber: "1611", tankAssignmentStatus: "confirmed" as const },
    { id: "wheat-1612", style: "חיטה", liters: 1100, tankId: "tank-2",
      date: "2026-11-04", batchNumber: "1612" },
  ];
  const draft = [
    ...existing.map((brew) => ({ id: brew.id, style: brew.style, liters: brew.liters })),
    { style: "לאגר", liters: 3000 },
  ];
  const after = materializeWeeklyBrewDraft(existing, draft, "2026-11-01", () => "new-lager");
  assert.deepEqual(after.slice(0, 3), existing);
  assert.deepEqual(after[3], {
    id: "new-lager", style: "לאגר", liters: 3000, tankId: "", date: "2026-11-02",
  });
});

test("weekly editing refuses to silently move or relink a confirmed brew", () => {
  const existing = [{
    id: "ipa-1610", style: "IPA", liters: 3000, tankId: "tank-12",
    date: "2026-11-02", batchNumber: "1610",
  }];
  assert.throws(() => materializeWeeklyBrewDraft(existing, [{
    id: "ipa-1610", style: "פייל", liters: 3000,
  }], "2026-11-01", () => "unused"), /לוח העבודה/);
});

test("updating a truly unassigned decision preserves its identity", () => {
  const original = [{ id: "unassigned-id", style: "IPA", liters: 3000, tankId: "", date: "2026-11-02" }];
  const result = materializeWeeklyBrewDraft(original, [
    { id: "unassigned-id", style: "פייל", liters: 3200 },
  ], "2026-11-01", () => "unused");
  assert.deepEqual(result, [{ ...original[0], style: "פייל", liters: 3200 }]);
});
