// Per-record keyed sync for the Realtime Database.
//
// Each slice (items, sales, expenses, logs) is stored as a MAP keyed by the record's own
// `id` — e.g. shop/items/<id> — instead of one big array. This is what makes the app safe
// across many devices:
//   • Concurrent edits to DIFFERENT records merge naturally (different keys never collide).
//   • Writes are field-level: only the changed fields of a changed record are pushed, so two
//     devices editing different fields of the SAME record both survive (last-write-wins per
//     field for the rare same-field clash).
//   • Incoming cloud snapshots are 3-way merged with un-pushed local edits, so a remote change
//     can't silently drop something you just added on this device.
//
// The React layer keeps working with plain arrays; this module is the only array↔map bridge.

import { ref, onValue, set, update } from "firebase/database";
import { db } from "./firebase.js";
import { can } from "./roles.js";

export const SLICES = [
  // Ported from the grocery core — same shapes, same merge behaviour.
  "items", "sales", "expenses", "logs", "vendorBills", "dailyBills",
  // Salon slices.
  "customers", "services", "staff", "appointments", "packages", "customerPackages",
  "messageTemplates",
];

// Which slices a role is allowed to READ, and therefore to subscribe to. This mirrors the
// read side of database.rules.json: subscribing to a slice the rules deny would spam the
// console with permission-denied errors and pop a scary sync-error toast at the counter, so
// the client simply never asks for what it isn't allowed to have.
//
// The money slices (expenses/vendorBills/dailyBills) are the only ones withheld — everything
// else has to be readable for the POS and the diary to function at all. See the README for
// why that is an accepted limit rather than a leak we can close in RTDB.
const SLICE_READ_ACTIONS = {
  expenses: "expenses.manage",
  vendorBills: "vendorBills.manage",
  dailyBills: "vendorBills.manage",
};

export const readableSlices = (role) =>
  SLICES.filter((s) => !SLICE_READ_ACTIONS[s] || can(role, SLICE_READ_ACTIONS[s]));

const path = (slice) => "shop/" + slice;

// RTDB rejects `undefined` and functions; JSON round-trip drops them and deep-clones.
export const sanitize = (x) => JSON.parse(JSON.stringify(x ?? null));

const eq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Stable, predictable ordering so every device shows the same list order.
const SORTERS = {
  items: (a, b) => String(a.name || "").localeCompare(String(b.name || "")),
  sales: (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.id).localeCompare(String(b.id))),
  expenses: (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.id).localeCompare(String(b.id))),
  logs: (a, b) => (b.at || 0) - (a.at || 0), // newest first
  vendorBills: (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : String(b.id).localeCompare(String(a.id))), // newest first
  dailyBills: (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0)), // newest first
  // Salon slices.
  customers: (a, b) => String(a.name || "").localeCompare(String(b.name || "")),
  services: (a, b) =>
    String(a.category || "").localeCompare(String(b.category || "")) ||
    String(a.name || "").localeCompare(String(b.name || "")),
  staff: (a, b) => String(a.name || "").localeCompare(String(b.name || "")),
  // Chronological: the day view reads these straight through, so date-then-start-time is the
  // order the diary actually renders in.
  appointments: (a, b) =>
    (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) ||
    (a.startMin || 0) - (b.startMin || 0) ||
    String(a.id).localeCompare(String(b.id)),
  packages: (a, b) => String(a.name || "").localeCompare(String(b.name || "")),
  customerPackages: (a, b) => (b.purchasedAt || 0) - (a.purchasedAt || 0), // newest first
  messageTemplates: (a, b) => String(a.name || "").localeCompare(String(b.name || "")),
};

// Accept null / legacy-array / keyed-object → { [id]: record }, keeping only valid records.
export function toMap(val) {
  const out = {};
  if (!val) return out;
  const entries = Array.isArray(val) ? val : Object.values(val);
  for (const rec of entries) {
    if (rec && typeof rec === "object" && rec.id != null) out[String(rec.id)] = rec;
  }
  return out;
}

export function mapToArray(slice, map) {
  const arr = Object.values(map);
  const cmp = SORTERS[slice];
  return cmp ? arr.slice().sort(cmp) : arr;
}

// True if the stored node isn't already keyed by record id (legacy array, or numeric keys)
// and therefore needs a one-time rewrite into the keyed-by-id shape.
export function isLegacyShape(val, map) {
  if (!val) return false;
  if (Array.isArray(val)) return true;
  return Object.keys(val).some((k) => map[k] === undefined);
}

// Build an atomic multi-path update from the last-known cloud map → the new local array:
// only the changed fields of changed/added records, plus `null` for deleted records.
export function buildSliceUpdate(prevMap, nextArr) {
  const updates = {};
  const nextMap = {};
  for (const rec of nextArr) {
    if (!rec || rec.id == null) continue;
    const id = String(rec.id);
    nextMap[id] = rec;
    const prev = prevMap[id];
    if (!prev) {
      updates[id] = sanitize(rec); // brand-new record → write the whole node
      continue;
    }
    for (const k of new Set([...Object.keys(prev), ...Object.keys(rec)])) {
      if (!eq(prev[k], rec[k])) updates[`${id}/${k}`] = rec[k] === undefined ? null : sanitize(rec[k]);
    }
  }
  for (const id of Object.keys(prevMap)) {
    if (!(id in nextMap)) updates[id] = null; // deleted locally
  }
  return { updates, nextMap, changed: Object.keys(updates).length > 0 };
}

// 3-way merge: reconcile an incoming cloud snapshot (`theirs`) with un-pushed local state
// (`ours`) relative to the last snapshot we acted on (`base`). Remote changes are accepted,
// but local-only adds/edits/deletes that haven't reached the cloud yet are preserved.
export function mergeRemote(base, theirs, ours) {
  const result = { ...theirs };
  for (const id of Object.keys(ours)) {
    const o = ours[id];
    const b = base[id];
    if (!b) {
      // Added locally since `base`. Keep it unless the cloud already has this id.
      if (!(id in theirs)) result[id] = o;
      continue;
    }
    const t = theirs[id];
    if (!t) continue; // remote deleted it → respect the deletion
    let merged = t;
    let changed = false;
    for (const k of new Set([...Object.keys(o), ...Object.keys(b)])) {
      if (!eq(o[k], b[k])) {
        // Field changed locally since base → apply our value on top of theirs.
        if (!changed) { merged = { ...t }; changed = true; }
        if (o[k] === undefined) delete merged[k];
        else merged[k] = o[k];
      }
    }
    if (changed) result[id] = merged;
  }
  // Deleted locally since `base`: honour it unless the cloud changed that record meanwhile.
  for (const id of Object.keys(base)) {
    if (!(id in ours) && id in result && eq(theirs[id], base[id])) delete result[id];
  }
  return result;
}

export const writeSlice = (slice, updates) => update(ref(db, path(slice)), updates);
export const overwriteSlice = (slice, map) => set(ref(db, path(slice)), sanitize(map));

export function subscribeSlice(slice, onData, onError) {
  return onValue(ref(db, path(slice)), (snap) => onData(snap.val()), onError);
}

// ---------- store config (singleton) ----------
// Store identity (shop name, address, logo, PC IP …) is ONE object shared by the shop, not a
// keyed collection of records, so it skips the per-record map/merge machinery above and is read
// and written whole at shop/config. Last write wins — fine for a setting a single owner edits.
const CONFIG_PATH = "shop/config";
export const subscribeConfig = (onData, onError) =>
  onValue(ref(db, CONFIG_PATH), (snap) => onData(snap.val()), onError);
export const writeConfig = (config) => set(ref(db, CONFIG_PATH), sanitize(config));

// ---------- users / roles ----------
// shop/users/<uid> is keyed by Firebase Auth uid, NOT by a record `id` field, so it does not
// go through the toMap/mergeRemote machinery above (which keys on rec.id). It is small,
// owner-written and rarely edited, so it is read whole and written per-uid. Last write wins.
const USERS_PATH = "shop/users";

export const subscribeUsers = (onData, onError) =>
  onValue(ref(db, USERS_PATH), (snap) => onData(snap.val()), onError);

// One-shot read of just the signed-in user's own record. Every authenticated user can read
// their own node (see the $uid .read rule) even before they have a role, which is what lets
// the app tell "you aren't set up yet" apart from "the network is down".
export const subscribeOwnUser = (uid, onData, onError) =>
  onValue(ref(db, `${USERS_PATH}/${uid}`), (snap) => onData(snap.val()), onError);

export const writeUser = (uid, record) => set(ref(db, `${USERS_PATH}/${uid}`), sanitize(record));
export const updateUser = (uid, fields) => update(ref(db, `${USERS_PATH}/${uid}`), sanitize(fields));

// Live online/offline signal from the RTDB client. cb(true|false).
export function subscribeConnection(cb) {
  return onValue(
    ref(db, ".info/connected"),
    (snap) => cb(snap.val() === true),
    () => cb(false)
  );
}
