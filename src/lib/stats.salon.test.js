// Tests for the salon analytics appended to stats.js in Phase 6.
//
// Kept in their own file so the ported grocery suite (stats.test.js) stays exactly as it
// arrived — if it ever fails, that's a real regression in validated code, not a merge artefact.
import { describe, it, expect } from "vitest";
import {
  inRange, serviceVsProductRevenue, topServices, repeatRatio, avgBillTrend,
  ltvDistribution, newVsReturning, noShowPct, dormantTrend, rebookConversion,
} from "./stats.js";

const svc = (name, amount, qty = 1) => ({ lineType: "service", name, qty, amount, price: amount });
const prod = (name, amount, qty = 1) => ({ lineType: "product", name, qty, amount, price: amount });
// A grocery-era line: no lineType at all. Must be treated as a product.
const legacy = (name, amount) => ({ name, qty: 1, amount, price: amount });

const SALES = [
  { id: "b1", date: "2026-05-02", customerPhone: "9000000001", total: 1180, lines: [svc("Haircut", 400), prod("Shampoo", 780)] },
  { id: "b2", date: "2026-05-20", customerPhone: "9000000001", total: 3000, lines: [svc("Colour", 3000)] },
  { id: "b3", date: "2026-06-03", customerPhone: "9000000002", total: 400, lines: [svc("Haircut", 400)] },
  { id: "b4", date: "2026-06-10", total: 250, lines: [svc("Men Cut", 250)] }, // walk-in — no phone
  { id: "b5", date: "2026-07-01", customerPhone: "9000000003", total: 900, lines: [legacy("Old Product", 900)] },
];

describe("inRange", () => {
  it("is inclusive at both ends", () => {
    expect(inRange(SALES, "2026-05-20", "2026-06-10").map((s) => s.id)).toEqual(["b2", "b3", "b4"]);
  });
  it("treats blank bounds as open", () => expect(inRange(SALES, "", "")).toHaveLength(5));
  it("copes with no sales", () => expect(inRange(null, "", "")).toEqual([]));
});

describe("serviceVsProductRevenue — the split that says which half pays the rent", () => {
  it("separates labour from stock", () => {
    const r = serviceVsProductRevenue(SALES, "", "");
    expect(r.service).toBe(4050); // 400 + 3000 + 400 + 250
    expect(r.product).toBe(1680); // 780 + 900 (legacy)
    expect(r.total).toBe(5730);
    expect(r.servicePct).toBe(70.68);
  });

  it("counts a legacy line with no lineType as a PRODUCT", () => {
    // Every grocery-era bill is products off a shelf. Counting them as services would
    // retroactively invent a service business that never existed.
    const r = serviceVsProductRevenue([{ id: "x", date: "2026-01-01", lines: [legacy("Thing", 100)] }], "", "");
    expect(r).toMatchObject({ service: 0, product: 100, servicePct: 0 });
  });

  it("honours the date range", () => {
    expect(serviceVsProductRevenue(SALES, "2026-06-01", "2026-06-30").service).toBe(650);
  });

  it("returns zeros — not NaN — with no data", () => {
    expect(serviceVsProductRevenue([], "", "")).toEqual({ service: 0, product: 0, total: 0, servicePct: 0 });
  });
});

describe("topServices", () => {
  it("ranks by revenue and ignores products", () => {
    const t = topServices(SALES);
    expect(t.map((x) => x.name)).toEqual(["Colour", "Haircut", "Men Cut"]);
    expect(t[1]).toMatchObject({ name: "Haircut", revenue: 800, count: 2 });
    expect(t.some((x) => x.name === "Shampoo")).toBe(false);
  });

  it("can rank by how often they're done instead", () => {
    expect(topServices(SALES, { metric: "count" })[0].name).toBe("Haircut");
  });

  it("respects the limit and the range", () => {
    expect(topServices(SALES, { limit: 1 })).toHaveLength(1);
    expect(topServices(SALES, { from: "2026-06-01", to: "2026-06-30" }).map((x) => x.name).sort())
      .toEqual(["Haircut", "Men Cut"]);
  });

  it("counts quantity, not lines", () => {
    const sales = [{ id: "x", date: "2026-01-01", lines: [svc("Threading", 150, 3)] }];
    expect(topServices(sales)[0].count).toBe(3);
  });
});

describe("repeatRatio — walk-ins must not be one giant returning customer", () => {
  it("counts only identified customers", () => {
    const r = repeatRatio(SALES, "", "");
    // 3 identified phones; only ...001 came twice. The walk-in is excluded entirely.
    expect(r).toEqual({ identified: 3, repeat: 1, once: 2, pct: 33.33 });
  });

  it("ignores walk-ins rather than lumping them into one customer", () => {
    // The bug this guards: keying on a blank phone would make every walk-in the SAME person,
    // producing a spectacular and entirely fictional repeat rate.
    const walkIns = [
      { id: "1", date: "2026-01-01", total: 100, lines: [] },
      { id: "2", date: "2026-01-02", total: 100, lines: [] },
      { id: "3", date: "2026-01-03", total: 100, lines: [] },
    ];
    expect(repeatRatio(walkIns, "", "")).toEqual({ identified: 0, repeat: 0, once: 0, pct: 0 });
  });

  it("is 0, not NaN, with nothing to measure", () => {
    expect(repeatRatio([], "", "").pct).toBe(0);
  });
});

describe("avgBillTrend", () => {
  it("averages per month, carrying the bill count", () => {
    const t = avgBillTrend(SALES, "", "");
    expect(t.map((r) => r.ym)).toEqual(["2026-05", "2026-06", "2026-07"]);
    expect(t[0]).toMatchObject({ bills: 2, avg: 2090 }); // (1180+3000)/2
    expect(t[1]).toMatchObject({ bills: 2, avg: 325 }); // (400+250)/2 — walk-ins DO count here
  });

  it("labels months for the axis", () => {
    expect(avgBillTrend(SALES, "", "")[0].label).toMatch(/May/);
  });

  it("is empty with no bills", () => expect(avgBillTrend([], "", "")).toEqual([]));
});

describe("ltvDistribution", () => {
  it("buckets identified customers by lifetime spend", () => {
    const bands = ltvDistribution(SALES);
    const byLabel = Object.fromEntries(bands.map((b) => [b.label, b.count]));
    // Lifetimes: ...001 = 1180 + 3000 = 4180, ...002 = 400, ...003 = 900.
    expect(byLabel["< ₹1k"]).toBe(2); // 400 and 900
    expect(byLabel["₹1k–₹5k"]).toBe(1); // 4180
    // Everything above is empty, and the walk-in bill isn't anywhere.
    expect(bands.reduce((a, b) => a + b.count, 0)).toBe(3);
  });

  it("sums a customer's whole history, not their biggest bill", () => {
    const bands = ltvDistribution([
      { id: "1", date: "2026-01-01", customerPhone: "9000000001", total: 600 },
      { id: "2", date: "2026-02-01", customerPhone: "9000000001", total: 600 },
    ]);
    // Two 600 bills = one 1200 customer, which lands in the 1k–5k band, not below 1k.
    expect(bands.find((b) => b.min === 1000).count).toBe(1);
    expect(bands[0].count).toBe(0);
  });

  it("excludes walk-ins — an anonymous bill has no lifetime", () => {
    expect(ltvDistribution([{ id: "w", date: "2026-01-01", total: 5000 }]).every((b) => b.count === 0)).toBe(true);
  });

  it("always returns every band, so the chart keeps its shape", () => {
    expect(ltvDistribution([])).toHaveLength(6); // 5 thresholds + the "and above" band
  });

  it("puts a huge spender in the top band", () => {
    const rich = [{ id: "r", date: "2026-01-01", customerPhone: "9000000009", total: 900000 }];
    expect(ltvDistribution(rich).at(-1).count).toBe(1);
  });
});

describe("newVsReturning", () => {
  it("counts a customer as new only in the month of their FIRST EVER bill", () => {
    const t = newVsReturning(SALES, "", "");
    const may = t.find((r) => r.ym === "2026-05");
    expect(may).toMatchObject({ new: 1, returning: 0 }); // ...001's first bill
  });

  it("counts a returning visit in a later month as returning, not new", () => {
    const sales = [
      { id: "1", date: "2026-05-02", customerPhone: "9000000001", total: 100 },
      { id: "2", date: "2026-06-02", customerPhone: "9000000001", total: 100 },
    ];
    const t = newVsReturning(sales, "", "");
    expect(t.find((r) => r.ym === "2026-05")).toMatchObject({ new: 1, returning: 0 });
    expect(t.find((r) => r.ym === "2026-06")).toMatchObject({ new: 0, returning: 1 });
  });

  it("computes 'first ever' against the WHOLE history, not the visible range", () => {
    // The bug this guards: scoping firstSeen to the range would make every customer look new
    // in the first month of whatever window you happened to pick.
    const sales = [
      { id: "old", date: "2026-01-02", customerPhone: "9000000001", total: 100 },
      { id: "new", date: "2026-06-02", customerPhone: "9000000001", total: 100 },
    ];
    expect(newVsReturning(sales, "2026-06-01", "2026-06-30")).toEqual([
      { ym: "2026-06", label: expect.any(String), new: 0, returning: 1 },
    ]);
  });

  it("counts a customer once per month however many times they came", () => {
    const sales = [
      { id: "1", date: "2026-06-02", customerPhone: "9000000001", total: 100 },
      { id: "2", date: "2026-06-20", customerPhone: "9000000001", total: 100 },
    ];
    expect(newVsReturning(sales, "", "")[0]).toMatchObject({ new: 1, returning: 0 });
  });

  it("ignores walk-ins", () => {
    expect(newVsReturning([{ id: "w", date: "2026-06-01", total: 100 }], "", "")).toEqual([]);
  });
});

describe("noShowPct", () => {
  const a = (over) => ({ id: "x", date: "2026-07-01", status: "completed", ...over });

  it("is no-shows over resolved appointments", () => {
    const appts = [a(), a({ id: "2" }), a({ id: "3", status: "no-show" }), a({ id: "4" })];
    expect(noShowPct(appts, "", "")).toEqual({ completed: 3, noShow: 1, resolved: 4, pct: 25 });
  });

  it("excludes cancellations and still-booked slots", () => {
    const appts = [a(), a({ id: "2", status: "cancelled" }), a({ id: "3", status: "booked" }), a({ id: "4", status: "blocked" })];
    expect(noShowPct(appts, "", "")).toMatchObject({ resolved: 1, pct: 0 });
  });

  it("is 0, not NaN, with nothing resolved", () => {
    expect(noShowPct([], "", "").pct).toBe(0);
  });

  it("honours the date range", () => {
    expect(noShowPct([a({ status: "no-show" })], "2026-08-01", "2026-08-31").resolved).toBe(0);
  });
});

describe("dormantTrend", () => {
  it("counts who was dormant at each month END, using only what was known then", () => {
    // ...001 last came 2026-01-05; by 31 Mar they're 85 days gone → dormant.
    const sales = [{ id: "1", date: "2026-01-05", customerPhone: "9000000001", total: 100 }];
    const t = dormantTrend(sales, "2026-01", "2026-03", 60);
    expect(t.map((r) => r.dormant)).toEqual([0, 0, 1]);
  });

  it("does not peek at the future", () => {
    // In January, a customer who returns in March has NOT gone quiet — the January point must
    // reflect what was true in January.
    const sales = [
      { id: "1", date: "2026-01-05", customerPhone: "9000000001", total: 100 },
      { id: "2", date: "2026-03-05", customerPhone: "9000000001", total: 100 },
    ];
    const t = dormantTrend(sales, "2026-01", "2026-03", 60);
    expect(t.map((r) => r.dormant)).toEqual([0, 0, 0]);
  });

  it("resets someone who comes back", () => {
    const sales = [
      { id: "1", date: "2026-01-05", customerPhone: "9000000001", total: 100 },
      { id: "2", date: "2026-04-05", customerPhone: "9000000001", total: 100 },
    ];
    const t = dormantTrend(sales, "2026-03", "2026-04", 60);
    expect(t.map((r) => r.dormant)).toEqual([1, 0]);
  });

  it("tracks how many customers are known at each point", () => {
    const sales = [
      { id: "1", date: "2026-01-05", customerPhone: "9000000001", total: 100 },
      { id: "2", date: "2026-02-05", customerPhone: "9000000002", total: 100 },
    ];
    expect(dormantTrend(sales, "2026-01", "2026-02", 60).map((r) => r.known)).toEqual([1, 2]);
  });

  it("is empty when nobody is identified", () => {
    expect(dormantTrend([{ id: "w", date: "2026-01-01", total: 100 }], "2026-01", "2026-03")).toEqual([]);
    expect(dormantTrend([], "2026-01", "2026-03")).toEqual([]);
  });
});

describe("rebookConversion — did the reminders actually work?", () => {
  const TODAY = "2026-07-17";

  it("counts a visit inside the window as a conversion", () => {
    const customers = [{ phone: "9000000001", remindersSentAt: { rebook: "2026-06-01" } }];
    const sales = [{ id: "1", date: "2026-06-05", customerPhone: "9000000001", total: 500 }];
    expect(rebookConversion(customers, sales, TODAY, 14)).toMatchObject({ sent: 1, converted: 1, pct: 100 });
  });

  it("does not count a visit outside the window", () => {
    const customers = [{ phone: "9000000001", remindersSentAt: { rebook: "2026-06-01" } }];
    const sales = [{ id: "1", date: "2026-06-30", customerPhone: "9000000001", total: 500 }];
    expect(rebookConversion(customers, sales, TODAY, 14)).toMatchObject({ sent: 1, converted: 0, pct: 0 });
  });

  it("does not count a visit from BEFORE the reminder", () => {
    // Otherwise every reminder sent to a recent customer would score as a win.
    const customers = [{ phone: "9000000001", remindersSentAt: { rebook: "2026-06-01" } }];
    const sales = [{ id: "1", date: "2026-05-30", customerPhone: "9000000001", total: 500 }];
    expect(rebookConversion(customers, sales, TODAY, 14)).toMatchObject({ sent: 1, converted: 0 });
  });

  it("holds back reminders whose window hasn't finished", () => {
    // Counting a message sent yesterday as a failure would drag the rate down for no reason
    // but impatience.
    const customers = [{ phone: "9000000001", remindersSentAt: { rebook: "2026-07-16" } }];
    expect(rebookConversion(customers, [], TODAY, 14)).toMatchObject({ sent: 0, pending: 1, pct: 0 });
  });

  it("counts each kind of reminder separately", () => {
    const customers = [{ phone: "9000000001", remindersSentAt: { rebook: "2026-06-01", birthday: "2026-06-01" } }];
    const sales = [{ id: "1", date: "2026-06-05", customerPhone: "9000000001", total: 500 }];
    expect(rebookConversion(customers, sales, TODAY, 14)).toMatchObject({ sent: 2, converted: 2 });
  });

  it("ignores a corrupt future send date", () => {
    const customers = [{ phone: "9000000001", remindersSentAt: { rebook: "2030-01-01" } }];
    expect(rebookConversion(customers, [], TODAY, 14)).toMatchObject({ sent: 0, pending: 0 });
  });

  it("is 0, not NaN, when nothing has been sent", () => {
    expect(rebookConversion([{ phone: "9000000001" }], [], TODAY)).toEqual({ sent: 0, converted: 0, pending: 0, pct: 0 });
    expect(rebookConversion(null, null, TODAY).pct).toBe(0);
  });
});
