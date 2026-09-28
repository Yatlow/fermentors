from pathlib import Path

path = Path('src/components/planning/PlanningBrewAssignmentEditor.tsx')
text = path.read_text()

text = text.replace(
    'import type { Release } from "../../SERVICES/planning/productionCycle";',
    'import { brewSizeLabel, type Release } from "../../SERVICES/planning/productionCycle";',
    1,
)

needle = '''function sourceForAssignedTank(brew: BrewPlanWithMeta, sources: Fermentor[]) {\n  if (!brew.tankId) return undefined;\n  return sources.find((item) => item.id === brew.tankId)\n    ?? sources.find((item) => String(item.tankNumber) === String(brew.tankId));\n}\n'''
replacement = needle + '''\nfunction canonicalTankId(brew: BrewPlanWithMeta, sources: Fermentor[]): string {\n  return sourceForAssignedTank(brew, sources)?.id ?? brew.tankId;\n}\n\nfunction compatibleTankForBrew(brew: BrewPlanWithMeta, tank: Fermentor): boolean {\n  return tankKind(tank.tankNumber) === brewSizeLabel(Number(brew.liters) || 0);\n}\n'''
if needle not in text:
    raise SystemExit('sourceForAssignedTank block not found')
text = text.replace(needle, replacement, 1)

needle = '''  const [draft, setDraft] = useState<WeekPlan>(() => {\n    const copy = structuredClone(initial);\n    const hasSavedBatchIdentity = copy.brews.some(\n'''
replacement = '''  const [draft, setDraft] = useState<WeekPlan>(() => {\n    const copy = structuredClone(initial);\n    // Weekly planning may persist a tentative tank as either the Firestore id or\n    // the human tank number. Canonicalize it on first open so the work manager\n    // sees the tentative recommendation already selected instead of starting blank.\n    copy.brews = copy.brews.map((brew) =>\n      brew.tankId ? { ...brew, tankId: canonicalTankId(brew, brews) } : brew,\n    );\n    const hasSavedBatchIdentity = copy.brews.some(\n'''
if needle not in text:
    raise SystemExit('draft initializer not found')
text = text.replace(needle, replacement, 1)

needle = '''  function setTank(index: number, tankId: string) {\n    const targetRelease = releases.find((item) => item.tankId === tankId);\n    setDraft((current) => {\n'''
replacement = '''  function setTank(index: number, tankId: string) {\n    const selectedForGuard = orderedBrews[index];\n    const targetTank = brews.find((item) => item.id === tankId);\n    if (!selectedForGuard || !targetTank || !compatibleTankForBrew(selectedForGuard, targetTank)) {\n      const required = selectedForGuard ? brewSizeLabel(Number(selectedForGuard.liters) || 0) : "";\n      setError(required ? `בישול ${required} ניתן לשבץ רק למיכל ${required}.` : "המיכל אינו תואם לגודל הבישול.");\n      return;\n    }\n\n    const previousSource = selectedForGuard.tankId\n      ? sourceForAssignedTank(selectedForGuard, brews)\n      : undefined;\n    const otherIndexForGuard = orderedBrews.findIndex((brew, i) => i !== index && canonicalTankId(brew, brews) === tankId);\n    if (otherIndexForGuard >= 0 && previousSource) {\n      const other = orderedBrews[otherIndexForGuard];\n      if (!compatibleTankForBrew(other, previousSource)) {\n        const required = brewSizeLabel(Number(other.liters) || 0);\n        setError(`לא ניתן להחליף: אצווה ${other.batchNumber} היא בישול ${required} ומיכל ${previousSource.tankNumber} אינו ${required}.`);\n        return;\n      }\n    }\n\n    const targetRelease = releases.find((item) => item.tankId === tankId);\n    setDraft((current) => {\n'''
if needle not in text:
    raise SystemExit('setTank start not found')
text = text.replace(needle, replacement, 1)

needle = '''      const previousTankId = selected.tankId;\n      const otherIndex = next.findIndex((brew, i) => i !== index && brew.tankId === tankId);\n      const previousRelease = previousTankId ? releases.find((item) => item.tankId === previousTankId) : undefined;\n'''
replacement = '''      const previousTankId = selected.tankId ? canonicalTankId(selected, brews) : "";\n      const otherIndex = next.findIndex((brew, i) => i !== index && canonicalTankId(brew, brews) === tankId);\n      const previousRelease = previousTankId ? releases.find((item) => item.tankId === previousTankId) : undefined;\n'''
if needle not in text:
    raise SystemExit('setTank swap block not found')
text = text.replace(needle, replacement, 1)

needle = '''  async function save() {\n    if (orderedBrews.some((brew) => !brew.tankId)) {\n      setError("יש לשבץ מיכל לכל בישול לפני השמירה.");\n      return;\n    }\n    setBusy(true);\n'''
replacement = '''  async function save() {\n    if (orderedBrews.some((brew) => !brew.tankId)) {\n      setError("יש לשבץ מיכל לכל בישול לפני השמירה.");\n      return;\n    }\n    const incompatible = orderedBrews.find((brew) => {\n      const source = sourceForAssignedTank(brew, brews);\n      return !source || !compatibleTankForBrew(brew, source);\n    });\n    if (incompatible) {\n      const required = brewSizeLabel(Number(incompatible.liters) || 0);\n      setError(`אצווה ${incompatible.batchNumber}: בישול ${required} חייב להיות משובץ למיכל ${required}.`);\n      return;\n    }\n    setBusy(true);\n'''
if needle not in text:
    raise SystemExit('save validation block not found')
text = text.replace(needle, replacement, 1)

text = text.replace(
    '            const source = brews.find((item) => item.id === brew.tankId);',
    '            const source = sourceForAssignedTank(brew, brews);',
    1,
)

needle = '''          <div className="bp-brew-placement-title">\n            <b>אצווה {selectedBrew.batchNumber} · {displayStyle(selectedBrew.style)}</b>\n            <small>כל המיכלים שצפויים להיות פנויים במהלך השבוע מוצגים כאן, גם אם כרגע שובצו לאצווה אחרת.</small>\n          </div>\n'''
replacement = '''          <div className="bp-brew-placement-title">\n            <b>אצווה {selectedBrew.batchNumber} · {displayStyle(selectedBrew.style)} · {brewSizeLabel(Number(selectedBrew.liters) || 0)}</b>\n            <small>כל המיכלים שצפויים להיות פנויים במהלך השבוע מוצגים כאן. ניתן לבחור רק מיכל בגודל {brewSizeLabel(Number(selectedBrew.liters) || 0)}.</small>\n          </div>\n'''
if needle not in text:
    raise SystemExit('placement title block not found')
text = text.replace(needle, replacement, 1)

needle = '''            {allWeekTanks.map((tank) => {\n              const isAssigned = selectedBrew.tankId === tank.id;\n              const assignedTo = orderedBrews.findIndex((brew) => brew.tankId === tank.id);\n              const occupiedByOther = assignedTo >= 0 && assignedTo !== selectedIndex;\n              return <button\n                type="button"\n                key={tank.id}\n                className={`bp-brew-tank-visual bp-brew-tank-visual-compact ${isAssigned ? "is-assigned" : ""}`}\n                onClick={() => setTank(selectedIndex, tank.id)}\n                title={occupiedByOther ? `החלף עם אצווה ${orderedBrews[assignedTo]?.batchNumber}` : `שבץ למיכל ${tank.tankNumber}`}\n              >\n'''
replacement = '''            {allWeekTanks.map((tank) => {\n              const compatible = compatibleTankForBrew(selectedBrew, tank);\n              const selectedTankId = canonicalTankId(selectedBrew, brews);\n              const isAssigned = selectedTankId === tank.id;\n              const assignedTo = orderedBrews.findIndex((brew) => canonicalTankId(brew, brews) === tank.id);\n              const occupiedByOther = assignedTo >= 0 && assignedTo !== selectedIndex;\n              const requiredKind = brewSizeLabel(Number(selectedBrew.liters) || 0);\n              return <button\n                type="button"\n                key={tank.id}\n                className={`bp-brew-tank-visual bp-brew-tank-visual-compact ${isAssigned ? "is-assigned" : ""}`}\n                onClick={() => setTank(selectedIndex, tank.id)}\n                disabled={!compatible}\n                aria-disabled={!compatible}\n                title={!compatible\n                  ? `בישול ${requiredKind} ניתן לשבץ רק למיכל ${requiredKind}`\n                  : occupiedByOther\n                    ? `החלף עם אצווה ${orderedBrews[assignedTo]?.batchNumber}`\n                    : `שבץ למיכל ${tank.tankNumber}`}\n              >\n'''
if needle not in text:
    raise SystemExit('tank map block not found')
text = text.replace(needle, replacement, 1)

path.write_text(text)
