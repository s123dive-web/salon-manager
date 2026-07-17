// The salon catalogue: services, staff, and the shape of a bill line.
//
// Billing in a salon is not the grocery model. A grocery bill is N products off a shelf; a
// salon bill mixes SERVICES (labour, performed by a named person, earning them commission)
// with PRODUCTS (stock, depleting inventory). The two behave differently at almost every
// step — stock, commission, rebooking, analytics — so every line carries a `lineType` that
// says which it is, and services carry the `staffId` of whoever did the work.
//
// Bills written before this existed have neither field. Everything here treats a missing
// lineType as "product", which is exactly what a grocery-era bill was.

import { serviceIconFor } from "./seed.js";

export const LINE_TYPES = ["service", "product"];

/** A line's type, defaulting a legacy line to "product". */
export const lineTypeOf = (line) => (line?.lineType === "service" ? "service" : "product");

export const isServiceLine = (line) => lineTypeOf(line) === "service";
export const isProductLine = (line) => lineTypeOf(line) === "product";

// ── Services ─────────────────────────────────────────────────────────────────────────────

export const blankService = (createdAt = "") => ({
  id: "",
  name: "",
  category: "Hair",
  durationMin: 30,
  price: 0,
  commissionPct: 10,
  rebookCycleDays: 0,
  active: true,
  icon: serviceIconFor("Hair"),
  createdAt,
});

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

/**
 * Validate a service form. Returns an error string, or null when it's fine.
 * Deliberately strict about duration: the appointment grid lays slots out on a 5-minute
 * lattice, and a 37-minute service would render off-grid forever after.
 */
export function validateService(form) {
  if (!String(form.name || "").trim()) return "Give the service a name.";
  const price = num(form.price);
  if (!Number.isFinite(price) || price < 0) return "Price must be a number, and not negative.";
  const duration = num(form.durationMin);
  if (!Number.isFinite(duration) || duration <= 0) return "Duration must be more than 0 minutes.";
  if (duration % 5 !== 0) return "Duration must be a multiple of 5 minutes, so it lines up on the appointment grid.";
  if (duration > 8 * 60) return "Duration looks wrong — that's over 8 hours.";
  const commission = num(form.commissionPct);
  if (!Number.isFinite(commission) || commission < 0 || commission > 100) return "Commission must be between 0 and 100%.";
  const rebook = num(form.rebookCycleDays);
  if (!Number.isFinite(rebook) || rebook < 0) return "Rebooking cycle can't be negative (use 0 for one-off services).";
  if (rebook > 730) return "Rebooking cycle looks wrong — that's over two years.";
  return null;
}

/** Coerce a service form's numeric fields, so a form's strings never reach the database. */
export const makeService = (form, { id, createdAt = "" } = {}) => ({
  ...blankService(createdAt),
  ...form,
  id: id || form.id,
  name: String(form.name || "").trim(),
  durationMin: num(form.durationMin) || 0,
  price: Math.round((num(form.price) || 0) * 100) / 100,
  commissionPct: num(form.commissionPct) || 0,
  rebookCycleDays: num(form.rebookCycleDays) || 0,
  active: form.active !== false,
});

export const activeServices = (services) => (services || []).filter((s) => s.active !== false);

export const serviceById = (services, id) => (services || []).find((s) => s.id === id) || null;

// ── Staff ────────────────────────────────────────────────────────────────────────────────

// Distinct, readable-on-white colours for the appointment grid's staff columns.
export const STAFF_COLORS = [
  "#7C3AED", "#0EA5E9", "#059669", "#D97706", "#DC2626",
  "#DB2777", "#4F46E5", "#0891B2", "#65A30D", "#9333EA",
];

/** The first unused colour, so two stylists don't get the same block colour by default. */
export function nextStaffColor(staff) {
  const used = new Set((staff || []).map((s) => String(s.color || "").toLowerCase()));
  return STAFF_COLORS.find((c) => !used.has(c.toLowerCase())) || STAFF_COLORS[0];
}

export const blankStaff = (staff = [], createdAt = "") => ({
  id: "",
  name: "",
  phone: "",
  role: "",
  color: nextStaffColor(staff),
  commissionPctDefault: 10,
  active: true,
  createdAt,
});

export function validateStaff(form) {
  if (!String(form.name || "").trim()) return "Give the staff member a name.";
  const commission = num(form.commissionPctDefault);
  if (!Number.isFinite(commission) || commission < 0 || commission > 100) return "Default commission must be between 0 and 100%.";
  if (!/^#[0-9A-Fa-f]{6}$/.test(String(form.color || ""))) return "Pick a colour for the appointment grid.";
  return null;
}

export const makeStaff = (form, { id, createdAt = "" } = {}) => ({
  ...blankStaff([], createdAt),
  ...form,
  id: id || form.id,
  name: String(form.name || "").trim(),
  phone: String(form.phone || "").trim(),
  role: String(form.role || "").trim(),
  commissionPctDefault: num(form.commissionPctDefault) || 0,
  active: form.active !== false,
});

export const activeStaff = (staff) => (staff || []).filter((s) => s.active !== false);

export const staffById = (staff, id) => (staff || []).find((s) => s.id === id) || null;

/** A staff member's display name, for receipts and reports. Never blank. */
export const staffName = (staff, id) => staffById(staff, id)?.name || "—";

/**
 * The commission rate that applies to a service line: the service's own rate, falling back to
 * the staff member's default when the service doesn't set one.
 *
 * `commissionPct: 0` is a REAL value meaning "this service pays no commission" and must not
 * fall through to the staff default — hence the null/undefined check rather than `||`.
 * Phase 5 computes money off this; getting it wrong would quietly overpay on every threading
 * appointment.
 */
export function commissionRateFor(service, staffMember) {
  const svc = service?.commissionPct;
  if (svc != null && Number.isFinite(Number(svc))) return Number(svc);
  const dflt = staffMember?.commissionPctDefault;
  if (dflt != null && Number.isFinite(Number(dflt))) return Number(dflt);
  return 0;
}

/** Turn a service + the person performing it into a cart line. */
export const serviceToCartLine = (service, staffId = "") => ({
  id: service.id,
  lineType: "service",
  name: service.name,
  icon: service.icon || serviceIconFor(service.category),
  unit: "service",
  sellPrice: Number(service.price) || 0,
  // A service has no cost of goods: the labour cost is the commission, which is booked
  // separately (Phase 5). Treating it as zero-cost here keeps bill profit meaning the same
  // thing it has always meant — revenue minus the cost of stock consumed.
  buyPrice: 0,
  qty: 1,
  staffId,
  durationMin: Number(service.durationMin) || 0,
  commissionPct: Number(service.commissionPct) || 0,
});
