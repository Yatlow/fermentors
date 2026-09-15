// ============================================================
// FIREBASE AUTHENTICATION FOR APPS SCRIPT WEB APP
// ============================================================
// The browser sends its Firebase ID token (a signed JWT) in the POST body.
// Apps Script does not ship with firebase-admin, so the token is verified by
// Firebase Auth's accounts:lookup endpoint. We then independently require the
// verified email to exist as a document ID in Firestore /approvedUsers.
//
// Important: the Firebase Web API key is not a secret. Authorization comes from
// the signed ID token + approvedUsers membership, not from this key.
// ============================================================

const FIREBASE_AUTH_PROJECT_ID = "fermenter-dashboard-bada3";
const FIREBASE_AUTH_WEB_API_KEY = "AIzaSyAzmFTjWuLZjNzYDVKM9kK_xNEm37jiuGY";

function authenticateFirebaseRequest_(idToken) {
  const token = String(idToken || "").trim();
  if (!token) {
    throw new Error("Unauthorized");
  }

  const verifiedUser = verifyFirebaseIdToken_(token);
  const email = String(verifiedUser.email || "").trim();

  if (!email || !verifiedUser.localId) {
    throw new Error("Unauthorized");
  }

  if (!isApprovedFirebaseUser_(email)) {
    throw new Error("Forbidden");
  }

  return {
    uid: String(verifiedUser.localId),
    email: email,
    emailVerified: verifiedUser.emailVerified === true
  };
}

function verifyFirebaseIdToken_(idToken) {
  const url =
    "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" +
    encodeURIComponent(FIREBASE_AUTH_WEB_API_KEY);

  const response = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ idToken: idToken }),
    muteHttpExceptions: true
  });

  const status = response.getResponseCode();
  const text = response.getContentText();

  if (status < 200 || status >= 300) {
    console.log("Firebase token verification failed. HTTP " + status);
    throw new Error("Unauthorized");
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error("Unauthorized");
  }

  const user = parsed && parsed.users && parsed.users[0];
  if (!user || !user.localId || !user.email) {
    throw new Error("Unauthorized");
  }

  return user;
}

function isApprovedFirebaseUser_(email) {
  const normalizedEmail = String(email || "").trim();
  if (!normalizedEmail) return false;

  const url =
    "https://firestore.googleapis.com/v1/projects/" +
    encodeURIComponent(FIREBASE_AUTH_PROJECT_ID) +
    "/databases/(default)/documents/approvedUsers/" +
    encodeURIComponent(normalizedEmail);

  const response = UrlFetchApp.fetch(url, {
    method: "get",
    headers: {
      Authorization: "Bearer " + ScriptApp.getOAuthToken()
    },
    muteHttpExceptions: true
  });

  const status = response.getResponseCode();

  if (status === 404) return false;
  if (status >= 200 && status < 300) return true;

  console.log("approvedUsers lookup failed. HTTP " + status);
  throw new Error("Authorization service unavailable");
}
