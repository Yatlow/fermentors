declare global {
  interface Window {
    google: any;
  }
}

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string;
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

const BREW_FOLDER_ID =
  "0B6DbCIATIM92fm1KQkpVeTR3dXk1ZVRPOUttUVJGelMzcl9nUTR6SzM3ZEE3WjVvc0RvSVk";

let gisLoaded = false;
let accessToken: string | null = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load " + src));
    document.body.appendChild(script);
  });
}

async function ensureGis(): Promise<void> {
  if (gisLoaded) return;
  await loadScript("https://accounts.google.com/gsi/client");
  gisLoaded = true;
}

function reclaimFocus() {
  let attempts = 0;
  const tryBlur = () => {
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body) active.blur();
    document.body.focus();
    attempts += 1;
    if (attempts < 8) requestAnimationFrame(tryBlur);
  };
  requestAnimationFrame(tryBlur);
  setTimeout(tryBlur, 300);
  setTimeout(tryBlur, 700);
}

async function ensureAccessToken(): Promise<string> {
  await ensureGis();
  if (accessToken) return accessToken;

  if (!GOOGLE_CLIENT_ID) {
    throw new Error("חסר VITE_GOOGLE_CLIENT_ID בהגדרות הפרויקט");
  }

  return new Promise((resolve, reject) => {
    const tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE,
      callback: (response: any) => {
        if (response.error) {
          reject(new Error(response.error));
          return;
        }
        accessToken = response.access_token;
        reclaimFocus();
        resolve(accessToken as string);
      },
    });
    tokenClient.requestAccessToken({ prompt: "" });
  });
}

export type PickedFile = {
  id: string;
  name: string;
  url: string;
};

type DriveApiFile = {
  id: string;
  name: string;
  modifiedTime?: string;
};

function escapeDriveQueryTerm(term: string): string {
  return term.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function driveFetch(url: URL, token: string): Promise<any> {
  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status === 401) {
    accessToken = null;
    const freshToken = await ensureAccessToken();
    const retryResponse = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${freshToken}` },
    });
    if (retryResponse.status === 404) {
      throw new Error("הקובץ לא נמצא או שאין הרשאת גישה אליו");
    }
    if (!retryResponse.ok) throw new Error("שגיאה בתקשורת מול הדרייב");
    return retryResponse.json();
  }

  if (response.status === 404) {
    throw new Error("הקובץ לא נמצא או שאין הרשאת גישה אליו");
  }
  if (!response.ok) throw new Error("שגיאה בתקשורת מול הדרייב");
  return response.json();
}

// -----------------------------------------------------------
// מיפוי עץ תתי-התיקיות תחת BREW_FOLDER_ID, עם קאש קצר-טווח
// (מבנה התיקיות משתנה לעיתים נדירות, בניגוד לקבצים בתוכן)
// -----------------------------------------------------------
let folderTreeCache: { ids: string[]; fetchedAt: number } | null = null;
const FOLDER_TREE_TTL_MS = 5 * 60 * 1000; // 5 דקות

async function fetchAllSubfolderIds(token: string): Promise<string[]> {
  const now = Date.now();
  if (folderTreeCache && now - folderTreeCache.fetchedAt < FOLDER_TREE_TTL_MS) {
    return folderTreeCache.ids;
  }

  const allIds: string[] = [BREW_FOLDER_ID];
  let frontier: string[] = [BREW_FOLDER_ID];

  // BFS על העץ, שכבה-שכבה, כדי לתפוס תתי-תיקיות בכל עומק
  while (frontier.length > 0) {
    const parentsClause = frontier
      .map((id) => `'${id}' in parents`)
      .join(" or ");

    const q = `(${parentsClause}) and mimeType='application/vnd.google-apps.folder' and trashed=false`;

    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", q);
    url.searchParams.set("fields", "files(id)");
    url.searchParams.set("pageSize", "1000");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");

    const data = await driveFetch(url, token);
    const foundIds: string[] = (data.files || []).map((f: DriveApiFile) => f.id);

    allIds.push(...foundIds);
    frontier = foundIds;
  }

  folderTreeCache = { ids: allIds, fetchedAt: now };
  return allIds;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

function mapFiles(files: DriveApiFile[]): PickedFile[] {
  return files.map((f) => ({
    id: f.id,
    name: f.name,
    url: `https://docs.google.com/spreadsheets/d/${f.id}/edit`,
  }));
}

/**
 * מחפש קבצי גיליון בתיקיית הבישולים ובכל תתי-התיקיות שלה, בכל עומק.
 * term ריק => מחזיר את הקבצים האחרונים שהשתנו בכל העץ.
 */
export async function searchBrewSheets(term: string): Promise<PickedFile[]> {
  const token = await ensureAccessToken();
  const folderIds = await fetchAllSubfolderIds(token);

  const trimmed = term.trim();
  const nameClause = trimmed
    ? ` and name contains '${escapeDriveQueryTerm(trimmed)}'`
    : "";

  // גוגל מגביל את אורך ה-query, אז מפצלים לקבוצות של תיקיות
  const FOLDER_CHUNK_SIZE = 20;
  const folderChunks = chunk(folderIds, FOLDER_CHUNK_SIZE);

  const requests = folderChunks.map((idsChunk) => {
    const parentsClause = idsChunk.map((id) => `'${id}' in parents`).join(" or ");
    const q = `(${parentsClause}) and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false${nameClause}`;

    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", q);
    url.searchParams.set("fields", "files(id,name,modifiedTime)");
    url.searchParams.set("orderBy", "modifiedTime desc");
    url.searchParams.set("pageSize", "25");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");

    return driveFetch(url, token);
  });

  const results = await Promise.all(requests);
  const allFiles: DriveApiFile[] = results.flatMap((r) => r.files || []);

  // מאחדים כפילויות (לא אמורות להיות, אבל ליתר ביטחון) וממיינים לפי תאריך עדכון
  const uniqueById = new Map<string, DriveApiFile>();
  for (const f of allFiles) uniqueById.set(f.id, f);

  const sorted = Array.from(uniqueById.values()).sort((a, b) => {
    const aTime = a.modifiedTime ? new Date(a.modifiedTime).getTime() : 0;
    const bTime = b.modifiedTime ? new Date(b.modifiedTime).getTime() : 0;
    return bTime - aTime;
  });

  return mapFiles(sorted.slice(0, 30));
}

// מזהה קובץ מתוך URL של Google Sheets/Drive, בכל אחד מהפורמטים הנפוצים:
// https://docs.google.com/spreadsheets/d/FILE_ID/edit...
// https://drive.google.com/file/d/FILE_ID/view...
// https://drive.google.com/open?id=FILE_ID
export function extractFileIdFromUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  const patterns = [
    /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/,
    /\/file\/d\/([a-zA-Z0-9_-]+)/,
    /[?&]id=([a-zA-Z0-9_-]+)/,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match) return match[1];
  }

  // אם הודבק ID גולמי בלבד (לא URL) - נקבל גם את זה
  if (/^[a-zA-Z0-9_-]{20,}$/.test(trimmed)) return trimmed;

  return null;
}

/**
 * שולף שם ומטא-דאטה של קובץ ספציפי לפי ID - לשימוש כשהמשתמש מדביק URL ישירות.
 */
export async function getFileById(fileId: string): Promise<PickedFile> {
  const token = await ensureAccessToken();

  const url = new URL(`https://www.googleapis.com/drive/v3/files/${fileId}`);
  url.searchParams.set("fields", "id,name,mimeType,trashed,parents");
  url.searchParams.set("supportsAllDrives", "true");

  const data = await driveFetch(url, token);

  if (data.trashed) {
    throw new Error("הקובץ נמצא באשפה בדרייב");
  }
  if (data.mimeType !== "application/vnd.google-apps.spreadsheet") {
    throw new Error("הקישור שהודבק אינו מפנה לגיליון Google Sheets");
  }

  // בדיקה שהקובץ אכן נמצא בתוך תיקיית הבישולים או אחת מתתי-התיקיות שלה
  const allowedFolderIds = await fetchAllSubfolderIds(token);
  const fileParents: string[] = data.parents || [];
  const isInsideBrewFolder = fileParents.some((parentId) =>
    allowedFolderIds.includes(parentId)
  );

  if (!isInsideBrewFolder) {
    throw new Error("הקובץ שהודבק אינו נמצא בתיקיית טופסי הבישול");
  }

  return {
    id: data.id,
    name: data.name,
    url: `https://docs.google.com/spreadsheets/d/${data.id}/edit`,
  };
}
