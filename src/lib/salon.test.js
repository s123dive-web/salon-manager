import { describe, it, expect } from "vitest";
import {
  LINE_TYPES, lineTypeOf, isServiceLine, isProductLine,
  blankService, validateService, makeService, activeServices, serviceById,
  STAFF_COLORS, nextStaffColor, validateStaff, makeStaff, activeStaff,
  staffById, staffName, commissionRateFor, serviceToCartLine,
} from "./salon.js";

describe("line types", () => {
  it("knows a service line from a product line", () => {
    expect(LINE_TYPES).toEqual(["service", "product"]);
    expect(lineTypeOf({ lineType: "service" })).toBe("service");
    expect(lineTypeOf({ lineType: "product" })).toBe("product");
    expect(isServiceLine({ lineType: "service" })).toBe(true);
    expect(isProductLine({ lineType: "product" })).toBe(true);
  });

  it("treats a legacy line with no lineType as a product", () => {
    // Every grocery-era bill is exactly this: products off a shelf. Defaulting the other way
    // would retroactively turn all of them into commission-earning services.
    expect(lineTypeOf({ name: "Shampoo", qty: 1 })).toBe("product");
    expect(isProductLine({ name: "Shampoo" })).toBe(true);
    expect(isServiceLine({ name: "Shampoo" })).toBe(false);
  });

  it("treats junk as a product rather than throwing", () => {
    [null, undefined, {}, { lineType: "" }, { lineType: "nonsense" }].forEach((l) =>
      expect(lineTypeOf(l)).toBe("product")
    );
  });
});

// ── services ─────────────────────────────────────────────────────────────────────────────
const okService = { name: "Haircut", category: "Hair", durationMin: 30, price: 400, commissionPct: 10, rebookCycleDays: 45 };

describe("validateService", () => {
  it("accepts a sane service", () => {
    expect(validateService(okService)).toBe(null);
  });

  it("requires a name", () => {
    expect(validateService({ ...okService, name: "  " })).toMatch(/name/i);
  });

  it("rejects a negative or non-numeric price", () => {
    expect(validateService({ ...okService, price: -1 })).toMatch(/price/i);
    expect(validateService({ ...okService, price: "abc" })).toMatch(/price/i);
  });

  it("allows a free service (price 0)", () => {
    // A complimentary trim or a package redemption line is a real thing.
    expect(validateService({ ...okService, price: 0 })).toBe(null);
  });

  it("insists duration lands on the 5-minute grid", () => {
    // The day view is a 15-minute lattice; an off-grid service renders wrong forever after.
    expect(validateService({ ...okService, durationMin: 37 })).toMatch(/multiple of 5/i);
    expect(validateService({ ...okService, durationMin: 30 })).toBe(null);
    expect(validateService({ ...okService, durationMin: 45 })).toBe(null);
  });

  it("rejects a zero/negative/absurd duration", () => {
    expect(validateService({ ...okService, durationMin: 0 })).toMatch(/duration/i);
    expect(validateService({ ...okService, durationMin: -30 })).toMatch(/duration/i);
    expect(validateService({ ...okService, durationMin: 600 })).toMatch(/8 hours/i);
  });

  it("keeps commission a real percentage", () => {
    expect(validateService({ ...okService, commissionPct: -5 })).toMatch(/commission/i);
    expect(validateService({ ...okService, commissionPct: 101 })).toMatch(/commission/i);
    expect(validateService({ ...okService, commissionPct: 0 })).toBe(null);
    expect(validateService({ ...okService, commissionPct: 100 })).toBe(null);
  });

  it("keeps the rebook cycle sane, and allows 0 for one-off work", () => {
    expect(validateService({ ...okService, rebookCycleDays: 0 })).toBe(null);
    expect(validateService({ ...okService, rebookCycleDays: -1 })).toMatch(/negative/i);
    expect(validateService({ ...okService, rebookCycleDays: 900 })).toMatch(/two years/i);
  });
});

describe("makeService", () => {
  it("coerces form strings to numbers, so no string reaches the database", () => {
    const s = makeService({ ...okService, price: "400", durationMin: "30", commissionPct: "10", rebookCycleDays: "45" }, { id: "s1" });
    expect(s.price).toBe(400);
    expect(s.durationMin).toBe(30);
    expect(s.commissionPct).toBe(10);
    expect(s.rebookCycleDays).toBe(45);
    expect(s.id).toBe("s1");
  });

  it("trims the name and rounds price to paise", () => {
    const s = makeService({ ...okService, name: "  Haircut  ", price: 400.005 }, { id: "s1" });
    expect(s.name).toBe("Haircut");
    expect(s.price).toBe(400.01);
  });

  it("defaults to active", () => {
    expect(makeService(okService, { id: "s1" }).active).toBe(true);
    expect(makeService({ ...okService, active: false }, { id: "s1" }).active).toBe(false);
  });
});

describe("service lookups", () => {
  const list = [
    { id: "a", name: "Cut", active: true },
    { id: "b", name: "Colour", active: false },
    { id: "c", name: "Spa" },
  ];

  it("filters to active, treating a missing flag as active", () => {
    expect(activeServices(list).map((s) => s.id)).toEqual(["a", "c"]);
  });

  it("finds by id, and returns null when absent", () => {
    expect(serviceById(list, "b").name).toBe("Colour");
    expect(serviceById(list, "zz")).toBe(null);
    expect(serviceById(null, "a")).toBe(null);
  });
});

describe("blankService", () => {
  it("is valid out of the box apart from the name", () => {
    const b = blankService("2026-07-17");
    expect(validateService({ ...b, name: "X" })).toBe(null);
    expect(b.createdAt).toBe("2026-07-17");
  });
});

// ── staff ────────────────────────────────────────────────────────────────────────────────
describe("nextStaffColor", () => {
  it("hands out an unused colour, so two stylists don't share a grid colour", () => {
    expect(nextStaffColor([])).toBe(STAFF_COLORS[0]);
    expect(nextStaffColor([{ color: STAFF_COLORS[0] }])).toBe(STAFF_COLORS[1]);
    expect(nextStaffColor([{ color: STAFF_COLORS[0] }, { color: STAFF_COLORS[1] }])).toBe(STAFF_COLORS[2]);
  });

  it("ignores case when checking what's taken", () => {
    expect(nextStaffColor([{ color: STAFF_COLORS[0].toLowerCase() }])).toBe(STAFF_COLORS[1]);
  });

  it("wraps rather than returning undefined once every colour is used", () => {
    expect(nextStaffColor(STAFF_COLORS.map((c) => ({ color: c })))).toBe(STAFF_COLORS[0]);
  });

  it("copes with a missing list or colourless records", () => {
    expect(nextStaffColor(null)).toBe(STAFF_COLORS[0]);
    expect(nextStaffColor([{}, { color: "" }])).toBe(STAFF_COLORS[0]);
  });
});

describe("validateStaff", () => {
  const ok = { name: "Priya", color: "#7C3AED", commissionPctDefault: 10 };

  it("accepts a sane record", () => expect(validateStaff(ok)).toBe(null));

  it("requires a name", () => expect(validateStaff({ ...ok, name: " " })).toMatch(/name/i));

  it("keeps default commission a real percentage", () => {
    expect(validateStaff({ ...ok, commissionPctDefault: -1 })).toMatch(/commission/i);
    expect(validateStaff({ ...ok, commissionPctDefault: 101 })).toMatch(/commission/i);
    expect(validateStaff({ ...ok, commissionPctDefault: 0 })).toBe(null);
  });

  it("requires a real hex colour for the grid", () => {
    ["", "red", "#ABC", "7C3AED"].forEach((c) => expect(validateStaff({ ...ok, color: c })).toMatch(/colour/i));
  });
});

describe("makeStaff", () => {
  it("trims text and coerces the commission", () => {
    const s = makeStaff({ name: "  Priya  ", phone: " 98765 43210 ", role: " Stylist ", color: "#7C3AED", commissionPctDefault: "12" }, { id: "st1" });
    expect(s).toMatchObject({ id: "st1", name: "Priya", phone: "98765 43210", role: "Stylist", commissionPctDefault: 12, active: true });
  });
});

describe("staff lookups", () => {
  const list = [{ id: "s1", name: "Priya", active: true }, { id: "s2", name: "Rahul", active: false }];

  it("filters to active", () => expect(activeStaff(list).map((s) => s.id)).toEqual(["s1"]));

  it("finds by id", () => {
    expect(staffById(list, "s2").name).toBe("Rahul");
    expect(staffById(list, "nope")).toBe(null);
  });

  it("never renders a blank name on a receipt", () => {
    expect(staffName(list, "s1")).toBe("Priya");
    expect(staffName(list, "gone")).toBe("—");
    expect(staffName(null, "s1")).toBe("—");
  });
});

describe("commissionRateFor — the money rule", () => {
  const staffMember = { commissionPctDefault: 10 };

  it("prefers the service's own rate", () => {
    expect(commissionRateFor({ commissionPct: 15 }, staffMember)).toBe(15);
  });

  it("falls back to the staff default when the service doesn't set one", () => {
    expect(commissionRateFor({}, staffMember)).toBe(10);
    expect(commissionRateFor({ commissionPct: null }, staffMember)).toBe(10);
    expect(commissionRateFor({ commissionPct: undefined }, staffMember)).toBe(10);
  });

  it("treats an explicit 0% as REAL, not as 'unset'", () => {
    // The bug this guards: `service.commissionPct || staff.default` would silently pay 10% on
    // every service the owner deliberately set to 0. That's money out the door, every day.
    expect(commissionRateFor({ commissionPct: 0 }, staffMember)).toBe(0);
  });

  it("returns 0 when nothing is set anywhere, rather than NaN", () => {
    expect(commissionRateFor({}, {})).toBe(0);
    expect(commissionRateFor(null, null)).toBe(0);
    expect(commissionRateFor({ commissionPct: "abc" }, {})).toBe(0);
  });

  it("ignores a non-numeric service rate and uses the staff default", () => {
    expect(commissionRateFor({ commissionPct: "abc" }, staffMember)).toBe(10);
  });
});

describe("serviceToCartLine", () => {
  const svc = { id: "s1", name: "Haircut", category: "Hair", price: 400, durationMin: 30, commissionPct: 12, icon: "💇" };

  it("builds a service line attributed to the person doing the work", () => {
    expect(serviceToCartLine(svc, "st1")).toMatchObject({
      id: "s1", lineType: "service", name: "Haircut", sellPrice: 400, qty: 1,
      staffId: "st1", durationMin: 30, commissionPct: 12,
    });
  });

  it("costs nothing, because a service consumes no stock", () => {
    // Bill profit has always meant revenue minus the cost of goods sold. A service's real
    // cost is commission, which is booked separately — charging it here would double-count.
    expect(serviceToCartLine(svc).buyPrice).toBe(0);
  });

  it("allows an unassigned line (staff picked later)", () => {
    expect(serviceToCartLine(svc).staffId).toBe("");
  });

  it("coerces junk prices/durations to 0 rather than NaN", () => {
    const line = serviceToCartLine({ ...svc, price: undefined, durationMin: "abc" });
    expect(line.sellPrice).toBe(0);
    expect(line.durationMin).toBe(0);
  });
});
