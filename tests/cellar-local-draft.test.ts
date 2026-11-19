import { test } from "node:test";
import assert from "node:assert/strict";
import { CELLAR_DRAFT_TTL_MS, encodeCellarDraft, restoreCellarDraft } from "../src/SERVICES/cellering/cellarLocalDraft";

const tanks = [{ id: "a", batchNumber: "#1603" }, { id: "b", batchNumber: "1612" }];
test("local draft restores across navigation within four hours", () => {
  const saved = encodeCellarDraft({ a: { pressure: "1.3", temp: "15" } }, tanks, 1000);
  assert.deepEqual(restoreCellarDraft(saved, tanks, 1000 + 3600000), { a: { pressure: "1.3", temp: "15" } });
});
test("expired and changed-batch drafts never restore", () => {
  const saved = encodeCellarDraft({ a: { plato: "6.5" } }, tanks, 1000);
  assert.deepEqual(restoreCellarDraft(saved, tanks, 1000 + CELLAR_DRAFT_TTL_MS + 1), {});
  assert.deepEqual(restoreCellarDraft(saved, [{ id: "a", batchNumber: "1604" }], 1200), {});
});
test("a removed fermentor is never restored to another tank", () => {
  const saved = encodeCellarDraft({ a: { pressure: "0.8" }, b: { temp: "3" } }, tanks, 1000);
  assert.deepEqual(restoreCellarDraft(saved, [tanks[1]], 1200), { b: { temp: "3" } });
});