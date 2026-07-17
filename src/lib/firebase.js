// Firebase init for Salon Manager — Auth (email/password) + Realtime Database + Storage.
//
// ⚠ PLACEHOLDER CONFIG — THE APP CANNOT SIGN IN OR SYNC UNTIL YOU FILL THIS IN. ⚠
//
// Salon Manager needs its OWN Firebase project. Do not point it at another app's
// project: this app stores everything under the same `shop/<slice>` paths that the
// grocery-store-manager app uses, so sharing a project would have the two apps
// overwrite each other's live data.
//
// SETUP (once):
//   1. Firebase console → Add project.
//   2. Build → Authentication → Sign-in method → enable Email/Password.
//   3. Build → Realtime Database → Create database (pick your region).
//   4. Build → Storage → Get started (needed for vendor-bill proof uploads).
//   5. Project settings → General → Your apps → Web app → copy the config object
//      and paste its values over the PLACEHOLDER strings below.
//   6. Deploy the security rules:  firebase deploy --only database,storage
//      (see database.rules.json + storage.rules; first sign-in self-registers as owner).
//
// These keys are client-side config and are safe to be public — they identify the
// project, they don't grant access. Access is enforced by Firebase Auth plus the
// role-based security rules in database.rules.json / storage.rules.
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getDatabase } from "firebase/database";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: "PLACEHOLDER_API_KEY",
  authDomain: "PLACEHOLDER.firebaseapp.com",
  databaseURL: "https://PLACEHOLDER-default-rtdb.firebaseio.com",
  projectId: "PLACEHOLDER",
  storageBucket: "PLACEHOLDER.firebasestorage.app",
  messagingSenderId: "PLACEHOLDER_SENDER_ID",
  appId: "PLACEHOLDER_APP_ID",
};

// True once the config above has actually been filled in. The sign-in screen uses this
// to show a clear "not configured yet" message instead of letting Firebase fail with an
// opaque auth/invalid-api-key error.
export const isFirebaseConfigured = !Object.values(firebaseConfig).some((v) =>
  String(v).includes("PLACEHOLDER")
);

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);
export const storage = getStorage(app);

// Creating a user with the client SDK signs that new user in, which would kick the owner
// out of their own session. The standard workaround is a SECOND, throwaway app instance:
// create the account on it, then sign it out. The owner's session lives on the primary
// `app` above and is never touched.
// Used by Settings → Users (owner only). See src/lib/roles.js for the permission matrix.
export const secondaryApp = () => initializeApp(firebaseConfig, "userCreator");
