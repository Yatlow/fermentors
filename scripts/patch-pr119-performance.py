from pathlib import Path
import re

# Remove the preview-only server probes. They duplicated every planning dataset
# with get*FromServer reads and made preview slower/more expensive than prod.
p = Path('src/components/planning/PlanningView.tsx')
s = p.read_text(encoding='utf-8')
s = s.replace('import { useEffect, useMemo, useRef, useState } from "react";', 'import { useEffect, useMemo, useRef, useState } from "react";')
s = s.replace('''import {\n  collection, doc, getDocFromServer, getDocsFromServer, query, Timestamp, where, updateDoc, serverTimestamp,\n} from "firebase/firestore";''', 'import { doc, updateDoc, serverTimestamp } from "firebase/firestore";')
s = s.replace('import { runtimeConfig } from "../../config/runtimeConfig";\n', '')
s = s.replace('import { addDays, parseDate, tanksFrom, weekStart, type Settings, type WeekPlan } from "../../SERVICES/planning/planningEngine";', 'import { addDays, tanksFrom, weekStart, type Settings, type WeekPlan } from "../../SERVICES/planning/planningEngine";')
s = s.replace('import { startOfJerusalemDay, useHolidays, usePlanning, usePlanningToday, type PlanningReadScope } from "../../SERVICES/planning/usePlanning";', 'import { useHolidays, usePlanning, usePlanningToday, type PlanningReadScope } from "../../SERVICES/planning/usePlanning";')
s = re.sub(r'\ntype PlanningQueryTiming = \{[^\n]+\};\n', '\n', s, count=1)
s = re.sub(r'\n  const planningAuditStartedAt = useRef\(Date\.now\(\)\);.*?\n  const showPreviewDiagnostics = runtimeConfig\.deployEnv !== "production";\n', '\n', s, count=1, flags=re.S)
start = s.find('  useEffect(() => {\n    if (data.loading || planningAuditLogged.current) return;')
end_marker = '  const tanks = useMemo(() => tanksFrom(productionTanks, settings, actuals), [productionTanks, settings, actuals]);'
end = s.find(end_marker)
if start == -1 or end == -1 or end <= start:
    raise SystemExit('Planning diagnostics block anchor not found')
s = s[:start] + s[end:]
s, n = re.subn(r'\n      \{showPreviewDiagnostics && !data\.loading && !data\.error && \(.*?\n      \)\}', '', s, count=1, flags=re.S)
if n != 1:
    raise SystemExit('Planning diagnostics JSX anchor not found')
p.write_text(s, encoding='utf-8')

# Make pagination responsive without changing Firestore scope/query behavior.
p = Path('src/components/planning/PlanningGantt.tsx')
s = p.read_text(encoding='utf-8')
s = s.replace('import { Fragment, useMemo, useState } from "react";', 'import { Fragment, useMemo, useState, useTransition } from "react";', 1)
anchor = 'import PlanningGanttDailyModal from "./PlanningGanttDailyModal";\n'
if anchor not in s:
    raise SystemExit('Gantt import anchor not found')
s = s.replace(anchor, anchor + 'import BeerLoader from "../general/Loading";\n', 1)
anchor = '  const [weekPage, setWeekPage] = useState(0);\n'
if anchor not in s:
    raise SystemExit('weekPage anchor not found')
s = s.replace(anchor, anchor + '''  const [isPaging, startPaginationTransition] = useTransition();\n  const changeWeekPage = (next: number | ((current: number) => number)) => {\n    startPaginationTransition(() => setWeekPage(next));\n  };\n''', 1)
rest_start = s.index('  const currentWeek = weekStart(today);')
head, rest = s[:rest_start], s[rest_start:]
call_count = rest.count('setWeekPage(')
if call_count < 1:
    raise SystemExit('No pagination setter call sites found')
rest = rest.replace('setWeekPage(', 'changeWeekPage(')
s = head + rest
root_candidates = ['<section className="bp-gantt', '<div className="bp-gantt']
pos = max(s.rfind(candidate) for candidate in root_candidates)
if pos < 0:
    raise SystemExit('Gantt root JSX anchor not found')
line_end = s.find('>', pos)
if line_end < 0:
    raise SystemExit('Gantt root opening tag malformed')
s = s[:line_end+1] + '\n      {isPaging && <BeerLoader overlay message="מעדכן את חלון התכנון…" />}' + s[line_end+1:]
p.write_text(s, encoding='utf-8')

print(f'Patched PlanningView diagnostics and {call_count} Gantt pagination call(s).')