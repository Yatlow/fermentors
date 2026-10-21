import test from "node:test";
import assert from "node:assert/strict";
import type { SpecChart } from "../src/SERVICES/getAndPost/getSpecsFromFb";
import { getQuickReportPressureDefault } from "../src/SERVICES/cellering/quickReportDefaults";

const specs: SpecChart = {
  pressure: { ipa: 1.6, "פייל": 1.7, "לאגר": 1.1, "הופי": 1.1, "חיטה": 1.6, "סטאוט": 1.5, other: 1.45 },
};

test("valve adjustment defaults to the configured pressure for each beer style", () => {
  for (const [style, expected] of [
    ["IPA", "1.6"], ["פייל", "1.7"], ["לאגר", "1.1"], ["הופי", "1.1"],
    ["חיטה", "1.6"], ["סטאוט", "1.5"], ["Winter Beer", "1.45"],
  ]) {
    assert.equal(getQuickReportPressureDefault("פורק", style, specs), expected, style);
  }
});

test("valve defaults follow the current specs, not a hardcoded target or current tank pressure", () => {
  assert.equal(getQuickReportPressureDefault("פורק", "IPA", {
    pressure: { ...specs.pressure, ipa: 1.75 },
  }), "1.75");
  assert.equal(getQuickReportPressureDefault("סגירת מיכל", "פייל", specs), "1.7");
});

test("missing specs and other report types do not invent a pressure default", () => {
  assert.equal(getQuickReportPressureDefault("פורק", "IPA", null), null);
  assert.equal(getQuickReportPressureDefault("פורק", "IPA", {}), null);
  assert.equal(getQuickReportPressureDefault("פורק", "IPA", { pressure: {} }), null);
  assert.equal(getQuickReportPressureDefault("לחץ", "IPA", specs), null);
  assert.equal(getQuickReportPressureDefault("שמרים", "IPA", specs), null);
});
