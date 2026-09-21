import {
  readSandboxSheetRange,
  searchAccessibleBrewSheetsByStyle,
} from "./sandboxSheet";

export type MashAcidHistoryRow = {
  batchNumber: string;
  brewLetter: "A" | "B" | "C";
  brewDate: string;
  mashPh: string;
  mashVolume: string;
  acidMl: string;
  boilPh: string;
  boilAcidMl: string;
  outToFermentorPh: string;
  sheetName: string;
  sheetUrl: string;
};

function numericText(value: unknown): string {
  const text = String(value ?? "").replace(",", ".").trim();
  const match = text.match(/-?\d+(?:\.\d+)?/);
  return match ? match[0] : "";
}

function cell(
  rows: string[][],
  row: number,
  col: number,
): string {
  return String(rows[row - 1]?.[col - 1] ?? "").trim();
}

function batchFromName(name: string): number | null {
  const matches = [...name.matchAll(/(?:^|\s|#)(\d{3,6})(?=#|\s|$)/g)];
  if (!matches.length) return null;
  const value = Number(matches[matches.length - 1][1]);
  return Number.isFinite(value) ? value : null;
}

function blockLayout(name: string) {
  if (name.includes("משולש")) {
    return {
      bases: [9, 59, 106],
      headers: [4, 54, 102],
    };
  }
  if (name.includes("כפול")) {
    return {
      bases: [9, 59],
      headers: [4, 54],
    };
  }
  return {
    bases: [9],
    headers: [4],
  };
}

function parseBlock(
  rows: string[][],
  baseRow: number,
  headerRow: number,
  letter: "A" | "B" | "C",
  batchNumber: string,
  sheetName: string,
  sheetUrl: string,
): MashAcidHistoryRow | null {
  const mashMeta = cell(rows, baseRow, 8);
  const mashVolume =
    mashMeta.match(/נפח\s*מאש\s*([\d.,]+)/i)?.[1]?.replace(",", ".") || "";
  const mashPh =
    mashMeta.match(/pH\s*([\d.,]+)/i)?.[1]?.replace(",", ".") || "";

  const acidMl = numericText(cell(rows, baseRow + 28, 1));
  const boilPh = numericText(cell(rows, baseRow + 28, 6));
  const boilAcidMl = numericText(cell(rows, baseRow + 29, 1));
  const outToFermentorPh = numericText(cell(rows, baseRow + 40, 8));
  const brewDate = cell(rows, headerRow, 8);

  if (!mashVolume && !mashPh && !acidMl && !boilPh && !boilAcidMl && !outToFermentorPh) {
    return null;
  }

  return {
    batchNumber,
    brewLetter: letter,
    brewDate,
    mashPh,
    mashVolume,
    acidMl,
    boilPh,
    boilAcidMl,
    outToFermentorPh,
    sheetName,
    sheetUrl,
  };
}

const CACHE_PREFIX = "fermentors:brewing:acid-history:v2:";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

function cacheKey(style: string) {
  return CACHE_PREFIX + String(style || "").trim().toLowerCase();
}

function loadCached(style: string): MashAcidHistoryRow[] | null {
  try {
    const raw = window.localStorage.getItem(cacheKey(style));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      savedAt?: number;
      rows?: MashAcidHistoryRow[];
    };
    if (
      !parsed.savedAt ||
      Date.now() - parsed.savedAt > CACHE_TTL_MS ||
      !Array.isArray(parsed.rows)
    ) {
      return null;
    }
    return parsed.rows;
  } catch {
    return null;
  }
}

function saveCached(style: string, rows: MashAcidHistoryRow[]) {
  try {
    window.localStorage.setItem(
      cacheKey(style),
      JSON.stringify({ savedAt: Date.now(), rows }),
    );
  } catch {
    // Local storage is a convenience cache only.
  }
}

export async function loadMashAcidHistoryPreview(
  style: string,
  currentBatchNumber: string,
  forceRefresh = false,
): Promise<MashAcidHistoryRow[]> {
  if (!forceRefresh) {
    const cached = loadCached(style);
    if (cached) return cached;
  }
  const sheets = await searchAccessibleBrewSheetsByStyle(style, 80);
  const currentBatch = Number(
    String(currentBatchNumber || "").replace("#", "").trim(),
  );

  const byBatch = new Map<number, (typeof sheets)[number]>();

  sheets.forEach((sheet) => {
    if (
      !sheet.name ||
      sheet.name.includes("[SANDBOX]") ||
      sheet.name.includes("דף בישול")
    ) {
      return;
    }

    const batch = batchFromName(sheet.name);
    if (batch === null || batch === currentBatch) return;

    const previous = byBatch.get(batch);
    if (!previous || String(sheet.modifiedTime || "") > String(previous.modifiedTime || "")) {
      byBatch.set(batch, sheet);
    }
  });

  const candidates = Array.from(byBatch.entries())
    .sort(([a], [b]) => b - a)
    .slice(0, 12);

  const result: MashAcidHistoryRow[] = [];
  let batchesWithData = 0;

  for (const [batch, sheet] of candidates) {
    if (batchesWithData >= 3) break;

    const rows = await readSandboxSheetRange(
      sheet.id,
      "'גיליון1'!A1:H150",
    );
    const layout = blockLayout(sheet.name);
    const batchRows: MashAcidHistoryRow[] = [];

    layout.bases.forEach((baseRow, index) => {
      const row = parseBlock(
        rows,
        baseRow,
        layout.headers[index],
        (["A", "B", "C"] as const)[index],
        String(batch),
        sheet.name,
        sheet.url,
      );
      if (row) batchRows.push(row);
    });

    if (batchRows.length > 0) {
      batchesWithData += 1;
      result.push(...batchRows);
    }
  }

  const rows = result.slice(0, 9);
  saveCached(style, rows);
  return rows;
}
