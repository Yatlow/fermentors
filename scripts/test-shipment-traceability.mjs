import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/SERVICES/tools/shipmentTraceability.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
} }).outputText;
const { buildShipmentTraceability, displayShipmentExpiry } = await import(
    "data:text/javascript;base64," + Buffer.from(js).toString("base64")
);

const catalog = (style, type) => ({
    sku: style === "IPA" && type === "kegs" ? "7009940" : "7009676",
    displayText: style + " " + type,
});
const pallet = (id, batchNumber, quantity, expiryDateStr = "2027-02-15") => ({
    id, beerStyle: "IPA", itemType: "kegs", quantity, batchNumber, expiryDateStr,
});

test("groups identical SKU + lot + expiry and separates different lots", () => {
    const shipment = { id: "2401", shipmentNumber: 2401, palletIds: ["a", "b", "c"], palletSnapshot: [
        { palletId: "a", ...pallet("a", "1601", 20) },
        { palletId: "b", ...pallet("b", "1601", 5) },
        { palletId: "c", ...pallet("c", "1603", 10) },
    ], totals: [
        { beerStyle: "IPA", itemType: "kegs", totalQuantity: 35 },
    ] };
    const actual = buildShipmentTraceability(shipment, [
        pallet("a", "1601", 20), pallet("b", "1601", 5), pallet("c", "1603", 10),
    ], catalog);
    assert.equal(actual.rows.length, 2);
    assert.deepEqual(actual.rows.map((r) => [r.batchNumber, r.quantity]), [["1601", 25], ["1603", 10]]);
    assert.equal(actual.hasUnverifiedData, false);
});

test("preserves distinct expiry dates even when batch number is identical", () => {
    const shipment = { palletIds: ["a", "b"], totals: [], palletSnapshot: [
        { palletId: "a", ...pallet("a", "1601", 3, "2027-01-01") },
        { palletId: "b", ...pallet("b", "1601", 8, "2027-02-01") },
    ] };
    const result = buildShipmentTraceability(shipment, [], catalog);
    assert.deepEqual(result.rows.map((r) => r.quantity), [3, 8]);
    assert.equal(result.rows.length, 2);
});

test("new shipments use immutable snapshot even when current pallets differ", () => {
    const shipment = { palletIds: ["a"], palletSnapshot: [{
        palletId: "a", beerStyle: "IPA", itemType: "kegs", quantity: 4,
        batchNumber: "1601", expiryDateStr: "2027-02-15", sku: "7009940",
        description: "Original at shipping",
    }], totals: [] };
    const result = buildShipmentTraceability(shipment, [pallet("a", "9999", 99)], catalog);
    assert.equal(result.rows[0].quantity, 4);
    assert.equal(result.rows[0].batchNumber, "1601");
    assert.equal(result.rows[0].description, "Original at shipping");
});

test("missing old pallet keeps unexplained amount separate and flagged", () => {
    const shipment = { palletIds: ["a", "b"], totals: [{
        beerStyle: "IPA", itemType: "kegs", totalQuantity: 20,
    }] };
    const result = buildShipmentTraceability(shipment, [pallet("a", "1601", 8)], catalog);
    assert.equal(result.missingPallets, 1);
    assert.equal(result.rows.reduce((sum, row) => sum + row.quantity, 0), 20);
    assert.equal(result.rows.find((row) => !row.batchNumber)?.quantity, 12);
    assert.equal(result.hasUnverifiedData, true);
});

test("manual note missing lots displays unknown rather than guessed dates", () => {
    const result = buildShipmentTraceability({
        sourceType: "manual", palletIds: [], totals: [], manualLines: [
            { id: "one", sku: "SKU", description: "OTHER", quantity: 6, source: "catalog" },
        ],
    }, [], catalog);
    assert.equal(result.rows[0].batchNumber, null);
    assert.equal(result.rows[0].expiryDateStr, null);
    assert.equal(result.hasUnverifiedData, true);
});

test("manual note lot metadata can be preserved without altering outbound document", () => {
    const result = buildShipmentTraceability({
        sourceType: "manual", palletIds: [], totals: [], manualLines: [
            { id: "one", sku: "SKU", description: "OTHER", quantity: 6, source: "catalog",
              batchNumber: "1555", expiryDateStr: "05/09/2027" },
        ],
    }, [], catalog);
    assert.equal(result.rows[0].batchNumber, "1555");
    assert.equal(result.rows[0].expiryDateStr, "05/09/2027");
    assert.equal(result.hasUnverifiedData, false);
});

test("date formatting supports ISO and preserves manually entered dates", () => {
    assert.equal(displayShipmentExpiry("2027-02-15"), "15/02/2027");
    assert.equal(displayShipmentExpiry("15/02/2027"), "15/02/2027");
    assert.equal(displayShipmentExpiry(null), "לא ידוע");
});

test("complete lot details from referenced existing pallets are identified without extra snapshot", () => {
    const shipment = { palletIds: ["a"], totals: [{ beerStyle: "IPA", itemType: "kegs", totalQuantity: 8 }] };
    const result = buildShipmentTraceability(shipment, [pallet("a", "1601", 8)], catalog);
    assert.equal(result.rows[0].unverified, false);
    assert.equal(result.hasUnverifiedData, false);
    assert.deepEqual(result.warnings, []);
});

test("shipment report sticks note number and shipping date while dropping status data column", () => {
    const ui = readFileSync(new URL("../src/components/tools/ShipmentTraceabilityReport.tsx", import.meta.url), "utf8");
    const css = readFileSync(new URL("../src/components/tools/ShipmentTraceabilityReport.css", import.meta.url), "utf8");
    assert.match(ui, /shipment-traceability-details shipment-traceability-sticky-heading/);
    assert.match(ui, /<h3>תעודת משלוח \{selected\.shipmentNumber\}<\/h3>/);
    assert.match(ui, /<p>\{shipmentDate\(selected\)\}/);
    const shipmentTable = ui.slice(ui.indexOf('<thead><tr><th>אצווה</th>'));
    assert.match(shipmentTable, /<th>תאריך תפוגה<\/th><\/tr>/);
    assert.doesNotMatch(shipmentTable.split('</table>')[0], /מצב נתונים|row\.unverified/);
    assert.match(css, /\.shipment-traceability-sticky-heading\s*\{[^}]*position:\s*sticky;/s);
    assert.match(css, /\.shipment-traceability-sticky-heading\s*\{[^}]*z-index:\s*40;/s);
});
