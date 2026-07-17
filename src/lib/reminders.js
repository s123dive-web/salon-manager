// The reminder queue and RFM segmentation.
//
// This is the module that decides who the salon contacts today, so its failure mode is
// pestering real people. Two rules follow from that and are enforced throughout:
//
//   1. Never invent a reason. Every row is a fact derived from the bills — a service whose
//      rebook cycle has landed, a birthday, a package about to lapse. If the data doesn't say
//      it, the queue doesn't say it.
//   2. One reason per customer per day. A customer who is simultaneously due a haircut, having
//      a birthday and holding an expiring package gets ONE message, not three. `dedupeByCustomer`
//      is what enforces that, and it is not optional.
//
// Delivery is a WhatsApp DEEP LINK, opened by the user, one at a time. There is no API here and
// no automation: a human decides to send each message. That is a deliberate constraint, not a
// missing feature — it keeps the salon on the right side of both WhatsApp's terms and its
// customers' patience.

import { normalizePhone, billsForCustomer } from "./customers.js";
import { isServiceLine } from "./salon.js";
import { addDaysISO, daysBetweenISO, expiringPackages } from "./loyalty.js";

/** Reminder kinds, in the order they should win when a customer qualifies for several. */
export const KINDS = ["package", "birthday", "anniversary", "rebook", "dormant"];

export const KIND_LABELS = {
  rebook: "Due a service",
  birthday: "Birthday",
  anniversary: "Anniversary",
  dormant: "Not seen in a while",
  package: "Package expiring",
};

export const KIND_ICONS = {
  rebook: "💇",
  birthday: "🎂",
  anniversary: "💐",
  dormant: "👋",
  package: "🎁",
};

// Priority when one customer qualifies for several reasons at once. Ordered by what is
// time-critical and what the customer would rather hear:
//   package  — real money of theirs expires on a deadline; miss it and they lose it.
//   birthday — the day is the day; it cannot be sent late.
//   rebook   — useful, but a day either way costs nothing.
//   dormant  — the weakest signal, and the most likely to read as spam.
const PRIORITY = { package: 0, birthday: 1, anniversary: 2, rebook: 3, dormant: 4 };

export const DORMANT_AFTER_DAYS = 60;
export const PACKAGE_EXPIRY_WINDOW = 14;
/** How close to a birthday counts as "today's job". */
export const OCCASION_WINDOW = 3;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** dd-mm → how many days until it next comes round (0 = today). null for a blank/bad value. */
export function daysUntilOccasion(dayMonth, today) {
  const m = /^(\d{2})-(\d{2})$/.exec(String(dayMonth || ""));
  if (!m) return null;
  const day = +m[1];
  const month = +m[2];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const now = new Date(String(today) + "T00:00");
  if (Number.isNaN(now.getTime())) return null;

  const build = (year) => {
    const d = new Date(year, month - 1, day);
    // A 29-Feb birthday in a non-leap year rolls to 1 Mar; pull it back to 28 Feb so it is
    // greeted in February, which is when the person expects it.
    if (d.getMonth() !== month - 1) return new Date(year, month - 1 + 1, 0);
    return d;
  };

  const thisYear = build(now.getFullYear());
  const target = thisYear >= now ? thisYear : build(now.getFullYear() + 1);
  return Math.round((target - now) / 86400000);
}

/**
 * The last date each service was taken by this customer, from their bills.
 * Keyed by serviceId; legacy/product lines are ignored.
 */
export function lastServiceDates(sales, phone) {
  const m = new Map();
  for (const b of billsForCustomer(sales, phone)) {
    for (const l of b.lines || []) {
      if (!isServiceLine(l) || !l.serviceId) continue;
      const prev = m.get(l.serviceId);
      if (!prev || String(b.date) > prev) m.set(l.serviceId, String(b.date));
    }
  }
  return m;
}

/**
 * Rebooking rows: a service whose cycle has landed, for a customer who took it.
 *
 * Only the MOST overdue service per customer is returned. Someone who is due a cut, a colour
 * and a facial does not need three messages — they need one that mentions the biggest thing.
 */
export function rebookDue(customer, sales, services, today) {
  const byId = new Map((services || []).map((s) => [s.id, s]));
  const last = lastServiceDates(sales, customer.phone);
  let best = null;
  for (const [serviceId, lastDate] of last) {
    const svc = byId.get(serviceId);
    if (!svc) continue; // deleted service — no cycle to honour
    const cycle = num(svc.rebookCycleDays);
    if (cycle <= 0) continue; // 0 = one-off work; a "due another bridal makeup" nudge is absurd
    if (svc.active === false) continue; // don't tout something off the menu
    const dueOn = addDaysISO(lastDate, cycle);
    const overdueBy = daysBetweenISO(dueOn, today);
    if (overdueBy < 0) continue; // not due yet
    if (!best || overdueBy > best.overdueBy) {
      best = { serviceId, serviceName: svc.name, lastDate, dueOn, overdueBy, days: daysBetweenISO(lastDate, today) };
    }
  }
  return best;
}

/**
 * Build the whole reminder queue for a day.
 *
 * Returns one row per customer (the highest-priority reason), sorted most urgent first.
 * `sentLog` is the record of what's already been sent — see `wasSentRecently`.
 */
export function buildQueue({ customers, sales, services, customerPackages, today, sentLog = {}, dormantAfter = DORMANT_AFTER_DAYS }) {
  const rows = [];
  const expiring = expiringPackages(customerPackages, today, PACKAGE_EXPIRY_WINDOW);
  const expiringByPhone = new Map();
  for (const cp of expiring) {
    const key = normalizePhone(cp.customerPhone);
    // Soonest-expiring wins if they hold several.
    const prev = expiringByPhone.get(key);
    if (!prev || String(cp.expiresAt) < String(prev.expiresAt)) expiringByPhone.set(key, cp);
  }

  for (const c of customers || []) {
    if (!c.phone) continue;
    const candidates = [];

    // Package about to lapse with sessions still on it — their money, on a deadline.
    const cp = expiringByPhone.get(c.phone);
    if (cp) {
      candidates.push({
        kind: "package", days: daysBetweenISO(today, cp.expiresAt),
        serviceName: cp.name, packageId: cp.id, usesLeft: cp.usesLeft,
      });
    }

    // Occasions.
    const dob = daysUntilOccasion(c.dob, today);
    if (dob !== null && dob <= OCCASION_WINDOW) candidates.push({ kind: "birthday", days: dob });
    const ann = daysUntilOccasion(c.anniversary, today);
    if (ann !== null && ann <= OCCASION_WINDOW) candidates.push({ kind: "anniversary", days: ann });

    // Due a service.
    const due = rebookDue(c, sales, services, today);
    if (due) {
      candidates.push({ kind: "rebook", days: due.days, serviceName: due.serviceName, overdueBy: due.overdueBy, dueOn: due.dueOn });
    }

    // Dormant — but only for someone who HAS been in. A customer with no visits was never
    // ours to win back, and "we've missed you" to someone who never came is embarrassing.
    if (c.lastVisitAt) {
      const since = daysBetweenISO(c.lastVisitAt, today);
      if (since > dormantAfter) candidates.push({ kind: "dormant", days: since });
    }

    if (!candidates.length) continue;
    candidates.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind]);
    const top = candidates[0];
    rows.push({
      phone: c.phone,
      name: c.name || "",
      customer: c,
      ...top,
      // Everything they qualified for, so the UI can say "also due a facial" without sending
      // a second message.
      alsoKinds: candidates.slice(1).map((x) => x.kind),
      sentAt: sentLog[reminderKey(c.phone, top.kind)] || "",
    });
  }

  return rows.sort(
    (a, b) =>
      PRIORITY[a.kind] - PRIORITY[b.kind] ||
      // Within a kind, the most pressing first: soonest to expire, or longest overdue.
      (a.kind === "package" ? a.days - b.days : b.days - a.days)
  );
}

/** The key a "sent" mark is stored under. Per customer, per kind. */
export const reminderKey = (phone, kind) => `${normalizePhone(phone)}:${kind}`;

/**
 * Was this reminder sent recently enough that sending again would be pestering?
 *
 * A birthday is annual, so a 30-day memory is plenty. A rebook nudge repeating weekly is the
 * fastest way to get a salon blocked, hence the long default.
 */
export function wasSentRecently(sentAt, today, withinDays = 30) {
  if (!sentAt) return false;
  const since = daysBetweenISO(sentAt, today);
  return since >= 0 && since < withinDays;
}

/** Fill a template's placeholders. Unknown placeholders are left alone rather than blanked. */
export function fillTemplate(body, vars) {
  return String(body || "").replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) && vars[key] != null && vars[key] !== ""
      ? String(vars[key])
      : match
  );
}

/** The variables available to a template for one queue row. */
export const templateVars = (row, shopName) => ({
  // First name only: "Hi Asha" reads like a person wrote it; "Hi Asha Patil" reads like a bank.
  name: String(row.name || "").trim().split(/\s+/)[0] || "there",
  service: row.serviceName || "your last visit",
  days: String(Math.abs(num(row.days))),
  shopName: shopName || "our salon",
});

/**
 * A WhatsApp deep link.
 *
 * Deep links only — no WhatsApp Business API, no unofficial libraries. The user taps, WhatsApp
 * opens with the message pre-filled, and a human presses send.
 *
 * The 91 country code is prefixed only for bare 10-digit Indian mobiles; anything else is
 * passed through as-is rather than guessed at.
 */
export function waLink(phone, text) {
  const p = normalizePhone(phone);
  const intl = /^[6-9]\d{9}$/.test(p) ? `91${p}` : p;
  return `https://wa.me/${intl}?text=${encodeURIComponent(String(text || ""))}`;
}

// ── RFM segmentation ─────────────────────────────────────────────────────────────────────
// Recency / Frequency / Monetary, bucketed into names a salon owner can act on rather than
// scores they'd have to interpret.

export const SEGMENTS = ["TOP", "Regular", "At-risk", "Dormant", "New"];

export const SEGMENT_COLORS = {
  TOP: "#1B5E43",
  Regular: "#2A6FB0",
  "At-risk": "#C9803A",
  Dormant: "#8A9C90",
  New: "#7C3AED",
};

export const SEGMENT_HINTS = {
  TOP: "Your best customers — frequent, recent, high spend. Protect these.",
  Regular: "Steady and recent. The backbone.",
  "At-risk": "They used to come often and haven't lately. Worth a nudge now.",
  Dormant: "Gone quiet for a long time. A win-back, or let go.",
  New: "One visit so far. The next one decides whether they stay.",
};

/**
 * Which segment a customer is in.
 *
 * Deliberately rule-based rather than quintile-scored: a 30-customer salon has no meaningful
 * quintiles, and an owner can argue with "hasn't been in for 90 days" in a way they can't
 * argue with "RFM score 3-4-2".
 *
 * Order matters — the first match wins:
 *   New      — one visit. Says nothing about value yet, so it must be judged before anything else.
 *   Dormant  — gone long enough that recency outweighs whatever they used to spend.
 *   At-risk  — the important one: a good customer drifting. Catch them before they're dormant.
 *   TOP      — recent, frequent AND high-spending.
 *   Regular  — everyone else who's still active.
 */
export function segmentOf(customer, today, thresholds = {}) {
  const {
    dormantDays = 90,
    atRiskDays = 45,
    topVisits = 5,
    topSpend = 15000,
    regularVisits = 2,
  } = thresholds;

  const visits = num(customer.totalVisits);
  const spend = num(customer.totalSpend);
  if (visits === 0) return "New"; // on the books but never billed — a quick-create at the counter
  const since = customer.lastVisitAt ? daysBetweenISO(customer.lastVisitAt, today) : Infinity;

  if (visits === 1) return "New";
  if (since > dormantDays) return "Dormant";
  if (since > atRiskDays && visits >= regularVisits) return "At-risk";
  if (visits >= topVisits && spend >= topSpend) return "TOP";
  return "Regular";
}

/** Segment every customer, and count each bucket. */
export function segmentAll(customers, today, thresholds) {
  const counts = Object.fromEntries(SEGMENTS.map((s) => [s, 0]));
  const rows = (customers || []).map((c) => {
    const segment = segmentOf(c, today, thresholds);
    counts[segment]++;
    return { ...c, segment };
  });
  return { rows, counts };
}
