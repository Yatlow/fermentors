function env(name: keyof ImportMetaEnv, fallback: string): string {
  const value = import.meta.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/**
 * Browser configuration lives in one place so moving Firebase / Apps Script /
 * Drive to the work account is a config change instead of a repository-wide
 * search-and-replace. These are public browser identifiers, not credentials.
 */
export const runtimeConfig = {
  firebase: {
    apiKey: env("VITE_FIREBASE_API_KEY", "AIzaSyAzmFTjWuLZjNzYDVKM9kK_xNEm37jiuGY"),
    authDomain: env("VITE_FIREBASE_AUTH_DOMAIN", "fermenter-dashboard-bada3.firebaseapp.com"),
    projectId: env("VITE_FIREBASE_PROJECT_ID", "fermenter-dashboard-bada3"),
    storageBucket: env("VITE_FIREBASE_STORAGE_BUCKET", "fermenter-dashboard-bada3.firebasestorage.app"),
    messagingSenderId: env("VITE_FIREBASE_MESSAGING_SENDER_ID", "1000438477674"),
    appId: env("VITE_FIREBASE_APP_ID", "1:1000438477674:web:3e105bd365821853556b13"),
    measurementId: env("VITE_FIREBASE_MEASUREMENT_ID", "G-Y1EWH9FMV9"),
  },
  appsScriptUrl: env(
    "VITE_APPS_SCRIPT_URL",
    "https://script.google.com/macros/s/AKfycbzSq8vnL_P9DOkiXluKReSUNFILqlRkK-WxnPC_Q0BNt23rFHbLpRlkvPudbqElqw5h/exec",
  ),
  googleClientId: env(
    "VITE_GOOGLE_CLIENT_ID",
    "1000438477674-d4bl366t8qkiovrhmlpr0cnlcd97lp8p.apps.googleusercontent.com",
  ),
  brewFolderId: env(
    "VITE_BREW_FOLDER_ID",
    "0B6DbCIATIM92fm1KQkpVeTR3dXk1ZVRPOUttUVJGelMzcl9nUTR6SzM3ZEE3WjVvc0RvSVk",
  ),
} as const;
