import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const source = readFileSync("server/planningSnapshots.js", "utf8");

const context = {
  console,
  Date,
  Number,
  String,
  Object,
  Array,
  JSON,
  Math,
  encodeURIComponent,
  FIREBASE_PROJECT_ID: "test-project",
  Utilities: {
    formatDate(date, _tz, format) {
      // Tests below only exercise pure date-key/target helpers with UTC-noon
      // inputs, where Jerusalem and UTC share the same calendar day.
      if (format === "yyyy-MM-dd") return date.toISOString().slice(0, 10);
      if (format === "HH:mm") return date.toISOString().slice(11, 16);
      if (format === "yyyy-MM-dd-HH-mm-ss") {
        return date.toISOString().slice(0, 19).replace("T", "-").replaceAll(":", "-");
      }
      throw new Error(`Unexpected format ${format}`);
    },
  },
};
vm.createContext(context);
vm.runInContext(source, context, { filename: "planningSnapshots.js" });

assert.deepEqual(
  JSON.parse(JSON.stringify(context.planningSnapshotTargets_("2026-09-18", false))),
  [
    { targetWeek: "2026-09-20", checkpoint: "lead1" },
    { targetWeek: "2026-09-27", checkpoint: "lead2" },
    { targetWeek: "2026-10-04", checkpoint: "lead3" },
    { targetWeek: "2026-10-11", checkpoint: "lead4" },
  ],
);
assert.deepEqual(
  JSON.parse(JSON.stringify(context.planningSnapshotTargets_("2026-09-20", true))),
  [{ targetWeek: "2026-09-20", checkpoint: "opening" }],
);
assert.throws(() => context.planningSnapshotTargets_("2026-09-17", false));
assert.throws(() => context.planningSnapshotTargets_("2026-09-18", true));

const cutoff = new Date("2026-09-18T09:00:00Z");
const before = { revision: 2, updatedAt: new Date("2026-09-18T08:59:00Z") };
const after = { revision: 3, updatedAt: new Date("2026-09-18T09:01:00Z") };
const chosen = context.planningSelectVersion_([after, before], after, cutoff);
assert.equal(chosen.state, "captured");
assert.equal(chosen.value.revision, 2);

assert.equal(
  context.planningSelectVersion_([], null, cutoff).state,
  "no-plan",
);

console.log("Planning snapshot helper tests passed");
