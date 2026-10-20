import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const transpile = (path) => ts.transpileModule(
    readFileSync(new URL(path, import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
).outputText;
const uri = (text) => "data:text/javascript;base64," + Buffer.from(text).toString("base64");
const helperUrl = uri(transpile("../src/SERVICES/tools/shipmentTraceability.ts"));
const batchJs = transpile("../src/SERVICES/tools/batchTraceability.ts")
    .replace('from "./shipmentTraceability"', 'from "' + helperUrl + '"');
const { buildBatchTraceability, listTraceableBatches } = await import(uri(batchJs));

const catalog = (style, type) => ({ sku: style + "-" + type, displayText: style + " " + type });
const pallet = (id, lot, type, qty, zone, expiryDateStr = "2027-01-01") => ({
    id, batchNumber: lot, beerStyle: "IPA", itemType: type, quantity: qty, zone, expiryDateStr,
});
const note = (number, ids, date, customerName) => ({
    id: String(number), shipmentNumber: number, palletIds: ids,
    sourceType: "pallets", totals: [], customerName,
    createdAt: { toDate: () => new Date(date) },
});

test("identifies batch across historical notes and calculates remaining physical stock by SKU, never subtracts from shipped quantity", () => {
    const pallets = [
        pallet("a", "1601", "kegs", 20, "shipped"),
        pallet("b", "1601", "crates", 12, "shipped"),
        pallet("c", "1601", "kegs", 6, "cooler"),
        pallet("d", "1601", "crates", 3, "pending"),
        pallet("e", "1601", "kegs", 7, "loadingDock"),
        pallet("f", "1601", "crates", 2, "bottleRoom"),
        pallet("g", "1602", "kegs", 99, "cooler"),
    ];
    const shipments = [
        note(2401, ["a", "b"], "2026-10-01", "א"),
        note(2402, [], "2026-10-08", "ב"),
    ];
    shipments[1].palletSnapshot = [
        { palletId: "gone", beerStyle: "IPA", itemType: "kegs", quantity: 8,
          batchNumber: "1601", expiryDateStr: "2027-03-01", sku: "IPA-kegs", description: "IPA kegs" },
    ];
    const report = buildBatchTraceability("1601", shipments, pallets, catalog);
    assert.equal(report.shipments.length, 3);
    assert.equal(report.shipments[0].customerName, "ב");
    assert.deepEqual(report.summaries.map((x) => [x.sku, x.shipped, x.remaining]),
        [["IPA-crates", 12, 5], ["IPA-kegs", 28, 13]]);
    assert.equal(report.stock.reduce((sum, x) => sum + x.quantity, 0), 18);
    assert.equal(report.stock.some((x) => x.quantity === 99), false);
});

test("keeps expiry and physical locations distinct for remaining inventory", () => {
    const pallets = [
        pallet("a", "1700", "kegs", 5, "cooler", "2027-01-01"),
        pallet("b", "1700", "kegs", 7, "pending", "2027-01-01"),
        pallet("c", "1700", "kegs", 9, "loadingDock", "2027-02-01"),
        pallet("d", "1700", "kegs", 20, "shipped", "2027-02-01"),
    ];
    const report = buildBatchTraceability("1700", [], pallets, catalog);
    assert.equal(report.summaries[0].remaining, 21);
    assert.equal(report.stock.length, 2);
    assert.deepEqual(report.stock[0].zones, { cooler: 5, pending: 7 });
    assert.equal(report.stock[1].quantity, 9);
});

test("manual shipment only appears under its explicitly recorded lot", () => {
    const shipment = { id: "2470", shipmentNumber: 2470, sourceType: "manual",
        manualLines: [
            { sku: "X", description: "Manual item", quantity: 2, batchNumber: "1601", expiryDateStr: "2027-01-01" },
            { sku: "X", description: "Other", quantity: 9 },
        ] };
    const report = buildBatchTraceability("1601", [shipment], [], catalog);
    assert.equal(report.shipments.length, 1);
    assert.equal(report.summaries[0].shipped, 2);
    assert.equal(report.summaries[0].remaining, 0);
});

test("missing historical pallets never invent batch attribution", () => {
    const shipment = { ...note(2500, ["missing"], "2026-10-01", "א"),
        totals: [{ beerStyle: "IPA", itemType: "kegs", totalQuantity: 8 }] };
    const report = buildBatchTraceability("1601", [shipment], [
        pallet("stock", "1601", "kegs", 3, "cooler"),
    ], catalog);
    assert.equal(report.shipments.length, 0);
    assert.equal(report.summaries[0].remaining, 3);
    assert.equal(report.missingHistoricalPallets, 1);
});

test("normalizes numeric lot IDs and lists batches from shipped, active, manual and saved legacy snapshots", () => {
    const pallets = [pallet("a", 1601, "kegs", 2, "shipped"), pallet("b", "1602", "kegs", 3, "cooler")];
    const manual = { id: "m", shipmentNumber: 3000, sourceType: "manual",
        manualLines: [{ sku: "M", description: "manual", quantity: 2, batchNumber: "1603" }] };
    const snapshot = { id: "s", shipmentNumber: 2999, palletSnapshot: [
        { palletId: "lost", beerStyle: "IPA", itemType: "kegs", batchNumber: "1604", quantity: 4 },
    ], palletIds: [], totals: [] };
    assert.deepEqual(listTraceableBatches([manual, snapshot], pallets), ["1604", "1603", "1602", "1601"]);
    assert.equal(buildBatchTraceability("1601", [note(2401, ["a"], "2026-10-01", "א")], pallets, catalog).summaries[0].shipped, 2);
});

test("report is only under Reports and no longer snapshots new shipment records", () => {
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    const service = readFileSync(new URL("../src/SERVICES/cooler/Palletservice.ts", import.meta.url), "utf8");
    assert.match(app, /selectedReports === "עקיבות" && <ShipmentTraceabilityReport/);
    assert.doesNotMatch(app, /selectedAdminTools === "shipmentTraceability"/);
    assert.doesNotMatch(service, /palletIds: uniquePalletIds, palletSnapshot/);
});
