import { runtimeConfig } from "../../config/runtimeConfig";
import type { SandboxDemoTank } from "./brewingSandbox";
import type { BrewRecipe } from "./brewRecipe";
import type { IngredientDefinition } from "./ingredientLibrary";
import {
  serverCreateBrewSheet,
  serverReadBrewSheetRange,
  serverTrashBrewSheet,
  serverWriteBrewSheetCells,
} from "./brewingSheetServer";

type TankType = SandboxDemoTank["tankType"];

export type SandboxSheetResult = {
  id: string;
  name: string;
  url: string;
};

export type AccessibleBrewSheet = {
  id: string;
  name: string;
  url: string;
  modifiedTime?: string;
};

function layoutFor(tankType: TankType) {
  if (tankType === "single") {
    return {
      blockHeaderRows: [4],
      fermentationHeaderRow: 57,
      startingPlatoRow: 59,
      startingPlatoFormula: '=IF(B48<>"",B48+0.05,"")',
    };
  }
  if (tankType === "double") {
    return {
      blockHeaderRows: [4, 54],
      fermentationHeaderRow: 104,
      startingPlatoRow: 106,
      startingPlatoFormula:
        '=IF(B98<>"",IF(AND(C48<>"",C98<>""),(((B48+0.05)*C48)+((B98+0.05)*C98))/(C48+C98),""),IF(B48<>"",B48+0.05,""))',
    };
  }
  return {
    blockHeaderRows: [4, 54, 102],
    fermentationHeaderRow: 154,
    startingPlatoRow: 156,
    startingPlatoFormula:
      '=IF(B145<>"",IF(AND(C48<>"",C98<>"",C145<>""),(((B48+0.05)*C48)+((B98+0.05)*C98)+((B145+0.05)*C145))/(C48+C98+C145),""),IF(B98<>"",IF(AND(C48<>"",C98<>""),(((B48+0.05)*C48)+((B98+0.05)*C98))/(C48+C98),""),IF(B48<>"",B48+0.05,"")))',
  };
}


function tankLabel(tankType: TankType) {
  return tankType === "single" ? "בודד" : tankType === "double" ? "כפול" : "משולש";
}

export async function deleteSandboxBrewSheet(fileId: string): Promise<void> {
  if (!fileId || runtimeConfig.deployEnv !== "preview") return;
  await serverTrashBrewSheet(fileId);
}

export async function ensureSandboxSheetAccess(): Promise<void> {
  if (runtimeConfig.deployEnv !== "preview") {
    throw new Error("הרשאת Sandbox זמינה רק ב-Preview.");
  }
  // Access is authenticated by the Firebase ID token in appsScriptClient.
}

export async function createSandboxBrewSheet(input: {
  batchNumber: string;
  style: string;
  tankNumber: string;
  tankType: TankType;
  recipe?: BrewRecipe;
  ingredients?: IngredientDefinition[];
  production?: boolean;
}): Promise<SandboxSheetResult> {
  if (runtimeConfig.deployEnv !== "preview") {
    throw new Error("יצירת Sheet מענף הפיתוח זמינה רק ב-Preview.");
  }
  if (!input.production && input.style !== "IPA") {
    throw new Error("ב-Sandbox הדמו יצירת Sheet פעילה ל-IPA בלבד.");
  }

  const typeSuffix =
    input.tankType === "single" ? "" : " " + tankLabel(input.tankType);
  const name = input.production
    ? input.style + typeSuffix + " " + input.batchNumber + "#"
    : "[SANDBOX] IPA " + tankLabel(input.tankType) + " " + input.batchNumber + "#";

  const layout = layoutFor(input.tankType);
  const styleLabel =
    input.tankType === "single"
      ? input.style
      : input.style + " " + tankLabel(input.tankType);
  const suffixes = ["A", "B", "C"];
  const writes: Array<{ range: string; value: string | number | boolean | null }> = [
    { range: "'גיליון1'!B1", value: input.style },
    { range: "'גיליון1'!D1", value: input.tankNumber },
    { range: "'גיליון1'!F1", value: input.batchNumber },
    { range: "'גיליון1'!H1", value: "" },
  ];

  layout.blockHeaderRows.forEach((row, index) => {
    writes.push(
      { range: `'גיליון1'!C${row}`, value: styleLabel },
      { range: `'גיליון1'!E${row}`, value: `${input.batchNumber}${suffixes[index] || ""}` },
      { range: `'גיליון1'!H${row}`, value: "" },
    );
  });
  writes.push(
    { range: `'גיליון1'!B${layout.fermentationHeaderRow}`, value: styleLabel },
    { range: `'גיליון1'!D${layout.fermentationHeaderRow}`, value: input.batchNumber },
    { range: `'גיליון1'!G${layout.fermentationHeaderRow}`, value: input.tankNumber },
  );

  if (!input.production) {
    writes.push(
      { range: `'גיליון1'!B${layout.startingPlatoRow}`, value: "" },
      { range: `'גיליון1'!D${layout.startingPlatoRow}`, value: layout.startingPlatoFormula },
    );
  }

  const created = await serverCreateBrewSheet({
    batchNumber: input.batchNumber,
    style: input.style,
    tankNumber: input.tankNumber,
    tankType: input.tankType,
    name,
    initialWrites: writes,
  });
  return { id: created.id, name: created.name, url: created.url };
}

export async function productionBrewSheetExists(
  batchNumber: string,
): Promise<boolean> {
  const clean = String(batchNumber || "").replace("#", "").trim();
  if (!/^\\d+$/.test(clean)) return false;
  const { serverListBrewDriveHistory } = await import("./brewingSheetServer");
  const rows = await serverListBrewDriveHistory(150);
  return rows.some((row) => String(row.batchNumber || "").replace("#", "").trim() === clean);
}

export async function searchAccessibleBrewSheetsByStyle(
  style: string,
  maxResults = 80,
): Promise<AccessibleBrewSheet[]> {
  if (runtimeConfig.deployEnv !== "preview") {
    throw new Error("חיפוש Sheets היסטוריים זמין כרגע ב-Preview בלבד.");
  }
  const cleanStyle = String(style || "").trim().toLowerCase();
  if (!cleanStyle) return [];
  const { serverListBrewDriveHistory } = await import("./brewingSheetServer");
  const rows = await serverListBrewDriveHistory(Math.max(10, Math.min(150, maxResults)));
  return rows
    .filter((row) => String(row.beerStyle || "").trim().toLowerCase().includes(cleanStyle))
    .map((row) => ({
      id: row.fileId || row.id,
      name: row.fileName,
      url: row.sheetUrl,
    }))
    .filter((row) => !!row.id);
}

export async function readSandboxSheetRange(
  fileId: string,
  range: string,
): Promise<string[][]> {
  if (!fileId || runtimeConfig.deployEnv !== "preview") {
    throw new Error("קריאה מ-Sheet זמינה רק ב-Preview.");
  }
  const result = await serverReadBrewSheetRange(fileId, range);
  return Array.isArray(result.values) ? result.values : [];
}

export async function writeSandboxSheetCells(
  fileId: string,
  data: Array<{ range: string; value: string | number | boolean | null }>,
): Promise<void> {
  if (!fileId || runtimeConfig.deployEnv !== "preview") {
    throw new Error("כתיבה ל-Sheet זמינה רק ב-Preview.");
  }
  const result = await serverWriteBrewSheetCells(
    fileId,
    data.map((item) => ({ range: item.range, value: item.value })),
  );
  if (result.updated !== data.length) {
    throw new Error(
      `Google Sheets אישר רק ${result.updated} מתוך ${data.length} כתיבות. הנתונים נשארו מסומנים כלא מסונכרנים.`,
    );
  }
}