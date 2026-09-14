from pathlib import Path

path = Path("server/addFermentationMeasurement.js")
text = path.read_text(encoding="utf-8").replace("\r\n", "\n")

start_marker = '''    let targetRow = -1;
    let entryNumber = -1;
    const maxRowsToScan = 10;
'''
end_marker = '''    Logger.log("Target row for dry hop: " + targetRow + " (entry #" + entryNumber + ")");
'''

start = text.find(start_marker)
if start == -1:
    raise SystemExit("Dry-hop slot start marker was not found; refusing to patch")

end = text.find(end_marker, start)
if end == -1:
    raise SystemExit("Dry-hop slot end marker was not found; refusing to patch")

new_block = '''    let targetRow = -1;
    let entryNumber = -1;
    const maxRowsToScan = 10;
    const emptySlotPattern = /^(\\d+)\\)\\s*$/;
    const numberedPrefixPattern = /^(\\d+)\\)/;

    // Read a fixed-size block directly from the sheet so completely empty rows
    // are included even when they fall outside getDataRange().
    const slotStartRow = lastHeaderRow + 2; // first data row, 1-indexed
    const slotRows = sheet
      .getRange(slotStartRow, 1, maxRowsToScan, 3)
      .getDisplayValues();

    let firstCompletelyEmptyRow = -1;
    let highestEntryNumber = 0;

    // Prefer an explicitly prepared "N)" slot when one exists.
    // Otherwise remember the first truly empty A:C row and derive
    // the next number from the entries that are already in the table.
    for (let i = 0; i < slotRows.length; i++) {
      const colA = String(slotRows[i][0] || "").trim();
      const colB = String(slotRows[i][1] || "").trim();
      const colC = String(slotRows[i][2] || "").trim();

      const numberedMatch = colC.match(numberedPrefixPattern);
      if (numberedMatch) {
        highestEntryNumber = Math.max(
          highestEntryNumber,
          parseInt(numberedMatch[1], 10)
        );
      }

      const emptyNumberedMatch = colC.match(emptySlotPattern);
      if (targetRow === -1 && emptyNumberedMatch && !colA && !colB) {
        targetRow = slotStartRow + i;
        entryNumber = parseInt(emptyNumberedMatch[1], 10);
      }

      if (firstCompletelyEmptyRow === -1 && !colA && !colB && !colC) {
        firstCompletelyEmptyRow = slotStartRow + i;
      }
    }

    if (targetRow === -1 && firstCompletelyEmptyRow !== -1) {
      targetRow = firstCompletelyEmptyRow;
      entryNumber = highestEntryNumber + 1;
      Logger.log(
        "No prepared numbered hop slot found; using empty row " + targetRow +
        " as entry #" + entryNumber
      );
    }

    if (targetRow === -1) {
      throw new Error("No empty slot found in the first 10 rows of the hops table");
    }

'''

patched = text[:start] + new_block + text[end:]
path.write_text(patched, encoding="utf-8")
