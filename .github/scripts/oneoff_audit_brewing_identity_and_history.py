from pathlib import Path

# Keep an open production brew form bound to the full live run identity. The
# existing effect only refreshed progress/edit fields, so a batch/style/sheet
# reassignment could leave the form writing against stale identity metadata.
brewing = Path('src/components/brewing/BrewingView.tsx')
text = brewing.read_text()
old = '''        const changed =
            liveRun.action !== selectedRun.action ||
            liveRun.brewSheetEditRevision !== selectedRun.brewSheetEditRevision ||
'''
new = '''        const changed =
            liveRun.batchNumber !== selectedRun.batchNumber ||
            liveRun.style !== selectedRun.style ||
            liveRun.sheetId !== selectedRun.sheetId ||
            liveRun.sheetUrl !== selectedRun.sheetUrl ||
            liveRun.brewDate !== selectedRun.brewDate ||
            liveRun.tankNumber !== selectedRun.tankNumber ||
            liveRun.tankType !== selectedRun.tankType ||
            liveRun.action !== selectedRun.action ||
            liveRun.brewSheetEditRevision !== selectedRun.brewSheetEditRevision ||
'''
if old not in text:
    raise SystemExit('BrewingView selectedRun identity marker not found')
text = text.replace(old, new, 1)

old = '''                <BrewFormStepper
                    run={selectedRun}
'''
new = '''                <BrewFormStepper
                    key={`${selectedRun.tankId}:${selectedRun.batchNumber}:${selectedRun.sheetId}`}
                    run={selectedRun}
'''
if old not in text:
    raise SystemExit('BrewFormStepper render marker not found')
text = text.replace(old, new, 1)
brewing.write_text(text)

# Historical measurement IDs are not always zero-padded (_917 exists in real
# history). The cellar engine already accepts 3-4 digit times; the chart should
# not silently drop the same rows.
chart = Path('src/components/dashboard/Batchhistorychart.tsx')
text = chart.read_text()
old = r'''    const match = String(id).match(/^(\d{4})-(\d{2})-(\d{2})_\d{4}$/);'''
new = r'''    const match = String(id).match(/^(\d{4})-(\d{2})-(\d{2})_\d{3,4}$/);'''
if old not in text:
    raise SystemExit('Batchhistorychart measurement regex marker not found')
chart.write_text(text.replace(old, new, 1))
