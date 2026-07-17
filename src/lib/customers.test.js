import { describe, it, expect } from "vitest";
import {
  normalizePhone, isValidPhone, formatPhone, customerKey, blankCustomer,
  billsForCustomer, recomputeStats, withStats, reconcileCustomers, searchCustomers,
  toDayMonth, fromDayMonth, isValidDayMonth,
} from "./customers.js";

describe("normalizePhone", () => {
  it("reduces every way a number gets typed to the same 10 digits", () => {
    const same = [
      "9876543210", "98765 43210", "98765-43210", "+91 98765 43210", "+919876543210",
      "919876543210", "09876543210", "0091 98765 43210", " 9876543210 ", "(98765) 43210",
    ];
    same.forEach((v) => expect(normalizePhone(v)).toBe("9876543210"));
  });

  it("is the thing that stops one customer becoming three", () => {
    // The whole point: these are one person walking in three times.
    const keys = new Set(["+91 98765 43210", "098765 43210", "9876543210"].map(customerKey));
    expect(keys.size).toBe(1);
  });

  it("returns '' for empty/garbage input", () => {
    ["", null, undefined, "abc", "   ", "-"].forEach((v) => expect(normalizePhone(v)).toBe(""));
  });

  it("does not strip a leading 9 from a valid 10-digit number", () => {
    // "91..." as a country code is only meaningful at 12 digits. A 10-digit number starting
    // 91 is a real mobile and must survive intact.
    expect(normalizePhone("9123456789")).toBe("9123456789");
  });

  it("returns digits for a non-mobile, and flags it invalid rather than silently accepting it", () => {
    // A landline collides with the leading-0 strip (11 digits, starts 0), so the STD code's 0
    // comes off. That's a knowing trade: the strip exists for "09876543210", the far more
    // common input, and a landline fails isValidPhone either way — so nothing is keyed on it.
    expect(normalizePhone("020 2567 8900")).toBe("2025678900");
    expect(isValidPhone("020 2567 8900")).toBe(false);
  });
});

describe("isValidPhone", () => {
  it("accepts 10-digit mobiles starting 6-9, however they're typed", () => {
    ["9876543210", "+91 6123456789", "7000000000", "8999999999"].forEach((v) =>
      expect(isValidPhone(v)).toBe(true)
    );
  });

  it("rejects wrong length, wrong leading digit, and junk", () => {
    ["", "98765", "98765432101", "5876543210", "1234567890", "0000000000", "abcdefghij"].forEach(
      (v) => expect(isValidPhone(v)).toBe(false)
    );
  });
});

describe("formatPhone", () => {
  it("groups a valid number for reading", () => {
    expect(formatPhone("+919876543210")).toBe("98765 43210");
  });
  it("passes anything non-standard through as digits", () => {
    expect(formatPhone("12345")).toBe("12345");
    expect(formatPhone("")).toBe("");
  });
});

describe("blankCustomer", () => {
  it("sets id === phone, so the sync layer can key it", () => {
    // sync.js keys every slice on rec.id; a customer without one silently vanishes on save.
    const c = blankCustomer("+91 98765 43210", "2026-07-17");
    expect(c.id).toBe("9876543210");
    expect(c.phone).toBe("9876543210");
    expect(c.id).toBe(c.phone);
  });

  it("starts with zeroed stats", () => {
    const c = blankCustomer("9876543210");
    expect(c.totalVisits).toBe(0);
    expect(c.totalSpend).toBe(0);
    expect(c.lastVisitAt).toBe("");
  });
});

// ── stats ────────────────────────────────────────────────────────────────────────────────
const SALES = [
  { id: "b1", customerPhone: "9876543210", date: "2026-01-10", total: 500 },
  { id: "b2", customerPhone: "9876543210", date: "2026-03-05", total: 1200.5 },
  { id: "b3", customerPhone: "9000000001", date: "2026-02-01", total: 800 },
  { id: "b4", date: "2026-02-02", total: 300 }, // walk-in, no customer
  { id: "b5", customerPhone: "+91 98765 43210", date: "2026-02-20", total: 700 }, // same person, typed differently
];

describe("billsForCustomer", () => {
  it("matches on the normalised phone, not the raw string", () => {
    const bills = billsForCustomer(SALES, "9876543210");
    expect(bills.map((b) => b.id)).toEqual(["b1", "b5", "b2"]); // oldest first
  });

  it("finds the same bills whichever way the phone is passed in", () => {
    expect(billsForCustomer(SALES, "+91 98765 43210").length).toBe(3);
    expect(billsForCustomer(SALES, "098765 43210").length).toBe(3);
  });

  it("never sweeps up walk-in bills", () => {
    expect(billsForCustomer(SALES, "").length).toBe(0);
    expect(billsForCustomer(SALES, "9000000001").map((b) => b.id)).toEqual(["b3"]);
  });
});

describe("recomputeStats", () => {
  it("counts bills as visits and sums the net total", () => {
    expect(recomputeStats("9876543210", SALES)).toEqual({
      totalVisits: 3,
      totalSpend: 2400.5,
      lastVisitAt: "2026-03-05",
    });
  });

  it("counts a multi-service sitting as ONE visit", () => {
    // A cut + colour on one bill is one visit. Counting lines would inflate every frequency
    // metric that reads this.
    const oneBill = [{ id: "x", customerPhone: "9876543210", date: "2026-05-01", total: 3000, lines: [{}, {}, {}] }];
    expect(recomputeStats("9876543210", oneBill).totalVisits).toBe(1);
  });

  it("returns zeros for someone with no bills", () => {
    expect(recomputeStats("9999999999", SALES)).toEqual({ totalVisits: 0, totalSpend: 0, lastVisitAt: "" });
  });

  it("rounds the total once, not per bill", () => {
    const pennies = [
      { id: "1", customerPhone: "9876543210", date: "2026-01-01", total: 0.1 },
      { id: "2", customerPhone: "9876543210", date: "2026-01-02", total: 0.2 },
    ];
    expect(recomputeStats("9876543210", pennies).totalSpend).toBe(0.3);
  });

  it("tolerates missing/garbage totals rather than producing NaN", () => {
    const messy = [
      { id: "1", customerPhone: "9876543210", date: "2026-01-01" },
      { id: "2", customerPhone: "9876543210", date: "2026-01-02", total: "abc" },
      { id: "3", customerPhone: "9876543210", date: "2026-01-03", total: 100 },
    ];
    expect(recomputeStats("9876543210", messy).totalSpend).toBe(100);
  });
});

describe("withStats", () => {
  it("overwrites whatever was on the record", () => {
    const stale = { ...blankCustomer("9876543210"), totalVisits: 99, totalSpend: 1, lastVisitAt: "1999-01-01" };
    expect(withStats(stale, SALES)).toMatchObject({ totalVisits: 3, totalSpend: 2400.5, lastVisitAt: "2026-03-05" });
  });
});

describe("reconcileCustomers — the anti-drift guarantee", () => {
  const customers = [blankCustomer("9876543210"), blankCustomer("9000000001")];

  it("brings stale stats back in line with the bills", () => {
    const next = reconcileCustomers(customers, SALES);
    expect(next.find((c) => c.phone === "9876543210")).toMatchObject({ totalVisits: 3, totalSpend: 2400.5 });
    expect(next.find((c) => c.phone === "9000000001")).toMatchObject({ totalVisits: 1, totalSpend: 800 });
  });

  it("REVERSES a deleted bill automatically", () => {
    // This is the delete-restores-stock discipline applied to customer stats. No explicit
    // reversal code exists, and that's the point: there is none to forget.
    const after = reconcileCustomers(reconcileCustomers(customers, SALES), SALES.filter((s) => s.id !== "b2"));
    expect(after.find((c) => c.phone === "9876543210")).toMatchObject({
      totalVisits: 2,
      totalSpend: 1200,
      lastVisitAt: "2026-02-20", // the last visit rolls back too
    });
  });

  it("zeroes a customer whose every bill was deleted", () => {
    const after = reconcileCustomers(reconcileCustomers(customers, SALES), []);
    after.forEach((c) => expect(c).toMatchObject({ totalVisits: 0, totalSpend: 0, lastVisitAt: "" }));
  });

  it("returns the SAME array reference when nothing changed", () => {
    // Dropped straight into setState — a fresh array every render would push a pointless
    // write to the cloud on a 300ms debounce, forever.
    const settled = reconcileCustomers(customers, SALES);
    expect(reconcileCustomers(settled, SALES)).toBe(settled);
  });

  it("is idempotent", () => {
    const once = reconcileCustomers(customers, SALES);
    expect(reconcileCustomers(once, SALES)).toEqual(once);
  });

  it("leaves non-stat fields alone", () => {
    const withNotes = [{ ...blankCustomer("9876543210"), name: "Asha", notes: "prefers Priya", tags: ["vip"] }];
    const next = reconcileCustomers(withNotes, SALES);
    expect(next[0]).toMatchObject({ name: "Asha", notes: "prefers Priya", tags: ["vip"] });
  });

  it("handles an empty/missing customer list", () => {
    expect(reconcileCustomers([], SALES)).toEqual([]);
    expect(reconcileCustomers(null, SALES)).toBe(null);
  });
});

describe("searchCustomers", () => {
  const list = [
    { phone: "9876543210", name: "Asha Patil" },
    { phone: "9812345678", name: "Bhavna Rao" },
    { phone: "9000000001", name: "Natasha Kulkarni" },
  ];

  it("finds by phone prefix — the front desk's main move", () => {
    expect(searchCustomers(list, "98765").map((c) => c.name)).toEqual(["Asha Patil"]);
  });

  it("finds by a spaced phone the way it's written on a card", () => {
    expect(searchCustomers(list, "98765 43210").map((c) => c.name)).toEqual(["Asha Patil"]);
  });

  it("finds by name, prefix matches first", () => {
    // "Asha Patil" starts with the query; "Natasha Kulkarni" merely contains it.
    expect(searchCustomers(list, "asha").map((c) => c.name)).toEqual(["Asha Patil", "Natasha Kulkarni"]);
  });

  it("is case-insensitive", () => {
    expect(searchCustomers(list, "BHAVNA").map((c) => c.name)).toEqual(["Bhavna Rao"]);
  });

  it("returns nothing for a blank query rather than the whole database", () => {
    // A biller may pick a customer but must not browse the list; an empty query returning
    // everyone would hand them exactly that.
    ["", "   ", null, undefined].forEach((q) => expect(searchCustomers(list, q)).toEqual([]));
  });

  it("respects the limit", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ phone: `98765432${String(i).padStart(2, "0")}`, name: `P${i}` }));
    expect(searchCustomers(many, "98765", 5).length).toBe(5);
  });

  it("copes with a missing list", () => {
    expect(searchCustomers(null, "asha")).toEqual([]);
  });
});

describe("day-month occasion helpers", () => {
  it("round-trips a date input value", () => {
    expect(toDayMonth("1994-03-09")).toBe("09-03");
    expect(fromDayMonth("09-03", "2026")).toBe("2026-03-09");
  });

  it("returns '' for blank/invalid input", () => {
    ["", null, "1994-3-9", "garbage"].forEach((v) => expect(toDayMonth(v)).toBe(""));
    ["", null, "9-3"].forEach((v) => expect(fromDayMonth(v, "2026")).toBe(""));
  });

  it("validates real calendar days", () => {
    ["01-01", "31-12", "30-06", "29-02"].forEach((v) => expect(isValidDayMonth(v)).toBe(true));
    ["00-01", "32-01", "01-13", "31-04", "30-02", "1-1", "", "abc"].forEach((v) =>
      expect(isValidDayMonth(v)).toBe(false)
    );
  });

  it("allows 29 Feb — it's a real birthday that recurs", () => {
    expect(isValidDayMonth("29-02")).toBe(true);
  });
});
