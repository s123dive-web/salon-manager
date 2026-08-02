// @vitest-environment jsdom
//
// End-to-end check of the colour-theme feature against the REAL app module. Firebase and the
// charting lib are stubbed so the actual component tree — App → RoleGate → StoreManager →
// StoreConfig — renders in jsdom. We sign in as an owner, open Settings, pick a theme, save, and
// assert the whole app re-skins (the .app root's --brand CSS variable flips to the chosen palette).
import { describe, it, expect, vi, beforeAll } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const OWNER = { email: "owner@test", name: "Owner", role: "owner", active: true, createdAt: "2026-08-02" };

// Fire whatever a given RTDB path should resolve to: the signed-in user's owner record, the users
// map, an online connection, and empty data for config + every slice.
const dataFor = (path) => {
  if (path.includes(".info/connected")) return true;
  if (path.includes("shop/users/")) return OWNER; // subscribeOwnUser(uid)
  if (path.endsWith("shop/users")) return { u1: OWNER }; // subscribeUsers / readUsersOnce
  return null; // shop/config + all data slices => empty
};
const snap = (v) => ({ val: () => v });

vi.mock("./lib/firebase.js", () => ({ app: {}, auth: {}, db: {}, storage: {}, isFirebaseConfigured: true, secondaryApp: () => ({}) }));
vi.mock("firebase/auth", () => ({
  onAuthStateChanged: (_auth, cb) => { cb({ uid: "u1", email: "owner@test" }); return () => {}; },
  signInWithEmailAndPassword: vi.fn(), createUserWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(), sendPasswordResetEmail: vi.fn(), getAuth: vi.fn(),
  EmailAuthProvider: { credential: vi.fn() }, reauthenticateWithCredential: vi.fn(),
}));
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: String(path) }),
  onValue: (refObj, cb) => { cb(snap(dataFor(refObj.path))); return () => {}; },
  set: vi.fn(() => Promise.resolve()),
  update: vi.fn(() => Promise.resolve()),
  get: (refObj) => Promise.resolve(snap(dataFor(refObj.path))),
}));
vi.mock("firebase/storage", () => ({ ref: vi.fn(), uploadBytes: vi.fn(), getDownloadURL: vi.fn(), deleteObject: vi.fn() }));
vi.mock("firebase/app", () => ({ initializeApp: vi.fn(() => ({})), deleteApp: vi.fn() }));
// Charts need browser APIs jsdom lacks and aren't what we're testing — render them as no-ops.
vi.mock("recharts", () => {
  const S = () => null;
  return { ResponsiveContainer: S, AreaChart: S, Area: S, BarChart: S, Bar: S, LineChart: S, Line: S, ComposedChart: S, Treemap: S, ReferenceLine: S, XAxis: S, YAxis: S, Tooltip: S, CartesianGrid: S, PieChart: S, Pie: S, Cell: S, Legend: S };
});
vi.mock("jsbarcode", () => ({ default: vi.fn() }));
vi.mock("qrcode-generator", () => ({ default: () => ({ addData() {}, make() {}, createDataURL: () => "", getModuleCount: () => 0, isDark: () => false }) }));

beforeAll(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});

const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };

describe("colour theme — real app, end to end", () => {
  it("signs in as owner, and picking + saving a theme re-skins the whole app", async () => {
    const App = (await import("./salon-manager.jsx")).default;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => { root.render(<App />); });
    await flush();

    const appRoot = () => container.querySelector(".app");
    expect(appRoot(), "app shell should render (signed in as owner, past the role gate)").toBeTruthy();

    // Default theme is Emerald, so the root's brand variable is the emerald green.
    expect(appRoot().style.getPropertyValue("--brand").toLowerCase()).toContain("1b5e43");

    const buttons = () => [...container.querySelectorAll("button")];
    const byText = (re) => buttons().find((b) => re.test((b.textContent || "").replace(/\s+/g, " ").trim()));

    // Navigate: open the "Other" group, then Salon Settings.
    const other = byText(/Other/);
    expect(other, "the Other nav group should be present").toBeTruthy();
    await act(async () => { other.click(); });
    await flush();
    const settings = byText(/Salon Settings/);
    expect(settings, "Salon Settings should be reachable for an owner").toBeTruthy();
    await act(async () => { settings.click(); });
    await flush();

    // The theme picker lives on the Settings screen.
    const plum = byText(/^Plum$/);
    expect(plum, "the Plum theme swatch should render in Settings").toBeTruthy();
    await act(async () => { plum.click(); });
    await flush();

    const save = byText(/^Save settings$/);
    expect(save, "Save settings button should be present").toBeTruthy();
    expect(save.disabled, "Save should be enabled once a theme is picked (form is dirty)").toBe(false);
    await act(async () => { save.click(); });
    await flush();

    // The whole app re-skinned: the root's --brand is now Plum's violet.
    expect(appRoot().style.getPropertyValue("--brand").toLowerCase()).toContain("7c3aed");

    root.unmount();
    container.remove();
  });
});
