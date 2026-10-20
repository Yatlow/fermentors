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

test("shipped pallet operations protect the traceability index", () => {
    const source = readFileSync(new URL("../src/SERVICES/cooler/Palletservice.ts", import.meta.url), "utf8");
    for (const functionName of ["updatePallet", "updatePalletQuantity", "deletePallet", "splitPallet"]) {
        const start = source.indexOf("export async function " + functionName + "(");
        assert.ok(start >= 0, functionName + " exists");
        const next = source.indexOf("\nexport ", start + 1);
        const body = source.slice(start, next < 0 ? undefined : next);
        assert.match(body, /zone === "shipped"/, functionName + " blocks post-shipment mutation");
    }
});

const packaged = (id, lot, type, qty, style = "IPA") => ({
    id, operationId: id, batchNumber: lot, beerStyle: style,
    packagingType: type, quantity: qty, source: "actual",
});

test("50 packaged, 35 shipped, 10 on hand produces a warning for 5 unaccounted kegs", () => {
    const pallets = [
        pallet("sent1", "1601", "kegs", 20, "shipped"),
        pallet("sent2", "1601", "kegs", 15, "shipped"),
        pallet("stock", "1601", "kegs", 10, "cooler"),
    ];
    const report = buildBatchTraceability("1601",
        [note(2401, ["sent1", "sent2"], "2026-10-01", "Tempo")],
        pallets, catalog, [packaged("pkg1", "1601", "kegs", 50)]);
    assert.equal(report.summaries.length, 1);
    const kegs = report.summaries[0];
    assert.equal(kegs.packaged, 50);
    assert.equal(kegs.shipped, 35);
    assert.equal(kegs.remaining, 10);
    assert.equal(kegs.variance, 5);
    assert.equal(kegs.reconciliationStatus, "shortage");
});

test("multiple packaging operations of one SKU are summed but duplicated retries are ignored", () => {
    const pallets = [
        pallet("sent", "1601", "kegs", 30, "shipped"),
        pallet("stock", "1601", "kegs", 20, "cooler"),
    ];
    const rows = [
        packaged("first", "1601", "kegs", 15),
        packaged("second", "1601", "kegs", 35),
        { ...packaged("second-again", "1601", "kegs", 35), operationId: "second" },
        packaged("other-batch", "1602", "kegs", 500),
    ];
    const result = buildBatchTraceability("1601", [note(2400, ["sent"], "2026-10-01", "Tempo")],
        pallets, catalog, rows);
    assert.deepEqual([result.summaries[0].packaged, result.summaries[0].variance,
        result.summaries[0].reconciliationStatus], [50, 0, "matched"]);
});

test("extra shipments or inventory beyond reported packaging are flagged as excess", () => {
    const pallets = [pallet("sent", "1700", "kegs", 20, "shipped"),
        pallet("stock", "1700", "kegs", 15, "cooler")];
    const result = buildBatchTraceability("1700", [note(2400, ["sent"], "2026-10-01", "Tempo")],
        pallets, catalog, [packaged("pkg", "1700", "kegs", 30)]);
    assert.equal(result.summaries[0].variance, -5);
    assert.equal(result.summaries[0].reconciliationStatus, "excess");
});

test("kegs and bottles (counted as crates) reconcile independently with actual packaging", () => {
    const pallets = [pallet("k", "1800", "kegs", 10, "shipped"),
        pallet("c", "1800", "crates", 8, "cooler")];
    const rows = [packaged("kegs", "1800", "kegs", 10),
        packaged("crates", "1800", "bottles", 8)];
    const result = buildBatchTraceability("1800", [note(2400, ["k"], "2026-10-01", "A")],
        pallets, catalog, rows);
    assert.deepEqual(result.summaries.map((x) => [x.sku, x.packaged, x.shipped, x.remaining, x.variance]),
        [["IPA-crates", 8, 0, 8, 0], ["IPA-kegs", 10, 10, 0, 0]]);
});

test("missing historical packaging records are unknown, never treated as zero or balanced", () => {
    const stock = [pallet("c", "1900", "kegs", 10, "cooler")];
    for (const records of [[], null]) {
        const result = buildBatchTraceability("1900", [], stock, catalog, records);
        assert.equal(result.summaries[0].packaged, null);
        assert.equal(result.summaries[0].variance, null);
        assert.equal(result.summaries[0].reconciliationStatus, "unknown");
    }
});

test("malformed actual report prevents a false green even if valid reports balance", () => {
    const stock = [pallet("c", "2000", "kegs", 10, "cooler")];
    const rows = [packaged("good", "2000", "kegs", 10), { ...packaged("bad", "2000", "bottles", 5), beerStyle: "" }];
    const result = buildBatchTraceability("2000", [], stock, catalog, rows);
    assert.equal(result.invalidPackagingRecords, 1);
    assert.equal(result.summaries[0].packaged, 10);
    assert.equal(result.summaries[0].variance, null);
    assert.equal(result.summaries[0].reconciliationStatus, "unknown");
});

test("packaging-only lots still show up, even without surviving pallets or shipment references", () => {
    const result = buildBatchTraceability("#2100", [], [], catalog,
        [packaged("one", 2100, "kegs", 20)]);
    assert.equal(result.summaries.length, 1);
    assert.equal(result.summaries[0].packaged, 20);
    assert.equal(result.summaries[0].shipped, 0);
    assert.equal(result.summaries[0].remaining, 0);
    assert.equal(result.summaries[0].variance, 20);
});

test("batch UI reads only selected packagingLog batch and labels missing records explicitly", () => {
    const ui = readFileSync(new URL("../src/components/tools/ShipmentTraceabilityReport.tsx", import.meta.url), "utf8");
    assert.match(ui, /collection\(db, "packagingLog"\)/);
    assert.match(ui, /where\("batchNumber", "in", alternatives\)/);
    assert.match(ui, /נארז בפועל/);
    assert.match(ui, /חוסר בלתי מוסבר/);
    assert.match(ui, /לא ניתן לאמת/);
});
