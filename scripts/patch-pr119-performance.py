from pathlib import Path
import re

# PlanningView: remove temporary diagnostics/server-probe machinery entirely and
# avoid computing tab-specific derived models when their tab is not mounted.
p = Path('src/components/planning/PlanningView.tsx')
s = p.read_text(encoding='utf-8')
s = s.replace('import { useEffect, useMemo, useRef, useState } from "react";', 'import { useEffect, useMemo, useRef, useState } from "react";')
s = re.sub(r'import \{\n  collection, doc, getDocFromServer, getDocsFromServer, query, Timestamp, where, updateDoc, serverTimestamp,\n\} from "firebase/firestore";\n', '', s, count=1)
s = s.replace('import { doc, updateDoc, serverTimestamp } from "firebase/firestore";\n', '')
s = s.replace('import { auth, db } from "../../firebase";\n', '')
s = s.replace('import { runtimeConfig } from "../../config/runtimeConfig";\n', '')
s = s.replace('import { addDays, parseDate, tanksFrom, weekStart, type Settings, type WeekPlan } from "../../SERVICES/planning/planningEngine";', 'import { addDays, tanksFrom, weekStart, type Settings, type WeekPlan } from "../../SERVICES/planning/planningEngine";')
s = s.replace('import { startOfJerusalemDay, useHolidays, usePlanning, usePlanningToday, type PlanningReadScope } from "../../SERVICES/planning/usePlanning";', 'import { useHolidays, usePlanning, usePlanningToday, type PlanningReadScope } from "../../SERVICES/planning/usePlanning";')
s = re.sub(r'\ntype PlanningQueryTiming = \{[^\n]+\};\n', '\n', s, count=1)
start = s.find('  const planningAuditStartedAt = useRef(Date.now());')
end_anchor = '  const tanks = useMemo(() => tanksFrom(productionTanks, settings, actuals), [productionTanks, settings, actuals]);'
end = s.find(end_anchor)
if start >= 0 and end > start:
    s = s[:start] + s[end:]
s = re.sub(r'\n      \{showPreviewDiagnostics && !data\.loading && !data\.error && \(.*?\n      \)\}', '', s, count=1, flags=re.S)
s = s.replace('{data.offline && <p role="status">ממתין לחיבור לשרת.</p>}', '{data.offline && !data.loading && <p role="status">ממתין לחיבור לשרת.</p>}')
s = s.replace(
    '  const executionPlans = useMemo(() => plansAfterActualPackagingCompletion(identityAlignedPlans, settings.products, actuals, productionTanks), [identityAlignedPlans, settings.products, actuals, productionTanks]);',
    '  const executionPlans = useMemo(() => (tab === "calendar" ? plansAfterActualPackagingCompletion(identityAlignedPlans, settings.products, actuals, productionTanks) : identityAlignedPlans), [tab, identityAlignedPlans, settings.products, actuals, productionTanks]);'
)
s = s.replace(
    '  const weeklyPlans = useMemo(() => pendingPlansAfterActualShipments(executionPlans, data.actualShipments, settings.products), [executionPlans, data.actualShipments, settings.products]);',
    '  const weeklyPlans = useMemo(() => (tab === "calendar" ? pendingPlansAfterActualShipments(executionPlans, data.actualShipments, settings.products) : identityAlignedPlans), [tab, executionPlans, identityAlignedPlans, data.actualShipments, settings.products]);'
)
s = s.replace(
    '  const calendarSettings = useMemo(() => settingsAfterActualShipments(settings, data.actualShipments, today), [settings, data.actualShipments, today]);',
    '  const calendarSettings = useMemo(() => ((tab === "calendar" || tab === "fiveWeeks") ? settingsAfterActualShipments(settings, data.actualShipments, today) : settings), [tab, settings, data.actualShipments, today]);'
)
s = s.replace(
    '  const fiveWeekPlans = useMemo(() => withTentativeFiveWeekTanks(identityAlignedPlans, tanks, calendarSettings), [identityAlignedPlans, tanks, calendarSettings]);',
    '  const fiveWeekPlans = useMemo(() => (tab === "fiveWeeks" ? withTentativeFiveWeekTanks(identityAlignedPlans, tanks, calendarSettings) : identityAlignedPlans), [tab, identityAlignedPlans, tanks, calendarSettings]);'
)
p.write_text(s, encoding='utf-8')

# PlanningGantt: keep the existing business simulation, but pre-index plans and
# actual packaging by week so render helpers stop repeatedly scanning full arrays.
p = Path('src/components/planning/PlanningGantt.tsx')
s = p.read_text(encoding='utf-8')
anchor = '  const actualStockLabel = oldestInventoryUpdate ? `מעודכן ל־${shortDate(oldestInventoryUpdate)}` : "בפועל";\n'
insert = '''  const planByWeek = useMemo(() => new Map(historyPlans.map((plan) => [plan.id, plan])), [historyPlans]);\n  const actualsByWeek = useMemo(() => {\n    const grouped = new Map<string, Actual[]>();\n    for (const actual of actuals) {\n      const date = actualDate(actual);\n      if (!date) continue;\n      const week = weekStart(date);\n      grouped.set(week, [...(grouped.get(week) ?? []), actual]);\n    }\n    return grouped;\n  }, [actuals]);\n'''
if 'const planByWeek = useMemo' not in s:
    if anchor not in s:
        raise SystemExit('Gantt indexing anchor not found')
    s = s.replace(anchor, anchor + insert, 1)
s = s.replace('      const saved = historyPlans.find((plan) => plan.id === week);', '      const saved = planByWeek.get(week);')
s = s.replace('  }, [settings, pallets, tanks, historyPlans, actuals, sources, today, weekIds, holidays, shipments, currentWeek]);', '  }, [settings, pallets, tanks, historyPlans, planByWeek, actuals, sources, today, weekIds, holidays, shipments, currentWeek]);')
s = s.replace('  const decisionPlanFor = (weekId: string) => historyPlans.find((plan) => plan.id === weekId);', '  const decisionPlanFor = (weekId: string) => planByWeek.get(weekId);')
old = '''    const actualItems: SummaryItem[] = actuals\n      .filter((actual) => {\n        const date = actualDate(actual);\n        return !!date && weekStart(date) === weekId && Number(actual.quantity) > 0;\n      })\n      .map((actual) => {'''
new = '''    const actualItems: SummaryItem[] = (actualsByWeek.get(weekId) ?? [])\n      .filter((actual) => Number(actual.quantity) > 0)\n      .map((actual) => {'''
if old in s:
    s = s.replace(old, new, 1)
s = s.replace('message="מעדכן את חלון התכנון…"', 'message="מעדכן…"')
p.write_text(s, encoding='utf-8')

print('Applied deep planning responsiveness pass without changing Firestore queries or business rules.')