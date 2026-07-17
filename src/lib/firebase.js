// Firebase init for Prakash Super Mart — Auth (email/password) + Realtime Database.
// These keys are client-side config (safe to be public); access is enforced by Firebase
// Auth + the Realtime Database security rules (locked to the shop owner's email).
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getDatabase } from "firebase/database";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: "AIzaSyAcaC5njD3I67r2infw4dsIKped1z0UlcU",
  authDomain: "prakash-super-mart-cf4a7.firebaseapp.com",
  databaseURL: "https://prakash-super-mart-cf4a7-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "prakash-super-mart-cf4a7",
  storageBucket: "prakash-super-mart-cf4a7.firebasestorage.app",
  messagingSenderId: "148896169688",
  appId: "1:148896169688:web:834d51de3fee1ac825e1ad",
  measurementId: "G-FZ7VQP2ETP",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);
export const storage = getStorage(app);
