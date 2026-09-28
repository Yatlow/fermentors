from pathlib import Path

path = Path("src/components/planning/PlanningBoard.tsx")
text = path.read_text()

old = '''  async function persist(next: WeekPlan, confirmBrews = false) {\n    if (weekIsClosed(next.id, today)) throw new Error("השבוע נסגר לתכנון בתחילת יום שישי.");\n    const confirmedNext = confirmBrews ? confirmAssignedBrews(next) : next;\n'''
new = '''  async function persist(next: WeekPlan, confirmBrews = false) {\n    if (weekIsClosed(next.id, today)) throw new Error("השבוע נסגר לתכנון בתחילת יום שישי.");\n    // The dedicated brew-assignment editor never edits packaging. Remember that\n    // before normalization adds derived flags, so existing packaging exceptions\n    // cannot block an unrelated brew save or open a hidden confirmation dialog.\n    const packagingWasEdited = JSON.stringify(next.packaging) !== JSON.stringify(current.packaging);\n    const confirmedNext = confirmBrews ? confirmAssignedBrews(next) : next;\n'''
if old not in text:
    raise SystemExit("persist header not found")
text = text.replace(old, new, 1)

old = '''    let production = validateProduction(datedOnly, settings, validationTanks, actuals, today);\n    if (production?.includes("לפני מועד ההבשלה")) {\n      setBusy(false);\n      const approved = await requestEarlyPackagingOverride(production);\n      if (!approved) throw new Error("השיבוץ בוטל.");\n      setBusy(true);\n\n      effectiveNext = {\n        ...effectiveNext,\n        packaging: effectiveNext.packaging.map((run) => {\n          if (!run.date || !run.tankId) return run;\n          const tank = validationTanks.find((item) => item.id === run.tankId);\n          return tank && run.date < tank.ready\n            ? { ...run, earlyPackagingOverride: true }\n            : run;\n        }),\n      };\n      all = [...plans.filter((w) => w.id !== effectiveNext.id), effectiveNext];\n      datedOnly = all.map((w) => ({ ...w, packaging: w.packaging.filter((run) => !!run.date) }));\n      validationTanks = futureTanks(tanks, all, settings);\n      production = validateProduction(datedOnly, settings, validationTanks, actuals, today);\n    }\n'''
new = '''    let production = validateProduction(datedOnly, settings, validationTanks, actuals, today);\n    if (production?.includes("לפני מועד ההבשלה")) {\n      if (confirmBrews && !packagingWasEdited) {\n        // This save changes only brew order/tank assignment. Any early packaging\n        // here is an already-existing planner decision, so do not make the brew\n        // save wait for a packaging confirmation that this focused UI cannot own.\n        production = validateProduction(\n          datedOnly,\n          settings,\n          validationTanks,\n          actuals,\n          today,\n          { allowEarlyPackaging: true },\n        );\n      } else {\n        setBusy(false);\n        const approved = await requestEarlyPackagingOverride(production);\n        if (!approved) throw new Error("השיבוץ בוטל.");\n        setBusy(true);\n\n        effectiveNext = {\n          ...effectiveNext,\n          packaging: effectiveNext.packaging.map((run) => {\n            if (!run.date || !run.tankId) return run;\n            const tank = validationTanks.find((item) => item.id === run.tankId);\n            return tank && run.date < tank.ready\n              ? { ...run, earlyPackagingOverride: true }\n              : run;\n          }),\n        };\n        all = [...plans.filter((w) => w.id !== effectiveNext.id), effectiveNext];\n        datedOnly = all.map((w) => ({ ...w, packaging: w.packaging.filter((run) => !!run.date) }));\n        validationTanks = futureTanks(tanks, all, settings);\n        production = validateProduction(datedOnly, settings, validationTanks, actuals, today);\n      }\n    }\n'''
if old not in text:
    raise SystemExit("early packaging validation block not found")
text = text.replace(old, new, 1)

old = '''  if (brewAssignmentOnly) {\n    return <section className="bp-gantt-brew-assignment-only">\n      {busy && <BeerLoader overlay message="שומר שיבוצי בישול…" />}\n'''
new = '''  const earlyPackagingDialog = earlyPackagingWarning && <div className="bp-modal-backdrop" role="presentation">\n    <div className="bp-modal" role="dialog" aria-modal="true" aria-labelledby="bp-early-packaging-title">\n      <div className="bp-editor-header">\n        <div>\n          <h3 id="bp-early-packaging-title">חריגה ממועד הבשלת המיכל</h3>\n          <small>האריזה שובצה לפני המועד שבו המיכל צפוי להיות בשל.</small>\n        </div>\n      </div>\n      <p className="bp-alert">{earlyPackagingWarning}</p>\n      <p>אפשר לחרוג מההתראה ולשמור את השיבוץ בכל זאת. זו חריגה תפעולית בהחלטת המתכנן או מנהל העבודה.</p>\n      <div className="bp-actions">\n        <button type="button" onClick={() => resolveEarlyPackagingOverride(false)}>ביטול</button>\n        <button type="button" className="bp-action-warning" onClick={() => resolveEarlyPackagingOverride(true)}>חרוג ושבץ</button>\n      </div>\n    </div>\n  </div>;\n\n  if (brewAssignmentOnly) {\n    return <section className="bp-gantt-brew-assignment-only">\n      {earlyPackagingDialog}\n      {busy && <BeerLoader overlay message="שומר שיבוצי בישול…" />}\n'''
if old not in text:
    raise SystemExit("brewAssignmentOnly block not found")
text = text.replace(old, new, 1)

old = '''  return <section>\n    {earlyPackagingWarning && <div className="bp-modal-backdrop" role="presentation">\n      <div className="bp-modal" role="dialog" aria-modal="true" aria-labelledby="bp-early-packaging-title">\n        <div className="bp-editor-header">\n          <div>\n            <h3 id="bp-early-packaging-title">חריגה ממועד הבשלת המיכל</h3>\n            <small>האריזה שובצה לפני המועד שבו המיכל צפוי להיות בשל.</small>\n          </div>\n        </div>\n        <p className="bp-alert">{earlyPackagingWarning}</p>\n        <p>אפשר לחרוג מההתראה ולשמור את השיבוץ בכל זאת. זו חריגה תפעולית בהחלטת המתכנן או מנהל העבודה.</p>\n        <div className="bp-actions">\n          <button type="button" onClick={() => resolveEarlyPackagingOverride(false)}>ביטול</button>\n          <button type="button" className="bp-action-warning" onClick={() => resolveEarlyPackagingOverride(true)}>חרוג ושבץ</button>\n        </div>\n      </div>\n    </div>}\n'''
new = '''  return <section>\n    {earlyPackagingDialog}\n'''
if old not in text:
    raise SystemExit("main early packaging dialog not found")
text = text.replace(old, new, 1)

path.write_text(text)

# One-shot helper files should not remain in the PR.
Path("scripts/patch-brew-assignment-save-deadlock.py").unlink(missing_ok=True)
Path(".github/workflows/fix-brew-assignment-save-deadlock.yml").unlink(missing_ok=True)
