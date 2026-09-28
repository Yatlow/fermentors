from pathlib import Path
import re

# 1) Brew form: remove automatic date writes and make acid rows semantic even when blank.
path = Path('src/components/brewing/BrewFormStepper.tsx')
text = path.read_text()

# Remove the automatic date default that runs after hydration/reconciliation.
pattern = re.compile(
    r'\n  useEffect\(\(\) => \{\n'
    r'(?:(?!\n  \}, \[).)*?'
    r'void commitBrewDate\(shortIsraeliDate\(iso\), \{ manual: false \}\);\n'
    r'(?:(?!\n  \}, \[).)*?'
    r'\n  \}, \[[^\n]*\]\);\n',
    re.S,
)
match = pattern.search(text)
if not match:
    raise SystemExit('Automatic brew-date useEffect not found')
text = text[:match.start()] + '\n' + text[match.end():]

# That effect was the only consumer of this state.
old = '  const [initialSheetReconciled, setInitialSheetReconciled] = useState(false);\n'
if old not in text:
    raise SystemExit('initialSheetReconciled state not found')
text = text.replace(old, '', 1)

# Remove mash-start date refresh helper entirely.
pattern = re.compile(
    r'\n  function refreshAutoBrewDateOnMashStart\([\s\S]*?\n  \}\n\n  async function commitStageStart',
)
match = pattern.search(text)
if not match:
    raise SystemExit('refreshAutoBrewDateOnMashStart helper not found')
text = text[:match.start()] + '\n\n  async function commitStageStart' + text[match.end():]

# Remove the call that changed an auto-assigned date when mash-in started.
old = '''    // Opening an old B/C must never change its date. Only the actual mash-in\n    // start is allowed to refresh an automatically assigned date.\n    if (stage.key === "mashIn" && value) {\n      nextExecution = refreshAutoBrewDateOnMashStart(nextExecution, writes);\n    }\n\n'''
if old not in text:
    raise SystemExit('Mash-start auto-date refresh call not found')
text = text.replace(old, '', 1)

# Discover both H3PO4 rows by their semantic label even if the second amount is blank.
# Otherwise three-rest templates fall back to a fixed row and write boil acid into the wrong cell.
old = '''    .filter((item) => /H3PO4/i.test(item.type) && !!item.amount);'''
new = '''    .filter((item) => /H3PO4/i.test(item.type));'''
if old not in text:
    raise SystemExit('Acid row filter not found')
text = text.replace(old, new, 1)

path.write_text(text)

# 2) ACTION 0 -> 1: only the canonical fermentation volume from extractBrew may transition.
path = Path('server/BREW_ACTION_SERVICE.js')
text = path.read_text()
old = '''  if (\n    stageInfo.beerVolume !== null &&\n    stageInfo.beerVolume !== undefined\n  ) {\n\n    updateFermentorAction(\n      tankNumber,\n      1\n    );\n\n    return;\n  }\n\n  if (stageInfo.hasUnstartedHeader) {\n\n    Logger.log(\n      "Tank " +\n      tankNumber +\n      ": another planned brew block hasn't started yet - staying ACTION 0."\n    );\n\n    return;\n  }\n\n  const outStage =\n    stageInfo.lastBlock.stages.find(\n      function (s) {\n        return s.code === STAGE_CODE_OUT_TO_FERMENTOR;\n      }\n    );\n\n  if (\n    outStage &&\n    outStage.startDateTime\n  ) {\n\n    const graceMs =\n      2 * 60 * 60 * 1000;\n\n    if (\n      Date.now() -\n      outStage.startDateTime.getTime() >=\n      graceMs\n    ) {\n\n      updateFermentorAction(\n        tankNumber,\n        1\n      );\n\n      return;\n    }\n  }\n'''
new = '''  // ACTION 0 -> 1 is driven only by the canonical fermentation-volume\n  // extraction used by the dashboard/sync. Process times and brew dates are\n  // useful for progress display, but must never guess that beer reached the tank.\n  let canonicalBrew = null;\n  try {\n    canonicalBrew = extractBrew(sheetUrl);\n  } catch (error) {\n    Logger.log(\n      "Tank " + tankNumber +\n      ": canonical fermentation volume read failed - staying ACTION 0: " +\n      error.message\n    );\n    return;\n  }\n\n  const fermentationVolume = canonicalBrew\n    ? Number(canonicalBrew.beerVolume)\n    : NaN;\n\n  if (Number.isFinite(fermentationVolume) && fermentationVolume > 0) {\n    updateFermentorAction(\n      tankNumber,\n      1\n    );\n    return;\n  }\n\n  Logger.log(\n    "Tank " + tankNumber +\n    ": no fermentation volume yet - staying ACTION 0."\n  );\n'''
if old not in text:
    raise SystemExit('ACTION 0 legacy transition block not found')
text = text.replace(old, new, 1)
path.write_text(text)

# 3) Stage extraction remains read-only: never backfill brew dates into the Sheet.
path = Path('server/extractBrewStageInfo.js')
text = path.read_text()
pattern = re.compile(
    r'\n  const beerVolume = brewStageFindBeerVolume_\(values\);\n\n'
    r'  const outStage =[\s\S]*?'
    r'  if \(readyForAction1\) \{[\s\S]*?\n  \}\n\n'
    r'  const dateAssumed =',
)
match = pattern.search(text)
if not match:
    raise SystemExit('Stage readyForAction1/date reconciliation block not found')
text = text[:match.start()] + '\n\n  const dateAssumed =' + text[match.end():]
text = text.replace('    beerVolume: beerVolume,\n', '', 1)
path.write_text(text)
