// Customer identity and the denormalized visit/spend stats.
//
// ── Why phone is the key ────────────────────────────────────────────────────────────────
// A salon's customer record is keyed by PHONE (shop/customers/<phone>), not by a generated
// id. It is the one identifier the front desk always has, it is what a returning customer
// gives when asked, and it is what a WhatsApp reminder is sent to. That makes normalisation
// load-bearing: "+91 98765 43210", "098765 43210" and "9876543210" are the same person, and
// if they key differently the salon ends up with three of them.
//
// ── Why stats are RECOMPUTED, not incremented ───────────────────────────────────────────
// totalVisits / totalSpend / lastVisitAt are denormalized onto the customer record so the
// list and picker are cheap to render. They are always recomputed from the bills rather than
// nudged by a delta on each save. Incremental updates drift: a missed reversal on a delete, a
// bill edited on another device, a merge that lands twice — and the numbers quietly rot with
// no way to tell. Recomputing from the source of truth cannot drift, makes delete-reversal
// automatic, and costs a single pass over an in-memory array.

const digits = (s) => String(s ?? "").replace(/\D+/g, "");

/**
 * Reduce any way a phone number gets typed to a bare 10-digit Indian mobile.
 * Handles +91, 0091, a bare 91 country code, a leading 0, and any spacing/punctuation.
 * Returns "" when there's nothing usable. Non-Indian / malformed input is returned as its
 * bare digits so it can still be stored and shown — it just won't validate.
 */
export function normalizePhone(raw) {
  let d = digits(raw);
  if (!d) return "";
  if (d.length === 14 && d.startsWith("0091")) d = d.slice(4); // 0091 98765 43210
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2); // +91 98765 43210
  // Only strip a leading 0 down to 10 digits — never off an already-10-digit number, since a
  // valid mobile can't start with 0 anyway and we'd be corrupting something else.
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1); // 098765 43210
  return d;
}

/** Indian mobile numbers are 10 digits and start 6–9. */
export const isValidPhone = (raw) => /^[6-9]\d{9}$/.test(normalizePhone(raw));

/** "9876543210" → "98765 43210". Falls back to the raw digits for anything non-standard. */
export function formatPhone(raw) {
  const p = normalizePhone(raw);
  return /^\d{10}$/.test(p) ? `${p.slice(0, 5)} ${p.slice(5)}` : p;
}

/** The key a customer is stored under. Always normalise before reading or writing. */
export const customerKey = (raw) => normalizePhone(raw);

/**
 * A new customer record. `phone` doubles as both the key and the `id` — the sync layer keys
 * every slice on `rec.id`, so this must be set for the record to survive a round-trip.
 */
export const blankCustomer = (phone = "", createdAt = "") => ({
  id: normalizePhone(phone),
  phone: normalizePhone(phone),
  name: "",
  gender: "",
  dob: "", // dd-mm — no year: a birthday greeting doesn't need one, and asking for age costs goodwill
  anniversary: "", // dd-mm
  notes: "",
  tags: [],
  createdAt,
  // Denormalized — never hand-edited; always the output of recomputeStats().
  totalVisits: 0,
  totalSpend: 0,
  lastVisitAt: "",
  loyaltyPoints: 0,
  tier: "",
});

/** Every bill belonging to this customer, oldest first. */
export function billsForCustomer(sales, phone) {
  const key = normalizePhone(phone);
  if (!key) return [];
  return (sales || [])
    .filter((s) => normalizePhone(s.customerPhone) === key)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id)));
}

/**
 * Visit/spend stats for one customer, derived from the bills. This is the ONLY thing that
 * writes these three fields.
 *
 * A visit is a BILL, not a service line: a customer who has a cut and a colour in one sitting
 * visited once, and counting lines would inflate every frequency metric downstream (RFM in
 * Phase 4 leans on this).
 */
export function recomputeStats(phone, sales) {
  const bills = billsForCustomer(sales, phone);
  let totalSpend = 0;
  let lastVisitAt = "";
  for (const b of bills) {
    totalSpend += Number(b.total) || 0;
    const d = String(b.date || "");
    if (d > lastVisitAt) lastVisitAt = d;
  }
  return {
    totalVisits: bills.length,
    // Round once at the end: summing pre-rounded values would drift a few paise per bill.
    totalSpend: Math.round(totalSpend * 100) / 100,
    lastVisitAt,
  };
}

/** A customer record with its stats brought back in line with the bills. */
export const withStats = (customer, sales) => ({ ...customer, ...recomputeStats(customer.phone, sales) });

/**
 * Recompute every customer's stats. Used after a bill is saved, edited or deleted, and by the
 * Admin repair tool. Only returns a new array when something actually changed, so it can be
 * dropped straight into a setState without triggering a pointless sync write.
 */
export function reconcileCustomers(customers, sales) {
  let changed = false;
  const next = (customers || []).map((c) => {
    const stats = recomputeStats(c.phone, sales);
    if (c.totalVisits === stats.totalVisits && c.totalSpend === stats.totalSpend && c.lastVisitAt === stats.lastVisitAt) {
      return c;
    }
    changed = true;
    return { ...c, ...stats };
  });
  return changed ? next : customers;
}

/**
 * Search for the picker: match on name or phone, best matches first.
 * A phone search is matched against the normalised digits, so "98765 43210" finds the
 * customer stored as "9876543210".
 */
export function searchCustomers(customers, query, limit = 8) {
  const raw = String(query || "").trim().toLowerCase();
  if (!raw) return [];
  const asDigits = digits(raw);
  const scored = [];
  for (const c of customers || []) {
    const name = String(c.name || "").toLowerCase();
    const phone = String(c.phone || "");
    let score = -1;
    if (asDigits && phone.startsWith(asDigits)) score = 0; // phone prefix — the front desk's main move
    else if (asDigits && phone.includes(asDigits)) score = 1;
    else if (name.startsWith(raw)) score = 2;
    else if (name.includes(raw)) score = 3;
    if (score >= 0) scored.push({ c, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || String(a.c.name || "").localeCompare(String(b.c.name || "")))
    .slice(0, limit)
    .map((s) => s.c);
}

/** dd-mm for an occasion field, from a yyyy-mm-dd date input. "" when blank. */
export const toDayMonth = (isoDate) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ""));
  return m ? `${m[3]}-${m[2]}` : "";
};

/** dd-mm → a yyyy-mm-dd in the given year, for putting back into a date input. */
export const fromDayMonth = (dayMonth, year) => {
  const m = /^(\d{2})-(\d{2})$/.exec(String(dayMonth || ""));
  return m ? `${year}-${m[2]}-${m[1]}` : "";
};

/** Is this dd-mm well-formed and a real calendar day? (29-02 is allowed — it recurs.) */
export function isValidDayMonth(dayMonth) {
  const m = /^(\d{2})-(\d{2})$/.exec(String(dayMonth || ""));
  if (!m) return false;
  const day = +m[1];
  const month = +m[2];
  if (month < 1 || month > 12 || day < 1) return false;
  const maxDay = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= maxDay;
}
