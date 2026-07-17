import { describe, it, expect, vi } from "vitest";

// Smoke test for the app module itself.
//
// `vite build` proves the imports RESOLVE, but it never EVALUATES the module — so a
// module-init fault (a const read before its initialiser, a seed builder throwing on load)
// ships green and only explodes in the browser. This file evaluates the real module graph.
//
// Firebase is stubbed: importing the app reaches src/lib/firebase.js, which would otherwise
// call initializeApp() with the placeholder config and try to open a network connection.
vi.mock("./lib/firebase.js", () => ({
  app: {},
  auth: {},
  db: {},
  storage: {},
  isFirebaseConfigured: false,
  secondaryApp: () => ({}),
}));
vi.mock("firebase/database", () => ({
  ref: vi.fn(), onValue: vi.fn(() => vi.fn()), set: vi.fn(), update: vi.fn(), get: vi.fn(),
}));
vi.mock("firebase/auth", () => ({
  onAuthStateChanged: vi.fn(() => vi.fn()),
  signInWithEmailAndPassword: vi.fn(),
  createUserWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  getAuth: vi.fn(),
  EmailAuthProvider: { credential: vi.fn() },
  reauthenticateWithCredential: vi.fn(),
}));
vi.mock("firebase/storage", () => ({
  ref: vi.fn(), uploadBytes: vi.fn(), getDownloadURL: vi.fn(), deleteObject: vi.fn(),
}));
vi.mock("firebase/app", () => ({ initializeApp: vi.fn(() => ({})), deleteApp: vi.fn() }));

describe("salon-manager module", () => {
  it("evaluates without throwing, and exports the App component", async () => {
    // A module-init error (bad ordering, a throwing seed builder) surfaces here as a rejected
    // import rather than as a white screen in front of a customer.
    const mod = await import("./salon-manager.jsx");
    expect(typeof mod.default).toBe("function");
  });

  it("builds its seed catalogues at module load", async () => {
    // The seeds are top-level consts: if buildProducts/buildServices threw, or read `uid`
    // before its initialiser, the import above would already have failed. This asserts they
    // actually produced data rather than silently yielding empty arrays.
    const { buildProducts, buildServices, buildStaff, buildTemplates } = await import("./lib/seed.js");
    const uid = (() => { let n = 0; return () => `id${++n}`; })();
    expect(buildProducts({ uid, today: "2026-07-17" }).length).toBeGreaterThan(0);
    expect(buildServices({ uid, today: "2026-07-17" }).length).toBeGreaterThan(0);
    expect(buildStaff({ uid, today: "2026-07-17" }).length).toBeGreaterThan(0);
    expect(buildTemplates({ uid, today: "2026-07-17" }).length).toBeGreaterThan(0);
  });
});
