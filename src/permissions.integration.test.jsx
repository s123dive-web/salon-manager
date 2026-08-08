// @vitest-environment jsdom
//
// Settings → Feature access, asserted against the REAL app module.
//
// roles.test.js proves the matrix maths. This file proves the wiring: that a switch stored in
// config.permissions actually changes which rails a signed-in worker gets, that it lands
// LIVE (the salon does not reload a counter tablet), and — the two that matter most — that a
// forged switch for an owner-only feature changes nothing, and that no switch can touch an
// owner. Those last two are the difference between an operational control and a hole.
//
// Everything here mounts the whole app with Firebase mocked, so a change that satisfies
// roles.js but forgets to thread `perms` into a component still fails.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Mutable fixture the mocked database reads from. `vi.hoisted` because vi.mock factories are
// lifted above every other statement in the file and cannot see ordinary module scope.
const fx = vi.hoisted(() => ({ role: "biller", config: {}, configListeners: [] }));

const snap = (v) => ({ val: () => v });

vi.mock("./lib/firebase.js", () => ({ app: {}, auth: {}, db: {}, storage: {}, isFirebaseConfigured: true, secondaryApp: () => ({}) }));
vi.mock("firebase/auth", () => ({
  onAuthStateChanged: (_auth, cb) => { cb({ uid: "u1", email: "staff@test" }); return () => {}; },
  signInWithEmailAndPassword: vi.fn(), createUserWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(), sendPasswordResetEmail: vi.fn(), getAuth: vi.fn(),
  EmailAuthProvider: { credential: vi.fn() }, reauthenticateWithCredential: vi.fn(),
}));
vi.mock("firebase/database", () => {
  const me = () => ({ email: "staff@test", name: "Staff", role: fx.role, active: true, createdAt: "2026-08-02" });
  const dataFor = (path) => {
    if (path.includes(".info/connected")) return true;
    if (path.endsWith("shop/config")) return fx.config;
    if (path.includes("shop/users/")) return me();
    if (path.endsWith("shop/users")) return { u1: me() };
    return null;
  };
  return {
    ref: (_db, path) => ({ path: String(path) }),
    onValue: (refObj, cb) => {
      // Keep the config listeners so a test can push a change from "another device".
      if (refObj.path.endsWith("shop/config")) fx.configListeners.push(cb);
      cb({ val: () => dataFor(refObj.path) });
      return () => {};
    },
    set: vi.fn(() => Promise.resolve()),
    update: vi.fn(() => Promise.resolve()),
    get: (refObj) => Promise.resolve({ val: () => dataFor(refObj.path) }),
  };
});
vi.mock("firebase/storage", () => ({ ref: vi.fn(), uploadBytes: vi.fn(), uploadBytesResumable: vi.fn(), getDownloadURL: vi.fn(), deleteObject: vi.fn() }));
vi.mock("firebase/app", () => ({ initializeApp: vi.fn(() => ({})), deleteApp: vi.fn() }));
vi.mock("recharts", () => {
  const S = () => null;
  return { ResponsiveContainer: S, AreaChart: S, Area: S, BarChart: S, Bar: S, LineChart: S, Line: S, ComposedChart: S, Treemap: S, ReferenceLine: S, XAxis: S, YAxis: S, Tooltip: S, CartesianGrid: S, PieChart: S, Pie: S, Cell: S, Legend: S };
});
vi.mock("jsbarcode", () => ({ default: vi.fn() }));
vi.mock("qrcode-generator", () => ({ default: () => ({ addData() {}, make() {}, createDataURL: () => "", getModuleCount: () => 0, isDark: () => false }) }));

beforeAll(() => { globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; });

const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };

/** Mount the real app as `role`, with `permissions` already saved in the shop config. */
async function mountAs(role, permissions) {
  fx.role = role;
  fx.config = permissions ? { permissions } : {};
  const App = (await import("./salon-manager.jsx")).default;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(<App />); });
  await flush();
  return { container, cleanup: () => { root.unmount(); container.remove(); } };
}

/** The owner changes a switch on their own device; the worker's tablet is told. */
async function pushPermissions(permissions) {
  fx.config = { permissions };
  await act(async () => { fx.configListeners.forEach((cb) => cb(snap(fx.config))); });
  await flush();
}

/** Open the collapsed "Other" group, so the secondary rails are in the DOM too. */
async function expandOther(container) {
  const toggle = [...container.querySelectorAll(".nav .navbtn")].find((b) => b.getAttribute("title") === "Other");
  if (toggle && toggle.getAttribute("aria-expanded") === "false") {
    await act(async () => { toggle.click(); });
    await flush();
  }
}

/** Every sidebar entry this session offers, secondary group included. Read off aria-label
 *  because the visible text carries the icon glyph too ("₹Billing (POS)"). */
async function rails(container) {
  await expandOther(container);
  return [...container.querySelectorAll(".nav .navbtn[aria-label]")].map((b) => b.getAttribute("aria-label"));
}

async function clickRail(container, label) {
  await expandOther(container);
  const btn = [...container.querySelectorAll(".nav .navbtn[aria-label]")].find((b) => b.getAttribute("aria-label") === label);
  expect(btn, `no rail entry called "${label}"`).toBeTruthy();
  await act(async () => { btn.click(); });
  await flush();
}

const locked = (container) => /Not available for your role/.test(container.textContent);

let live = null;
beforeEach(() => { fx.configListeners = []; });
afterEach(() => { live?.cleanup(); live = null; });

describe("a shop that has never opened the panel", () => {
  it("gives a biller exactly the rails it always did", async () => {
    live = await mountAs("biller");
    const seen = await rails(live.container);
    expect(seen).toContain("Billing (POS)");
    expect(seen).toContain("Appointments");
    expect(seen).toContain("Sales History");
    expect(seen).not.toContain("Customers");
    expect(seen).not.toContain("Stats");
    expect(seen).not.toContain("Salon Settings");
  });
});

describe("switching a feature ON for a role", () => {
  it("adds the rail AND opens the screen behind it", async () => {
    // Hiding a tab is not the control — `tab` is ordinary state — so the view's own guard has
    // to agree with the nav. This asserts both halves.
    live = await mountAs("biller", { biller: { "customers.browse": true } });
    expect(await rails(live.container)).toContain("Customers");
    await clickRail(live.container, "Customers");
    expect(locked(live.container), "the view guard must agree with the rail").toBe(false);
  });

  it("applies to one role only", async () => {
    live = await mountAs("biller", { inventory: { "logs.view": true } });
    expect(await rails(live.container)).not.toContain("Activity Log");
    live.cleanup();

    live = await mountAs("inventory", { inventory: { "logs.view": true } });
    expect(await rails(live.container)).toContain("Activity Log");
  });
});

describe("switching a feature OFF for a role", () => {
  it("takes the rail away and locks the view behind it", async () => {
    live = await mountAs("biller", { biller: { "appointments.view": false } });
    expect(await rails(live.container)).not.toContain("Appointments");
    expect(await rails(live.container)).toContain("Billing (POS)"); // the rest of the role is intact
  });

  it("lands live, and moves the worker off a screen they're standing on", async () => {
    // The salon does not reload a counter tablet. An owner revoking a feature has to take
    // effect where the worker already is, without stranding them on a blank pane.
    live = await mountAs("biller", { biller: { "customers.browse": true } });
    await clickRail(live.container, "Customers");
    expect(locked(live.container)).toBe(false);

    await pushPermissions({ biller: { "customers.browse": false } });
    expect(await rails(live.container)).not.toContain("Customers");
    expect(locked(live.container), "falls back to the dashboard, not a locked pane").toBe(false);
    expect(live.container.textContent).toMatch(/Today/); // the worker dashboard
  });
});

describe("what a switch can never do", () => {
  it("cannot grant a feature the database would refuse", async () => {
    // A permissions blob hand-edited into the Firebase console. Every one of these is
    // owner-only in database.rules.json, so honouring it would open a screen whose reads
    // all come back permission-denied.
    const forged = {
      biller: { "expenses.manage": true, "stats.view": true, "settings.manage": true, "users.manage": true, "sales.delete": true },
      inventory: { "vendorBills.manage": true, "staff.manage": true, "services.manage": true },
    };
    live = await mountAs("biller", forged);
    const asBiller = await rails(live.container);
    ["Add Expense", "Stats", "Salon Settings", "Admin"].forEach((t) =>
      expect(asBiller, `${t} must stay out of reach`).not.toContain(t)
    );
    live.cleanup();

    live = await mountAs("inventory", forged);
    const asInventory = await rails(live.container);
    ["Vendor Bills", "Staff", "Services"].forEach((t) =>
      expect(asInventory, `${t} must stay out of reach`).not.toContain(t)
    );
  });

  it("cannot restrict an owner", async () => {
    // Nothing in Settings may cost the last owner their own shop — there is no way back.
    live = await mountAs("owner", {
      owner: { "settings.manage": false, "users.manage": false, "billing.use": false },
      biller: { "billing.use": false },
    });
    const seen = await rails(live.container);
    expect(seen).toContain("Salon Settings");
    expect(seen).toContain("Billing (POS)");
    expect(seen).toContain("Stats");
  });
});

describe("the panel itself", () => {
  it("is on the owner's Salon Settings screen, with a switch per worker role", async () => {
    live = await mountAs("owner");
    await clickRail(live.container, "Salon Settings");
    const { container } = live;

    expect(container.textContent).toMatch(/Feature access/);
    // One checkbox per (grantable feature × role) — enough to prove the matrix rendered
    // rather than an empty table, without pinning the exact feature count.
    const boxes = [...container.querySelectorAll('input[type="checkbox"]')];
    expect(boxes.length).toBeGreaterThan(10);
    expect(boxes.some((b) => /for Biller$/.test(b.getAttribute("aria-label") || ""))).toBe(true);
    expect(boxes.some((b) => /for Inventory$/.test(b.getAttribute("aria-label") || ""))).toBe(true);
    // The features that can't be delegated are named, with the reason, rather than absent.
    expect(container.textContent).toMatch(/Always the owner's/);
  });

  it("shows a worker's saved switches ticked, and offers nothing for owner-only features", async () => {
    live = await mountAs("owner", { biller: { "customers.browse": true } });
    await clickRail(live.container, "Salon Settings");
    const box = [...live.container.querySelectorAll('input[type="checkbox"]')]
      .find((b) => b.getAttribute("aria-label") === "Customer list for Biller");
    expect(box, "the saved switch has a checkbox").toBeTruthy();
    expect(box.checked).toBe(true);

    const labels = [...live.container.querySelectorAll('input[type="checkbox"]')]
      .map((b) => b.getAttribute("aria-label") || "");
    ["Expenses", "Vendor Bills", "Stats", "Delete"].forEach((owned) =>
      expect(labels.some((l) => l.includes(owned)), `${owned} must not be switchable`).toBe(false)
    );
  });

  it("does not offer to save a screen nobody has touched", async () => {
    // Opens on a shop that already has switches saved: the panel must read them back as the
    // current state, not as pending edits.
    live = await mountAs("owner", { biller: { "customers.browse": true, "billing.discount": false } });
    await clickRail(live.container, "Salon Settings");
    const save = [...live.container.querySelectorAll("button")].find((b) => /Save feature access|^Saved$/.test(b.textContent));
    expect(save.textContent).toBe("Saved");
    expect(save.disabled).toBe(true);

    // …and does offer once something actually changes.
    const box = [...live.container.querySelectorAll('input[type="checkbox"]')]
      .find((b) => b.getAttribute("aria-label") === "Edit a bill for Biller");
    await act(async () => { box.click(); });
    await flush();
    expect([...live.container.querySelectorAll("button")].some((b) => b.textContent === "Save feature access")).toBe(true);
  });
});
