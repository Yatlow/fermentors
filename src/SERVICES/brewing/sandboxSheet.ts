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
        '=IF(B98<>"",IF(AND(C49<>"",C99<>""),(((B48+0.05)*C49)+((B98+0.05)*(C99-C49)))/C99,""),IF(B48<>"",B48+0.05,""))',
    };
  }
  return {
    blockHeaderRows: [4, 54, 102],
    fermentationHeaderRow: 154,
    startingPlatoRow: 156,
    startingPlatoFormula:
      '=IF(B145<>"",IF(AND(C49<>"",C99<>"",C146<>""),(((B48+0.05)*C49)+((B98+0.05)*(C99-C49))+((B145+0.05)*(C146-C99)))/C146,""),IF(B98<>"",IF(AND(C49<>"",C99<>""),(((B48+0.05)*C49)+((B98+0.05)*(C99-C49)))/C99,""),IF(B48<>"",B48+0.05,"")))',
  };
}

function jerusalemDate(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.day}/${map.month}/${map.year}`;
}

function sheetDate(value?: string): string {
  const text = String(value || "").trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  const display = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (display) {
    return `${display[1].padStart(2, "0")}/${display[2].padStart(2, "0")}/${display[3]}`;
  }
  return jerusalemDate();
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
  brewDate?: string;
  recipe?: BrewRecipe;
  ingredients?: IngredientDefinition[];
}): Promise<SandboxSheetResult> {
  if (runtimeConfig.deployEnv !== "preview") {
    throw new Error("יצירת Sheet ב-Sandbox זמינה רק ב-Preview.");
  }
  if (input.style !== "IPA") {
    throw new Error("בשלב ה-Sandbox הראשון יצירת Sheet פעילה ל-IPA בלבד.");
  }

  const folderId = runtimeConfig.brewingSandbox.folderId;
  if (!folderId) throw new Error("לא הוגדרה תיקיית Sandbox ב-Drive.");

  const templateId = templateIdFor(input.tankType);
  const name = `[SANDBOX] IPA ${tankLabel(input.tankType)} ${input.batchNumber}#`;

  const copyResponse = await googleFetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(templateId)}/copy?supportsAllDrives=true&fields=id,name,webViewLink`,
    {
      method: "POST",
      body: JSON.stringify({
        name,
        parents: [folderId],
      }),
    },
  );
  await requireOk(copyResponse, "יצירת העתק של טופס הבישול נכשלה");
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

    const date = sheetDate(input.brewDate);
    const layout = layoutFor(input.tankType);
    const styleLabel =
      input.tankType === "single" ? "IPA" : `IPA ${tankLabel(input.tankType)}`;
    const suffixes = ["A", "B", "C"];

    const data: Array<{ range: string; values: unknown[][] }> = [
      { range: "'גיליון1'!B1", values: [["IPA"]] },
      { range: "'גיליון1'!D1", values: [[input.tankNumber]] },
      { range: "'גיליון1'!F1", values: [[input.batchNumber]] },
      { range: "'גיליון1'!H1", values: [[date]] },
    ];

    layout.blockHeaderRows.forEach((row, index) => {
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
      layout.blockHeaderRows.forEach((headerRow) => {
        input.recipe!.grains.forEach((grain, grainIndex) => {
          const ingredient = input.ingredients!.find(
            (item) => item.id === grain.ingredientId,
          );
          if (!ingredient) return;

          const lot = activeLot(ingredient);
          const row = headerRow + 4 + grainIndex;
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

    data.push(
      {
        range: `'גיליון1'!B${layout.fermentationHeaderRow}`,
        values: [[styleLabel]],
      },
      {
        range: `'גיליון1'!D${layout.fermentationHeaderRow}`,
        values: [[input.batchNumber]],
      },
      {
        range: `'גיליון1'!G${layout.fermentationHeaderRow}`,
        values: [[input.tankNumber]],
      },
      {
        range: `'גיליון1'!B${layout.startingPlatoRow}`,
        values: [[date]],
      },
      {
        range: `'גיליון1'!D${layout.startingPlatoRow}`,
        values: [[layout.startingPlatoFormula]],
      },
    );

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
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(fileId)}/values:batchUpdate`,
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
}
