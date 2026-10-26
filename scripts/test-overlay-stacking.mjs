import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const app = source("src/App.css");
const tokens = Object.fromEntries(
  [...app.matchAll(/--(layer-[a-z-]+):\s*(\d+)\s*;/g)].map(([, name, value]) => [name, Number(value)]),
);
function styleZ(file, selector) {
  const css = source(file);
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = new RegExp(escaped + "\\s*\\{([^}]*)\\}", "g");
  const match = [...css.matchAll(rule)].find((entry) => /z-index\s*:/.test(entry[1]));
  assert.ok(match, `Missing z-index for ${selector} in ${file}`);
  const z = match[1].match(/z-index:\s*([^;\n}]+)/)?.[1].trim();
  assert.ok(z, `Invalid z-index in ${selector}`);
  const variable = z.match(/^var\(--(layer-[a-z-]+)\)$/);
  if (variable) {
    assert.ok(tokens[variable[1]] !== undefined, `Undefined token ${variable[1]}`);
    return tokens[variable[1]];
  }
  const number = Number(z.replace(/!important$/, "").trim());
  assert.ok(Number.isFinite(number), `Unrecognized z-index '${z}' in ${selector}`);
  return number;
}

test("mobile navigation and search stay above content, below every modal", () => {
  const backdrop = styleZ("src/App.css", ".mobile-nav-backdrop");
  const nav = styleZ("src/App.css", ".mobile-nav-shell");
  const search = styleZ("src/App.css", ".tank-search-shell");
  assert.ok(search < backdrop);
  assert.ok(backdrop < nav);
  assert.ok(nav < tokens["layer-modal"]);
  assert.equal(nav, tokens["layer-nav"]);
});

test("shared modal overlay remains above mobile menu regardless of stylesheet import order", () => {
  const files = ["src/App.css", "src/Coolermap.css"];
  for (const file of files) {
    assert.equal(styleZ(file, ".modal-overlay"), tokens["layer-modal"], file);
  }
});

test("cellar and dashboard overlays sit above navigation", () => {
  for (const selector of [".fermentorInfoOverlay", ".batch-chart-overlay"]) {
    assert.equal(styleZ("src/App.css", selector), tokens["layer-modal"]);
  }
  assert.equal(styleZ("src/App.css", ".permission-modal-overlay"), tokens["layer-permission"]);
  assert.ok(tokens["layer-permission"] > tokens["layer-modal"]);
});

test("brewing dialogs use the standard overlay layer", () => {
  const file = "src/components/brewing/BrewingView.css";
  for (const selector of [".brew-modal-backdrop", ".brewing-modal-backdrop"]) {
    assert.equal(styleZ(file, selector), tokens["layer-modal"], selector);
  }
});

test("planning, weekly calendar, Gantt and packaging dialogs are all modal-layer", () => {
  const overlays = [
    ["src/components/planning/planning.css", ".brew-planning .bp-modal-backdrop"],
    ["src/components/planning/planningGantt.css", ".bp-gantt-editor-backdrop"],
    ["src/components/planning/planningGantt.css", ".bp-inventory-dialog-backdrop"],
    ["src/components/planning/planningFiveWeek.css", ".bp-calendar-editor-backdrop"],
    ["src/components/planning/planningPackagingModal.css", ".bp-pack-modal-backdrop"],
  ];
  for (const [file, selector] of overlays) {
    assert.equal(styleZ(file, selector), tokens["layer-modal"], selector);
  }
});

test("priority dialogs remain above regular dialogs, without a max-integer close button", () => {
  const dashboardCss = source("src/components/dashboard/DashboardBrewFormModal.css");
  assert.equal(styleZ("src/components/dashboard/DashboardBrewFormModal.css", ".dashboardBrewModalBackdrop"), tokens["layer-elevated-modal"]);
  assert.equal(styleZ("src/components/cooler/ShipmentDocument.css", ".modal-overlay.shipment-document-overlay"), tokens["layer-elevated-modal"]);
  assert.equal(styleZ("src/components/dashboard/DashboardBrewFormModal.css", ".dashboardBrewModal"), 1);
  assert.equal(styleZ("src/components/dashboard/DashboardBrewFormModal.css", ".dashboardBrewModalClose"), 2);
  assert.doesNotMatch(dashboardCss, /2147483\d{3}/);
});

test("status controls and busy overlays cannot obstruct an action modal", () => {
  assert.ok(styleZ("src/App.css", ".report-success-toast") < tokens["layer-modal"]);
  assert.equal(styleZ("src/App.css", ".beer-loader-overlay"), tokens["layer-busy"]);
  assert.equal(styleZ("src/components/general/beer-loader.css", ".beer-loader-overlay"), tokens["layer-busy"]);
  assert.ok(tokens["layer-busy"] > tokens["layer-elevated-modal"]);
  assert.match(source("src/components/cooler/CoolerUndoControl.tsx"), /zIndex:\s*"var\(--layer-status\)"/);
});

test("both pallet transfer dialogs portal to document.body beyond local stacking contexts", () => {
  const zone = source("src/components/cooler/Zonetrays.tsx");
  const portalCount = (zone.match(/return createPortal\(/g) || []).length;
  const bodyCount = (zone.match(/document\.body,/g) || []).length;
  assert.equal(portalCount, 2, "single and bulk transfer dialogs must portal");
  assert.equal(bodyCount, 2);
  assert.equal((zone.match(/className="modal-overlay"/g) || []).length, 2);
});

test("shared confirmations portal above nested controls and dialogs", () => {
  const confirmation = source("src/components/general/ConfirmModal.tsx");
  assert.match(confirmation, /return createPortal\(/);
  assert.match(confirmation, /document\.body,/);
  assert.match(confirmation, /aria-modal="true"/);
});
