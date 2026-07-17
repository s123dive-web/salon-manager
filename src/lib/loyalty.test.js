import { describe, it, expect } from "vitest";
import {
  loyaltyRules, pointsForSpend, maxRedeemablePoints, redeemValueOf, billPoints,
  pointsBalance, pointsLedger, rollingSpend, shiftMonths, tierForSpend, tierFor,
  nextTierGap, reconcileLoyalty, money2,
  blankPackage, validatePackage, makePackage, activePackages,
  addDaysISO, daysBetweenISO, sellPackage, isExpired, isRedeemable,
  redeemablePackages, packageCovering, expiringPackages,
  drawsAgainst, reconcilePackages,
} from "./loyalty.js";

const RULES = loyaltyRules({});

describe("loyaltyRules — a missing config means OFF, never a crash at the till", () => {
  it("defaults everything sensibly", () => {
    expect(RULES).toMatchObject({
      enabled: true, earnRate: 1, redeemValue: 1, minRedeemPoints: 50, maxRedeemPctOfBill: 20,
    });
    expect(RULES.tiers).toEqual({ silver: 10000, gold: 25000, platinum: 50000 });
  });

  it("survives null / partial / junk config", () => {
    [null, undefined, {}, { loyaltyConfig: null }, { loyaltyConfig: {} }].forEach((c) =>
      expect(() => loyaltyRules(c)).not.toThrow()
    );
    expect(loyaltyRules({ loyaltyConfig: { earnRate: 2 } }).redeemValue).toBe(1); // other fields still default
  });

  it("clamps hostile values rather than trusting them", () => {
    const r = loyaltyRules({ loyaltyConfig: { earnRate: -5, redeemValue: -1, maxRedeemPctOfBill: 500, minRedeemPoints: -3 } });
    expect(r.earnRate).toBe(0);
    expect(r.redeemValue).toBe(0);
    expect(r.maxRedeemPctOfBill).toBe(100);
    expect(r.minRedeemPoints).toBe(0);
  });

  it("respects an explicit disable", () => {
    expect(loyaltyRules({ loyaltyConfig: { enabled: false } }).enabled).toBe(false);
  });
});

describe("pointsForSpend", () => {
  it("earns at the configured rate", () => {
    expect(pointsForSpend(100, RULES)).toBe(1);
    expect(pointsForSpend(2000, RULES)).toBe(20);
    expect(pointsForSpend(0, RULES)).toBe(0);
  });

  it("FLOORS rather than rounds", () => {
    // Rounding would award a point for ₹50 at a "1 point per ₹100" rate — a rate the owner
    // never agreed to, given away on every small bill, forever.
    expect(pointsForSpend(50, RULES)).toBe(0);
    expect(pointsForSpend(99, RULES)).toBe(0);
    expect(pointsForSpend(199, RULES)).toBe(1);
    expect(pointsForSpend(150, RULES)).toBe(1);
  });

  it("earns nothing when loyalty is off or the rate is zero", () => {
    expect(pointsForSpend(5000, loyaltyRules({ loyaltyConfig: { enabled: false } }))).toBe(0);
    expect(pointsForSpend(5000, loyaltyRules({ loyaltyConfig: { earnRate: 0 } }))).toBe(0);
  });

  it("never earns on a negative or junk amount", () => {
    expect(pointsForSpend(-500, RULES)).toBe(0);
    expect(pointsForSpend("abc", RULES)).toBe(0);
    expect(pointsForSpend(null, RULES)).toBe(0);
  });

  it("honours a richer rate", () => {
    expect(pointsForSpend(1000, loyaltyRules({ loyaltyConfig: { earnRate: 5 } }))).toBe(50);
  });
});

describe("maxRedeemablePoints — the tightest ceiling wins", () => {
  it("is capped by the owner's % of the bill", () => {
    // 20% of ₹1000 = ₹200 = 200 points, even though they hold 500.
    expect(maxRedeemablePoints(500, 1000, RULES)).toBe(200);
  });

  it("is capped by what they actually have", () => {
    expect(maxRedeemablePoints(60, 1000, RULES)).toBe(60);
  });

  it("is capped by the bill — you can't pay off more than is owed", () => {
    const generous = loyaltyRules({ loyaltyConfig: { maxRedeemPctOfBill: 100, minRedeemPoints: 0 } });
    expect(maxRedeemablePoints(5000, 300, generous)).toBe(300);
  });

  it("returns 0 below the minimum, so 3 points can't clutter the till", () => {
    expect(maxRedeemablePoints(49, 1000, RULES)).toBe(0);
    expect(maxRedeemablePoints(50, 1000, RULES)).toBe(50);
  });

  it("can never zero out a bill at the default cap", () => {
    // The margin protection: points are a nudge, not a free service.
    const max = maxRedeemablePoints(999999, 1000, RULES);
    expect(redeemValueOf(max, RULES)).toBeLessThan(1000);
  });

  it("returns 0 when loyalty is off or points are worthless", () => {
    expect(maxRedeemablePoints(500, 1000, loyaltyRules({ loyaltyConfig: { enabled: false } }))).toBe(0);
    expect(maxRedeemablePoints(500, 1000, loyaltyRules({ loyaltyConfig: { redeemValue: 0 } }))).toBe(0);
  });

  it("never returns negative or fractional points", () => {
    expect(maxRedeemablePoints(-100, 1000, RULES)).toBe(0);
    expect(maxRedeemablePoints(500, 0, RULES)).toBe(0);
    expect(Number.isInteger(maxRedeemablePoints(500, 333, RULES))).toBe(true);
  });

  it("floors when a point is worth more than ₹1", () => {
    // 20% of ₹1000 = ₹200; at ₹30/point that's 6.67 → 6, not 7. Rounding up would hand back
    // ₹210 against a ₹200 cap.
    const rich = loyaltyRules({ loyaltyConfig: { redeemValue: 30, minRedeemPoints: 0 } });
    expect(maxRedeemablePoints(100, 1000, rich)).toBe(6);
  });
});

describe("redeemValueOf", () => {
  it("converts points to rupees", () => {
    expect(redeemValueOf(200, RULES)).toBe(200);
    expect(redeemValueOf(10, loyaltyRules({ loyaltyConfig: { redeemValue: 2.5 } }))).toBe(25);
  });
  it("floors fractional points and clamps negatives", () => {
    expect(redeemValueOf(10.9, RULES)).toBe(10);
    expect(redeemValueOf(-5, RULES)).toBe(0);
  });
});

// ── balances ─────────────────────────────────────────────────────────────────────────────
const P = "9876543210";
const SALES = [
  { id: "b1", customerPhone: P, date: "2026-01-10", total: 2000, pointsEarned: 20 },
  { id: "b2", customerPhone: P, date: "2026-03-05", total: 1000, pointsEarned: 10, pointsRedeemed: 15 },
  { id: "b3", customerPhone: P, date: "2026-05-01", total: 500 }, // legacy bill, no points fields
  { id: "b4", customerPhone: "9000000001", date: "2026-02-01", total: 800, pointsEarned: 8 },
];

describe("billPoints", () => {
  it("reads what a bill earned and redeemed", () => {
    expect(billPoints({ pointsEarned: 20, pointsRedeemed: 5 })).toEqual({ earned: 20, redeemed: 5 });
  });

  it("treats a legacy bill with no points fields as zero", () => {
    // Every grocery-era bill is exactly this.
    expect(billPoints({ total: 500 })).toEqual({ earned: 0, redeemed: 0 });
    expect(billPoints(null)).toEqual({ earned: 0, redeemed: 0 });
  });

  it("refuses negative/fractional junk", () => {
    expect(billPoints({ pointsEarned: -5, pointsRedeemed: 2.7 })).toEqual({ earned: 0, redeemed: 2 });
  });
});

describe("pointsBalance", () => {
  it("is earned minus redeemed across the customer's bills", () => {
    expect(pointsBalance(P, SALES)).toBe(15); // 20 - 15 + 10
  });

  it("only counts that customer's bills", () => {
    expect(pointsBalance("9000000001", SALES)).toBe(8);
  });

  it("matches however the phone is typed", () => {
    expect(pointsBalance("+91 98765 43210", SALES)).toBe(15);
  });

  it("REVERSES automatically when a bill is deleted", () => {
    // No reversal code exists — that's the design. Drop the bill and the points that came
    // with it are simply no longer in the sum.
    expect(pointsBalance(P, SALES.filter((s) => s.id !== "b1"))).toBe(0); // 10 - 15 → clamped
    expect(pointsBalance(P, SALES.filter((s) => s.id !== "b2"))).toBe(20);
  });

  it("never goes negative", () => {
    const overdrawn = [{ id: "x", customerPhone: P, date: "2026-01-01", total: 100, pointsRedeemed: 500 }];
    expect(pointsBalance(P, overdrawn)).toBe(0);
  });

  it("is 0 for someone with no bills", () => {
    expect(pointsBalance("9999999999", SALES)).toBe(0);
    expect(pointsBalance(P, [])).toBe(0);
  });
});

describe("pointsLedger", () => {
  it("shows a running balance, newest first", () => {
    const rows = pointsLedger(P, SALES);
    expect(rows.map((r) => [r.id, r.earned, r.redeemed, r.balance])).toEqual([
      ["b2", 10, 15, 15],
      ["b1", 20, 0, 20],
    ]);
  });

  it("skips bills that touched no points", () => {
    // A retail-only bill isn't a ledger entry; listing it as "0 / 0" is noise.
    expect(pointsLedger(P, SALES).some((r) => r.id === "b3")).toBe(false);
  });

  it("is empty for a customer with no points activity", () => {
    expect(pointsLedger("9999999999", SALES)).toEqual([]);
  });
});

// ── tiers ────────────────────────────────────────────────────────────────────────────────
describe("shiftMonths", () => {
  it("steps back a year", () => expect(shiftMonths("2026-07-17", -12)).toBe("2025-07-17"));

  it("does not overflow off a month end", () => {
    // The classic bug: setMonth on the 31st rolls into the next month. Mar 31 minus one month
    // must be Feb 28, not Mar 3.
    expect(shiftMonths("2026-03-31", -1)).toBe("2026-02-28");
    expect(shiftMonths("2026-05-31", -1)).toBe("2026-04-30");
  });

  it("clamps onto a leap day correctly", () => {
    expect(shiftMonths("2028-03-31", -1)).toBe("2028-02-29");
  });

  it("returns junk unchanged", () => expect(shiftMonths("nonsense", -12)).toBe("nonsense"));
});

describe("rollingSpend — 12 months, not lifetime", () => {
  const asOf = "2026-07-17";
  const history = [
    { id: "old", customerPhone: P, date: "2024-01-01", total: 90000 }, // one big wedding, years ago
    { id: "new", customerPhone: P, date: "2026-06-01", total: 5000 },
  ];

  it("ignores spend older than 12 months", () => {
    // Lifetime spend would keep this customer Platinum forever on the strength of one job in
    // 2024. A tier is meant to say "valuable NOW".
    expect(rollingSpend(P, history, asOf)).toBe(5000);
  });

  it("includes spend exactly 12 months ago", () => {
    expect(rollingSpend(P, [{ id: "e", customerPhone: P, date: "2025-07-17", total: 1000 }], asOf)).toBe(1000);
  });

  it("excludes future-dated bills", () => {
    expect(rollingSpend(P, [{ id: "f", customerPhone: P, date: "2027-01-01", total: 1000 }], asOf)).toBe(0);
  });
});

describe("tierForSpend", () => {
  it("maps spend to the highest tier reached", () => {
    expect(tierForSpend(0, RULES)).toBe("");
    expect(tierForSpend(9999, RULES)).toBe("");
    expect(tierForSpend(10000, RULES)).toBe("Silver");
    expect(tierForSpend(24999, RULES)).toBe("Silver");
    expect(tierForSpend(25000, RULES)).toBe("Gold");
    expect(tierForSpend(50000, RULES)).toBe("Platinum");
    expect(tierForSpend(999999, RULES)).toBe("Platinum");
  });

  it("checks the highest tier first, so a big spender isn't labelled Silver", () => {
    expect(tierForSpend(60000, RULES)).toBe("Platinum");
  });

  it("skips a tier the owner disabled with 0", () => {
    const noSilver = loyaltyRules({ loyaltyConfig: { tiers: { silver: 0, gold: 25000, platinum: 50000 } } });
    expect(tierForSpend(15000, noSilver)).toBe("");
    expect(tierForSpend(30000, noSilver)).toBe("Gold");
  });

  it("tierFor reads it off the bills", () => {
    const rich = [{ id: "r", customerPhone: P, date: "2026-06-01", total: 30000 }];
    expect(tierFor(P, rich, RULES, "2026-07-17")).toBe("Gold");
  });
});

describe("nextTierGap", () => {
  it("says what's left to the next tier", () => {
    expect(nextTierGap(0, RULES)).toEqual({ tier: "Silver", need: 10000 });
    expect(nextTierGap(12000, RULES)).toEqual({ tier: "Gold", need: 13000 });
    expect(nextTierGap(26000, RULES)).toEqual({ tier: "Platinum", need: 24000 });
  });

  it("returns null at the top — there's nothing left to chase", () => {
    expect(nextTierGap(50000, RULES)).toBe(null);
    expect(nextTierGap(90000, RULES)).toBe(null);
  });
});

describe("reconcileLoyalty", () => {
  const customers = [{ phone: P, name: "Asha" }, { phone: "9000000001", name: "Bhavna" }];

  it("writes the derived balance and tier onto the record", () => {
    const next = reconcileLoyalty(customers, SALES, {}, "2026-07-17");
    expect(next[0]).toMatchObject({ loyaltyPoints: 15, tier: "" });
  });

  it("returns the SAME array when nothing changed, so it can't loop", () => {
    const settled = reconcileLoyalty(customers, SALES, {}, "2026-07-17");
    expect(reconcileLoyalty(settled, SALES, {}, "2026-07-17")).toBe(settled);
  });

  it("corrects a drifted balance", () => {
    const wrong = [{ phone: P, name: "Asha", loyaltyPoints: 9999, tier: "Platinum" }];
    expect(reconcileLoyalty(wrong, SALES, {}, "2026-07-17")[0]).toMatchObject({ loyaltyPoints: 15, tier: "" });
  });

  it("handles an empty/missing list", () => {
    expect(reconcileLoyalty([], SALES, {}, "2026-07-17")).toEqual([]);
    expect(reconcileLoyalty(null, SALES, {}, "2026-07-17")).toBe(null);
  });
});

// ── packages ─────────────────────────────────────────────────────────────────────────────
describe("validatePackage", () => {
  const ok = { name: "6 Facials", serviceIds: ["s1"], totalUses: 6, price: 6000, validityDays: 180 };

  it("accepts a sane package", () => expect(validatePackage(ok)).toBe(null));

  it("requires a name and at least one covered service", () => {
    expect(validatePackage({ ...ok, name: " " })).toMatch(/name/i);
    expect(validatePackage({ ...ok, serviceIds: [] })).toMatch(/service/i);
  });

  it("requires whole, positive, believable sessions", () => {
    expect(validatePackage({ ...ok, totalUses: 0 })).toMatch(/sessions/i);
    expect(validatePackage({ ...ok, totalUses: 2.5 })).toMatch(/whole number/i);
    expect(validatePackage({ ...ok, totalUses: 500 })).toMatch(/over 100/i);
  });

  it("requires believable validity", () => {
    expect(validatePackage({ ...ok, validityDays: 0 })).toMatch(/validity/i);
    expect(validatePackage({ ...ok, validityDays: 2000 })).toMatch(/three years/i);
  });

  it("allows a free package (a comped one is a real thing)", () => {
    expect(validatePackage({ ...ok, price: 0 })).toBe(null);
    expect(validatePackage({ ...ok, price: -1 })).toMatch(/negative/i);
  });
});

describe("makePackage / blankPackage", () => {
  it("coerces form strings", () => {
    const p = makePackage({ name: " 6 Facials ", serviceIds: ["s1"], totalUses: "6", price: "6000.005", validityDays: "180" }, { id: "p1" });
    expect(p).toMatchObject({ id: "p1", name: "6 Facials", totalUses: 6, price: 6000.01, validityDays: 180, active: true });
  });

  it("blankPackage is valid once named and given a service", () => {
    expect(validatePackage({ ...blankPackage(), name: "X", serviceIds: ["s1"] })).toBe(null);
  });

  it("activePackages filters, treating a missing flag as active", () => {
    expect(activePackages([{ id: "a" }, { id: "b", active: false }]).map((p) => p.id)).toEqual(["a"]);
  });
});

describe("date helpers", () => {
  it("adds days across month/year ends", () => {
    expect(addDaysISO("2026-07-17", 180)).toBe("2027-01-13");
    expect(addDaysISO("2026-12-31", 1)).toBe("2027-01-01");
  });
  it("measures whole days, signed", () => {
    expect(daysBetweenISO("2026-07-17", "2026-07-20")).toBe(3);
    expect(daysBetweenISO("2026-07-20", "2026-07-17")).toBe(-3);
    expect(daysBetweenISO("2026-07-17", "2026-07-17")).toBe(0);
  });
  it("returns 0 rather than NaN for junk", () => {
    expect(daysBetweenISO("x", "2026-07-17")).toBe(0);
  });
});

describe("sellPackage", () => {
  const pkg = { id: "p1", name: "6 Facials", serviceIds: ["s1", "s2"], totalUses: 6, price: 6000, validityDays: 180 };
  const cp = sellPackage(pkg, "+91 98765 43210", { id: "cp1", today: "2026-07-17" });

  it("starts full and dated", () => {
    expect(cp).toMatchObject({
      id: "cp1", packageId: "p1", customerPhone: "9876543210",
      totalUses: 6, usesLeft: 6, pricePaid: 6000,
      purchasedAt: "2026-07-17", expiresAt: "2027-01-13",
    });
  });

  it("SNAPSHOTS the name and covered services", () => {
    // Renaming the package or changing what it covers must not rewrite what a customer
    // already bought. They paid for what was on the board that day.
    expect(cp.name).toBe("6 Facials");
    expect(cp.serviceIds).toEqual(["s1", "s2"]);
    pkg.serviceIds.push("s3");
    expect(cp.serviceIds).toEqual(["s1", "s2"]); // not a shared reference
  });
});

describe("package redemption eligibility", () => {
  const today = "2026-07-17";
  const live = { id: "cp1", customerPhone: "9876543210", serviceIds: ["s1"], usesLeft: 3, expiresAt: "2026-12-01" };
  const spent = { ...live, id: "cp2", usesLeft: 0 };
  const lapsed = { ...live, id: "cp3", expiresAt: "2026-07-16" };

  it("is redeemable with sessions left and time left", () => {
    expect(isRedeemable(live, today)).toBe(true);
  });

  it("is not redeemable once used up", () => expect(isRedeemable(spent, today)).toBe(false));

  it("is not redeemable once expired", () => {
    expect(isExpired(lapsed, today)).toBe(true);
    expect(isRedeemable(lapsed, today)).toBe(false);
  });

  it("is still redeemable ON the expiry date, not a day early", () => {
    // Off-by-one here means turning a paying customer away on a day they were entitled to.
    const lastDay = { ...live, expiresAt: today };
    expect(isExpired(lastDay, today)).toBe(false);
    expect(isRedeemable(lastDay, today)).toBe(true);
  });

  it("handles junk", () => expect(isRedeemable(null, today)).toBe(false));
});

describe("redeemablePackages", () => {
  const today = "2026-07-17";
  const all = [
    { id: "a", customerPhone: "9876543210", serviceIds: ["s1"], usesLeft: 2, expiresAt: "2026-12-01" },
    { id: "b", customerPhone: "9876543210", serviceIds: ["s2"], usesLeft: 1, expiresAt: "2026-08-01" },
    { id: "c", customerPhone: "9876543210", serviceIds: ["s1"], usesLeft: 0, expiresAt: "2026-12-01" },
    { id: "d", customerPhone: "9000000001", serviceIds: ["s1"], usesLeft: 5, expiresAt: "2026-12-01" },
  ];

  it("returns only this customer's usable packages, soonest to expire first", () => {
    // Draw down what would otherwise be wasted.
    expect(redeemablePackages(all, "9876543210", today).map((p) => p.id)).toEqual(["b", "a"]);
  });

  it("matches however the phone is typed", () => {
    expect(redeemablePackages(all, "+91 98765 43210", today)).toHaveLength(2);
  });

  it("returns nothing for a blank phone — a walk-in has no packages", () => {
    expect(redeemablePackages(all, "", today)).toEqual([]);
  });

  it("finds the package covering a service", () => {
    expect(packageCovering(all, "9876543210", "s1", today).id).toBe("a");
    expect(packageCovering(all, "9876543210", "s2", today).id).toBe("b");
    expect(packageCovering(all, "9876543210", "s99", today)).toBe(null);
  });

  it("won't cover a service from a used-up package", () => {
    const onlySpent = [{ id: "c", customerPhone: "9876543210", serviceIds: ["s1"], usesLeft: 0, expiresAt: "2026-12-01" }];
    expect(packageCovering(onlySpent, "9876543210", "s1", today)).toBe(null);
  });
});

describe("reconcilePackages — usesLeft is DERIVED, so a delete hands the session back", () => {
  const cps = [
    { id: "cp1", totalUses: 6, usesLeft: 6 },
    { id: "cp2", totalUses: 3, usesLeft: 3 },
  ];
  const withDraws = [
    { id: "b1", packageRedemptions: [{ customerPackageId: "cp1", serviceId: "s1" }] },
    { id: "b2", packageRedemptions: [{ customerPackageId: "cp1", serviceId: "s1" }, { customerPackageId: "cp2", serviceId: "s2" }] },
    { id: "b3", total: 500 }, // an ordinary bill that drew on nothing
  ];

  it("counts draws across bills", () => {
    expect(drawsAgainst("cp1", withDraws)).toBe(2);
    expect(drawsAgainst("cp2", withDraws)).toBe(1);
    expect(drawsAgainst("nope", withDraws)).toBe(0);
  });

  it("counts two draws on ONE bill separately", () => {
    // A customer taking two package sessions in one sitting must lose two, not one.
    const twoOnOne = [{ id: "b", packageRedemptions: [{ customerPackageId: "cp1" }, { customerPackageId: "cp1" }] }];
    expect(reconcilePackages(cps, twoOnOne)[0].usesLeft).toBe(4);
  });

  it("derives usesLeft from the bills", () => {
    const next = reconcilePackages(cps, withDraws);
    expect(next[0].usesLeft).toBe(4); // 6 - 2
    expect(next[1].usesLeft).toBe(2); // 3 - 1
  });

  it("RESTORES a session when the bill that used it is deleted", () => {
    // This is the whole reason usesLeft is derived. There is no restore code to forget.
    const settled = reconcilePackages(cps, withDraws);
    const afterDelete = reconcilePackages(settled, withDraws.filter((b) => b.id !== "b1"));
    expect(afterDelete[0].usesLeft).toBe(5);
  });

  it("restores everything when every bill is gone", () => {
    expect(reconcilePackages(reconcilePackages(cps, withDraws), []).map((c) => c.usesLeft)).toEqual([6, 3]);
  });

  it("never goes below zero on corrupt data", () => {
    const over = [{ id: "b", packageRedemptions: Array.from({ length: 99 }, () => ({ customerPackageId: "cp1" })) }];
    expect(reconcilePackages(cps, over)[0].usesLeft).toBe(0);
  });

  it("returns the SAME array when nothing changed, so it can't loop", () => {
    const settled = reconcilePackages(cps, withDraws);
    expect(reconcilePackages(settled, withDraws)).toBe(settled);
  });

  it("corrects a drifted counter", () => {
    const wrong = [{ id: "cp1", totalUses: 6, usesLeft: 99 }];
    expect(reconcilePackages(wrong, withDraws)[0].usesLeft).toBe(4);
  });

  it("handles empty/missing input", () => {
    expect(reconcilePackages([], withDraws)).toEqual([]);
    expect(reconcilePackages(null, withDraws)).toBe(null);
    expect(reconcilePackages(cps, null).map((c) => c.usesLeft)).toEqual([6, 3]);
  });
});

describe("expiringPackages", () => {
  const today = "2026-07-17";

  it("finds packages about to lapse with sessions still on them", () => {
    const list = [
      { id: "soon", usesLeft: 2, expiresAt: "2026-07-25" },
      { id: "later", usesLeft: 2, expiresAt: "2026-12-01" },
      { id: "spent", usesLeft: 0, expiresAt: "2026-07-25" },
      { id: "gone", usesLeft: 2, expiresAt: "2026-07-01" },
    ];
    expect(expiringPackages(list, today, 14).map((p) => p.id)).toEqual(["soon"]);
  });

  it("ignores a used-up package — there's nothing left to lose", () => {
    expect(expiringPackages([{ id: "x", usesLeft: 0, expiresAt: "2026-07-18" }], today, 14)).toEqual([]);
  });

  it("ignores one that already lapsed — too late to nudge", () => {
    expect(expiringPackages([{ id: "x", usesLeft: 3, expiresAt: "2026-07-16" }], today, 14)).toEqual([]);
  });

  it("includes one expiring today", () => {
    expect(expiringPackages([{ id: "x", usesLeft: 3, expiresAt: today }], today, 14)).toHaveLength(1);
  });
});

describe("money2", () => {
  it("rounds to paise without float dust", () => {
    expect(money2(0.1 + 0.2)).toBe(0.3);
    expect(money2(1.005)).toBe(1.01);
    expect(money2("abc")).toBe(0);
  });
});
