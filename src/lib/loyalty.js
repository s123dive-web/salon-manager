// Loyalty points, tiers, and prepaid packages.
//
// This module handles money the salon has promised to customers, which makes it the least
// forgiving code in the app: a points bug either quietly eats the salon's margin or shorts a
// customer at the counter, and both get noticed. Everything here is pure and derived.
//
// ── Points are DERIVED, not stored as a running total ────────────────────────────────────
// `customer.loyaltyPoints` is a denormalized cache, exactly like totalSpend: it is recomputed
// from the bills, never incremented. Same reasoning as customers.js — an incremented balance
// drifts the first time a bill is deleted, edited on another device, or merged twice, and a
// drifted points balance is an argument at the till with no way to adjudicate it.
//
// The ledger IS the bills. Every bill records what it earned (`pointsEarned`) and what it
// redeemed (`pointsRedeemed`); the balance is the sum. Delete the bill and both reverse
// themselves, with no reversal code to forget.

import { billsForCustomer, normalizePhone } from "./customers.js";

export const TIERS = ["", "Silver", "Gold", "Platinum"];

export const TIER_COLORS = {
  Silver: "#8A9BA8",
  Gold: "#C9971F",
  Platinum: "#5B6CB8",
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Round to paise. Money must never carry float dust into a receipt. */
export const money2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;

/**
 * The loyalty rules in force, with every field defaulted. The config is owner-edited and lives
 * in the shop/config singleton, so it can be partial, stale, or absent entirely — a missing
 * config must mean "loyalty is off", never a crash at the till.
 */
export function loyaltyRules(config) {
  const c = config?.loyaltyConfig || {};
  const t = c.tiers || {};
  return {
    enabled: c.enabled !== false,
    earnRate: Math.max(0, num(c.earnRate ?? 1)), // points per ₹100 spent
    redeemValue: Math.max(0, num(c.redeemValue ?? 1)), // ₹ per point
    minRedeemPoints: Math.max(0, num(c.minRedeemPoints ?? 50)),
    maxRedeemPctOfBill: Math.min(100, Math.max(0, num(c.maxRedeemPctOfBill ?? 20))),
    tiers: {
      silver: Math.max(0, num(t.silver ?? 10000)),
      gold: Math.max(0, num(t.gold ?? 25000)),
      platinum: Math.max(0, num(t.platinum ?? 50000)),
    },
  };
}

/**
 * Points earned by spending `amount`.
 *
 * Floored, not rounded: awarding a point for ₹50 at a "1 point per ₹100" rate is a rate the
 * owner didn't agree to. Points are whole — a customer cannot spend half a point.
 */
export function pointsForSpend(amount, rules) {
  if (!rules.enabled || rules.earnRate <= 0) return 0;
  const spend = Math.max(0, num(amount));
  return Math.floor((spend / 100) * rules.earnRate);
}

/**
 * The most that may be redeemed against a bill, in points.
 *
 * Three separate ceilings, and the tightest wins:
 *  1. what the customer actually has,
 *  2. the owner's cap (a % of the bill), so points can never zero out a bill,
 *  3. the bill itself — you cannot pay off more than is owed.
 * Below `minRedeemPoints` the answer is 0: a 3-point redemption is till clutter, not a perk.
 */
export function maxRedeemablePoints(balance, billAmount, rules) {
  if (!rules.enabled || rules.redeemValue <= 0) return 0;
  const have = Math.max(0, Math.floor(num(balance)));
  if (have < rules.minRedeemPoints) return 0;
  const capRupees = money2((Math.max(0, num(billAmount)) * rules.maxRedeemPctOfBill) / 100);
  const capPoints = Math.floor(capRupees / rules.redeemValue);
  const billPoints = Math.floor(Math.max(0, num(billAmount)) / rules.redeemValue);
  return Math.max(0, Math.min(have, capPoints, billPoints));
}

/** What `points` are worth in rupees. */
export const redeemValueOf = (points, rules) =>
  money2(Math.max(0, Math.floor(num(points))) * rules.redeemValue);

/**
 * The points a bill earned and redeemed, read straight off the bill.
 * Legacy bills (and every grocery-era bill) have neither field and contribute zero.
 */
export const billPoints = (bill) => ({
  earned: Math.max(0, Math.floor(num(bill?.pointsEarned))),
  redeemed: Math.max(0, Math.floor(num(bill?.pointsRedeemed))),
});

/**
 * A customer's current points balance, summed from their bills.
 *
 * Never returns a negative: a balance below zero can only come from corrupt data, and showing
 * "-40 points" at the counter is worse than showing 0 while the owner sorts it out.
 */
export function pointsBalance(phone, sales) {
  let balance = 0;
  for (const b of billsForCustomer(sales, phone)) {
    const { earned, redeemed } = billPoints(b);
    balance += earned - redeemed;
  }
  return Math.max(0, balance);
}

/** The points ledger for a customer profile — newest first, with a running balance. */
export function pointsLedger(phone, sales) {
  const bills = billsForCustomer(sales, phone); // oldest first
  let running = 0;
  const rows = [];
  for (const b of bills) {
    const { earned, redeemed } = billPoints(b);
    if (!earned && !redeemed) continue; // a bill that touched no points isn't a ledger entry
    running += earned - redeemed;
    rows.push({ id: b.id, date: b.date, earned, redeemed, balance: running, total: num(b.total) });
  }
  return rows.reverse();
}

/**
 * 12-month rolling spend — the basis for a tier.
 *
 * Rolling, not lifetime: a tier is meant to say "this customer is valuable NOW". Lifetime spend
 * would keep someone Platinum forever on the strength of one wedding season five years ago.
 */
export function rollingSpend(phone, sales, asOf) {
  const cutoff = shiftMonths(asOf, -12);
  let total = 0;
  for (const b of billsForCustomer(sales, phone)) {
    if (String(b.date || "") >= cutoff && String(b.date || "") <= asOf) total += num(b.total);
  }
  return money2(total);
}

/** YYYY-MM-DD shifted by n months, staying in local time. */
export function shiftMonths(dateStr, n) {
  const d = new Date(String(dateStr) + "T00:00");
  if (Number.isNaN(d.getTime())) return dateStr;
  const day = d.getDate();
  d.setDate(1); // avoid the Mar-31 → Mar-03 overflow when stepping back a month
  d.setMonth(d.getMonth() + n);
  // Clamp to the last valid day of the landing month.
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The tier for a given 12-month spend. "" = no tier yet. */
export function tierForSpend(spend, rules) {
  const s = num(spend);
  const t = rules.tiers;
  if (t.platinum > 0 && s >= t.platinum) return "Platinum";
  if (t.gold > 0 && s >= t.gold) return "Gold";
  if (t.silver > 0 && s >= t.silver) return "Silver";
  return "";
}

/** A customer's tier right now. */
export const tierFor = (phone, sales, rules, asOf) => tierForSpend(rollingSpend(phone, sales, asOf), rules);

/** How much more they'd need to spend to reach the next tier. null once Platinum. */
export function nextTierGap(spend, rules) {
  const s = num(spend);
  const t = rules.tiers;
  for (const [name, threshold] of [["Silver", t.silver], ["Gold", t.gold], ["Platinum", t.platinum]]) {
    if (threshold > 0 && s < threshold) return { tier: name, need: money2(threshold - s) };
  }
  return null;
}

/**
 * Recompute the denormalized loyalty fields for every customer.
 *
 * Mirrors reconcileCustomers: returns the SAME array when nothing changed, so it settles after
 * one pass instead of pushing a write to the cloud on every render.
 */
export function reconcileLoyalty(customers, sales, config, asOf) {
  const rules = loyaltyRules(config);
  let changed = false;
  const next = (customers || []).map((c) => {
    const loyaltyPoints = pointsBalance(c.phone, sales);
    const tier = tierFor(c.phone, sales, rules, asOf);
    if (c.loyaltyPoints === loyaltyPoints && (c.tier || "") === tier) return c;
    changed = true;
    return { ...c, loyaltyPoints, tier };
  });
  return changed ? next : customers;
}

// ── Packages ─────────────────────────────────────────────────────────────────────────────
// A package is prepaid work: the customer buys N sessions up front and draws them down. The
// money is taken on day one, so a redemption is a ZERO-price line — charging again would be
// charging twice for the same session.

export const blankPackage = (createdAt = "") => ({
  id: "",
  name: "",
  serviceIds: [],
  totalUses: 1,
  price: 0,
  validityDays: 180,
  active: true,
  createdAt,
});

export function validatePackage(form) {
  if (!String(form.name || "").trim()) return "Give the package a name.";
  if (!(form.serviceIds || []).length) return "Pick at least one service the package covers.";
  const uses = num(form.totalUses);
  if (!Number.isInteger(uses) || uses <= 0) return "Number of sessions must be a whole number above 0.";
  if (uses > 100) return "That's over 100 sessions — check the number.";
  const price = num(form.price);
  if (price < 0) return "Price can't be negative.";
  const validity = num(form.validityDays);
  if (!Number.isInteger(validity) || validity <= 0) return "Validity must be a whole number of days above 0.";
  if (validity > 1095) return "Validity looks wrong — that's over three years.";
  return null;
}

export const makePackage = (form, { id, createdAt = "" } = {}) => ({
  ...blankPackage(createdAt),
  ...form,
  id: id || form.id,
  name: String(form.name || "").trim(),
  totalUses: Math.floor(num(form.totalUses)) || 1,
  price: money2(form.price),
  validityDays: Math.floor(num(form.validityDays)) || 1,
  active: form.active !== false,
});

export const activePackages = (packages) => (packages || []).filter((p) => p.active !== false);

/** Add days to a YYYY-MM-DD, in local time. */
export function addDaysISO(dateStr, n) {
  const d = new Date(String(dateStr) + "T00:00");
  if (Number.isNaN(d.getTime())) return dateStr;
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Whole days from a → b (negative when b is in the past). */
export function daysBetweenISO(a, b) {
  const da = new Date(String(a) + "T00:00");
  const db = new Date(String(b) + "T00:00");
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return 0;
  return Math.round((db - da) / 86400000);
}

/** Sell a package to a customer — the record that tracks what they have left. */
export const sellPackage = (pkg, phone, { id, today }) => ({
  id,
  packageId: pkg.id,
  customerPhone: normalizePhone(phone),
  name: pkg.name, // snapshotted: renaming the package later must not rewrite history
  serviceIds: [...(pkg.serviceIds || [])],
  totalUses: Math.floor(num(pkg.totalUses)) || 1,
  usesLeft: Math.floor(num(pkg.totalUses)) || 1,
  pricePaid: money2(pkg.price),
  purchasedAt: today,
  expiresAt: addDaysISO(today, Math.floor(num(pkg.validityDays)) || 1),
});

/**
 * How many sessions of a given customer-package have been drawn down, counted from the bills.
 *
 * `packageRedemptions` on a bill is the record of what it drew. Counting them is what makes
 * `usesLeft` derived rather than a running total — see reconcilePackages.
 */
export function drawsAgainst(customerPackageId, sales) {
  let n = 0;
  for (const b of sales || []) {
    for (const r of b.packageRedemptions || []) {
      if (r.customerPackageId === customerPackageId) n++;
    }
  }
  return n;
}

/**
 * Recompute `usesLeft` for every sold package from the bills that drew on it.
 *
 * Same discipline as points and customer stats: a stored counter drifts the first time a bill
 * is deleted, edited on another device, or merged twice — and a drifted package balance means
 * either turning away a customer who has sessions left, or giving away work that was already
 * used up. Deriving it makes the delete-reversal automatic: drop the bill and the session is
 * simply back.
 *
 * Returns the SAME array when nothing changed, so it settles after one pass.
 */
export function reconcilePackages(customerPackages, sales) {
  let changed = false;
  const next = (customerPackages || []).map((cp) => {
    const total = Math.floor(num(cp.totalUses)) || 0;
    const usesLeft = Math.max(0, total - drawsAgainst(cp.id, sales));
    if (cp.usesLeft === usesLeft) return cp;
    changed = true;
    return { ...cp, usesLeft };
  });
  return changed ? next : customerPackages;
}

export const isExpired = (cp, today) => String(cp?.expiresAt || "") < String(today);

/** Usable = belongs to them, has sessions left, and hasn't lapsed. */
export const isRedeemable = (cp, today) =>
  !!cp && Math.floor(num(cp.usesLeft)) > 0 && !isExpired(cp, today);

/** Every package this customer can still draw on today. */
export function redeemablePackages(customerPackages, phone, today) {
  const key = normalizePhone(phone);
  if (!key) return [];
  return (customerPackages || [])
    .filter((cp) => normalizePhone(cp.customerPhone) === key && isRedeemable(cp, today))
    // Soonest to expire first: draw down what would otherwise be wasted.
    .sort((a, b) => String(a.expiresAt || "").localeCompare(String(b.expiresAt || "")));
}

/** The package (if any) that covers this service and can be redeemed today. */
export const packageCovering = (customerPackages, phone, serviceId, today) =>
  redeemablePackages(customerPackages, phone, today).find((cp) => (cp.serviceIds || []).includes(serviceId)) || null;

/** Packages running out of time but not sessions — the Phase 4 reminder queue reads this. */
export function expiringPackages(customerPackages, today, withinDays = 14) {
  return (customerPackages || []).filter((cp) => {
    if (Math.floor(num(cp.usesLeft)) <= 0) return false; // nothing left to lose
    const left = daysBetweenISO(today, cp.expiresAt);
    return left >= 0 && left <= withinDays;
  });
}
