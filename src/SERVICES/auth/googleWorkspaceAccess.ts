import {
  GoogleAuthProvider,
  reauthenticateWithPopup,
  type User,
  type UserCredential,
} from "firebase/auth";

export const GOOGLE_WORKSPACE_WRITE_SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/spreadsheets",
] as const;

const SESSION_TOKEN_KEY = "fermentors:google-workspace-token:v1";
const SESSION_TOKEN_EXPIRY_KEY =
  "fermentors:google-workspace-token-expiry:v1";
const TOKEN_TTL_MS = 50 * 60 * 1000;

let accessToken: string | null = null;
let accessTokenExpiresAt = 0;

export function configureGoogleWorkspaceProvider(
  provider: GoogleAuthProvider,
): GoogleAuthProvider {
  GOOGLE_WORKSPACE_WRITE_SCOPES.forEach((scope) =>
    provider.addScope(scope),
  );
  return provider;
}

export function rememberGoogleWorkspaceCredential(
  result: UserCredential,
): string | null {
  const credential =
    GoogleAuthProvider.credentialFromResult(result);
  const token = credential?.accessToken || null;
  if (!token) return null;

  accessToken = token;
  accessTokenExpiresAt = Date.now() + TOKEN_TTL_MS;

  try {
    sessionStorage.setItem(SESSION_TOKEN_KEY, token);
    sessionStorage.setItem(
      SESSION_TOKEN_EXPIRY_KEY,
      String(accessTokenExpiresAt),
    );
  } catch {
    // In-memory reuse still works for this page lifetime.
  }

  return token;
}

export function getRememberedGoogleWorkspaceToken(): string | null {
  if (accessToken && Date.now() < accessTokenExpiresAt) {
    return accessToken;
  }

  try {
    const storedToken =
      sessionStorage.getItem(SESSION_TOKEN_KEY) || "";
    const expiresAt = Number(
      sessionStorage.getItem(SESSION_TOKEN_EXPIRY_KEY) || 0,
    );

    if (storedToken && expiresAt > Date.now()) {
      accessToken = storedToken;
      accessTokenExpiresAt = expiresAt;
      return storedToken;
    }
  } catch {
    // sessionStorage may be unavailable in hardened/private contexts.
  }

  clearGoogleWorkspaceToken();
  return null;
}

export function clearGoogleWorkspaceToken() {
  accessToken = null;
  accessTokenExpiresAt = 0;

  try {
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
    sessionStorage.removeItem(SESSION_TOKEN_EXPIRY_KEY);
  } catch {
    // Ignore storage cleanup failures.
  }
}

export async function ensureGoogleWorkspaceToken(
  user: User,
  forceConsent = false,
): Promise<string> {
  if (!forceConsent) {
    const existing = getRememberedGoogleWorkspaceToken();
    if (existing) return existing;
  }

  const provider = configureGoogleWorkspaceProvider(
    new GoogleAuthProvider(),
  );
  if (forceConsent) {
    provider.setCustomParameters({ prompt: "consent" });
  }

  const result = await reauthenticateWithPopup(user, provider);
  const token = rememberGoogleWorkspaceCredential(result);

  if (!token) {
    throw new Error(
      "Google לא החזיר הרשאת Drive/Sheets.",
    );
  }

  return token;
}
