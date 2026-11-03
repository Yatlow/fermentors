import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/SERVICES/cooler/shipmentReportSort.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { sortShipmentReportsNewestFirst } = await import(
    "data:text/javascript;base64," + Buffer.from(compiled).toString("base64")
);

const stamp = (ms) => ({ toMillis: () => ms });
const original = [
    { id: "older", shipmentNumber: 2401, createdAt: stamp(1_000) },
    { id: "manual", shipmentNumber: 2403, createdAt: stamp(3_000), sourceType: "manual" },
    { id: "legacy", shipmentNumber: 2399, createdAt: null },
    { id: "pallets", shipmentNumber: 2402, createdAt: stamp(2_000), sourceType: "pallets" },
];
assert.deepEqual(sortShipmentReportsNewestFirst(original).map((s) => s.id), [
    "manual", "pallets", "older", "legacy",
], "newest issued delivery notes must appear first across source types");
assert.deepEqual(original.map((s) => s.id), ["older", "manual", "legacy", "pallets"],
    "render ordering must not mutate the Firestore snapshot array");
assert.deepEqual(sortShipmentReportsNewestFirst([
    { id: "old-without-timestamp", shipmentNumber: 2390, createdAt: null },
    { id: "new-without-timestamp", shipmentNumber: 2391, createdAt: null },
]).map((s) => s.id), ["new-without-timestamp", "old-without-timestamp"],
    "legacy notes with no timestamp must still be newest number first");
assert.deepEqual(sortShipmentReportsNewestFirst([
    { id: "b", shipmentNumber: 2502, createdAt: stamp(7_000) },
    { id: "a", shipmentNumber: 2501, createdAt: stamp(7_000) },
]).map((s) => s.id), ["b", "a"],
    "same timestamp is ordered by document number");

const reportView = readFileSync(new URL("../src/components/reports/ShipmentReportsView.tsx", import.meta.url), "utf8");
assert.match(reportView, /setShipments\(sortShipmentReportsNewestFirst\(data\)\)/,
    "report dropdown must use the descending order of delivery notes");
assert.match(reportView, /shipments\.map\(\(s\) =>/,
    "rendered options must use the sorted collection");
console.log("Shipment report newest-first ordering and legacy fallbacks passed");
