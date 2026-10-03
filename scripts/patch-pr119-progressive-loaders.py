from pathlib import Path

p = Path('src/components/planning/PlanningGantt.tsx')
s = p.read_text(encoding='utf-8')

# Keep the last rendered simulations visible while the next generation computes.
# Track pending weeks separately so loading feedback can sit on top of stale data
# instead of clearing/rebuilding the grid.
s = s.replace(
'''  const [simulations, setSimulations] = useState<Map<string, SimulatedWeek>>(() => new Map());
  const [isSimulating, setIsSimulating] = useState(true);
  const simulationGeneration = useRef(0);''',
'''  const [simulations, setSimulations] = useState<Map<string, SimulatedWeek>>(() => new Map());
  const [isSimulating, setIsSimulating] = useState(true);
  const [pendingSimulationWeeks, setPendingSimulationWeeks] = useState<Set<string>>(() => new Set());
  const simulationGeneration = useRef(0);''', 1)

s = s.replace(
'''    const generation = ++simulationGeneration.current;
    setIsSimulating(true);
    setSimulations(new Map());''',
'''    const generation = ++simulationGeneration.current;
    setIsSimulating(true);
    setPendingSimulationWeeks(new Set(weekIds));''', 1)

# Merge each completed week into the existing cache. Do not discard stale weeks.
s = s.replace(
'''      if (cancelled || generation !== simulationGeneration.current) return;
      setSimulations(new Map(result));''',
'''      if (cancelled || generation !== simulationGeneration.current) return;
      const completed = result.get(week);
      if (completed) {
        setSimulations((previous) => {
          const next = new Map(previous);
          next.set(week, completed);
          return next;
        });
      }
      setPendingSimulationWeeks((previous) => {
        const next = new Set(previous);
        next.delete(week);
        return next;
      });''', 1)

s = s.replace(
'''      if (cancelled || generation !== simulationGeneration.current) return;
      setIsSimulating(false);''',
'''      if (cancelled || generation !== simulationGeneration.current) return;
      setPendingSimulationWeeks(new Set());
      setIsSimulating(false);''', 1)

# A pending week may still have stale content. Keep rendering that content and
# show a centered, non-interactive hop spinner over it until the replacement is ready.
s = s.replace(
'''                const weekPending = isSimulating && !simulations.has(weekId);
                const items = weekPending ? [] : itemsFor(row.id, weekId);''',
'''                const weekPending = pendingSimulationWeeks.has(weekId);
                const items = itemsFor(row.id, weekId);''', 1)

s = s.replace(
'''                    {weekPending ? <BeerLoader size="spinner" message="" /> : !items.length && <span className="bp-five-week-empty">—</span>}''',
'''                    {weekPending && <div className="bp-gantt-cell-loader"><BeerLoader size="spinner" message="" /></div>}
                    {!items.length && !weekPending && <span className="bp-five-week-empty">—</span>}''', 1)

p.write_text(s, encoding='utf-8')

# Center the hop spinner both horizontally and vertically without changing cell
# geometry. The stale cell remains visible beneath a light veil.
p = Path('src/components/general/beer-loader.css')
css = p.read_text(encoding='utf-8')
rule = '.bp-five-week-cell{position:relative}.bp-gantt-cell-loader{position:absolute;inset:0;z-index:4;display:grid;place-items:center;pointer-events:none;background:rgba(255,255,255,.58)}.bp-gantt-cell-loader .beer-loader{width:100%;height:100%;display:grid;place-items:center}'
if '.bp-gantt-cell-loader{' not in css:
    css += '\n' + rule + '\n'
p.write_text(css, encoding='utf-8')

print('Applied stale-while-loading Gantt simulations with centered cell spinners.')
