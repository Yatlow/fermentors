import test from "node:test";
import assert from "node:assert/strict";
import { addDays, defaultSettings, emptyWeek } from "../src/SERVICES/planning/planningEngine";
import { planningMacroInsights } from "../src/SERVICES/planning/planningMacroInsights";
import type { PlanningSnapshot } from "../src/SERVICES/planning/planningReports";

function fixtures(count: number, stock: number | null = null): { snapshots: PlanningSnapshot[], settings: ReturnType<typeof defaultSettings> } {
  const settings = { ...defaultSettings(), products: [{
    id: "wheat-c", sku: "wheat-c", style: "חיטה", type: "crates" as const,
    monthly: 420, tempo: stock, tempoDate: "", leadDays: 14,
  }] };
  const snapshots = Array.from({ length: count }, (_, index): PlanningSnapshot => {
    const targetWeek = addDays("2026-08-02", index * 7);
    return {
      id: targetWeek + ":opening", targetWeek, checkpoint: "opening",
      plan: emptyWeek(targetWeek),
      settings: {
        ...settings,
        products: settings.products.map((product) => ({ ...product, tempoDate: stock == null ? "" : targetWeek })),
      },
      state: "captured",
    };
  });
  return { settings, snapshots };
}

test("repeated underplanning of wheat flags styles and brews but not lost sales", () => {
  const { settings, snapshots } = fixtures(6);
  const messages = planningMacroInsights(settings, snapshots, [], "2026-10-09");
  assert.ok(messages.some((row) => row.id === "style:חיטה"));
  assert.ok(messages.some((row) => row.id === "brews:חיטה"));
  assert.ok(messages.every((row) => !row.evidence.includes("מכירות אבודות")));
});

test("insufficient history never invents macro trends", () => {
  const { settings, snapshots } = fixtures(3);
  assert.deepEqual(planningMacroInsights(settings, snapshots, [], "2026-10-09"), []);
});

test("repeated dated SKU stock observations flag coverage review", () => {
  const { settings, snapshots } = fixtures(4, 10);
  assert.ok(planningMacroInsights(settings, snapshots, [], "2026-10-09")
    .some((row) => row.id === "sku:wheat-c"));
});
