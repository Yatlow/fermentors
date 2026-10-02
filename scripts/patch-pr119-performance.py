from pathlib import Path

# Keep preview diagnostics available, but opt-in. No extra server reads unless the
# user explicitly enables the preview-only toggle.
p = Path('src/components/planning/PlanningView.tsx')
s = p.read_text(encoding='utf-8')
old = '  const showPreviewDiagnostics = runtimeConfig.deployEnv !== "production";\n'
new = '''  const showPreviewDiagnostics = runtimeConfig.deployEnv !== "production";\n  const [diagnosticsEnabled, setDiagnosticsEnabled] = useState(false);\n'''
if old not in s:
    raise SystemExit('Diagnostics environment anchor not found')
s = s.replace(old, new, 1)
s = s.replace(
    '    if (!showPreviewDiagnostics || planningServerProbeStarted.current) return;',
    '    if (!showPreviewDiagnostics || !diagnosticsEnabled || planningServerProbeStarted.current) return;',
    1,
)
s = s.replace(
    '  }, [productionTanks, showPreviewDiagnostics, today]);',
    '  }, [diagnosticsEnabled, productionTanks, showPreviewDiagnostics, today]);',
    1,
)
old_jsx = '''      {showPreviewDiagnostics && !data.loading && !data.error && (\n        <div dir="ltr" style={{ margin: "8px 12px", padding: "8px 10px", border: "1px dashed currentColor", borderRadius: 8, fontSize: 12, lineHeight: 1.5, overflowWrap: "anywhere" }}>\n          <div><strong>Planning audit</strong>{` · Plans ${plans.length}`}{` · Pallets ${pallets.length}`}{` · Packaging ${actuals.length}`}{` · Shipments ${data.actualShipments.length}`}{` · Tanks ${productionTanks.length}`}{planningAuditElapsedMs !== null ? ` · Load ${(planningAuditElapsedMs / 1000).toFixed(2)}s` : ""}{` · ${data.offline ? "cache/offline" : "server/live"}`}</div>\n          <div style={{ marginTop: 4 }}><strong>Server probes</strong>{planningQueryTimings.length === 0 ? " · running…" : planningQueryTimings.map((item) => ` · ${item.label} ${(item.ms / 1000).toFixed(2)}s/${item.docs}${item.error ? " ERR" : ""}`).join("")}</div>\n        </div>\n      )}'''
new_jsx = '''      {showPreviewDiagnostics && !data.loading && !data.error && (\n        <div style={{ margin: "8px 12px" }}>\n          <button type="button" className="bp-secondary" aria-pressed={diagnosticsEnabled} onClick={() => setDiagnosticsEnabled((enabled) => !enabled)}>\n            {diagnosticsEnabled ? "כבה Diagnostics" : "הפעל Diagnostics"}\n          </button>\n          {diagnosticsEnabled && (\n            <div dir="ltr" style={{ marginTop: 8, padding: "8px 10px", border: "1px dashed currentColor", borderRadius: 8, fontSize: 12, lineHeight: 1.5, overflowWrap: "anywhere" }}>\n              <div><strong>Planning audit</strong>{` · Plans ${plans.length}`}{` · Pallets ${pallets.length}`}{` · Packaging ${actuals.length}`}{` · Shipments ${data.actualShipments.length}`}{` · Tanks ${productionTanks.length}`}{planningAuditElapsedMs !== null ? ` · Load ${(planningAuditElapsedMs / 1000).toFixed(2)}s` : ""}{` · ${data.offline ? "cache/offline" : "server/live"}`}</div>\n              <div style={{ marginTop: 4 }}><strong>Server probes</strong>{planningQueryTimings.length === 0 ? " · running…" : planningQueryTimings.map((item) => ` · ${item.label} ${(item.ms / 1000).toFixed(2)}s/${item.docs}${item.error ? " ERR" : ""}`).join("")}</div>\n            </div>\n          )}\n        </div>\n      )}'''
if old_jsx not in s:
    raise SystemExit('Diagnostics JSX anchor not found')
s = s.replace(old_jsx, new_jsx, 1)
p.write_text(s, encoding='utf-8')

# Make Gantt pagination paint a loader immediately and defer the expensive page
# recomputation. Also avoid tentative-tank computation while the daily modal is closed.
p = Path('src/components/planning/PlanningGantt.tsx')
s = p.read_text(encoding='utf-8')
if 'useTransition' not in s:
    s = s.replace('import { Fragment, useMemo, useState } from "react";', 'import { Fragment, useMemo, useState, useTransition } from "react";', 1)
if 'import BeerLoader from "../general/Loading";' not in s:
    anchor = 'import PlanningGanttDailyModal from "./PlanningGanttDailyModal";\n'
    if anchor not in s:
        raise SystemExit('Gantt import anchor not found')
    s = s.replace(anchor, anchor + 'import BeerLoader from "../general/Loading";\n', 1)
anchor = '  const [weekPage, setWeekPage] = useState(0);\n'
if anchor not in s:
    raise SystemExit('weekPage anchor not found')
s = s.replace(anchor, anchor + '''  const [isPaging, startPaginationTransition] = useTransition();\n  const changeWeekPage = (next: number | ((current: number) => number)) => {\n    startPaginationTransition(() => setWeekPage(next));\n  };\n''', 1)
# Only replace actual UI setter call sites, not the setter inside changeWeekPage.
s = s.replace('onClick={() => setWeekPage((page) => Math.max(0, page - 1))}', 'onClick={() => changeWeekPage((page) => Math.max(0, page - 1))}')
s = s.replace('onClick={() => setWeekPage((page) => Math.min(maxWeekPage, page + 1))}', 'onClick={() => changeWeekPage((page) => Math.min(maxWeekPage, page + 1))}')
# Render one overlay for either Gantt mode.
s = s.replace('<section className="bp-gantt-shell">', '<section className="bp-gantt-shell">\n        {isPaging && <BeerLoader overlay message="מעדכן את חלון התכנון…" />}', 1)
second = s.find('<section className="bp-gantt-shell">', s.find('<section className="bp-gantt-shell">') + 1)
if second >= 0:
    end = second + len('<section className="bp-gantt-shell">')
    s = s[:end] + '\n      {isPaging && <BeerLoader overlay message="מעדכן את חלון התכנון…" />}' + s[end:]
old_daily = '''  const dailyEditorPlans = useMemo(\n    () => withTentativeFiveWeekTanks(editorPlans, tanks, settings).map((plan) => ({'''
new_daily = '''  const dailyEditorPlans = useMemo(\n    () => dailyTarget ? withTentativeFiveWeekTanks(editorPlans, tanks, settings).map((plan) => ({'''
if old_daily not in s:
    raise SystemExit('Daily editor memo anchor not found')
s = s.replace(old_daily, new_daily, 1)
s = s.replace(
    '''      }),\n    })),\n    [editorPlans, tanks, settings],\n  );''',
    '''      }),\n    })) : editorPlans,\n    [dailyTarget, editorPlans, tanks, settings],\n  );''',
    1,
)
p.write_text(s, encoding='utf-8')

print('Patched preview diagnostics toggle, pagination transition/loader, and lazy daily planning computation.')