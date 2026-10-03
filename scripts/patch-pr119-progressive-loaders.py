from pathlib import Path

p = Path('src/components/planning/PlanningGantt.tsx')
s = p.read_text(encoding='utf-8')

# Clear stale simulations as soon as a new visible horizon starts calculating.
s = s.replace(
'''    const generation = ++simulationGeneration.current;
    setIsSimulating(true);

    const run = async () => {''',
'''    const generation = ++simulationGeneration.current;
    setIsSimulating(true);
    setSimulations(new Map());

    const run = async () => {''', 1)

# Publish each completed week immediately instead of waiting for all five.
old = '''      result.set(week, {
        model,
        effectivePlan: workingPlan,
        deliveryRecommendation,
        packagingRecommendation,
        brewRecommendation,
      });
    }

      if (cancelled || generation !== simulationGeneration.current) return;
      setSimulations(result);
      setIsSimulating(false);'''
new = '''      result.set(week, {
        model,
        effectivePlan: workingPlan,
        deliveryRecommendation,
        packagingRecommendation,
        brewRecommendation,
      });
      if (cancelled || generation !== simulationGeneration.current) return;
      setSimulations(new Map(result));
    }

      if (cancelled || generation !== simulationGeneration.current) return;
      setIsSimulating(false);'''
if old not in s:
    raise SystemExit('progressive simulation anchor not found')
s = s.replace(old, new, 1)

# Do not cover the summary grid with a global loader: individual pending cells show hop spinners.
s = s.replace('      {isPaging && <BeerLoader overlay message="מעדכן…" />}\n', '', 1)

# A week is pending until its simulation has actually been published.
needle = '''              {weekIds.map((weekId) => {
                const items = itemsFor(row.id, weekId);'''
replacement = '''              {weekIds.map((weekId) => {
                const weekPending = isSimulating && !simulations.has(weekId);
                const items = weekPending ? [] : itemsFor(row.id, weekId);'''
if needle not in s:
    raise SystemExit('cell loading anchor not found')
s = s.replace(needle, replacement, 1)

# Spinner takes the place of the ambiguous dash while a cell's week is calculating.
s = s.replace(
'                    {!items.length && <span className="bp-five-week-empty">—</span>}',
'                    {weekPending ? <BeerLoader size="spinner" message="" /> : !items.length && <span className="bp-five-week-empty">—</span>}',
1)

# Calendar/weekly-recommendations mode keeps a central loader during initial load and week-page changes.
s = s.replace(
'{(isPaging || isSimulating) && <BeerLoader overlay message="מעדכן…" />}',
'{(isPaging || isSimulating) && <BeerLoader overlay message={isPaging ? "טוען שבוע…" : "טוען המלצות שבועיות…"} />}',
1)

p.write_text(s, encoding='utf-8')
print('Applied progressive Gantt cells + weekly recommendations loaders.')
