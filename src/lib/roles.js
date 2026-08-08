// Role-based access control for Salon Manager.
//
// This module is the SINGLE source of truth for "who may do what" in the UI. Every view
// and every action gates through `can(role, action)` — no view is role-unaware.
//
// ── Two layers, and what each one is actually worth ──────────────────────────────────
// 1. This module (UI layer): decides what renders. It is an operational control — it
//    keeps staff out of things they have no business touching. It is NOT a security
//    boundary on its own: it runs on the client, where a determined user controls it.
// 2. database.rules.json (server layer): the real boundary. It re-derives the role from
//    shop/users/<auth.uid> and enforces the genuinely sensitive slices server-side.
//
// The two MUST agree. If you add an action here, add the matching rule there.
// See the README ("Roles" + "What the role system does and does not protect") for the
// documented limits of this design.
//
// ── Three inputs, not two ────────────────────────────────────────────────────────────
// The matrix below is the DEFAULT for each role. The owner can then move individual
// features per role from Settings → Users & roles, and those choices live in
// config.permissions and arrive here as `can()`'s third argument. What they CANNOT do is
// move a feature the database would refuse anyway — see GRANTABLE.

/** Every role in the system, most privileged first. */
export const ROLES = ["owner", "biller", "inventory"];

export const ROLE_LABELS = {
  owner: "Owner",
  biller: "Biller",
  inventory: "Inventory",
};

// What each role starts with. The owner can add or remove features per role below, so
// these describe the DEFAULT, not necessarily what a given salon's staff can reach today.
export const ROLE_DESCRIPTIONS = {
  owner: "Full access, including money, settings, staff payouts and user management.",
  biller: "Billing, appointments and the customer picker. No money or settings views.",
  inventory: "Everything a Biller can do, plus stock, alerts, barcodes and import.",
};

// ── Actions ─────────────────────────────────────────────────────────────────────────
// Actions are named for what the user is trying to DO, not for the view they happen to
// live in, so a view moving around doesn't silently change who can reach its powers.
export const ACTIONS = [
  // Billing / POS
  "billing.use", // open the POS and create a bill
  "billing.backdate", // save a bill against an earlier date
  "billing.discount", // apply a discount to a bill
  // Appointments
  "appointments.view",
  "appointments.edit", // create/reschedule/change status/block time
  // Customers
  "customers.pick", // search + quick-create from the billing picker
  "customers.browse", // full customer list, profiles, segments, export
  // Sales history
  "sales.view",
  "sales.edit",
  "sales.delete",
  // Inventory
  "inventory.view",
  "inventory.edit", // add/edit/restock products
  "alerts.view",
  "barcode.use",
  "import.use", // Data Import, inventory-target only
  // Money — owner only, top to bottom
  "finance.view",
  "stats.view",
  "expenses.manage",
  "vendorBills.manage",
  "udhari.manage",
  // Salon operations
  "services.manage",
  "staff.manage",
  "staff.payouts", // commission reports / payout amounts
  "loyalty.configure",
  "packages.manage",
  "reminders.use", // find who's due and send them a message
  "reminders.templates", // edit the message templates themselves — writes an owner-only node
  // Admin
  "settings.manage",
  "users.manage",
  "backup.use", // backup + restore
  "logs.view",
];

// ── The matrix ──────────────────────────────────────────────────────────────────────
// `owner` is deliberately NOT listed: it is allowed everything by rule, so a new action
// can never accidentally lock the owner out of their own shop.
//
// Read this as the authoritative answer to "what can a worker touch?".
const GRANTS = {
  biller: [
    "billing.use",
    "billing.discount",
    "appointments.view",
    "appointments.edit",
    "customers.pick",
    "sales.view", // needed to reprint a receipt; edit/delete withheld below
  ],
  // Inventory = biller + stock duties. Kept as an explicit extension of the biller list
  // so the "inventory is a superset of biller" promise can't silently drift apart.
  inventory: [
    "inventory.view",
    "inventory.edit",
    "alerts.view",
    "barcode.use",
    "import.use",
  ],
};

const GRANT_SETS = {
  owner: null, // null = everything
  biller: new Set(GRANTS.biller),
  inventory: new Set([...GRANTS.biller, ...GRANTS.inventory]),
};

// ── What the owner may switch on and off ────────────────────────────────────────────
// The matrix above is only the DEFAULT. Settings → Users & roles → Feature access lets
// the owner move any of the actions below for a worker role, and those choices ride in
// config.permissions (see effectivePermissions).
//
// The envelope is not a style choice. database.rules.json is the real boundary and it
// hard-codes `role === 'owner'` on the sensitive nodes, so a toggle can only ever move a
// permission INSIDE what the rules already allow that role. Offering more would open a
// screen whose every read comes back permission-denied — a switch that appears to work
// and doesn't. Anything absent from these lists is owner-only in the DATABASE, not merely
// in this file; LOCKED_FEATURES below says so, in the panel, for each one.
//
// Adding an action here means checking the matching rule in database.rules.json FIRST.
const DELEGABLE_ANY = [
  "billing.use",
  "billing.discount",
  "billing.backdate",
  "appointments.view",
  "appointments.edit",
  "customers.pick",
  "customers.browse",
  "sales.view",
  "sales.edit", // the rules gate DELETES only, so editing really is the owner's to give
  "udhari.manage", // settling credit writes shop/sales, which every active role may do
  "reminders.use", // sending only — editing a template is reminders.templates, owner-only
  "inventory.view",
  "alerts.view",
  "logs.view", // shop/logs is readable by every active role; only the VIEW was withheld
];

// Writing shop/items is gated to owner|inventory, so these three can only ever be handed
// to the inventory role. Granting them to a biller would fail at the database.
const DELEGABLE_STOCK = ["inventory.edit", "barcode.use", "import.use"];

/** Per role, every action an owner is allowed to switch on or off. Owner is absent: an
 *  owner is never restricted, so there is nothing to toggle. */
export const GRANTABLE = {
  biller: DELEGABLE_ANY,
  inventory: [...DELEGABLE_ANY, ...DELEGABLE_STOCK],
};

const GRANTABLE_SETS = {
  biller: new Set(GRANTABLE.biller),
  inventory: new Set(GRANTABLE.inventory),
};

/** The roles whose feature set the owner can edit, in the order the panel shows them. */
export const CONFIGURABLE_ROLES = Object.keys(GRANTABLE);

/**
 * What the owner CANNOT delegate, and why — rendered as-is under the toggles so the
 * panel explains its own gaps instead of just being mysteriously short. Every action
 * behind these lines is absent from GRANTABLE above.
 */
export const LOCKED_FEATURES = [
  { what: "Deleting a bill", why: "the rules let only an owner remove a sale" },
  {
    what: "Services, Staff, Packages, Loyalty rules, message templates",
    why: "the salon's catalogue and prices are owner-write-only at the database",
  },
  {
    what: "Salon Settings, Users & roles, Admin tools",
    why: "these write the shop config and the access registry itself",
  },
  {
    what: "Stats, Finance, Expenses, Vendor Bills",
    why: "the money nodes are owner-READ-only, so these screens would show takings with no costs",
  },
  {
    what: "Backup & restore",
    why: "a worker's backup would be missing the money slices, and restoring writes owner-only nodes",
  },
];

/** Labels + one-line hints for the Feature access panel, kept beside the matrix they
 *  describe rather than buried in JSX. */
export const ACTION_LABELS = {
  "billing.use": { label: "Billing (POS)", hint: "Open the till and ring up a bill" },
  "billing.discount": { label: "Give a discount", hint: "Take money off a bill at the counter" },
  "billing.backdate": { label: "Backdate a bill", hint: "Save a bill against an earlier date" },
  "udhari.manage": { label: "Udhari (credit)", hint: "See who owes money and settle it" },
  "appointments.view": { label: "See the diary", hint: "Open the appointments calendar" },
  "appointments.edit": { label: "Book & reschedule", hint: "Create, move, cancel and block time" },
  "customers.pick": { label: "Find a customer", hint: "Search and quick-add from the billing screen" },
  "customers.browse": { label: "Customer list", hint: "Full profiles, spend, segments and export" },
  "reminders.use": { label: "Reminders", hint: "See who's due and send them a message" },
  "sales.view": { label: "Sales history", hint: "Past bills, and reprint a receipt" },
  "sales.edit": { label: "Edit a bill", hint: "Change or split a bill that's already saved" },
  "inventory.view": { label: "See stock", hint: "Product list and stock levels" },
  "inventory.edit": { label: "Change stock", hint: "Add, edit and restock products" },
  "alerts.view": { label: "Stock alerts", hint: "Low stock and near-expiry warnings" },
  "barcode.use": { label: "Barcode creator", hint: "Assign and print product barcodes" },
  "import.use": { label: "Data import", hint: "Bulk-import products from a file" },
  "logs.view": { label: "Activity log", hint: "Who did what, and when" },
};

/** The toggles grouped the way the panel lists them. Every grantable action appears
 *  exactly once; the panel shows a row only where GRANTABLE allows it for some role. */
export const FEATURE_GROUPS = [
  { title: "Billing", actions: ["billing.use", "billing.discount", "billing.backdate", "udhari.manage"] },
  { title: "Appointments", actions: ["appointments.view", "appointments.edit"] },
  { title: "Customers", actions: ["customers.pick", "customers.browse", "reminders.use"] },
  { title: "Sales history", actions: ["sales.view", "sales.edit"] },
  { title: "Stock", actions: ["inventory.view", "inventory.edit", "alerts.view", "barcode.use", "import.use"] },
  { title: "Other", actions: ["logs.view"] },
];

/** True if `role` is a role this app knows about. */
export const isRole = (role) => ROLES.includes(role);

/** The owner's stored choice for one action, or undefined when they never touched it.
 *  Every type check here IS the sanitisation — this runs on the render path, so it reads
 *  the raw config blob directly rather than normalising the whole map first. */
const overrideValue = (overrides, role, action) => {
  const forRole = overrides && typeof overrides === "object" ? overrides[role] : null;
  const v = forRole && typeof forRole === "object" ? forRole[action] : undefined;
  return typeof v === "boolean" ? v : undefined;
};

/**
 * Can this role perform this action?
 *
 * `overrides` is config.permissions — the owner's per-role feature switches. Omit it and
 * this answers with the built-in matrix, exactly as it always has.
 *
 * Fails CLOSED, three ways over: an unknown role, an unknown action, a missing role (user
 * not yet in shop/users) or a deactivated user all return false; an override for an action
 * OUTSIDE that role's envelope is ignored rather than honoured, so a `permissions` blob
 * hand-edited in the Firebase console still cannot grant what the rules would refuse; and
 * an owner is answered before overrides are read at all, so no setting can lock the owner
 * out of their own shop.
 */
export function can(role, action, overrides) {
  if (!isRole(role) || !ACTIONS.includes(action)) return false;
  const grants = GRANT_SETS[role];
  if (grants === null) return true; // owner
  const chosen = overrideValue(overrides, role, action);
  if (chosen !== undefined && GRANTABLE_SETS[role].has(action)) return chosen;
  return grants.has(action);
}

/** The actions a role holds by default, before any override. For the panel's
 *  "changed from default" marker and its Reset button. */
export const roleDefaults = (role) => (GRANT_SETS[role] ? [...GRANT_SETS[role]] : []);

/** Every action this role actually holds once the owner's switches are applied. */
export const effectivePermissions = (role, overrides) =>
  ACTIONS.filter((a) => can(role, a, overrides));

/**
 * Normalise whatever is sitting at config.permissions into `{ role: { action: bool } }`,
 * keeping only known roles and only actions inside that role's envelope. Used on the way
 * IN (rendering the panel) and on the way OUT (saving it), so a blob written by an older
 * version — or by hand — can never put an unenforceable switch on screen.
 */
export function sanitizePermissions(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const role of CONFIGURABLE_ROLES) {
    const forRole = raw[role];
    if (!forRole || typeof forRole !== "object") continue;
    const kept = {};
    for (const action of GRANTABLE[role]) {
      if (typeof forRole[action] === "boolean") kept[action] = forRole[action];
    }
    if (Object.keys(kept).length) out[role] = kept;
  }
  return out;
}

/**
 * Resolve the effective role for a signed-in user from their shop/users record.
 * Returns null when the user has no record or has been deactivated — callers treat
 * null as "sign this person out with an explanation", never as "let them in".
 */
export function resolveRole(userRecord) {
  if (!userRecord || userRecord.active === false) return null;
  return isRole(userRecord.role) ? userRecord.role : null;
}

/**
 * Bootstrap rule, mirrored from database.rules.json: the very first user to sign in
 * while shop/users is empty becomes the owner. Afterwards the node locks down and only
 * the owner can add users. Keep this in step with the `.write` rule on shop/users/$uid.
 */
export const isBootstrap = (usersMap) => !usersMap || Object.keys(usersMap).length === 0;

/** A blank user record, for Settings → Users. `createdAt` is injected by the caller. */
export const blankUser = (createdAt = "") => ({
  email: "",
  name: "",
  role: "biller",
  active: true,
  createdAt,
});

/**
 * The owner must never be able to lock themselves out of their own shop — demoting or
 * deactivating the last active owner would leave nobody who can manage users, and there
 * is no console-free way back. Returns an error string, or null when the change is safe.
 *
 * `uid` is the user being changed; `next` is the record as it would be after the edit.
 */
export function validateUserChange(usersMap, uid, next) {
  const users = usersMap || {};
  const current = users[uid];
  if (!current) return null; // adding someone new can't orphan the shop
  const wasActiveOwner = current.role === "owner" && current.active !== false;
  if (!wasActiveOwner) return null;
  const staysActiveOwner = next.role === "owner" && next.active !== false;
  if (staysActiveOwner) return null;
  const otherActiveOwners = Object.entries(users).filter(
    ([id, u]) => id !== uid && u.role === "owner" && u.active !== false
  );
  if (otherActiveOwners.length > 0) return null;
  return "This is the only active owner — promote another owner first.";
}
