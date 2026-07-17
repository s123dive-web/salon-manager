// Staff commissions and performance.
//
// This module computes what the salon PAYS ITS PEOPLE, which makes it the one place where a
// quiet bug turns into a wage dispute. Two decisions carry that weight:
//
// ── Commission is read off the BILL, not recomputed from today's rates ───────────────────
// Every service line snapshots `commissionPct` at the moment of sale (see Billing). A payout
// report reads that snapshot. If the owner raises the colour commission from 12% to 15% in
// August, July's payout must not silently reprice — the stylist was paid on what was agreed in
// July, and a report that changes when you re-open it is a report nobody can trust.
//
// The fallback to a staff member's default rate exists only for bills written before the line
// carried its own rate, and for the rare line saved without one.
//
// ── A discount is the salon's decision, not the stylist's ────────────────────────────────
// Commission is computed on the LINE amount, before any whole-bill discount or points
// redemption. The owner chose to give that money away; the person who did the work still did
// the work. Netting the discount off their commission would quietly make every discount come
// half out of the stylist's pocket — see `commissionForLine`.

import { isServiceLine } from "./salon.js";

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export const money2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;

/**
 * The commission rate that applies to a saved bill line.
 *
 * Prefers the rate snapshotted on the line. Falls back to the staff member's default only when
 * the line has none — an explicit 0 on the line is a REAL rate meaning "this pays nothing" and
 * must not fall through.
 */
export function rateForLine(line, staffMember) {
  const onLine = line?.commissionPct;
  if (onLine != null && Number.isFinite(Number(onLine))) return Number(onLine);
  const dflt = staffMember?.commissionPctDefault;
  if (dflt != null && Number.isFinite(Number(dflt))) return Number(dflt);
  return 0;
}

/**
 * What one service line earns its stylist.
 *
 * Uses `line.amount` (price × qty) — the gross for the work done — deliberately ignoring any
 * whole-bill discount. See the note at the top of this file.
 *
 * A package redemption is a ₹0 line, so it earns ₹0 here: the money for that session was taken
 * (and its commission paid) when the package was sold. This is a knowing simplification — a
 * salon that wants to pay per redeemed session would need a different rule, and it's flagged
 * in the README.
 */
export function commissionForLine(line, staffMember) {
  if (!isServiceLine(line)) return 0; // products earn no commission
  const amount = num(line.amount);
  if (amount <= 0) return 0;
  const rate = rateForLine(line, staffMember);
  if (rate <= 0) return 0;
  return money2((amount * rate) / 100);
}

/** Every service line across the given bills, flattened, with its bill's date attached. */
export function serviceLines(sales) {
  const out = [];
  for (const b of sales || []) {
    for (const l of b.lines || []) {
      if (!isServiceLine(l)) continue;
      out.push({ line: l, bill: b, date: String(b.date || ""), staffId: l.staffId || "" });
    }
  }
  return out;
}

/** Bills within [from, to] inclusive. Dates are plain local YYYY-MM-DD strings. */
export const salesInRange = (sales, from, to) =>
  (sales || []).filter((s) => {
    const d = String(s.date || "");
    return (!from || d >= from) && (!to || d <= to);
  });

/**
 * The payout report for one staff member over a date range.
 *
 * `revenue` is what their work billed (gross of whole-bill discounts, per the rule above);
 * `commission` is what they're owed.
 */
export function staffPayout(staffMember, sales, from, to) {
  const rows = [];
  let revenue = 0;
  let commission = 0;
  for (const { line, bill, date } of serviceLines(salesInRange(sales, from, to))) {
    if (line.staffId !== staffMember.id) continue;
    const amount = num(line.amount);
    const c = commissionForLine(line, staffMember);
    revenue += amount;
    commission += c;
    rows.push({
      billId: bill.id, date, service: line.name, qty: num(line.qty) || 1,
      amount: money2(amount), rate: rateForLine(line, staffMember), commission: c,
      customer: bill.customer || "", fromPackage: !!line.fromPackageId,
    });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || String(a.billId).localeCompare(String(b.billId)));
  return {
    staffId: staffMember.id,
    name: staffMember.name,
    services: rows.length,
    revenue: money2(revenue),
    commission: money2(commission),
    rows,
  };
}

/** Payout reports for every staff member, biggest earner first. */
export const allPayouts = (staff, sales, from, to) =>
  (staff || [])
    .map((s) => staffPayout(s, sales, from, to))
    .sort((a, b) => b.commission - a.commission || b.revenue - a.revenue);

/**
 * Revenue and commission per stylist, for the bar chart. Includes people with zero — an empty
 * bar is information ("nobody booked with them"), not noise.
 */
export const revenuePerStaff = (staff, sales, from, to) =>
  allPayouts(staff, sales, from, to).map((p) => ({
    name: p.name, revenue: p.revenue, commission: p.commission, services: p.services,
  }));

/** Services performed per day by one stylist (or everyone), for the trend line. */
export function servicesPerDay(sales, staffId, from, to) {
  const m = new Map();
  for (const { line, date } of serviceLines(salesInRange(sales, from, to))) {
    if (staffId && line.staffId !== staffId) continue;
    m.set(date, (m.get(date) || 0) + (num(line.qty) || 1));
  }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, count]) => ({ date, count }));
}

/**
 * Peak-hour heatmap: appointments per weekday × hour.
 *
 * Built from APPOINTMENTS, not bills. A bill's timestamp is when the customer paid — which is
 * when they left, not when they were in the chair. Staffing decisions need the latter, and the
 * diary is the only thing that knows it.
 *
 * Rows are Mon–Sun (a salon's week), and only chair-occupying appointments count.
 */
export function peakHours(appointments, from, to) {
  // Mon..Sun × 24h.
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  let max = 0;
  for (const a of appointments || []) {
    const d = String(a.date || "");
    if ((from && d < from) || (to && d > to)) continue;
    if (a.status !== "booked" && a.status !== "completed") continue; // a no-show is not demand met
    const dt = new Date(d + "T00:00");
    if (Number.isNaN(dt.getTime())) continue;
    const row = (dt.getDay() + 6) % 7; // shift Sunday-first → Monday-first
    const hour = Math.floor((num(a.startMin) || 0) / 60);
    if (hour < 0 || hour > 23) continue;
    grid[row][hour]++;
    if (grid[row][hour] > max) max = grid[row][hour];
  }
  return { grid, max };
}

/**
 * No-show rate per stylist.
 *
 * Denominator is appointments that RESOLVED — completed + no-show. Cancellations are excluded:
 * a customer who rings ahead to cancel is not a no-show, and counting them would blame the
 * stylist for someone else's good manners. `blocked` and still-`booked` are excluded too.
 */
export function noShowRates(staff, appointments, from, to) {
  const byStaff = new Map((staff || []).map((s) => [s.id, { staffId: s.id, name: s.name, completed: 0, noShow: 0 }]));
  for (const a of appointments || []) {
    const d = String(a.date || "");
    if ((from && d < from) || (to && d > to)) continue;
    const row = byStaff.get(a.staffId);
    if (!row) continue;
    if (a.status === "completed") row.completed++;
    else if (a.status === "no-show") row.noShow++;
  }
  return [...byStaff.values()]
    .map((r) => {
      const resolved = r.completed + r.noShow;
      return { ...r, resolved, rate: resolved ? money2((r.noShow / resolved) * 100) : 0 };
    })
    .sort((a, b) => b.rate - a.rate || b.noShow - a.noShow);
}

/** Month boundaries for a YYYY-MM, in local time. */
export function monthRange(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ""));
  if (!m) return { from: "", to: "" };
  const year = +m[1];
  const month = +m[2];
  const last = new Date(year, month, 0).getDate(); // day 0 of next month = last day of this one
  return { from: `${m[1]}-${m[2]}-01`, to: `${m[1]}-${m[2]}-${String(last).padStart(2, "0")}` };
}
