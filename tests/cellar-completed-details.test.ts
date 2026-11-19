import { test } from "node:test";
import assert from "node:assert/strict";
import { completedCellarMeasurementDetails } from "../src/SERVICES/cellering/completedCellarMeasurementDetails";

test("shows the reported yeast buckets and all carbonation tests without changing KPI", () => {
  assert.deepEqual(completedCellarMeasurementDetails([
    { notes: "הורדת 2 דליי שמרים, לחץ אחרי 1.5 bar", carbonation: "2.45" },
    { notes: "הורדת 1 דליי שמרים, לחץ אחרי 1.4 bar", carbonation: 2.51 },
  ]), { yeast: "3 דליי שמרים", carbonation: "2.45 / 2.51 vol" });
});
test("legacy notes without a count are not filled from guesses", () => {
  assert.deepEqual(completedCellarMeasurementDetails([{ notes: "בוצעה הורדת שמרים" }]), {});
});
test("invalid carbonation values are not displayed", () => {
  assert.deepEqual(completedCellarMeasurementDetails([{ carbonation: "" }, { carbonation: "invalid" }]), {});
});