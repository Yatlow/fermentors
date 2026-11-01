import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
async function load(path) {
    const source = read(path);
    const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    return import("data:text/javascript;base64," + Buffer.from(compiled).toString("base64"));
}
const {
    DEFAULT_FERMENTATION_END_PLATO, WINTER_CARBONATION_TARGET,
    getFermentationEndPlatoLimit, fermentationEndStyleKey, carbonationSpecKey, withCellarSpecDefaults,
} = await load("../src/SERVICES/cellering/fermentationEndPlato.ts");
const { getCoolingPlatoStabilityEvidence } = await load("../src/SERVICES/cellering/coolingPlatoStability.ts");

test("all defined fermentation final Plato limits are mapped by style", () => {
    const expectations = [
        ["חיטה", 2.7], ["wheat", 2.7],
        ["לאגר", 2.6], ["הופי לאגר", 2.6], ["Hoppy Lager", 2.6],
        ["פייל", 2.8], ["Pale Ale", 2.8],
        ["IPA", 3.6], ["סטאוט", 4.1], ["Stout", 4.1],
    ];
    for (const [style, target] of expectations) {
        assert.equal(getFermentationEndPlatoLimit(style, {}), target, style);
    }
    assert.equal(Object.keys(DEFAULT_FERMENTATION_END_PLATO).length, 6);
});

test("settings overrides are effective immediately, and unknown styles do not inherit unsafe thresholds", () => {
    const settings = { fermentationEndPlato: { ipa: 3.3, "הופי": 2.4 } };
    assert.equal(getFermentationEndPlatoLimit("IPA", settings), 3.3);
    assert.equal(getFermentationEndPlatoLimit("הופי לאגר", settings), 2.4);
    assert.equal(getFermentationEndPlatoLimit("חורף", settings), null);
    assert.equal(getFermentationEndPlatoLimit("", settings), null);
    assert.equal(fermentationEndStyleKey("Hoppy Lager"), "הופי");
    assert.equal(getFermentationEndPlatoLimit("IPA", { fermentationEndPlato: { ipa: NaN } }), 3.6);
});

test("boundary is inclusive for cooling and above-limit results are review-only", () => {
    const threshold = getFermentationEndPlatoLimit("IPA", {});
    assert.equal(3.6 > threshold, false, "3.6 °P qualifies");
    assert.equal(3.61 > threshold, true, "3.61 °P must not qualify");
    const source = read("../src/SERVICES/cellering/calculateCelleringRecomendations.ts");
    assert.match(source, /todayPlato > fermentationEndPlatoLimit/);
    assert.match(source, /readyToCoolDown = coolingCandidate && !platoAboveFermentationEnd/);
    assert.match(source, /coolingReviewOnly = coolingCandidate && platoAboveFermentationEnd/);
    assert.match(source, /reviewOnly: coolingReviewOnly/);
    assert.match(source, /סף סיום התסיסה לסגנון/);
});

test("three same-day repeated results and 48-hour matched results retain distinct evidence", () => {
    const now = new Date(2026, 9, 11, 10, 0);
    const three = [
        { id: "2026-10-10_0800", plato: 4.2 },
        { id: "2026-10-10_1600", plato: 4.2 },
        { id: "2026-10-11_0900", plato: 4.2 },
    ];
    assert.deepEqual(getCoolingPlatoStabilityEvidence(three, now), { sampleCount: 3, route: "repeated" });
    const two = [three[0], three[2]];
    assert.equal(getCoolingPlatoStabilityEvidence(two, now), null);
    assert.deepEqual(getCoolingPlatoStabilityEvidence([
        { id: "2026-10-09_0900", plato: 4.2 }, three[2],
    ], now), { sampleCount: 2, route: "48-hours" });
    assert.equal(getCoolingPlatoStabilityEvidence([...three, { id: "2026-10-11_0930", plato: 4.1 }], now), null);
});

test("winter carbonation is 2.3 and is recognized in all supported beer style names", () => {
    assert.equal(WINTER_CARBONATION_TARGET, 2.3);
    for (const style of ["חורף", "בירת חורף", "Winter Beer"]) {
        assert.equal(carbonationSpecKey(style), "חורף");
    }
    const source = read("../src/SERVICES/getAndPost/getSpecsFromFb.ts");
    assert.match(source, /return withCellarSpecDefaults\(specs\)/);
    const engine = read("../src/SERVICES/cellering/calculateCelleringRecomendations.ts");
    assert.match(engine, /const normalizedStyle = carbonationSpecKey\(style\)/);
    assert.match(engine, /givenSpecs\.carbonation\?\.\[carbonationSpecKey\(style\)\]/);
});

test("cooling caveat remains visible but cannot be marked as cooled or affect KPI", () => {
    const dashboard = read("../src/components/dashboard/HealthDashboard.tsx");
    assert.match(dashboard, /if \(!recommendation\.reviewOnly\) scoreRecommendations\.push/);
    assert.match(dashboard, /!alert\.reviewOnly && \(\(\) =>/);
    assert.match(dashboard, /dismissible: !recommendation\.reviewOnly/);
    const specsUI = read("../src/components/tools/EditSpecs.tsx");
    assert.match(specsUI, /fermentationEndPlato:"טווח סיום תסיסה/);
    assert.match(specsUI, /חורף:"חורף"/);
});

test("real-time dashboard and settings view share winter and fermentation defaults", () => {
    const stored = {
        carbonation: { ipa: 2.45, other: 2.45 },
        tolorances: { carbonation: 0.04 },
    };
    const hydrated = withCellarSpecDefaults(stored);
    assert.equal(hydrated.carbonation["חורף"], 2.3);
    assert.equal(hydrated.carbonation.ipa, 2.45);
    assert.equal(hydrated.fermentationEndPlato.ipa, 3.6);
    assert.equal(carbonationSpecKey("חורף"), "חורף");
    assert.equal(Math.abs(2.3 - hydrated.carbonation[carbonationSpecKey("חורף")]) < stored.tolorances.carbonation, true);
    assert.equal(stored.carbonation["חורף"], undefined, "do not modify Firestore snapshot data");

    const customized = withCellarSpecDefaults({
        carbonation: { "חורף": 2.35, other: 2.45 },
        fermentationEndPlato: { ipa: 3.4 },
    });
    assert.equal(customized.carbonation["חורף"], 2.35, "persisted target must win");
    assert.equal(customized.fermentationEndPlato.ipa, 3.4, "persisted gravity must win");

    const app = read("../src/App.tsx");
    assert.ok(app.includes("setSpecs(withCellarSpecDefaults(nextSpecs))"), "real-time listener applies same defaults");
    assert.ok(app.includes('firebaseDoc.id === "hops"'), "legacy hops doc excluded in both paths");
    const loader = read("../src/SERVICES/getAndPost/getSpecsFromFb.ts");
    assert.ok(loader.includes("return withCellarSpecDefaults(specs)"), "one-time loader applies same defaults");
    const tankCard = read("../src/components/dashboard/TankCard.tsx");
    assert.ok(tankCard.includes("isCarbonationOutOfRange("));
    assert.ok(tankCard.includes("carbPressureDisplay-${CarbIsOk.importance}"));
});
