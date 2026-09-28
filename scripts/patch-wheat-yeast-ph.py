from pathlib import Path

# 1) Do not add a second print-only pH label. The Master already contains it.
server = Path('server/BREWING_SHEET_SERVICE.js')
text = server.read_text()
old = '''        const outToBoilCol = findLabelColumn(row, /^הוצאה\\s*לבישול$/i);\n        if (outToBoilCol >= 0 && row.length) {\n          // On the RTL print form, the last logical column is the visual left\n          // edge. Keep the source Sheet unchanged and add the pH label only to\n          // the temporary print copy.\n          row[row.length - 1] = "pH";\n        }\n\n'''
if old not in text:
    raise SystemExit('Expected print-only pH block not found')
text = text.replace(old, '', 1)
server.write_text(text)

# 2) In three-rest recipes, four rows are inserted before the downstream
# material area. Yeast is only written for brew A, so offset its physical row
# by those inserted rows instead of writing into the pre-insertion position.
form = Path('src/components/brewing/BrewFormStepper.tsx')
text = form.read_text()
old = '''        const row = baseRow + 23;\n        const yeastAmount ='''
new = '''        const mashHasThirdRest = recipe.mash.steps.some((step) => step.id === "rest3");\n        const row = baseRow + 23 + (mashHasThirdRest ? 4 : 0);\n        const yeastAmount ='''
if old not in text:
    raise SystemExit('Expected yeast row calculation not found')
text = text.replace(old, new, 1)
form.write_text(text)
