import { describe, it, expect } from "vitest";
import {
  rateForLine, commissionForLine, serviceLines, salesInRange,
  staffPayout, allPayouts, revenuePerStaff, servicesPerDay,
  peakHours, noShowRates, monthRange,
} from "./commissions.js";

const PRIYA = { id: "st1", name: "Priya", commissionPctDefault: 10 };
const RAHUL = { id: "st2", name: "Rahul", commissionPctDefault: 8 };

const svcLine = (over) => ({ lineType: "service", name: "Haircut", qty: 1, price: 400, amount: 400, staffId: "st1", commissionPct: 12, ...over });
const prodLine = (over) => ({ lineType: "product", name: "Shampoo", qty: 1, price: 780, amount: 780, ...over });

describe("rateForLine", () => {
  it("prefers the rate snapshotted on the line", () => {
    // The whole point: July's payout must not reprice when August's rates change.
    expect(rateForLine(svcLine({ commissionPct: 12 }), PRIYA)).toBe(12);
  });

  it("falls back to the staff default only when the line has no rate", () => {
    expect(rateForLine(svcLine({ commissionPct: undefined }), PRIYA)).toBe(10);
    expect(rateForLine(svcLine({ commissionPct: null }), PRIYA)).toBe(10);
  });

  it("treats an explicit 0 on the line as REAL, not as 'unset'", () => {
    // `line.commissionPct || default` would pay 10% on every service the owner set to zero.
    expect(rateForLine(svcLine({ commissionPct: 0 }), PRIYA)).toBe(0);
  });

  it("returns 0 rather than NaN when nothing is set anywhere", () => {
    expect(rateForLine({}, {})).toBe(0);
    expect(rateForLine(null, null)).toBe(0);
    expect(rateForLine(svcLine({ commissionPct: "abc" }), {})).toBe(0);
  });
});

describe("commissionForLine", () => {
  it("pays the line rate on the line amount", () => {
    expect(commissionForLine(svcLine({ amount: 400, commissionPct: 12 }), PRIYA)).toBe(48);
  });

  it("pays nothing on a product line", () => {
    // Retail is stock, not labour.
    expect(commissionForLine(prodLine(), PRIYA)).toBe(0);
  });

  it("pays nothing on a legacy line with no lineType (those were all products)", () => {
    expect(commissionForLine({ name: "X", amount: 500 }, PRIYA)).toBe(0);
  });

  it("pays nothing at a 0% rate", () => {
    expect(commissionForLine(svcLine({ commissionPct: 0 }), PRIYA)).toBe(0);
  });

  it("pays nothing on a ₹0 package-redemption line", () => {
    // The money for that session was taken (and its commission paid) when the package was sold.
    expect(commissionForLine(svcLine({ amount: 0, fromPackageId: "cp1" }), PRIYA)).toBe(0);
  });

  it("uses the LINE amount, ignoring any whole-bill discount", () => {
    // A discount is the owner's decision. Netting it off commission would make every discount
    // come half out of the stylist's pocket, silently.
    const line = svcLine({ amount: 400, commissionPct: 12 });
    expect(commissionForLine(line, PRIYA)).toBe(48); // not reduced by a bill-level discount
  });

  it("scales with quantity via the line amount", () => {
    expect(commissionForLine(svcLine({ qty: 3, amount: 1200, commissionPct: 10 }), PRIYA)).toBe(120);
  });

  it("rounds to paise", () => {
    expect(commissionForLine(svcLine({ amount: 333, commissionPct: 12 }), PRIYA)).toBe(39.96);
  });

  it("never pays on a negative amount", () => {
    expect(commissionForLine(svcLine({ amount: -400 }), PRIYA)).toBe(0);
  });

  it("copes with junk", () => {
    expect(commissionForLine(svcLine({ amount: "abc" }), PRIYA)).toBe(0);
    expect(commissionForLine(null, PRIYA)).toBe(0);
  });
});

// ── payouts ──────────────────────────────────────────────────────────────────────────────
const SALES = [
  { id: "b1", date: "2026-07-01", customer: "Asha", total: 1180, lines: [svcLine({ amount: 400, commissionPct: 12 }), prodLine()] },
  { id: "b2", date: "2026-07-05", customer: "Bhavna", total: 3000, lines: [svcLine({ name: "Colour", amount: 3000, commissionPct: 15 })] },
  { id: "b3", date: "2026-07-10", customer: "Chetan", total: 250, lines: [svcLine({ name: "Men Cut", amount: 250, commissionPct: 10, staffId: "st2" })] },
  { id: "b4", date: "2026-06-20", customer: "Old", total: 400, lines: [svcLine({ amount: 400, commissionPct: 12 })] },
];

describe("salesInRange", () => {
  it("is inclusive at both ends", () => {
    expect(salesInRange(SALES, "2026-07-01", "2026-07-10").map((s) => s.id)).toEqual(["b1", "b2", "b3"]);
  });
  it("treats missing bounds as open", () => {
    expect(salesInRange(SALES, "", "").length).toBe(4);
  });
});

describe("serviceLines", () => {
  it("flattens only service lines, keeping the bill date", () => {
    const ls = serviceLines(SALES);
    expect(ls).toHaveLength(4);
    expect(ls.every((x) => x.line.lineType === "service")).toBe(true);
    expect(ls[0].date).toBe("2026-07-01");
  });
  it("copes with missing lines/sales", () => {
    expect(serviceLines(null)).toEqual([]);
    expect(serviceLines([{ id: "x", date: "2026-01-01" }])).toEqual([]);
  });
});

describe("staffPayout", () => {
  const p = staffPayout(PRIYA, SALES, "2026-07-01", "2026-07-31");

  it("counts only that stylist's services, in that range", () => {
    expect(p.services).toBe(2); // b1 + b2; b3 is Rahul's, b4 is June
    expect(p.revenue).toBe(3400);
  });

  it("sums the commission at each line's own rate", () => {
    // 400 @ 12% = 48; 3000 @ 15% = 450.
    expect(p.commission).toBe(498);
  });

  it("excludes product lines from the stylist's revenue", () => {
    // b1 has a ₹780 shampoo on it; Priya's revenue is the ₹400 haircut only.
    expect(p.revenue).toBe(3400);
  });

  it("lists the rows in date order, with the detail needed to check a payslip", () => {
    expect(p.rows.map((r) => r.date)).toEqual(["2026-07-01", "2026-07-05"]);
    expect(p.rows[0]).toMatchObject({ service: "Haircut", amount: 400, rate: 12, commission: 48, customer: "Asha" });
  });

  it("returns zeros for someone with no work in the range, rather than nothing", () => {
    const empty = staffPayout({ id: "st9", name: "New Hire", commissionPctDefault: 10 }, SALES, "2026-07-01", "2026-07-31");
    expect(empty).toMatchObject({ name: "New Hire", services: 0, revenue: 0, commission: 0, rows: [] });
  });

  it("flags a package-redemption row, so a ₹0 line isn't read as a mistake", () => {
    const sales = [{ id: "p", date: "2026-07-02", lines: [svcLine({ amount: 0, fromPackageId: "cp1" })] }];
    const out = staffPayout(PRIYA, sales, "2026-07-01", "2026-07-31");
    expect(out.rows[0].fromPackage).toBe(true);
    expect(out.commission).toBe(0);
  });

  it("does not reprice history when the staff default changes", () => {
    // The core guarantee. Priya's default is 10; the lines say 12 and 15. Changing her default
    // to 50 must not move a rupee of July's payout.
    const richer = { ...PRIYA, commissionPctDefault: 50 };
    expect(staffPayout(richer, SALES, "2026-07-01", "2026-07-31").commission).toBe(498);
  });

  it("uses the default only for a line that never carried a rate", () => {
    const legacy = [{ id: "l", date: "2026-07-02", lines: [svcLine({ amount: 1000, commissionPct: undefined })] }];
    expect(staffPayout(PRIYA, legacy, "2026-07-01", "2026-07-31").commission).toBe(100); // 10%
  });
});

describe("allPayouts", () => {
  it("ranks by commission earned", () => {
    const rows = allPayouts([RAHUL, PRIYA], SALES, "2026-07-01", "2026-07-31");
    expect(rows.map((r) => r.name)).toEqual(["Priya", "Rahul"]);
    expect(rows[1].commission).toBe(25); // 250 @ 10%
  });

  it("includes staff with nothing — an empty row is information", () => {
    const rows = allPayouts([PRIYA, { id: "st9", name: "Idle", commissionPctDefault: 10 }], SALES, "2026-07-01", "2026-07-31");
    expect(rows.map((r) => r.name)).toEqual(["Priya", "Idle"]);
  });

  it("copes with no staff", () => expect(allPayouts(null, SALES, "", "")).toEqual([]));
});

describe("revenuePerStaff", () => {
  it("gives the chart one row per stylist", () => {
    expect(revenuePerStaff([PRIYA, RAHUL], SALES, "2026-07-01", "2026-07-31")).toEqual([
      { name: "Priya", revenue: 3400, commission: 498, services: 2 },
      { name: "Rahul", revenue: 250, commission: 25, services: 1 },
    ]);
  });
});

describe("servicesPerDay", () => {
  it("counts services per day for one stylist", () => {
    expect(servicesPerDay(SALES, "st1", "2026-07-01", "2026-07-31")).toEqual([
      { date: "2026-07-01", count: 1 },
      { date: "2026-07-05", count: 1 },
    ]);
  });

  it("counts everyone when no stylist is given", () => {
    expect(servicesPerDay(SALES, "", "2026-07-01", "2026-07-31")).toHaveLength(3);
  });

  it("counts quantity, not just lines", () => {
    const sales = [{ id: "x", date: "2026-07-01", lines: [svcLine({ qty: 3, amount: 150 })] }];
    expect(servicesPerDay(sales, "st1", "", "")[0].count).toBe(3);
  });

  it("skips days with nothing rather than emitting zeros", () => {
    expect(servicesPerDay(SALES, "st1", "2026-07-02", "2026-07-04")).toEqual([]);
  });
});

// ── appointments-derived ─────────────────────────────────────────────────────────────────
const appt = (over) => ({ id: "a", date: "2026-07-20", staffId: "st1", startMin: 600, durationMin: 60, status: "completed", ...over });

describe("peakHours", () => {
  it("buckets by weekday and hour, Monday first", () => {
    // 2026-07-20 is a Monday.
    const { grid, max } = peakHours([appt({ startMin: 600 })], "", "");
    expect(grid[0][10]).toBe(1);
    expect(max).toBe(1);
  });

  it("puts Sunday last, as a salon's week reads", () => {
    // 2026-07-19 is a Sunday.
    const { grid } = peakHours([appt({ date: "2026-07-19", startMin: 660 })], "", "");
    expect(grid[6][11]).toBe(1);
  });

  it("counts demand met — booked and completed, never a no-show", () => {
    // A no-show is not demand: staffing for chairs nobody sat in is the opposite of useful.
    const { max } = peakHours([appt({ status: "no-show" }), appt({ status: "cancelled" }), appt({ status: "blocked" })], "", "");
    expect(max).toBe(0);
  });

  it("uses the APPOINTMENT time, not a bill's", () => {
    // The bill is stamped when the customer pays — i.e. when they leave. Staffing needs when
    // they were in the chair, which only the diary knows.
    const { grid } = peakHours([appt({ startMin: 9 * 60 })], "", "");
    expect(grid[0][9]).toBe(1);
    expect(grid[0][10]).toBe(0);
  });

  it("honours the date range", () => {
    expect(peakHours([appt()], "2026-08-01", "2026-08-31").max).toBe(0);
  });

  it("returns a full empty grid rather than nothing", () => {
    const { grid, max } = peakHours([], "", "");
    expect(grid).toHaveLength(7);
    expect(grid[0]).toHaveLength(24);
    expect(max).toBe(0);
  });

  it("ignores a junk date rather than throwing", () => {
    expect(() => peakHours([appt({ date: "nonsense" })], "", "")).not.toThrow();
  });
});

describe("noShowRates", () => {
  it("is no-shows over RESOLVED appointments", () => {
    const appts = [
      appt({ id: "1", status: "completed" }), appt({ id: "2", status: "completed" }),
      appt({ id: "3", status: "no-show" }), appt({ id: "4", status: "completed" }),
    ];
    expect(noShowRates([PRIYA], appts, "", "")[0]).toMatchObject({ name: "Priya", completed: 3, noShow: 1, resolved: 4, rate: 25 });
  });

  it("EXCLUDES cancellations — ringing ahead is good manners, not a no-show", () => {
    // Counting them would blame the stylist for the customer being considerate.
    const appts = [appt({ id: "1", status: "completed" }), appt({ id: "2", status: "cancelled" })];
    expect(noShowRates([PRIYA], appts, "", "")[0]).toMatchObject({ resolved: 1, rate: 0 });
  });

  it("excludes still-booked appointments — they haven't resolved yet", () => {
    const appts = [appt({ id: "1", status: "completed" }), appt({ id: "2", status: "booked" })];
    expect(noShowRates([PRIYA], appts, "", "")[0].resolved).toBe(1);
  });

  it("is 0, not NaN, for a stylist with nothing resolved", () => {
    expect(noShowRates([PRIYA], [], "", "")[0]).toMatchObject({ resolved: 0, rate: 0 });
  });

  it("ranks worst first", () => {
    const appts = [
      appt({ id: "1", staffId: "st1", status: "no-show" }),
      appt({ id: "2", staffId: "st2", status: "completed" }),
      appt({ id: "3", staffId: "st2", status: "completed" }),
    ];
    expect(noShowRates([PRIYA, RAHUL], appts, "", "").map((r) => r.name)).toEqual(["Priya", "Rahul"]);
  });

  it("ignores appointments for staff not in the list", () => {
    expect(noShowRates([PRIYA], [appt({ staffId: "ghost", status: "no-show" })], "", "")[0].resolved).toBe(0);
  });
});

describe("monthRange", () => {
  it("spans a whole month", () => {
    expect(monthRange("2026-07")).toEqual({ from: "2026-07-01", to: "2026-07-31" });
    expect(monthRange("2026-06")).toEqual({ from: "2026-06-01", to: "2026-06-30" });
  });

  it("gets February right, leap and not", () => {
    expect(monthRange("2026-02").to).toBe("2026-02-28");
    expect(monthRange("2028-02").to).toBe("2028-02-29");
  });

  it("returns blanks for junk", () => {
    expect(monthRange("nonsense")).toEqual({ from: "", to: "" });
    expect(monthRange("")).toEqual({ from: "", to: "" });
  });
});
