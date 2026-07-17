// The appointment diary.
//
// Time is stored as `startMin` — minutes since midnight, local — plus a `durationMin`, rather
// than as a timestamp. A salon books "Tuesday at 3pm", not an instant on a global timeline:
// minutes-since-midnight is exactly that, and it can't be shifted by a timezone, a DST
// boundary, or a device with the wrong clock. `date` stays a plain local YYYY-MM-DD, the same
// shape every other date in this app uses.
//
// The overlap check is the load-bearing part of this module. Double-booking a stylist is the
// mistake that actually hurts: two customers turn up at once, one waits or leaves, and the
// salon eats it. So it is pure, exhaustively tested, and checked on every write path.

export const STATUSES = ["booked", "completed", "no-show", "cancelled", "blocked"];

export const STATUS_LABELS = {
  booked: "Booked",
  completed: "Completed",
  "no-show": "No-show",
  cancelled: "Cancelled",
  blocked: "Blocked",
};

export const STATUS_COLORS = {
  booked: "#2A6FB0",
  completed: "#1B5E43",
  "no-show": "#C44536",
  cancelled: "#8A9C90",
  blocked: "#5B6B62",
};

// Statuses that still occupy the chair. A cancelled or no-show slot is free again — the whole
// point of marking it — so neither blocks a new booking. `blocked` very much does: it's how a
// stylist's lunch or leave is carved out.
const OCCUPYING = new Set(["booked", "completed", "blocked"]);

export const occupiesChair = (appt) => OCCUPYING.has(appt?.status);

// The diary grid. 15 minutes is the row height: fine enough for a 15-minute threading slot,
// coarse enough that a day fits on a phone screen.
export const SLOT_MIN = 15;

export const DEFAULT_HOURS = { openMin: 10 * 60, closeMin: 21 * 60 }; // 10:00 – 21:00

/** "09:30" → 570. Returns NaN for anything unparseable. */
export function parseHM(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || "").trim());
  if (!m) return NaN;
  const h = +m[1];
  const min = +m[2];
  if (h > 23 || min > 59) return NaN;
  return h * 60 + min;
}

/** 570 → "09:30". */
export function toHM(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** 570 → "9:30 am" — how the front desk reads it. */
export function toClock(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  const h24 = Math.floor(m / 60) % 24;
  const h = h24 % 12 || 12;
  return `${h}:${String(m % 60).padStart(2, "0")} ${h24 < 12 ? "am" : "pm"}`;
}

export const endMin = (appt) => (Number(appt?.startMin) || 0) + (Number(appt?.durationMin) || 0);

/** Every slot start between open and close, for rendering the grid's rows. */
export function slotsBetween(openMin, closeMin, step = SLOT_MIN) {
  const out = [];
  for (let t = openMin; t < closeMin; t += step) out.push(t);
  return out;
}

/**
 * Do two time ranges overlap?
 *
 * Half-open [start, end): an appointment ending at 3:00 and one starting at 3:00 do NOT
 * overlap — that's back-to-back, which is a normal, busy, entirely legal salon day. Using
 * closed intervals here would reject the most common booking pattern there is.
 */
export const rangesOverlap = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

/**
 * Everything already in this stylist's chair that clashes with the proposed slot.
 *
 * `exceptId` skips the appointment being edited, so rescheduling a booking doesn't collide
 * with its own old time.
 */
export function findConflicts(appointments, { date, staffId, startMin, durationMin, exceptId } = {}) {
  const start = Number(startMin) || 0;
  const end = start + (Number(durationMin) || 0);
  return (appointments || []).filter(
    (a) =>
      a.id !== exceptId &&
      a.date === date &&
      a.staffId === staffId &&
      occupiesChair(a) &&
      rangesOverlap(start, end, Number(a.startMin) || 0, endMin(a))
  );
}

/** True when the proposed slot is free in this stylist's chair. */
export const isSlotFree = (appointments, slot) => findConflicts(appointments, slot).length === 0;

/**
 * Validate a booking. Returns an error string, or null when it's bookable.
 * `hours` bounds are advisory-ish but enforced: a booking outside opening hours renders off
 * the top or bottom of the grid and effectively disappears.
 */
export function validateAppointment(form, appointments, hours = DEFAULT_HOURS) {
  if (!form.date) return "Pick a date.";
  if (!form.staffId) return "Pick a staff member.";
  const start = Number(form.startMin);
  if (!Number.isFinite(start)) return "Pick a start time.";
  const duration = Number(form.durationMin);
  if (!Number.isFinite(duration) || duration <= 0) return "The appointment needs a duration.";
  if (form.status !== "blocked" && !(form.serviceIds || []).length) return "Pick at least one service.";
  if (start < hours.openMin) return `That's before opening time (${toClock(hours.openMin)}).`;
  if (start + duration > hours.closeMin) return `That runs past closing time (${toClock(hours.closeMin)}).`;
  const clashes = findConflicts(appointments, { ...form, exceptId: form.id });
  if (clashes.length) {
    const c = clashes[0];
    return `Clashes with ${c.status === "blocked" ? "blocked time" : "another booking"} at ${toClock(c.startMin)}–${toClock(endMin(c))}.`;
  }
  return null;
}

/** Total duration and price of a set of services — what a multi-service booking costs and takes. */
export function summarizeServices(serviceIds, services) {
  const byId = new Map((services || []).map((s) => [s.id, s]));
  let durationMin = 0;
  let price = 0;
  const names = [];
  for (const id of serviceIds || []) {
    const s = byId.get(id);
    if (!s) continue; // a service deleted since booking shouldn't break the diary
    durationMin += Number(s.durationMin) || 0;
    price += Number(s.price) || 0;
    names.push(s.name);
  }
  return { durationMin, price: Math.round(price * 100) / 100, names };
}

export const blankAppointment = (date = "", staffId = "", startMin = 0, createdAt = "") => ({
  id: "",
  date,
  staffId,
  startMin,
  durationMin: SLOT_MIN,
  serviceIds: [],
  customerPhone: "",
  status: "booked",
  note: "",
  billId: "",
  createdAt,
});

/** This day's appointments for one stylist, in chair order. */
export const dayAppointments = (appointments, date, staffId) =>
  (appointments || [])
    .filter((a) => a.date === date && (!staffId || a.staffId === staffId))
    .sort((a, b) => (Number(a.startMin) || 0) - (Number(b.startMin) || 0));

/**
 * Lay a day's appointments out into columns so overlapping blocks sit side by side instead of
 * on top of each other.
 *
 * The overlap check stops a stylist being double-booked going forward, but historical data can
 * still contain overlaps — imported bookings, a slot edited to clash on another device, or a
 * service whose duration was lengthened after the fact. Stacking those invisibly would hide a
 * real problem from the person trying to run the day, so they render side by side instead.
 */
export function layoutDay(appts) {
  const sorted = [...(appts || [])].sort(
    (a, b) => (Number(a.startMin) || 0) - (Number(b.startMin) || 0) || endMin(a) - endMin(b)
  );
  const laid = [];
  // A cluster is a run of mutually-overlapping appointments; its width is shared between them.
  let cluster = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    if (!cluster.length) return;
    const columns = []; // columns[i] = end time of the last appt placed in column i
    for (const a of cluster) {
      let col = columns.findIndex((end) => end <= (Number(a.startMin) || 0));
      if (col === -1) { col = columns.length; columns.push(0); }
      columns[col] = endMin(a);
      laid.push({ appt: a, col });
    }
    const total = columns.length;
    for (const l of laid.slice(-cluster.length)) l.cols = total;
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const a of sorted) {
    if (cluster.length && (Number(a.startMin) || 0) >= clusterEnd) flush();
    cluster.push(a);
    clusterEnd = Math.max(clusterEnd, endMin(a));
  }
  flush();
  return laid;
}

/** The days of the week containing `date`, Monday first — for the compact week strip. */
export function weekStrip(dateStr) {
  const d = new Date(dateStr + "T00:00");
  if (Number.isNaN(d.getTime())) return [];
  // getDay(): 0 = Sunday. Shift so Monday starts the week, which is how a salon's week reads.
  const offset = (d.getDay() + 6) % 7;
  const monday = new Date(d);
  monday.setDate(d.getDate() - offset);
  return Array.from({ length: 7 }, (_, i) => {
    const x = new Date(monday);
    x.setDate(monday.getDate() + i);
    // Build the string from local parts: toISOString() would convert to UTC and hand back the
    // previous day for anywhere east of Greenwich — which is to say, for this app's users.
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  });
}

/** Shift a YYYY-MM-DD by n days, staying in local time. */
export function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00");
  if (Number.isNaN(d.getTime())) return dateStr;
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Counts for the day's header: what's booked, done, and lost. */
export function dayStats(appointments, date) {
  const day = (appointments || []).filter((a) => a.date === date && a.status !== "blocked");
  return {
    total: day.length,
    booked: day.filter((a) => a.status === "booked").length,
    completed: day.filter((a) => a.status === "completed").length,
    noShow: day.filter((a) => a.status === "no-show").length,
    cancelled: day.filter((a) => a.status === "cancelled").length,
  };
}
