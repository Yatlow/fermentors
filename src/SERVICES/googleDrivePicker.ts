declare global {
  interface Window {
    gapi: any;
    google: any;
  }
}

// TODO: מלא ב-.env:
// VITE_GOOGLE_API_KEY=...
// VITE_GOOGLE_CLIENT_ID=...
const GOOGLE_API_KEY = import.meta.env.VITE_GOOGLE_API_KEY as string;
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string;
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

let pickerApiLoaded = false;
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

async function ensurePickerApi(): Promise<void> {
  if (pickerApiLoaded) return;
  await loadScript("https://apis.google.com/js/api.js");
  await new Promise<void>((resolve) => {
    window.gapi.load("picker", () => {
      pickerApiLoaded = true;
      resolve();
    });
  });
}

async function ensureGis(): Promise<void> {
  if (gisLoaded) return;
  await loadScript("https://accounts.google.com/gsi/client");
  gisLoaded = true;
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

export async function openSheetsPicker(): Promise<PickedFile | null> {
  if (!GOOGLE_API_KEY) {
    throw new Error("חסר VITE_GOOGLE_API_KEY בהגדרות הפרויקט");
  }

  await ensurePickerApi();
  const token = await ensureAccessToken();

  return new Promise((resolve) => {
    const view = new window.google.picker.DocsView(
      window.google.picker.ViewId.SPREADSHEETS
    )
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false);

    const picker = new window.google.picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(token)
      .setDeveloperKey(GOOGLE_API_KEY)
      .setCallback((data: any) => {
        if (data.action === window.google.picker.Action.PICKED) {
          const pickedDoc = data.docs[0];
          resolve({ id: pickedDoc.id, name: pickedDoc.name, url: pickedDoc.url });
        } else if (data.action === window.google.picker.Action.CANCEL) {
          resolve(null);
        }
      })
      .build();

    picker.setVisible(true);
  });
}