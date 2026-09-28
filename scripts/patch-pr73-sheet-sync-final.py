from pathlib import Path

# 1) Fix Apps Script -> Firestore field path for numeric block map keys.
server = Path('server/BREWING_SHEET_SERVICE.js')
text = server.read_text()
old = '    masks.push("brewingExecution.blocks." + blockIndex + ".fields.%60" + encodeURIComponent(key) + "%60");'
new = '    masks.push("brewingExecution.blocks.%60" + encodeURIComponent(String(blockIndex)) + "%60.fields.%60" + encodeURIComponent(key) + "%60");'
if old not in text:
    raise SystemExit('Expected Firestore update-mask line not found')
text = text.replace(old, new, 1)
server.write_text(text)

# 2) Fix rinse UX/sync behavior in BrewFormStepper.
form = Path('src/components/brewing/BrewFormStepper.tsx')
text = form.read_text()

# Kettle should be text-style input on mobile while still validated numerically on blur.
old_input = '''                    <label>\n                      נפח ב-Kettle\n                      <input\n                        type="number"\n                        required={index === 1}\n                        value={localValue(`rinse${index}.kettle`)}'''
new_input = '''                    <label>\n                      נפח ב-Kettle\n                      <input\n                        type="text"\n                        inputMode="decimal"\n                        required={index === 1}\n                        value={localValue(`rinse${index}.kettle`)}'''
if old_input not in text:
    raise SystemExit('Expected rinse kettle input not found')
text = text.replace(old_input, new_input, 1)

# Persist default 150 whenever any non-empty rinse field is committed, not only time.
start = text.find('  async function commitRinse(\n')
end = text.find('\n  async function commitSugar(', start)
if start < 0 or end < 0:
    raise SystemExit('commitRinse function bounds not found')
old_fn = text[start:end]
new_fn = '''  async function commitRinse(\n    index: number,\n    field: string,\n    value: string,\n  ) {\n    const rowOffset = 18 + (index - 1);\n    const key = `rinse${index}.${field}`;\n\n    const withDefaultAmount = (\n      currentExecution: BrewExecution,\n      writes: Array<{ range: string; value: string | number | boolean | null }>,\n    ) => {\n      const amountKey = `rinse${index}.amount`;\n      if (\n        field !== "amount" &&\n        String(value || "").trim() &&\n        !String(fields[amountKey] || "").trim()\n      ) {\n        currentExecution = setBrewingExecutionField(\n          currentExecution,\n          currentBlock,\n          amountKey,\n          "150",\n        );\n        writes.push({\n          range: stageCell(rowOffset, "F"),\n          value: 150,\n        });\n      }\n      return currentExecution;\n    };\n\n    if (field === "time") {\n      if (rejectTimelineTime(key, value)) return;\n\n      let nextExecution = setBrewingExecutionField(\n        execution,\n        currentBlock,\n        key,\n        value,\n      );\n      const writes: Array<{\n        range: string;\n        value: string | number | boolean | null;\n      }> = [{ range: stageCell(rowOffset, "E"), value }];\n\n      nextExecution = withDefaultAmount(nextExecution, writes);\n      setExecution(nextExecution);\n      await writeSheet(key, writes);\n      return;\n    }\n    if (field === "amount") {\n      if (!(await approveNumericValue(key, value))) return;\n      return commit(key, value, [\n        { range: stageCell(rowOffset, "F"), value: num(value) ?? value },\n      ]);\n    }\n    if (field === "temp") {\n      if (!(await approveNumericValue(key, value))) return;\n      let nextExecution = setBrewingExecutionField(\n        execution,\n        currentBlock,\n        key,\n        value,\n      );\n      const writes: Array<{\n        range: string;\n        value: string | number | boolean | null;\n      }> = [{\n        range: stageCell(rowOffset, "G"),\n        value: value ? `${value}°C` : "",\n      }];\n      nextExecution = withDefaultAmount(nextExecution, writes);\n      setExecution(nextExecution);\n      await writeSheet(key, writes);\n      return;\n    }\n\n    if (!(await approveNumericValue(key, value))) return;\n    const nextFields = { ...fields, [key]: value };\n    const kettle = nextFields[`rinse${index}.kettle`] || "";\n    const grant = nextFields[`rinse${index}.grant`] || "";\n    const display =\n      recipe.lautering.usesGrant && grant ? `${kettle}+${grant}` : kettle;\n\n    let nextExecution = setBrewingExecutionField(\n      execution,\n      currentBlock,\n      key,\n      value,\n    );\n    const writes: Array<{\n      range: string;\n      value: string | number | boolean | null;\n    }> = [{ range: stageCell(rowOffset, "H"), value: display }];\n    nextExecution = withDefaultAmount(nextExecution, writes);\n    setExecution(nextExecution);\n    await writeSheet(key, writes);\n  }\n'''
text = text[:start] + new_fn + text[end:]
form.write_text(text)
