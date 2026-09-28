from pathlib import Path
import re

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

path.write_text(text)
