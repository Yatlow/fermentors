import { runtimeConfig } from "../../config/runtimeConfig";
import { auth } from "../../firebase";
import {
  clearGoogleWorkspaceToken,
  ensureGoogleWorkspaceToken,
  getRememberedGoogleWorkspaceToken,
} from "../auth/googleWorkspaceAccess";
import type { SandboxDemoTank } from "./brewingSandbox";
import type { BrewRecipe } from "./brewRecipe";
import {
  activeLot,
  type IngredientDefinition,
} from "./ingredientLibrary";

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

async function requestWriteToken(
  forceConsent = false,
): Promise<string> {
  if (!forceConsent) {
    const existing = getRememberedGoogleWorkspaceToken();
    if (existing) return existing;
  }

  const user = auth.currentUser;
  if (!user) {
    throw new Error(
      "צריך להתחבר מחדש לפני יצירת Sheet.",
    );
  }

  return ensureGoogleWorkspaceToken(user, forceConsent);
}

async function googleFetch(
  url: string,
  init: RequestInit,
  retry = true,
): Promise<Response> {
  const token = await requestWriteToken(false);
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(url, { ...init, headers });
  if (response.status === 401 && retry) {
    clearGoogleWorkspaceToken();
    // The scopes were already granted at the application's Google login.
    // Re-authenticate the same account without forcing the consent screen again.
    const fresh = await requestWriteToken(false);
    headers.set("Authorization", `Bearer ${fresh}`);
    return fetch(url, { ...init, headers });
  }
  return response;
}

async function readSheetValues(
  fileId: string,
  range = "'גיליון1'!A1:H200",
): Promise<string[][]> {
  const response = await googleFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      fileId,
    )}/values/${encodeURIComponent(
      range,
    )}?valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`,
    { method: "GET" },
  );
  await requireOk(response, "קריאת מבנה טופס הבישול נכשלה");
  const payload = await response.json();
  return Array.isArray(payload?.values) ? payload.values : [];
}

type DiscoveredProductionLayout = {
  blockHeaderRows: number[];
  grainRows: number[];
  hopHeaderRows: number[];
  yeastRows: number[];
  mashStageRows: Array<{ stageIndex: number; row: number }>;
  fermentationHeaderRow: number | null;
};

async function discoverProductionLayout(
  fileId: string,
): Promise<DiscoveredProductionLayout> {
  const rows = await readSheetValues(fileId);
  const value = (rowIndex: number, columnIndex: number) =>
    String(rows[rowIndex]?.[columnIndex] ?? "").trim();

  const blockHeaderRows: number[] = [];
  const grainRows: number[] = [];
  const hopHeaderRows: number[] = [];
  const yeastRows: number[] = [];
  const mashStageRows: Array<{ stageIndex: number; row: number }> = [];
  let fermentationHeaderRow: number | null = null;

  rows.forEach((_, rowIndex) => {
    const a = value(rowIndex, 0);
    const b = value(rowIndex, 1);
    const c = value(rowIndex, 2);
    const d = value(rowIndex, 3);
    const f = value(rowIndex, 5);

    if (b === "סוג:" && d === "אצווה:") {
      blockHeaderRows.push(rowIndex + 1);
    }

    if (/^הכנסת לתת$/i.test(d)) {
      grainRows.push(rowIndex + 1);
    }

    if (/אחוז.*אלפה|אחוז.*אלפא/i.test(b) && /סוג/i.test(c)) {
      hopHeaderRows.push(rowIndex + 1);
    }

    if (
      /^כמות$/i.test(a) &&
      /^סוג$/i.test(b) &&
      /אצווה|מקור/i.test(c)
    ) {
      yeastRows.push(rowIndex + 2);
    }

    const mashStageMatch = /^(?:השריה|חימום)\s*(\d+)$/i.exec(d);
    if (mashStageMatch) {
      mashStageRows.push({
        stageIndex: Number(mashStageMatch[1]),
        row: rowIndex + 1,
      });
    }

    if (
      /^סוג:$/i.test(a) &&
      /^אצווה:$/i.test(c) &&
      /מספר מיכל/i.test(f)
    ) {
      fermentationHeaderRow = rowIndex + 1;
    }
  });

  return {
    blockHeaderRows,
    grainRows,
    hopHeaderRows,
    yeastRows,
    mashStageRows,
    fermentationHeaderRow,
  };
}

async function requireOk(response: Response, fallback: string) {
  if (response.ok) return response;
  let detail = "";
  try {
    const payload = await response.json();
    detail = String(payload?.error?.message || payload?.error || "");
  } catch {
    detail = await response.text().catch(() => "");
  }
  if (
    response.status === 403 &&
    /sheets\.googleapis\.com|Google Sheets API|has not been used|disabled/i.test(detail)
  ) {
    throw new Error(
      "Google Sheets API כבוי בפרויקט של Firebase. צריך להפעיל אותו פעם אחת ב-Google Cloud ואז לנסות שוב."
    );
  }

  throw new Error(detail ? `${fallback}: ${detail}` : fallback);
}

function templateIdFor(tankType: TankType): string {
  const id = runtimeConfig.brewingSandbox.templates[tankType];
  if (!id) throw new Error(`לא הוגדר Template ל-${tankType}.`);
  return id;
}

function tankLabel(tankType: TankType) {
  return tankType === "single" ? "בודד" : tankType === "double" ? "כפול" : "משולש";
}


type ProductionStyleConfig = {
  folderId: string;
  templates: Partial<Record<TankType, string>>;
};

const PRODUCTION_MASTER_TEMPLATE_IDS: Record<TankType, string> = {
  single: "1OUXheZt_jgup7MVVCHdxRybQc8vUC7S3dDFga4dKSsg",
  double: "1tn0PmHUTfbWQyHj4ujI14L1cvijVYKJhfRxb2C1JhpI",
  triple: "14Eq3C6tWRVNTa8kTRLVGW5tF1jfx0Yk7NDU5MOpPW_o",
};

const PRODUCTION_STYLE_CONFIG: Record<string, ProductionStyleConfig> = {
  ipa: {
    folderId:
      "0B6DbCIATIM92fnNfeTl3MmhQMUlZY0NYSERPbmk2b2RQZUlyNmJSbUpoS1NTdkVmZnNuNGM",
    templates: {
      single: "1qqYHpIhokc7mEsCHW2bhM6LDGrmh4CN0l937nYnonOw",
      double: "1M-IFhJL-JwphQDEKsAHFCpCR8zz4zXXgaXkCZ2hpXtY",
      triple: "1I8P0aoD7WEo0AYZcYebhFzCGdik5TzgPnNq2SgPEzkI",
    },
  },
  pale: {
    folderId:
      "0B6DbCIATIM92fmRXeGpLLW8wMEx5dlRxYlJVQVJPcWZOaEkzNmt2al9lTHVRVUZhVExPckE",
    templates: {
      single: "1RXFzcnWVjCZx2Iv72Kl_DuD3fJHyNCnGX_VSSIeJvJI",
      double: "1PBnf9yt_kPSdNYrOgDp1qH6HBJMAFNSDaDKCmLAc2hU",
      triple: "1S5xQOqr5V6YgHQUw06RxQlfcqEOVKJWtJDFispwVcpo",
    },
  },
  wheat: {
    folderId:
      "0B6DbCIATIM92fk5kczA1bmtSUUkyejlvYXdNQlhfTUp2VWYyTUNVclo0ZGFsRDNRY0NiS00",
    templates: {
      single: "1wKKFQLRTkfdV0v2Xc4YHqMK-OyG6chJ10biGg8JFeOg",
      double: "1vUa42VH9sqHoOtyulOt3bZ-mLXHvIBcTkFZwE3S6GaA",
      triple: "13CCd_hcZWCnhGPz2fvAi0tuc3jL5VOQ4-DCPIZslgNQ",
    },
  },
  stout: {
    folderId:
      "0B6DbCIATIM92fmljZWo5M0g2ZjFWM05GVWZqTGx1MHhDWEd6YThiMkNFSUpXNnZjVC1yRms",
    templates: {
      single: "1Vy0DT3-pkamca18w2W8ifue_9aHFq5raVHDnzaTlaQ4",
    },
  },
  lager: {
    folderId:
      "0B6DbCIATIM92fld5WHIyN3lYaEh5NFllY2trdl93ZlB3WDhicllVY3FhV0pGd1JZbXl3dTg",
    templates: {
      single: "1aGXFYutLe77oKiF7sQrc9umMt7sKRcVZbFwesR71THU",
      double: "1xfdZzGaOE4p8OFn-W3jj-pheYmpApFgiWnMrcFtX988",
      triple: "1CHkAlXZGeovmHFq_PrRV4CETXxb8xPlOcAUMST-xWWc",
    },
  },
  hoppy: {
    folderId: "1sQtiZKhHST52SsJW2A_vd1zBLZsqEezz",
    templates: {
      double: "19AXQ7MMPVLsCI9ufYZp07R5aJFWL5lvn3PvgvyMmgng",
      triple: "1O5lelBhQR7otZOTtOakLkxz3lCx2Qk7DVY_IsgYgq2I",
    },
  },
};

function productionStyleKey(
  style: string,
): keyof typeof PRODUCTION_STYLE_CONFIG | null {
  const normalized = String(style || "").trim().toLowerCase();
  if (normalized === "ipa" || normalized.includes("אייפיאיי")) return "ipa";
  if (normalized.includes("פייל") || normalized.includes("pale")) return "pale";
  if (normalized.includes("חיטה") || normalized.includes("wheat")) return "wheat";
  if (normalized.includes("סטאוט") || normalized.includes("stout")) return "stout";
  if (
    normalized.includes("הופי") ||
    normalized.includes("hoppy") ||
    normalized.includes("ניו לאגר")
  ) {
    return "hoppy";
  }
  if (normalized.includes("לאגר") || normalized.includes("lager")) return "lager";
  return null;
}

function escapeDriveQuery(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function ensureProductionStyleFolder(style: string): Promise<string> {
  const styleKey = productionStyleKey(style);
  if (styleKey) return PRODUCTION_STYLE_CONFIG[styleKey].folderId;

  const rootFolderId = runtimeConfig.brewFolderId;
  if (!rootFolderId) {
    throw new Error("לא הוגדרה תיקיית הבישולים הראשית.");
  }

  const cleanStyle = String(style || "").trim();
  if (!cleanStyle) throw new Error("חסר שם סגנון ליצירת תיקיית הבישול.");

  const escapedName = escapeDriveQuery(cleanStyle);
  const escapedParent = escapeDriveQuery(rootFolderId);
  const query = [
    "mimeType = 'application/vnd.google-apps.folder'",
    "trashed = false",
    `'${escapedParent}' in parents`,
    `name = '${escapedName}'`,
  ].join(" and ");

  const searchResponse = await googleFetch(
    "https://www.googleapis.com/drive/v3/files" +
      `?q=${encodeURIComponent(query)}` +
      "&pageSize=10&fields=files(id,name)",
    { method: "GET" },
  );
  await requireOk(searchResponse, "חיפוש תיקיית הסגנון ב-Drive נכשל");
  const searchPayload = await searchResponse.json();
  const existing = Array.isArray(searchPayload?.files)
    ? searchPayload.files[0]
    : null;
  if (existing?.id) return String(existing.id);

  const createResponse = await googleFetch(
    "https://www.googleapis.com/drive/v3/files?fields=id,name",
    {
      method: "POST",
      body: JSON.stringify({
        name: cleanStyle,
        mimeType: "application/vnd.google-apps.folder",
        parents: [rootFolderId],
      }),
    },
  );
  await requireOk(createResponse, "יצירת תיקיית הסגנון ב-Drive נכשלה");
  const created = await createResponse.json();
  const folderId = String(created?.id || "");
  if (!folderId) throw new Error("Google Drive לא החזיר מזהה לתיקיית הסגנון.");
  return folderId;
}

async function productionDriveTarget(style: string, tankType: TankType) {
  const styleKey = productionStyleKey(style);
  const legacyTemplateId = styleKey
    ? PRODUCTION_STYLE_CONFIG[styleKey].templates[tankType] || null
    : null;
  const masterTemplateId = PRODUCTION_MASTER_TEMPLATE_IDS[tankType];

  return {
    folderId: await ensureProductionStyleFolder(style),
    templateIds: [masterTemplateId, legacyTemplateId].filter(
      (value, index, values): value is string =>
        !!value && values.indexOf(value) === index,
    ),
  };
}

async function firstSheetId(fileId: string): Promise<number> {
  const response = await googleFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      fileId,
    )}?fields=sheets.properties(sheetId,title)`,
    { method: "GET" },
  );
  await requireOk(response, "קריאת מזהה גיליון ה-Master נכשלה");
  const payload = await response.json();
  const sheets = Array.isArray(payload?.sheets) ? payload.sheets : [];
  const main =
    sheets.find(
      (sheet: Record<string, any>) =>
        String(sheet?.properties?.title || "") === "גיליון1",
    ) || sheets[0];
  const sheetId = Number(main?.properties?.sheetId);
  if (!Number.isFinite(sheetId)) {
    throw new Error("לא נמצא גיליון ראשי בטופס הבישול.");
  }
  return sheetId;
}

async function applyMashStageVisibility(
  fileId: string,
  layout: DiscoveredProductionLayout,
  recipe?: BrewRecipe,
) {
  if (!recipe) return;

  const restCount = recipe.mash.steps.filter(
    (step) =>
      /^rest\d+$/i.test(String(step.id || "")) ||
      /^(?:מנוחה|השריה)\s*\d+$/i.test(String(step.label || "").trim()),
  ).length;

  if (restCount > 3) {
    throw new Error(
      `המתכון כולל ${restCount} מנוחות מאש. ה-Master הנוכחי תומך עד 3 מנוחות.`,
    );
  }

  const rowsToConfigure = layout.mashStageRows.filter(
    (item) => item.stageIndex >= 2,
  );
  if (!rowsToConfigure.length) return;

  const sheetId = await firstSheetId(fileId);
  const requests = rowsToConfigure.map((item) => ({
    updateDimensionProperties: {
      range: {
        sheetId,
        dimension: "ROWS",
        startIndex: item.row - 1,
        endIndex: item.row + 1,
      },
      properties: {
        hiddenByUser: item.stageIndex > restCount,
      },
      fields: "hiddenByUser",
    },
  }));

  const response = await googleFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      fileId,
    )}:batchUpdate`,
    {
      method: "POST",
      body: JSON.stringify({ requests }),
    },
  );
  await requireOk(response, "התאמת מספר מנוחות המאש ב-Sheet נכשלה");
}

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


async function deleteSandboxFile(fileId: string) {
  try {
    const response = await googleFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`,
      { method: "DELETE" },
    );
    if (!response.ok && response.status !== 404) {
      console.warn("Failed to remove orphan sandbox Sheet", response.status);
    }
  } catch (error) {
    console.warn("Failed to remove orphan sandbox Sheet", error);
  }
}

export async function deleteSandboxBrewSheet(fileId: string): Promise<void> {
  if (!fileId || runtimeConfig.deployEnv !== "preview") return;

  const response = await googleFetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
      fileId,
    )}?supportsAllDrives=true&fields=id,trashed`,
    {
      method: "PATCH",
      body: JSON.stringify({ trashed: true }),
    },
  );

  if (response.status === 404) return;
  await requireOk(response, "מחיקת Sheet ה-Sandbox מה-Drive נכשלה");

  const payload = await response.json().catch(() => null);
  if (payload?.trashed !== true) {
    throw new Error(
      "Google Drive לא אישר שה-Sheet הועבר לאשפה. האצווה לא נמחקה מהאפליקציה.",
    );
  }
}

export async function ensureSandboxSheetAccess(): Promise<void> {
  if (runtimeConfig.deployEnv !== "preview") {
    throw new Error("הרשאת Sandbox זמינה רק ב-Preview.");
  }
  await requestWriteToken(false);
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

  const productionTarget = input.production
    ? await productionDriveTarget(input.style, input.tankType)
    : null;
  const folderId = productionTarget
    ? productionTarget.folderId
    : runtimeConfig.brewingSandbox.folderId;
  if (!folderId) {
    throw new Error("לא הוגדרה תיקיית Sandbox ב-Drive.");
  }

  const templateIds = productionTarget
    ? productionTarget.templateIds
    : [templateIdFor(input.tankType)];
  const typeSuffix =
    input.tankType === "single" ? "" : " " + tankLabel(input.tankType);
  const name = input.production
    ? input.style + typeSuffix + " " + input.batchNumber + "#"
    : "[SANDBOX] IPA " + tankLabel(input.tankType) + " " + input.batchNumber + "#";

  let copyResponse: Response | null = null;
  let copiedFromTemplate = "";
  for (const templateId of templateIds) {
    const response = await googleFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
        templateId,
      )}/copy?supportsAllDrives=true&fields=id,name,webViewLink`,
      {
        method: "POST",
        body: JSON.stringify({
          name,
          parents: [folderId],
        }),
      },
    );

    if (response.ok) {
      copyResponse = response;
      copiedFromTemplate = templateId;
      break;
    }

    copyResponse = response;
  }

  if (!copyResponse) {
    throw new Error("לא נמצא Master ליצירת טופס הבישול.");
  }
  await requireOk(
    copyResponse,
    input.production
      ? "העתקת ה-Master נכשלה וגם ה-Template ההיסטורי לא היה זמין"
      : "יצירת העתק של טופס הבישול נכשלה",
  );
  const copied = await copyResponse.json();
  const fileId = String(copied.id || "");
  if (!fileId) throw new Error("Google לא החזיר מזהה לקובץ החדש.");

  try {
    const propertiesResponse = await googleFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(fileId)}:batchUpdate`,
      {
        method: "POST",
        body: JSON.stringify({
          requests: [
            {
              updateSpreadsheetProperties: {
                properties: { timeZone: "Asia/Jerusalem" },
                fields: "timeZone",
              },
            },
          ],
        }),
      },
    );
    await requireOk(propertiesResponse, "עדכון אזור הזמן של ה-Sheet נכשל");

    const date = "";
    const fallbackLayout = layoutFor(input.tankType);
    const discoveredLayout = input.production
      ? await discoverProductionLayout(fileId)
      : null;

    if (input.production && discoveredLayout) {
      await applyMashStageVisibility(fileId, discoveredLayout, input.recipe);
    }
    const blockHeaderRows =
      discoveredLayout?.blockHeaderRows.length
        ? discoveredLayout.blockHeaderRows
        : fallbackLayout.blockHeaderRows;
    const styleLabel =
      input.tankType === "single"
        ? input.style
        : input.style + " " + tankLabel(input.tankType);
    const suffixes = ["A", "B", "C"];

    const data: Array<{ range: string; values: unknown[][] }> = [
      { range: "'גיליון1'!B1", values: [[input.style]] },
      { range: "'גיליון1'!D1", values: [[input.tankNumber]] },
      { range: "'גיליון1'!F1", values: [[input.batchNumber]] },
      { range: "'גיליון1'!H1", values: [[date]] },
    ];

    blockHeaderRows.forEach((row, index) => {
      data.push(
        { range: `'גיליון1'!C${row}`, values: [[styleLabel]] },
        {
          range: `'גיליון1'!E${row}`,
          values: [[`${input.batchNumber}${suffixes[index] || ""}`]],
        },
        { range: `'גיליון1'!H${row}`, values: [[date]] },
      );
    });

    if (input.recipe && input.ingredients) {
      blockHeaderRows.forEach((headerRow, blockIndex) => {
        const firstGrainRow =
          discoveredLayout?.grainRows[blockIndex] || headerRow + 5;

        // Existing production templates contain example/raw-material rows.
        // Clear the ingredient slots before applying the selected recipe so
        // stale template values can never survive next to the new recipe.
        for (let slot = 0; slot < 6; slot += 1) {
          const row = firstGrainRow + slot;
          data.push(
            { range: `'גיליון1'!A${row}`, values: [[""]] },
            { range: `'גיליון1'!B${row}`, values: [[""]] },
            { range: `'גיליון1'!C${row}`, values: [[""]] },
          );
        }

        if (input.recipe!.grains.length > 6) {
          throw new Error(
            "ה-Master תומך כרגע עד 6 סוגי לתת בבישול אחד.",
          );
        }

        input.recipe!.grains.forEach((grain, grainIndex) => {
          const ingredient = input.ingredients!.find(
            (item) => item.id === grain.ingredientId,
          );
          if (!ingredient) {
            throw new Error(
              `חומר הגלם "${grain.ingredientId}" מהמתכון לא נמצא בספריית חומרי הגלם.`,
            );
          }

          const lot = activeLot(ingredient);
          const row = firstGrainRow + grainIndex;
          const typeAndLot = [
            ingredient.name,
            lot?.lotNumber ? `#${lot.lotNumber}` : "",
          ]
            .filter(Boolean)
            .join(" ");

          data.push(
            {
              range: `'גיליון1'!A${row}`,
              values: [[`${grain.kgPerBrew}Kg`]],
            },
            {
              range: `'גיליון1'!B${row}`,
              values: [[typeAndLot]],
            },
            {
              range: `'גיליון1'!C${row}`,
              values: [[lot?.supplier || ""]],
            },
          );
        });
      });
    }

    if (input.recipe && input.ingredients && discoveredLayout) {
      const boilHops = input.recipe.hops
        .filter((hop) => hop.purpose !== "dryHop")
        .slice(0, 3);

      discoveredLayout.hopHeaderRows.forEach((headerRow) => {
        // The Master uses additions 1–3 for the hot side. Addition 4 is
        // reserved for the existing cellar dry-hop flow; keep the extra raw
        // row clear as template headroom rather than turning it into a boil slot.
        for (let slot = 0; slot < 5; slot += 1) {
          const row = headerRow + 1 + slot;
          data.push(
            { range: `'גיליון1'!A${row}`, values: [[""]] },
            { range: `'גיליון1'!B${row}`, values: [[""]] },
            { range: `'גיליון1'!C${row}`, values: [[""]] },
          );
        }

        boilHops.forEach((hop, hopIndex) => {
          const ingredient = input.ingredients!.find(
            (item) => item.id === hop.ingredientId,
          );
          if (!ingredient) {
            throw new Error(
              `הכשות "${hop.ingredientId}" מהמתכון לא נמצאה בספריית חומרי הגלם.`,
            );
          }
          const lot = activeLot(ingredient);
          const row = headerRow + 1 + hopIndex;
          const alpha =
            lot?.alpha ??
            (Number.isFinite(Number(hop.aa)) ? Number(hop.aa) : undefined);

          data.push(
            { range: `'גיליון1'!A${row}`, values: [[""]] },
            {
              range: `'גיליון1'!B${row}`,
              values: [[alpha !== undefined ? Number(alpha) : ""]],
            },
            {
              range: `'גיליון1'!C${row}`,
              values: [[
                `${hopIndex + 1})${ingredient.name}${
                  lot?.lotNumber ? ` ${lot.lotNumber}` : ""
                }`,
              ]],
            },
          );
        });
      });

      const yeast = input.ingredients.find(
        (item) => item.id === input.recipe!.yeast.ingredientId,
      );

      discoveredLayout.yeastRows.forEach((row) => {
        data.push(
          { range: `'גיליון1'!A${row}`, values: [[""]] },
          { range: `'גיליון1'!B${row}`, values: [[""]] },
          { range: `'גיליון1'!C${row}`, values: [[""]] },
        );
      });

      if (yeast) {
        const lot = activeLot(yeast);
        discoveredLayout.yeastRows.forEach((row) => {
          data.push(
            {
              range: `'גיליון1'!A${row}`,
              values: [[
                input.recipe!.yeast.gramsPerBrew
                  ? `${input.recipe!.yeast.gramsPerBrew}g`
                  : "",
              ]],
            },
            { range: `'גיליון1'!B${row}`, values: [[yeast.name]] },
            {
              range: `'גיליון1'!C${row}`,
              values: [[
                [lot?.lotNumber, lot?.supplier].filter(Boolean).join(" · "),
              ]],
            },
          );
        });
      }
    }

    const fermentationHeaderRow =
      discoveredLayout?.fermentationHeaderRow ||
      fallbackLayout.fermentationHeaderRow;

    data.push(
      {
        range: `'גיליון1'!B${fermentationHeaderRow}`,
        values: [[styleLabel]],
      },
      {
        range: `'גיליון1'!D${fermentationHeaderRow}`,
        values: [[input.batchNumber]],
      },
      {
        range: `'גיליון1'!G${fermentationHeaderRow}`,
        values: [[input.tankNumber]],
      },
    );

    if (!input.production) {
      data.push(
        {
          range: `'גיליון1'!B${fallbackLayout.startingPlatoRow}`,
          values: [[date]],
        },
        {
          range: `'גיליון1'!D${fallbackLayout.startingPlatoRow}`,
          values: [[fallbackLayout.startingPlatoFormula]],
        },
      );
    }

    const valuesResponse = await googleFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(fileId)}/values:batchUpdate`,
      {
        method: "POST",
        body: JSON.stringify({
          valueInputOption: "USER_ENTERED",
          data,
        }),
      },
    );
    await requireOk(valuesResponse, "מילוי פרטי האצווה ב-Sheet נכשל");

    if (input.production) {
      console.info("Brew Sheet created", {
        batchNumber: input.batchNumber,
        style: input.style,
        tankType: input.tankType,
        templateId: copiedFromTemplate,
        usedMaster:
          copiedFromTemplate === PRODUCTION_MASTER_TEMPLATE_IDS[input.tankType],
      });
    }

    return {
      id: fileId,
      name: String(copied.name || name),
      url:
        String(copied.webViewLink || "") ||
        `https://docs.google.com/spreadsheets/d/${fileId}/edit`,
    };
  } catch (error) {
    await deleteSandboxFile(fileId);
    throw error;
  }
}


export async function productionBrewSheetExists(
  batchNumber: string,
): Promise<boolean> {
  const clean = String(batchNumber || "").replace("#", "").trim();
  if (!/^\d+$/.test(clean)) return false;

  const q =
    "mimeType = 'application/vnd.google-apps.spreadsheet'" +
    " and trashed = false" +
    " and name contains '" + clean + "'";
  const response = await googleFetch(
    "https://www.googleapis.com/drive/v3/files?q=" +
      encodeURIComponent(q) +
      "&pageSize=100&fields=files(id,name)",
    { method: "GET" },
  );
  await requireOk(response, "בדיקת מספר האצווה ב-Drive נכשלה");
  const payload = await response.json();
  const files = Array.isArray(payload?.files) ? payload.files : [];
  const exactBatch = new RegExp("(^|\\D)" + clean + "(?:#|\\D|$)");

  return files.some((file: Record<string, unknown>) =>
    exactBatch.test(String(file.name || "")),
  );
}

export async function searchAccessibleBrewSheetsByStyle(
  style: string,
  maxResults = 80,
): Promise<AccessibleBrewSheet[]> {
  if (runtimeConfig.deployEnv !== "preview") {
    throw new Error("חיפוש Sheets היסטוריים זמין כרגע ב-Preview בלבד.");
  }

  const cleanStyle = String(style || "").trim();
  if (!cleanStyle) return [];

  const escaped = cleanStyle.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const q = [
    "mimeType = 'application/vnd.google-apps.spreadsheet'",
    "trashed = false",
    `name contains '${escaped}'`,
  ].join(" and ");

  const url =
    "https://www.googleapis.com/drive/v3/files" +
    `?q=${encodeURIComponent(q)}` +
    `&pageSize=${Math.max(10, Math.min(100, maxResults))}` +
    "&orderBy=modifiedTime desc" +
    "&fields=files(id,name,webViewLink,modifiedTime)";

  const response = await googleFetch(url, { method: "GET" });
  await requireOk(response, "חיפוש בישולים קודמים ב-Drive נכשל");
  const payload = await response.json();
  const files = Array.isArray(payload?.files) ? payload.files : [];

  return files.map((file: Record<string, unknown>) => ({
    id: String(file.id || ""),
    name: String(file.name || ""),
    url:
      String(file.webViewLink || "") ||
      `https://docs.google.com/spreadsheets/d/${String(file.id || "")}/edit`,
    modifiedTime: file.modifiedTime ? String(file.modifiedTime) : undefined,
  })).filter((file: AccessibleBrewSheet) => !!file.id);
}


export async function readSandboxSheetRange(
  fileId: string,
  range: string,
): Promise<string[][]> {
  if (!fileId || runtimeConfig.deployEnv !== "preview") {
    throw new Error("קריאה מ-Sheet זמינה רק ב-Preview.");
  }

  const response = await googleFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      fileId,
    )}/values/${encodeURIComponent(
      range,
    )}?valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`,
    { method: "GET" },
  );

  await requireOk(response, "קריאת נתוני הבישול מה-Sheet נכשלה");
  const payload = await response.json();
  return Array.isArray(payload?.values) ? payload.values : [];
}


export async function writeSandboxSheetCells(
  fileId: string,
  data: Array<{ range: string; value: string | number | boolean | null }>,
): Promise<void> {
  if (!fileId || runtimeConfig.deployEnv !== "preview") {
    throw new Error("כתיבה ל-Sheet זמינה רק ב-Preview.");
  }

  const response = await googleFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(fileId)}/values:batchUpdate?includeValuesInResponse=true&responseValueRenderOption=FORMATTED_VALUE`,
    {
      method: "POST",
      body: JSON.stringify({
        valueInputOption: "USER_ENTERED",
        data: data.map((item) => ({
          range: item.range,
          values: [[item.value ?? ""]],
        })),
      }),
    },
  );

  await requireOk(response, "כתיבת נתוני הבישול ל-Sheet נכשלה");
  const payload = await response.json().catch(() => null);
  const responses = Array.isArray(payload?.responses) ? payload.responses : [];

  if (responses.length !== data.length) {
    throw new Error(
      `Google Sheets אישר רק ${responses.length} מתוך ${data.length} כתיבות. הנתונים נשארו מסומנים כלא מסונכרנים.`,
    );
  }
}
