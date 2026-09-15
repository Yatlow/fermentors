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

// Auth used to require two remote HTTP calls before EVERY Apps Script action:
// Firebase accounts:lookup + Firestore approvedUsers lookup. That added visible
// latency to every Sheet write. Keep short-lived server-side caches instead.
//
// Security trade-off is intentionally small:
// - an already verified Firebase ID token may remain accepted for up to 5 min
//   after revocation;
// - approvedUsers membership may remain accepted for up to 60 sec after removal.
// New/unknown tokens and users are still verified against Firebase immediately.
const FIREBASE_TOKEN_CACHE_SECONDS = 300;
const APPROVED_USER_CACHE_SECONDS = 60;
const DENIED_USER_CACHE_SECONDS = 30;

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

function authCacheHash_(value) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(value || ""),
    Utilities.Charset.UTF_8
  );

  return bytes.map(function (byte) {
    const unsigned = byte < 0 ? byte + 256 : byte;
    return ("0" + unsigned.toString(16)).slice(-2);
  }).join("");
}

function verifyFirebaseIdToken_(idToken) {
  const cache = CacheService.getScriptCache();
  const cacheKey = "firebase_token:" + authCacheHash_(idToken);
  const cached = cache.get(cacheKey);

  if (cached) {
    try {
      const parsedCached = JSON.parse(cached);
      if (parsedCached && parsedCached.localId && parsedCached.email) {
        return parsedCached;
      }
    } catch (error) {
      // Ignore malformed/stale cache and verify remotely below.
    }
  }

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

  // Store only the fields authorization actually needs. Never cache the token.
  const cacheValue = {
    localId: String(user.localId),
    email: String(user.email),
    emailVerified: user.emailVerified === true
  };

  cache.put(
    cacheKey,
    JSON.stringify(cacheValue),
    FIREBASE_TOKEN_CACHE_SECONDS
  );

  return cacheValue;
}

function isApprovedFirebaseUser_(email) {
  const normalizedEmail = String(email || "").trim();
  if (!normalizedEmail) return false;

  const cache = CacheService.getScriptCache();
  const cacheKey = "approved_user:" + authCacheHash_(normalizedEmail);
  const cached = cache.get(cacheKey);

  if (cached === "1") return true;
  if (cached === "0") return false;

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

  if (status === 404) {
    cache.put(cacheKey, "0", DENIED_USER_CACHE_SECONDS);
    return false;
  }

  if (status >= 200 && status < 300) {
    cache.put(cacheKey, "1", APPROVED_USER_CACHE_SECONDS);
    return true;
  }

  console.log("approvedUsers lookup failed. HTTP " + status);
  throw new Error("Authorization service unavailable");
}
