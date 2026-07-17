import { describe, it, expect } from "vitest";
import {
  KINDS, daysUntilOccasion, lastServiceDates, rebookDue, buildQueue,
  reminderKey, wasSentRecently, fillTemplate, templateVars, waLink,
  SEGMENTS, segmentOf, segmentAll, DORMANT_AFTER_DAYS,
} from "./reminders.js";

const TODAY = "2026-07-17"; // a Friday

describe("daysUntilOccasion", () => {
  it("counts to an upcoming day this year", () => {
    expect(daysUntilOccasion("20-07", TODAY)).toBe(3);
    expect(daysUntilOccasion("17-07", TODAY)).toBe(0); // today
  });

  it("rolls to next year once the day has passed", () => {
    // Yesterday's birthday is 364 days away, not 365: today itself isn't in the gap.
    expect(daysUntilOccasion("16-07", TODAY)).toBe(364);
    expect(daysUntilOccasion("01-01", TODAY)).toBe(168);
  });

  it("greets a 29-Feb birthday in FEBRUARY on a non-leap year", () => {
    // Rolling to 1 March would wish someone a happy birthday on the wrong day, in the wrong
    // month. 28 Feb is what the person expects.
    const days = daysUntilOccasion("29-02", "2027-02-01");
    expect(days).toBe(27); // 2027-02-28
  });

  it("uses the real 29th on a leap year", () => {
    expect(daysUntilOccasion("29-02", "2028-02-01")).toBe(28); // 2028-02-29
  });

  it("returns null for blank or malformed values, rather than guessing a date", () => {
    ["", null, undefined, "1-1", "abc", "00-01", "32-01", "01-13"].forEach((v) =>
      expect(daysUntilOccasion(v, TODAY)).toBe(null)
    );
  });

  it("returns null for a junk today", () => expect(daysUntilOccasion("20-07", "nonsense")).toBe(null));
});

// ── rebooking ────────────────────────────────────────────────────────────────────────────
const SERVICES = [
  { id: "cut", name: "Haircut", rebookCycleDays: 45, active: true },
  { id: "colour", name: "Global Colour", rebookCycleDays: 60, active: true },
  { id: "bridal", name: "Bridal Makeup", rebookCycleDays: 0, active: true },
  { id: "old", name: "Retired Service", rebookCycleDays: 30, active: false },
];

const bill = (id, date, serviceIds, phone = "9876543210") => ({
  id, date, customerPhone: phone, total: 1000,
  lines: serviceIds.map((sid) => ({ lineType: "service", serviceId: sid, name: sid, qty: 1 })),
});

describe("lastServiceDates", () => {
  it("takes the most recent date per service", () => {
    const sales = [bill("b1", "2026-01-01", ["cut"]), bill("b2", "2026-05-01", ["cut", "colour"])];
    const m = lastServiceDates(sales, "9876543210");
    expect(m.get("cut")).toBe("2026-05-01");
    expect(m.get("colour")).toBe("2026-05-01");
  });

  it("ignores product lines and legacy lines with no serviceId", () => {
    const sales = [{ id: "x", date: "2026-05-01", customerPhone: "9876543210", lines: [{ name: "Shampoo", qty: 1 }] }];
    expect(lastServiceDates(sales, "9876543210").size).toBe(0);
  });
});

describe("rebookDue", () => {
  const cust = { phone: "9876543210", name: "Asha" };

  it("is due once the cycle has landed", () => {
    const sales = [bill("b", "2026-05-01", ["cut"])]; // +45d = 2026-06-15, overdue by 32
    const due = rebookDue(cust, sales, SERVICES, TODAY);
    expect(due).toMatchObject({ serviceId: "cut", serviceName: "Haircut", dueOn: "2026-06-15", overdueBy: 32 });
  });

  it("is NOT due before the cycle lands", () => {
    const sales = [bill("b", "2026-07-10", ["cut"])];
    expect(rebookDue(cust, sales, SERVICES, TODAY)).toBe(null);
  });

  it("is due exactly ON the cycle date", () => {
    const sales = [bill("b", "2026-06-02", ["cut"])]; // +45d = 2026-07-17 = today
    expect(rebookDue(cust, sales, SERVICES, TODAY).overdueBy).toBe(0);
  });

  it("NEVER nags about one-off work", () => {
    // "You're due another bridal makeup" is the kind of message that loses a customer.
    const sales = [bill("b", "2020-01-01", ["bridal"])];
    expect(rebookDue(cust, sales, SERVICES, TODAY)).toBe(null);
  });

  it("won't tout a service that's been taken off the menu", () => {
    const sales = [bill("b", "2020-01-01", ["old"])];
    expect(rebookDue(cust, sales, SERVICES, TODAY)).toBe(null);
  });

  it("ignores a service deleted since the bill", () => {
    const sales = [bill("b", "2020-01-01", ["vanished"])];
    expect(rebookDue(cust, sales, SERVICES, TODAY)).toBe(null);
  });

  it("returns only the MOST overdue service, not one row per service", () => {
    // Three messages to one person about three services is how a salon gets blocked.
    const sales = [bill("b1", "2026-01-01", ["cut"]), bill("b2", "2026-05-01", ["colour"])];
    const due = rebookDue(cust, sales, SERVICES, TODAY);
    expect(due.serviceId).toBe("cut"); // overdue by far more
  });

  it("returns null for a customer with no service history", () => {
    expect(rebookDue(cust, [], SERVICES, TODAY)).toBe(null);
  });
});

// ── the queue ────────────────────────────────────────────────────────────────────────────
describe("buildQueue", () => {
  const base = { sales: [], services: SERVICES, customerPackages: [], today: TODAY };

  it("is empty when nobody is due anything", () => {
    const customers = [{ phone: "9876543210", name: "Asha", totalVisits: 1, lastVisitAt: TODAY }];
    expect(buildQueue({ ...base, customers })).toEqual([]);
  });

  it("never invents a reason for a customer with no history", () => {
    // A blank customer must generate nothing at all.
    const customers = [{ phone: "9876543210", name: "Asha" }];
    expect(buildQueue({ ...base, customers })).toEqual([]);
  });

  it("does NOT call someone dormant who has never visited", () => {
    // "We've missed you!" to someone who has never been in is embarrassing.
    const customers = [{ phone: "9876543210", name: "Asha", totalVisits: 0, lastVisitAt: "" }];
    expect(buildQueue({ ...base, customers })).toEqual([]);
  });

  it("flags a dormant customer who HAS been in", () => {
    const customers = [{ phone: "9876543210", name: "Asha", totalVisits: 3, lastVisitAt: "2026-01-01" }];
    const q = buildQueue({ ...base, customers });
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ kind: "dormant", phone: "9876543210" });
  });

  it("gives ONE row per customer even when several reasons apply", () => {
    // The central promise of this module. Three reasons, one message.
    const customers = [{
      phone: "9876543210", name: "Asha", totalVisits: 5, lastVisitAt: "2026-01-01", dob: "18-07",
    }];
    const customerPackages = [{ id: "cp1", customerPhone: "9876543210", name: "6 Facials", usesLeft: 2, expiresAt: "2026-07-25", totalUses: 6 }];
    const sales = [bill("b", "2026-01-01", ["cut"])];
    const q = buildQueue({ ...base, customers, customerPackages, sales });
    expect(q).toHaveLength(1);
  });

  it("picks the most time-critical reason when several apply", () => {
    // An expiring package is the customer's own money on a deadline — it beats a birthday,
    // a rebook nudge and a win-back.
    const customers = [{ phone: "9876543210", name: "Asha", totalVisits: 5, lastVisitAt: "2026-01-01", dob: "18-07" }];
    const customerPackages = [{ id: "cp1", customerPhone: "9876543210", name: "6 Facials", usesLeft: 2, expiresAt: "2026-07-25", totalUses: 6 }];
    const q = buildQueue({ ...base, customers, customerPackages });
    expect(q[0].kind).toBe("package");
    expect(q[0].alsoKinds).toContain("birthday");
    expect(q[0].alsoKinds).toContain("dormant");
  });

  it("prefers a birthday over a rebook nudge", () => {
    const customers = [{ phone: "9876543210", name: "Asha", totalVisits: 3, lastVisitAt: "2026-05-01", dob: "18-07" }];
    const sales = [bill("b", "2026-01-01", ["cut"])];
    expect(buildQueue({ ...base, customers, sales })[0].kind).toBe("birthday");
  });

  it("prefers a rebook nudge over a win-back", () => {
    // "You're due a haircut" is a better message than "we've missed you".
    const customers = [{ phone: "9876543210", name: "Asha", totalVisits: 3, lastVisitAt: "2026-01-01" }];
    const sales = [bill("b", "2026-01-01", ["cut"])];
    expect(buildQueue({ ...base, customers, sales })[0].kind).toBe("rebook");
  });

  it("only greets an occasion within the window", () => {
    const near = [{ phone: "9876543210", name: "A", totalVisits: 2, lastVisitAt: TODAY, dob: "19-07" }];
    const far = [{ phone: "9876543210", name: "A", totalVisits: 2, lastVisitAt: TODAY, dob: "30-08" }];
    expect(buildQueue({ ...base, customers: near })[0].kind).toBe("birthday");
    expect(buildQueue({ ...base, customers: far })).toEqual([]);
  });

  it("sorts most urgent first: packages, then occasions, then rebooks, then dormant", () => {
    const customers = [
      { phone: "9000000001", name: "Dormant", totalVisits: 3, lastVisitAt: "2026-01-01" },
      { phone: "9000000002", name: "Birthday", totalVisits: 2, lastVisitAt: TODAY, dob: "18-07" },
      { phone: "9000000003", name: "Package", totalVisits: 2, lastVisitAt: TODAY },
    ];
    const customerPackages = [{ id: "cp", customerPhone: "9000000003", name: "P", usesLeft: 1, expiresAt: "2026-07-20", totalUses: 3 }];
    expect(buildQueue({ ...base, customers, customerPackages }).map((r) => r.kind)).toEqual(["package", "birthday", "dormant"]);
  });

  it("puts the longest-overdue rebook first", () => {
    const customers = [
      { phone: "9000000001", name: "A", totalVisits: 2, lastVisitAt: "2026-05-01" },
      { phone: "9000000002", name: "B", totalVisits: 2, lastVisitAt: "2026-01-01" },
    ];
    const sales = [bill("b1", "2026-05-01", ["cut"], "9000000001"), bill("b2", "2026-01-01", ["cut"], "9000000002")];
    expect(buildQueue({ ...base, customers, sales }).map((r) => r.phone)).toEqual(["9000000002", "9000000001"]);
  });

  it("puts the soonest-expiring package first", () => {
    const customers = [
      { phone: "9000000001", name: "A", totalVisits: 2, lastVisitAt: TODAY },
      { phone: "9000000002", name: "B", totalVisits: 2, lastVisitAt: TODAY },
    ];
    const customerPackages = [
      { id: "c1", customerPhone: "9000000001", name: "P", usesLeft: 1, expiresAt: "2026-07-28", totalUses: 3 },
      { id: "c2", customerPhone: "9000000002", name: "P", usesLeft: 1, expiresAt: "2026-07-19", totalUses: 3 },
    ];
    expect(buildQueue({ ...base, customers, customerPackages }).map((r) => r.phone)).toEqual(["9000000002", "9000000001"]);
  });

  it("carries the sent mark through", () => {
    const customers = [{ phone: "9876543210", name: "Asha", totalVisits: 3, lastVisitAt: "2026-01-01" }];
    const sentLog = { [reminderKey("9876543210", "dormant")]: "2026-07-01" };
    expect(buildQueue({ ...base, customers, sentLog })[0].sentAt).toBe("2026-07-01");
  });

  it("skips customers with no phone", () => {
    expect(buildQueue({ ...base, customers: [{ name: "Ghost", totalVisits: 5, lastVisitAt: "2020-01-01" }] })).toEqual([]);
  });

  it("respects a custom dormant threshold", () => {
    const customers = [{ phone: "9876543210", name: "A", totalVisits: 3, lastVisitAt: "2026-06-01" }];
    expect(buildQueue({ ...base, customers })).toEqual([]); // 46 days < 60
    expect(buildQueue({ ...base, customers, dormantAfter: 30 })[0].kind).toBe("dormant");
    expect(DORMANT_AFTER_DAYS).toBe(60);
  });

  it("knows all its kinds", () => {
    expect(KINDS.sort()).toEqual(["anniversary", "birthday", "dormant", "package", "rebook"]);
  });
});

describe("wasSentRecently — the anti-pestering guard", () => {
  it("is false when never sent", () => {
    expect(wasSentRecently("", TODAY)).toBe(false);
    expect(wasSentRecently(null, TODAY)).toBe(false);
  });

  it("is true within the window", () => {
    expect(wasSentRecently("2026-07-15", TODAY, 30)).toBe(true);
    expect(wasSentRecently(TODAY, TODAY, 30)).toBe(true);
  });

  it("is false once the window has passed", () => {
    expect(wasSentRecently("2026-05-01", TODAY, 30)).toBe(false);
  });

  it("is false at exactly the window edge, so a monthly cadence stays possible", () => {
    expect(wasSentRecently("2026-06-17", TODAY, 30)).toBe(false); // exactly 30 days
  });

  it("ignores a future date rather than blocking forever", () => {
    expect(wasSentRecently("2027-01-01", TODAY, 30)).toBe(false);
  });
});

describe("fillTemplate", () => {
  const vars = { name: "Asha", service: "Haircut", days: "32", shopName: "Glow" };

  it("fills every known placeholder", () => {
    expect(fillTemplate("Hi {name}, it's been {days} days since your {service} at {shopName}.", vars))
      .toBe("Hi Asha, it's been 32 days since your Haircut at Glow.");
  });

  it("fills repeats", () => {
    expect(fillTemplate("{name} {name}", vars)).toBe("Asha Asha");
  });

  it("leaves an unknown placeholder visible rather than blanking it", () => {
    // A visible {mystery} is a bug the owner can see and report. A silent blank produces
    // "Hi , welcome to" — sent to a real customer.
    expect(fillTemplate("Hi {mystery}", vars)).toBe("Hi {mystery}");
  });

  it("leaves a placeholder alone when its value is empty", () => {
    expect(fillTemplate("Hi {name}", { name: "" })).toBe("Hi {name}");
    expect(fillTemplate("Hi {name}", { name: null })).toBe("Hi {name}");
  });

  it("handles an empty template", () => {
    expect(fillTemplate("", vars)).toBe("");
    expect(fillTemplate(null, vars)).toBe("");
  });
});

describe("templateVars", () => {
  it("uses the FIRST name only", () => {
    // "Hi Asha" reads like a person wrote it. "Hi Asha Patil" reads like a bank.
    expect(templateVars({ name: "Asha Patil", days: 32 }, "Glow").name).toBe("Asha");
  });

  it("falls back gracefully when there's no name", () => {
    expect(templateVars({ name: "", days: 1 }, "Glow").name).toBe("there");
    expect(templateVars({ days: 1 }, "").shopName).toBe("our salon");
  });

  it("always gives days as a positive string", () => {
    expect(templateVars({ name: "A", days: -5 }, "Glow").days).toBe("5");
    expect(templateVars({ name: "A", days: 0 }, "Glow").days).toBe("0");
  });

  it("falls back for a message with no specific service", () => {
    expect(templateVars({ name: "A", days: 1 }, "Glow").service).toBe("your last visit");
  });
});

describe("waLink", () => {
  it("builds a deep link with the 91 country code and an encoded message", () => {
    expect(waLink("9876543210", "Hi Asha!")).toBe("https://wa.me/919876543210?text=Hi%20Asha!");
  });

  it("normalises however the number is stored", () => {
    expect(waLink("+91 98765 43210", "x")).toBe(waLink("9876543210", "x"));
  });

  it("encodes newlines and emoji safely", () => {
    const link = waLink("9876543210", "Line1\nLine2 💇");
    expect(link).toContain("%0A");
    expect(() => new URL(link)).not.toThrow();
  });

  it("does NOT guess a country code for a non-Indian-mobile number", () => {
    expect(waLink("12345", "x")).toBe("https://wa.me/12345?text=x");
  });
});

// ── segmentation ─────────────────────────────────────────────────────────────────────────
describe("segmentOf", () => {
  const C = (over) => ({ totalVisits: 3, totalSpend: 3000, lastVisitAt: "2026-07-10", ...over });

  it("knows its segments", () => {
    expect(SEGMENTS).toEqual(["TOP", "Regular", "At-risk", "Dormant", "New"]);
  });

  it("calls a one-visit customer New, whatever they spent", () => {
    // One big bill says nothing about whether they'll come back. Calling them TOP on day one
    // would put them in the wrong bucket for every decision made afterwards.
    expect(segmentOf(C({ totalVisits: 1, totalSpend: 90000 }), TODAY)).toBe("New");
  });

  it("calls a never-billed customer New", () => {
    expect(segmentOf(C({ totalVisits: 0, totalSpend: 0, lastVisitAt: "" }), TODAY)).toBe("New");
  });

  it("calls a long-gone customer Dormant", () => {
    expect(segmentOf(C({ lastVisitAt: "2026-01-01" }), TODAY)).toBe("Dormant");
  });

  it("calls a drifting regular At-risk — the segment that's actually worth acting on", () => {
    expect(segmentOf(C({ visits: 4, lastVisitAt: "2026-05-20" }), TODAY)).toBe("At-risk");
  });

  it("calls a frequent, recent, high spender TOP", () => {
    expect(segmentOf(C({ totalVisits: 8, totalSpend: 30000, lastVisitAt: "2026-07-10" }), TODAY)).toBe("TOP");
  });

  it("does not call a frequent but low-spending customer TOP", () => {
    expect(segmentOf(C({ totalVisits: 9, totalSpend: 2000 }), TODAY)).toBe("Regular");
  });

  it("does not call a high-spending but infrequent customer TOP", () => {
    expect(segmentOf(C({ totalVisits: 2, totalSpend: 90000 }), TODAY)).toBe("Regular");
  });

  it("prefers Dormant over TOP for a lapsed big spender", () => {
    // Recency outweighs history: they're not a top customer any more, they're a lost one.
    expect(segmentOf(C({ totalVisits: 20, totalSpend: 90000, lastVisitAt: "2025-01-01" }), TODAY)).toBe("Dormant");
  });

  it("calls everyone else Regular", () => {
    expect(segmentOf(C(), TODAY)).toBe("Regular");
  });

  it("honours custom thresholds", () => {
    const t = { dormantDays: 5, atRiskDays: 2 };
    expect(segmentOf(C({ lastVisitAt: "2026-07-01" }), TODAY, t)).toBe("Dormant");
  });

  it("treats a missing lastVisitAt on a multi-visit record as dormant, not Regular", () => {
    // Corrupt data must not promote someone into an active segment.
    expect(segmentOf(C({ totalVisits: 5, lastVisitAt: "" }), TODAY)).toBe("Dormant");
  });
});

describe("segmentAll", () => {
  it("labels every customer and counts the buckets", () => {
    const customers = [
      { phone: "1", totalVisits: 1, totalSpend: 500, lastVisitAt: TODAY },
      { phone: "2", totalVisits: 8, totalSpend: 30000, lastVisitAt: "2026-07-10" },
      { phone: "3", totalVisits: 4, totalSpend: 4000, lastVisitAt: "2026-01-01" },
    ];
    const { rows, counts } = segmentAll(customers, TODAY);
    expect(rows.map((r) => r.segment)).toEqual(["New", "TOP", "Dormant"]);
    expect(counts).toMatchObject({ New: 1, TOP: 1, Dormant: 1, Regular: 0, "At-risk": 0 });
  });

  it("handles an empty list, still returning every counter", () => {
    const { rows, counts } = segmentAll([], TODAY);
    expect(rows).toEqual([]);
    SEGMENTS.forEach((s) => expect(counts[s]).toBe(0));
  });

  it("handles a missing list", () => expect(segmentAll(null, TODAY).rows).toEqual([]));
});
