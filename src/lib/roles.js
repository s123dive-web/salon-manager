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

/** Every role in the system, most privileged first. */
export const ROLES = ["owner", "biller", "inventory"];

export const ROLE_LABELS = {
  owner: "Owner",
  biller: "Biller",
  inventory: "Inventory",
};

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
  "reminders.use",
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

/** True if `role` is a role this app knows about. */
export const isRole = (role) => ROLES.includes(role);

/**
 * Can this role perform this action?
 *
 * Fails CLOSED: an unknown role, an unknown action, a missing role (user not yet in
 * shop/users) or a deactivated user all return false. That way a typo in an action name
 * hides a feature rather than exposing it.
 */
export function can(role, action) {
  if (!isRole(role) || !ACTIONS.includes(action)) return false;
  const grants = GRANT_SETS[role];
  if (grants === null) return true; // owner
  return grants.has(action);
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
