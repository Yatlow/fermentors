// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "firebase/firestore";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { runtimeConfig } from "./config/runtimeConfig";

const firebaseConfig = runtimeConfig.firebase;

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

// Keep Firestore data in IndexedDB and share it across tabs. This avoids
// downloading the same planning/pallet/log documents again every time the user
// leaves and re-enters the planning area. Live listeners still receive server
// deltas, so cached data never becomes a separate source of truth.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager(),
  }),
});
