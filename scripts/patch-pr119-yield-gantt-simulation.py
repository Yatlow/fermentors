from pathlib import Path

p = Path('src/components/planning/PlanningGantt.tsx')
s = p.read_text(encoding='utf-8')
s = s.replace('import { Fragment, useMemo, useState, useTransition } from "react";', 'import { Fragment, useEffect, useMemo, useRef, useState, useTransition } from "react";', 1)
start = s.index('  const simulations = useMemo(() => {')
end_marker = '\n\n  const productFor = (id: string) => settings.products.find((product) => product.id === id);'
end = s.index(end_marker, start)
old = s[start:end]
body_start = old.index('    const result = new Map<string, SimulatedWeek>();')
body_end = old.rindex('\n    return result;')
body = old[body_start:body_end]
# Turn the synchronous visible-week loop into an async, paint-friendly loop.
body = body.replace('    for (const week of weekIds) {', '    for (const week of weekIds) {\n      if (cancelled || generation !== simulationGeneration.current) return;\n      await new Promise<void>((resolve) => requestAnimationFrame(() => window.setTimeout(resolve, 0)));', 1)
# Yield after each expensive model rebuild, not just after each week. This keeps
# the exact same ordering/business logic while allowing paint/input between CPU bursts.
body = body.replace('            model = buildModel(week);', '            model = buildModel(week);\n            await new Promise<void>((resolve) => requestAnimationFrame(() => window.setTimeout(resolve, 0)));')
body = body.replace('            model = buildModel(week);', '            model = buildModel(week);\n            await new Promise<void>((resolve) => requestAnimationFrame(() => window.setTimeout(resolve, 0)));')
# The replacements above catch all identical occurrences; also yield after initial model.
body = body.replace('      let model = buildModel(week);', '      let model = buildModel(week);\n      await new Promise<void>((resolve) => requestAnimationFrame(() => window.setTimeout(resolve, 0)));', 1)
new = '''  const [simulations, setSimulations] = useState<Map<string, SimulatedWeek>>(() => new Map());
  const [isSimulating, setIsSimulating] = useState(true);
  const simulationGeneration = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const generation = ++simulationGeneration.current;
    setIsSimulating(true);

    const run = async () => {
''' + body + '''
      if (cancelled || generation !== simulationGeneration.current) return;
      setSimulations(result);
      setIsSimulating(false);
    };

    // Let the loader/previous UI paint before starting planning CPU work.
    const timer = window.setTimeout(() => { void run(); }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [settings, pallets, tanks, historyPlans, planByWeek, actuals, sources, today, weekIds, holidays, shipments, currentWeek]);'''
s = s[:start] + new + s[end:]
# Keep an overlay up for initial/pagination recomputation; unlike the old synchronous
# useMemo this overlay now gets real animation frames between simulation chunks.
needle = '{isPaging && <BeerLoader overlay message="מעדכן…" />}'
if needle in s:
    s = s.replace(needle, '{(isPaging || isSimulating) && <BeerLoader overlay message="מעדכן…" />}', 1)
else:
    raise SystemExit('paging loader anchor not found')
p.write_text(s, encoding='utf-8')
print('Converted Gantt simulation to chunked async work with browser yields.')
