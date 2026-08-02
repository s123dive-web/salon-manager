// @vitest-environment jsdom
//
// End-to-end check of the service-icon system against the REAL app module — the same harness as
// theme.integration.test.jsx, with a small seeded menu and a couple of staff so the billing
// screen and the appointment diary actually have something to draw.
//
// This is what stands in for "screenshot both themes": it signs in as an owner, walks the mount
// points, flips the icon style in Settings and asserts what the browser would be handed in each
// theme — including that the flat theme requests no gradients at all.
import { describe, it, expect, vi, beforeAll } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ICON_KEYS, ICON_LABELS } from "./lib/serviceIcons.js";
import { SERVICE_ICON_CSS } from "./components/ServiceIcon.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const OWNER = { email: "owner@test", name: "Owner", role: "owner", active: true, createdAt: "2026-08-02" };

// A menu small enough to reason about, wide enough to cover four icon families and both block
// heights in the diary. `icon` carries the legacy emoji, exactly as a seeded salon's does.
const SERVICES = {
  s1: { id: "s1", name: "Haircut Women — Trim", category: "Hair", durationMin: 30, price: 400, commissionPct: 10, rebookCycleDays: 45, active: true, icon: "💇", createdAt: "2026-08-01" },
  s2: { id: "s2", name: "Facial — Gold", category: "Skin", durationMin: 75, price: 1800, commissionPct: 12, rebookCycleDays: 30, active: true, icon: "🧖", createdAt: "2026-08-01" },
  s3: { id: "s3", name: "Threading — Eyebrow", category: "Skin", durationMin: 15, price: 50, commissionPct: 8, rebookCycleDays: 14, active: true, icon: "🧖", createdAt: "2026-08-01" },
  s4: { id: "s4", name: "Signature Ritual No. 4", category: "Other", durationMin: 60, price: 2000, commissionPct: 12, rebookCycleDays: 30, active: true, icon: "nailArt", createdAt: "2026-08-01" },
};
const STAFF = { t1: { id: "t1", name: "Priya Sharma", role: "Hair Stylist", color: "#7C3AED", phone: "", commissionPctDefault: 10, active: true, createdAt: "2026-08-01" } };
// Two bookings in one column: a 30-minute cut (roomy enough for an icon) and a 15-minute
// threading slot (which must stay text-only).
const APPOINTMENTS = {
  a1: { id: "a1", date: "2026-08-02", staffId: "t1", customerPhone: "", serviceIds: ["s1"], startMin: 660, durationMin: 30, status: "booked", note: "", createdAt: "2026-08-01" },
  a2: { id: "a2", date: "2026-08-02", staffId: "t1", customerPhone: "", serviceIds: ["s3"], startMin: 720, durationMin: 15, status: "booked", note: "", createdAt: "2026-08-01" },
};

// One customer with one bill: a service line (which gets an icon) and a retail line (which does
// not — the icon system labels work, not stock, in the visit history).
const CUSTOMERS = {
  c1: { id: "c1", phone: "9876543210", name: "Asha Kulkarni", dob: "", anniversary: "", notes: "", totalVisits: 1, totalSpend: 2200, lastVisitAt: "2026-08-01", createdAt: "2026-07-01" },
};
const SALES = {
  b1: {
    id: "b1", date: "2026-08-01", total: 2200, paid: 2200, payMode: "cash", customerPhone: "9876543210",
    lines: [
      { id: "s2", serviceId: "s2", lineType: "service", name: "Facial — Gold", qty: 1, sellPrice: 1800, buyPrice: 0, staffId: "t1", commissionPct: 12 },
      { id: "p1", lineType: "product", name: "Hair Serum 100ml", qty: 1, sellPrice: 400, buyPrice: 180 },
    ],
  },
};

const dataFor = (path) => {
  if (path.includes(".info/connected")) return true;
  if (path.includes("shop/users/")) return OWNER;
  if (path.endsWith("shop/users")) return { u1: OWNER };
  if (path.endsWith("shop/services")) return SERVICES;
  if (path.endsWith("shop/staff")) return STAFF;
  if (path.endsWith("shop/appointments")) return APPOINTMENTS;
  if (path.endsWith("shop/customers")) return CUSTOMERS;
  if (path.endsWith("shop/sales")) return SALES;
  return null;
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

// Mount the app, signed in as an owner, and hand back a few probes.
async function mountApp() {
  const App = (await import("./salon-manager.jsx")).default;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(<App />); });
  await flush();

  const buttons = () => [...container.querySelectorAll("button")];
  const byText = (re) => buttons().find((b) => re.test((b.textContent || "").replace(/\s+/g, " ").trim()));
  const click = async (el) => { await act(async () => { el.click(); }); await flush(); };
  const goto = async (label) => {
    let target = byText(label);
    if (!target) { await click(byText(/Other/)); target = byText(label); }
    expect(target, `nav: ${label}`).toBeTruthy();
    await click(target);
  };
  return {
    container, root, byText, click, goto,
    app: () => container.querySelector(".app"),
    icons: () => [...container.querySelectorAll("svg.svc-icon")],
    chips: () => [...container.querySelectorAll(".svc-chip")],
    unmount: () => { root.unmount(); container.remove(); },
  };
}

describe("service icons — real app, end to end", () => {
  it("draws a chip per service and per category in the billing picker, without touching the names", async () => {
    const a = await mountApp();
    await a.goto(/Billing \(POS\)$/);

    const picker = a.container.querySelector("section");
    expect(picker.textContent).toContain("Haircut Women — Trim");

    // A chip per service tile, plus one 32px chip per category heading (Hair, Skin, Other).
    expect(a.chips().length).toBe(4 + 3);
    // The icons are decorative: the accessible content of a tile is still the service name.
    a.icons().forEach((svg) => expect(svg.getAttribute("aria-hidden")).toBe("true"));

    // Resolution reached the DOM: a haircut is warm, a facial is rose, the override is plum.
    const tones = a.icons().map((s) => s.getAttribute("class"));
    expect(tones.some((c) => c.includes("svc-icon--warm"))).toBe(true);
    expect(tones.some((c) => c.includes("svc-icon--rose"))).toBe(true);
    expect(tones.some((c) => c.includes("svc-icon--plum"))).toBe(true); // "Signature Ritual No. 4" → nailArt override
    a.unmount();
  });

  it("puts an icon on a 30-minute block but never on a 15-minute one", async () => {
    const a = await mountApp();
    await a.goto(/Appointments$/);

    const blocks = [...a.container.querySelectorAll("button.svc-on-color")];
    expect(blocks.length, "both bookings should render").toBe(2);
    const withIcon = blocks.filter((b) => b.querySelector("svg.svc-icon"));
    expect(withIcon.length, "only the 30-minute block gets an icon").toBe(1);
    expect(withIcon[0].textContent).toContain("Walk-in");
    a.unmount();
  });

  it("shows the icon and the override picker on the services screen", async () => {
    const a = await mountApp();
    await a.goto(/Services$/);
    expect(a.chips().length, "one per service row plus one per category head").toBe(4 + 3);

    // Open the first service ("Haircut Women — Trim") — it has no override, so the picker opens
    // with nothing chosen and the icon still coming from the name.
    await a.click(a.byText(/^Edit$/));
    const swatches = () => ICON_KEYS.map((k) => a.container.querySelector(`[aria-label="${ICON_LABELS[k]}"]`));
    expect(swatches().filter(Boolean).length, "one swatch per icon").toBe(ICON_KEYS.length);
    expect(a.container.textContent).toContain("automatic, from the name");
    expect(swatches().filter((b) => b.getAttribute("aria-pressed") === "true").length).toBe(0);

    // Choosing one is an override, and it can be handed back to the resolver.
    await a.click(a.container.querySelector(`[aria-label="${ICON_LABELS.mehendi}"]`));
    expect(a.container.textContent).toContain("chosen by you");
    expect(swatches().filter((b) => b.getAttribute("aria-pressed") === "true").length).toBe(1);
    await a.click(a.byText(/^Back to automatic$/));
    expect(a.container.textContent).toContain("automatic, from the name");
    a.unmount();
  });

  it("marks the service lines in a customer's visit history, and leaves the retail line bare", async () => {
    const a = await mountApp();
    await a.goto(/Customers$/);
    await a.click(a.byText(/Asha Kulkarni/));

    const history = [...a.container.querySelectorAll("table")].pop();
    expect(history.textContent).toContain("Facial — Gold");
    expect(history.textContent).toContain("Hair Serum 100ml");
    // One icon on the bill: the facial. The retail line is stock, not work.
    expect(history.querySelectorAll("svg.svc-icon").length).toBe(1);
    expect(history.querySelector("svg.svc-icon").getAttribute("class")).toContain("svc-icon--rose");
    a.unmount();
  });

  it("flips the whole app between the Advanced (glass) and Basic (flat) appearances", async () => {
    const a = await mountApp();

    // Advanced is the default: the shared gradient defs are mounted, once.
    expect(a.app().getAttribute("data-theme")).toBe("advanced");
    expect(a.container.querySelectorAll("#si-grad-warm").length).toBe(1);
    expect(a.container.querySelectorAll("linearGradient").length).toBe(4);

    await a.goto(/Salon Settings/);
    await a.click(a.byText(/^Basic/));
    await a.click(a.byText(/^Save settings$/));

    expect(a.app().getAttribute("data-theme")).toBe("basic");
    // The flat appearance asks for no gradients at all — nothing to load, nothing to paint.
    expect(a.container.querySelectorAll("linearGradient").length).toBe(0);
    // …and the icons are still there, just flat.
    expect(a.icons().length).toBeGreaterThan(0);

    await a.click(a.byText(/^Advanced/));
    await a.click(a.byText(/^Save settings$/));
    expect(a.app().getAttribute("data-theme")).toBe("advanced");
    expect(a.container.querySelectorAll("linearGradient").length).toBe(4);
    a.unmount();
  });

  it("ships the icon stylesheet with the app, both themes, and never blurs a chip", async () => {
    const a = await mountApp();
    const css = [...a.container.querySelectorAll("style")].map((s) => s.textContent).join("\n");
    expect(css).toContain('[data-theme="advanced"] .svc-chip::before'); // the glass highlight
    expect(css).toContain('[data-theme="basic"]');
    a.unmount();
    // The blur budget (see CLAUDE.md): chips appear 80-at-a-time in scrolling lists, so the icon
    // stylesheet itself never blurs. backdrop-filter is reserved for the still shell surfaces —
    // the sidebar and the modal scrim — which live in the app's stylesheet, not this one.
    expect(SERVICE_ICON_CSS).not.toContain("backdrop-filter");
  });
});
