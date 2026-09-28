from pathlib import Path

# Allow free-text kettle volume while keeping Grant numeric validation.
form = Path('src/components/brewing/BrewFormStepper.tsx')
text = form.read_text()
old = '''                      <input\n                        type="text"\n                        inputMode="decimal"\n                        required={index === 1}\n                        value={localValue(`rinse${index}.kettle`)}'''
new = '''                      <input\n                        type="text"\n                        required={index === 1}\n                        value={localValue(`rinse${index}.kettle`)}'''
if old not in text:
    raise SystemExit('Expected kettle input block not found')
text = text.replace(old, new, 1)
old = '''    if (!(await approveNumericValue(key, value))) return;\n    const nextFields = { ...fields, [key]: value };'''
new = '''    if (field !== "kettle" && !(await approveNumericValue(key, value))) return;\n    const nextFields = { ...fields, [key]: value };'''
if old not in text:
    raise SystemExit('Expected rinse numeric validation not found')
text = text.replace(old, new, 1)
form.write_text(text)

# Fix print-only unit labels.
server = Path('server/BREWING_SHEET_SERVICE.js')
text = server.read_text()
old = r'''        const processCol = findLabelColumn(row, /^(?:השריה|חימום)\s*[1-3]$|^הכנסת\s*לתת$|^העברה\s*ל?\s*L\.T\.?$|^מנוחה\s*L\.T\.?$|^שטיפה\s*[1-7]$/i);'''
new = r'''        const processCol = findLabelColumn(row, /^(?:השריה|חימום)\s*[1-3]$|^הכנסת\s*לתת$|^העברה\s*ל?\s*L\.T\.?$|^שטיפה\s*[1-7]$/i);'''
if old not in text:
    raise SystemExit('Expected print temperature-label regex not found')
text = text.replace(old, new, 1)
needle = '''        const sugarCol = findLabelColumn(row, /^(?:F\\.R\\.|L\\.R\\.)$/i);'''
insert = '''        const outToBoilCol = findLabelColumn(row, /^הוצאה\\s*לבישול$/i);\n        if (outToBoilCol >= 0 && row.length) {\n          // On the RTL print form, the last logical column is the visual left\n          // edge. Keep the source Sheet unchanged and add the pH label only to\n          // the temporary print copy.\n          row[row.length - 1] = "pH";\n        }\n\n        const sugarCol = findLabelColumn(row, /^(?:F\\.R\\.|L\\.R\\.)$/i);'''
if needle not in text:
    raise SystemExit('Expected sugar label block not found')
text = text.replace(needle, insert, 1)
server.write_text(text)
