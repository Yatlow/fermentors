import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultSettings, emptyWeek, type Product, type WeekPlan } from "../src/SERVICES/planning/planningEngine";
import { planningWeekIssues } from "../src/SERVICES/planning/planningValidation";
import {
  hasSundayKegOverageApproval, sundayKegOverages, withSundayKegOverageApprovals,
} from "../src/SERVICES/planning/sundayKegCapacity";

const sunday = "2026-11-08";
const ipaKegs: Product = {
  id: "ipa-kegs", sku: "k", style: "IPA", type: "kegs",
  monthly: 100, tempo: 0, tempoDate: sunday, leadDays: 21,
};
const ipaCrates: Product = { ...ipaKegs, id: "ipa-crates", type: "crates" };
const stoutKegs: Product = { ...ipaKegs, id: "stout-kegs", style: "סטאוט" };
const settings = { ...defaultSettings(), products: [ipaKegs, ipaCrates, stoutKegs] };
const base: WeekPlan = {
  ...emptyWeek(sunday),
  packaging: [{ id: "ipa", productId: "ipa-kegs", quantity: 120, date: sunday }],
};

function messages(week: WeekPlan) {
  return planningWeekIssues(week, settings, [week], sunday).join("; ");
}

test("Sunday 120 kegs is blocked before explicit planner approval", () => {
  assert.deepEqual(sundayKegOverages(base, settings.products), [{ date: sunday, quantity: 120 }]);
  assert.match(messages(base), /120 חביות חורגים מקיבולת 100/);
});

test("planner approval authorizes exactly this Sunday and this quantity", () => {
  const confirmed = withSundayKegOverageApprovals(
    base, settings.products, sundayKegOverages(base, settings.products),
  );
  assert.deepEqual(confirmed.sundayKegOverageApprovals, [{ date: sunday, quantity: 120 }]);
  assert.equal(messages(confirmed), "");
  assert.equal(hasSundayKegOverageApproval(confirmed, { date: sunday, quantity: 120 }), true);
});

test("moving or increasing an approved shift demands a new confirmation", () => {
  const confirmed = withSundayKegOverageApprovals(
    base, settings.products, sundayKegOverages(base, settings.products),
  );
  const increased = withSundayKegOverageApprovals({
    ...confirmed, packaging: [{ ...base.packaging[0], quantity: 130 }],
  }, settings.products);
  assert.deepEqual(increased.sundayKegOverageApprovals, []);
  assert.match(messages(increased), /130 חביות חורגים מקיבולת 100/);
  const moved = withSundayKegOverageApprovals({
    ...confirmed, packaging: [{ ...base.packaging[0], date: "2026-11-09" }],
  }, settings.products);
  assert.deepEqual(moved.sundayKegOverageApprovals, []);
});

test("decreasing to 100 kegs removes stale approval automatically", () => {
  const confirmed = withSundayKegOverageApprovals(
    base, settings.products, [{ date: sunday, quantity: 120 }],
  );
  const reduced = withSundayKegOverageApprovals({
    ...confirmed, packaging: [{ ...base.packaging[0], quantity: 100 }],
  }, settings.products);
  assert.equal(messages(reduced), "");
  assert.deepEqual(reduced.sundayKegOverageApprovals, []);
});

test("Sunday total is cumulative across multiple keg rows", () => {
  const combined: WeekPlan = {
    ...base,
    packaging: [
      { ...base.packaging[0], quantity: 70 },
      { id: "second", productId: "ipa-kegs", quantity: 40, date: sunday },
    ],
  };
  assert.deepEqual(sundayKegOverages(combined, settings.products), [{ date: sunday, quantity: 110 }]);
  assert.match(messages(combined), /110 חביות חורגים מקיבולת 100/);
  const confirmed = withSundayKegOverageApprovals(
    combined, settings.products, [{ date: sunday, quantity: 110 }],
  );
  assert.equal(messages(confirmed), "");
});

test("approval cannot bypass weekday keg limits, Sunday crate limits or competing SKUs", () => {
  const extras: WeekPlan = {
    ...base,
    packaging: [
      base.packaging[0],
      { id: "monday", productId: "ipa-kegs", quantity: 151, date: "2026-11-09" },
      { id: "crates", productId: "ipa-crates", quantity: 169, date: sunday },
    ],
  };
  const approved = withSundayKegOverageApprovals(
    extras, settings.products, [{ date: sunday, quantity: 120 }],
  );
  assert.match(messages(approved), /151 חביות חורגים מקיבולת 150/);
  assert.match(messages(approved), /169 ארגזים חורגים מקיבולת 168/);
  const competing: WeekPlan = {
    ...base, packaging: [
      { ...base.packaging[0], quantity: 101 },
      { id: "other-style", productId: "stout-kegs", quantity: 10, date: sunday },
    ],
  };
  const sameDayApproved = withSundayKegOverageApprovals(
    competing, settings.products, [{ date: sunday, quantity: 111 }],
  );
  assert.match(messages(sameDayApproved), /יותר מפריט אריזה אחד מסוג חביות ביום/);
});

test("non-inventory special keg rows count toward the same Sunday cap", () => {
  const special: WeekPlan = {
    ...base,
    packaging: [{ id: "special", productId: "", nonInventoryStyle: "חורף", nonInventoryType: "kegs",
      quantity: 115, date: sunday }],
  };
  assert.deepEqual(sundayKegOverages(special, settings.products), [{ date: sunday, quantity: 115 }]);
  assert.equal(messages(withSundayKegOverageApprovals(
    special, settings.products, [{ date: sunday, quantity: 115 }],
  )), "");
});

test("an approval from one Sunday cannot authorize another date or week", () => {
  const monday = "2026-11-15";
  const next: WeekPlan = {
    ...emptyWeek(monday),
    packaging: [{ id: "ipa-next", productId: "ipa-kegs", quantity: 120, date: monday }],
    sundayKegOverageApprovals: [{ date: sunday, quantity: 120 }],
  };
  assert.deepEqual(withSundayKegOverageApprovals(next, settings.products).sundayKegOverageApprovals, []);
  assert.match(messages(next), /120 חביות חורגים מקיבולת 100/);
});
