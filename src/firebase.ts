// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth,GoogleAuthProvider } from "firebase/auth";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyAzmFTjWuLZjNzYDVKM9kK_xNEm37jiuGY",
  authDomain: "fermenter-dashboard-bada3.firebaseapp.com",
  projectId: "fermenter-dashboard-bada3",
  storageBucket: "fermenter-dashboard-bada3.firebasestorage.app",
  messagingSenderId: "1000438477674",
  appId: "1:1000438477674:web:3e105bd365821853556b13",
  measurementId: "G-Y1EWH9FMV9"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

export const auth=getAuth(app);
export const googleProvider= new GoogleAuthProvider();
export const db = getFirestore(app);