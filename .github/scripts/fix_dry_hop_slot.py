from pathlib import Path

path = Path("server/addFermentationMeasurement.js")
text = path.read_text(encoding="utf-8")

old = '''    let targetRow = -1;
    let entryNumber = -1;
    const maxRowsToScan = 10;
    const emptySlotPattern = /^(\\d+)\\)\\s*$/;

    for (let r = lastHeaderRow + 1; r < Math.min(lastHeaderRow + 1 + maxRowsToScan, values.length); r++) {
      const colC = String(values[r][2] || "").trim();
      const match = colC.match(emptySlotPattern);
      if (match) {
        targetRow = r + 1; // 1-indexed ל-Range
        entryNumber = parseInt(match[1], 10);
        break;
      }
    }

    if (targetRow === -1) {
      throw new Error("No empty numbered slot (e.g. '4)') found in hops table");
    }
'''

new = '''    let targetRow = -1;
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

if old not in text:
    raise SystemExit("Expected dry-hop slot block was not found; refusing to patch")

path.write_text(text.replace(old, new, 1), encoding="utf-8")
