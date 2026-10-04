from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one anchor, found {count}: {old[:100]!r}")
    p.write_text(text.replace(old, new, 1))


def replace_once_after(path: str, marker: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    marker_index = text.find(marker)
    if marker_index < 0:
        raise SystemExit(f"{path}: marker not found: {marker!r}")
    prefix = text[:marker_index]
    suffix = text[marker_index:]
    count = suffix.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one post-marker anchor, found {count}: {old[:100]!r}")
    p.write_text(prefix + suffix.replace(old, new, 1))


server = "server/BREWING_SHEET_SERVICE.js"
replace_once(
    server,
    """      SpreadsheetApp.flush();
    }

    // The fermentation page must always expose the canonical tank-volume field.
""",
    """      SpreadsheetApp.flush();
    }

    // Keep the out-to-boil pH unit consistent across all Master variants. Wheat
    // inserts extra mash rows and its Master can be missing the visible pH label,
    // even though column H is still the canonical outToBoilPh value cell. Resolve
    // the process row semantically after all row insertions and fill only a
    // genuinely missing label in column I, leaving Masters that already have it
    // untouched.
    {
      const sheet = ss.getSheets()[0];
      const values = sheet.getDataRange().getDisplayValues();
      let updated = false;
      values.forEach(function (row, index) {
        const outToBoilLabel = String((row || [])[3] || "").trim();
        if (!/^הוצאה\\s*לבישול$/i.test(outToBoilLabel)) return;
        const hasPhLabel = (row || []).some(function (cell) {
          return /^pH$/i.test(String(cell || "").trim());
        });
        if (!hasPhLabel) {
          sheet.getRange(index + 1, 9).setValue("pH");
          updated = true;
        }
      });
      if (updated) SpreadsheetApp.flush();
    }

    // The fermentation page must always expose the canonical tank-volume field.
""",
)

replace_once(
    server,
    """        const sugarCol = findLabelColumn(row, /^(?:F\\.R\\.|L\\.R\\.)$/i);
""",
    """        const outToBoilCol = findLabelColumn(row, /^הוצאה\\s*לבישול$/i);
        if (outToBoilCol >= 0 && row.length) {
          // Existing Wheat Sheets may predate the creation-time normalization.
          // Add the print-only label only when no pH label already exists, so
          // standard Masters never get the duplicate that an earlier fix caused.
          const hasPhLabel = row.some(function (cell) {
            return /^pH$/i.test(String(cell || "").trim());
          });
          if (!hasPhLabel) row[row.length - 1] = "pH";
        }

        const sugarCol = findLabelColumn(row, /^(?:F\\.R\\.|L\\.R\\.)$/i);
""",
)

view = "src/components/brewing/BrewingView.tsx"
replace_once(
    view,
    """                                {pendingProductionRuns.map((run) => {
                                    const style = beerStyleClass(run.style);
                                    return (
""",
    """                                {pendingProductionRuns.map((run) => {
                                    const style = beerStyleClass(run.style);
                                    const recipe =
                                        recipes.find((item) => sameStyle(item.style, run.style)) || null;
                                    return (
""",
)
replace_once_after(
    view,
    '<article className="brewing-tank-card brewing-pending-card"',
    """                                                <a className="brewing-sheet-link" href={run.sheetUrl} target="_blank" rel="noreferrer">פתח Sheet</a>
                                                <button type="button" onClick={() => printBrewCover(run)}>הדפס דף בישול</button>
""",
    """                                                <a className="brewing-sheet-link" href={run.sheetUrl} target="_blank" rel="noreferrer">פתח Sheet</a>
                                                <button
                                                    type="button"
                                                    disabled={!recipe}
                                                    onClick={() => {
                                                        setMessage("");
                                                        setSelectedRun(run);
                                                    }}
                                                >
                                                    {!recipe ? "חסר מתכון תואם" : "עריכת נתוני בישול"}
                                                </button>
                                                <button type="button" onClick={() => printBrewCover(run)}>הדפס דף בישול</button>
""",
)

server_text = Path(server).read_text()
view_text = Path(view).read_text()
assert 'sheet.getRange(index + 1, 9).setValue("pH")' in server_text
assert 'const outToBoilCol = findLabelColumn(row, /^הוצאה\\s*לבישול$/i);' in server_text
assert 'const hasPhLabel = row.some(function (cell)' in server_text
assert 'recipes.find((item) => sameStyle(item.style, run.style)) || null;' in view_text
assert '"עריכת נתוני בישול"' in view_text
