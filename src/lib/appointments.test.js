import { describe, it, expect } from "vitest";
import {
  STATUSES, SLOT_MIN, DEFAULT_HOURS,
  parseHM, toHM, toClock, endMin, slotsBetween,
  rangesOverlap, findConflicts, isSlotFree, validateAppointment,
  summarizeServices, blankAppointment, dayAppointments, layoutDay,
  weekStrip, addDays, dayStats, occupiesChair,
} from "./appointments.js";

describe("time helpers", () => {
  it("parses and formats round-trip", () => {
    expect(parseHM("09:30")).toBe(570);
    expect(parseHM("9:30")).toBe(570);
    expect(parseHM("00:00")).toBe(0);
    expect(parseHM("23:59")).toBe(1439);
    expect(toHM(570)).toBe("09:30");
    expect(toHM(0)).toBe("00:00");
  });

  it("rejects nonsense times rather than guessing", () => {
    ["", "abc", "9", "25:00", "09:60", "9:5", null].forEach((v) => expect(parseHM(v)).toBeNaN());
  });

  it("renders a 12-hour clock the front desk can read", () => {
    expect(toClock(0)).toBe("12:00 am");
    expect(toClock(570)).toBe("9:30 am");
    expect(toClock(720)).toBe("12:00 pm");
    expect(toClock(780)).toBe("1:00 pm");
    expect(toClock(1260)).toBe("9:00 pm");
  });

  it("computes an end time, tolerating missing fields", () => {
    expect(endMin({ startMin: 600, durationMin: 45 })).toBe(645);
    expect(endMin({ startMin: 600 })).toBe(600);
    expect(endMin({})).toBe(0);
    expect(endMin(null)).toBe(0);
  });

  it("lays out grid rows across opening hours", () => {
    const slots = slotsBetween(600, 660, 15);
    expect(slots).toEqual([600, 615, 630, 645]); // close time itself is not a row
    expect(SLOT_MIN).toBe(15);
    expect(DEFAULT_HOURS.openMin).toBeLessThan(DEFAULT_HOURS.closeMin);
  });
});

describe("rangesOverlap — back-to-back is NOT a clash", () => {
  it("treats ranges as half-open, so 3:00-end meets 3:00-start cleanly", () => {
    // The most common salon pattern there is. Closed intervals would reject a full day of
    // efficient back-to-back bookings.
    expect(rangesOverlap(600, 660, 660, 720)).toBe(false);
    expect(rangesOverlap(660, 720, 600, 660)).toBe(false);
  });

  it("catches a genuine overlap, whichever order", () => {
    expect(rangesOverlap(600, 660, 630, 690)).toBe(true);
    expect(rangesOverlap(630, 690, 600, 660)).toBe(true);
  });

  it("catches full containment, both ways", () => {
    expect(rangesOverlap(600, 720, 630, 660)).toBe(true);
    expect(rangesOverlap(630, 660, 600, 720)).toBe(true);
  });

  it("catches an exact duplicate slot", () => {
    expect(rangesOverlap(600, 660, 600, 660)).toBe(true);
  });

  it("says no when they're nowhere near each other", () => {
    expect(rangesOverlap(600, 660, 900, 960)).toBe(false);
  });
});

// ── conflicts ────────────────────────────────────────────────────────────────────────────
const A = (over) => ({ id: "a1", date: "2026-07-20", staffId: "st1", startMin: 600, durationMin: 60, status: "booked", ...over });

describe("findConflicts", () => {
  const existing = [A()];

  it("finds a clash in the same chair, same day", () => {
    expect(findConflicts(existing, { date: "2026-07-20", staffId: "st1", startMin: 630, durationMin: 30 })).toHaveLength(1);
  });

  it("allows the same time in a DIFFERENT stylist's chair", () => {
    // Two stylists working at once is the entire business model.
    expect(findConflicts(existing, { date: "2026-07-20", staffId: "st2", startMin: 600, durationMin: 60 })).toHaveLength(0);
  });

  it("allows the same time on a different day", () => {
    expect(findConflicts(existing, { date: "2026-07-21", staffId: "st1", startMin: 600, durationMin: 60 })).toHaveLength(0);
  });

  it("allows a back-to-back booking", () => {
    expect(findConflicts(existing, { date: "2026-07-20", staffId: "st1", startMin: 660, durationMin: 30 })).toHaveLength(0);
  });

  it("ignores the appointment being edited, so rescheduling doesn't clash with itself", () => {
    // Without exceptId, nudging a booking 15 minutes later would always report a conflict
    // against its own old slot and be impossible to save.
    expect(findConflicts(existing, { date: "2026-07-20", staffId: "st1", startMin: 615, durationMin: 60, exceptId: "a1" })).toHaveLength(0);
  });

  it("does NOT block on a cancelled or no-show slot — that chair is free again", () => {
    for (const status of ["cancelled", "no-show"]) {
      expect(findConflicts([A({ status })], { date: "2026-07-20", staffId: "st1", startMin: 600, durationMin: 60 })).toHaveLength(0);
    }
  });

  it("DOES block on blocked time — that's what blocking is for", () => {
    expect(findConflicts([A({ status: "blocked" })], { date: "2026-07-20", staffId: "st1", startMin: 600, durationMin: 60 })).toHaveLength(1);
  });

  it("DOES block on a completed appointment — the chair was genuinely occupied", () => {
    expect(findConflicts([A({ status: "completed" })], { date: "2026-07-20", staffId: "st1", startMin: 630, durationMin: 30 })).toHaveLength(1);
  });

  it("returns every clash, not just the first", () => {
    const many = [A({ id: "a1", startMin: 600, durationMin: 30 }), A({ id: "a2", startMin: 630, durationMin: 30 })];
    expect(findConflicts(many, { date: "2026-07-20", staffId: "st1", startMin: 600, durationMin: 60 })).toHaveLength(2);
  });

  it("copes with an empty/missing diary", () => {
    expect(findConflicts([], { date: "2026-07-20", staffId: "st1", startMin: 600, durationMin: 60 })).toEqual([]);
    expect(findConflicts(null, { date: "2026-07-20", staffId: "st1", startMin: 600, durationMin: 60 })).toEqual([]);
    expect(findConflicts(undefined, {})).toEqual([]);
  });

  it("isSlotFree is the inverse", () => {
    expect(isSlotFree(existing, { date: "2026-07-20", staffId: "st1", startMin: 660, durationMin: 30 })).toBe(true);
    expect(isSlotFree(existing, { date: "2026-07-20", staffId: "st1", startMin: 630, durationMin: 30 })).toBe(false);
  });
});

describe("occupiesChair", () => {
  it("knows which statuses hold the chair", () => {
    expect(STATUSES).toEqual(["booked", "completed", "no-show", "cancelled", "blocked"]);
    ["booked", "completed", "blocked"].forEach((s) => expect(occupiesChair({ status: s })).toBe(true));
    ["no-show", "cancelled"].forEach((s) => expect(occupiesChair({ status: s })).toBe(false));
    expect(occupiesChair(null)).toBe(false);
  });
});

// ── validation ───────────────────────────────────────────────────────────────────────────
describe("validateAppointment", () => {
  const hours = { openMin: 600, closeMin: 1260 }; // 10:00 – 21:00
  const ok = { date: "2026-07-20", staffId: "st1", startMin: 660, durationMin: 60, serviceIds: ["s1"], status: "booked" };

  it("accepts a sane booking", () => expect(validateAppointment(ok, [], hours)).toBe(null));

  it("requires date, staff, time, duration and a service", () => {
    expect(validateAppointment({ ...ok, date: "" }, [], hours)).toMatch(/date/i);
    expect(validateAppointment({ ...ok, staffId: "" }, [], hours)).toMatch(/staff/i);
    expect(validateAppointment({ ...ok, startMin: NaN }, [], hours)).toMatch(/start time/i);
    expect(validateAppointment({ ...ok, durationMin: 0 }, [], hours)).toMatch(/duration/i);
    expect(validateAppointment({ ...ok, serviceIds: [] }, [], hours)).toMatch(/service/i);
  });

  it("lets blocked time exist without a service — it isn't a booking", () => {
    expect(validateAppointment({ ...ok, status: "blocked", serviceIds: [] }, [], hours)).toBe(null);
  });

  it("rejects a booking outside opening hours, which would render off the grid", () => {
    expect(validateAppointment({ ...ok, startMin: 540 }, [], hours)).toMatch(/opening/i);
    expect(validateAppointment({ ...ok, startMin: 1230, durationMin: 60 }, [], hours)).toMatch(/closing/i);
  });

  it("allows a booking that ends exactly at closing time", () => {
    expect(validateAppointment({ ...ok, startMin: 1200, durationMin: 60 }, [], hours)).toBe(null);
  });

  it("reports a clash with the offending time, so the answer is actionable", () => {
    const existing = [A({ startMin: 660, durationMin: 60 })];
    const err = validateAppointment({ ...ok, startMin: 690 }, existing, hours);
    expect(err).toMatch(/clashes/i);
    expect(err).toMatch(/11:00 am/);
  });

  it("names blocked time as blocked, not as 'another booking'", () => {
    const existing = [A({ startMin: 660, durationMin: 60, status: "blocked" })];
    expect(validateAppointment({ ...ok, startMin: 690 }, existing, hours)).toMatch(/blocked time/i);
  });

  it("lets an existing appointment be re-saved unchanged", () => {
    const existing = [A({ id: "a1", startMin: 660, durationMin: 60 })];
    expect(validateAppointment({ ...ok, id: "a1", startMin: 660 }, existing, hours)).toBe(null);
  });
});

// ── services on a booking ────────────────────────────────────────────────────────────────
describe("summarizeServices", () => {
  const services = [
    { id: "s1", name: "Cut", durationMin: 30, price: 400 },
    { id: "s2", name: "Colour", durationMin: 90, price: 3000 },
  ];

  it("adds up duration and price across a multi-service booking", () => {
    expect(summarizeServices(["s1", "s2"], services)).toEqual({ durationMin: 120, price: 3400, names: ["Cut", "Colour"] });
  });

  it("returns zeros for nothing selected", () => {
    expect(summarizeServices([], services)).toEqual({ durationMin: 0, price: 0, names: [] });
    expect(summarizeServices(null, services)).toEqual({ durationMin: 0, price: 0, names: [] });
  });

  it("skips a service deleted since the booking, rather than breaking the diary", () => {
    expect(summarizeServices(["s1", "gone"], services)).toEqual({ durationMin: 30, price: 400, names: ["Cut"] });
  });

  it("rounds the price once", () => {
    const odd = [{ id: "x", name: "X", durationMin: 10, price: 0.1 }, { id: "y", name: "Y", durationMin: 10, price: 0.2 }];
    expect(summarizeServices(["x", "y"], odd).price).toBe(0.3);
  });
});

describe("blankAppointment", () => {
  it("starts as a booking, unassigned to a bill", () => {
    const a = blankAppointment("2026-07-20", "st1", 600, "2026-07-17");
    expect(a).toMatchObject({ date: "2026-07-20", staffId: "st1", startMin: 600, status: "booked", billId: "", serviceIds: [] });
  });
});

describe("dayAppointments", () => {
  const list = [
    A({ id: "a", startMin: 700 }),
    A({ id: "b", startMin: 600 }),
    A({ id: "c", startMin: 650, staffId: "st2" }),
    A({ id: "d", date: "2026-07-21" }),
  ];

  it("filters to the day and sorts by start time", () => {
    expect(dayAppointments(list, "2026-07-20").map((a) => a.id)).toEqual(["b", "c", "a"]);
  });

  it("filters to one stylist when asked", () => {
    expect(dayAppointments(list, "2026-07-20", "st2").map((a) => a.id)).toEqual(["c"]);
  });

  it("copes with a missing diary", () => expect(dayAppointments(null, "2026-07-20")).toEqual([]));
});

// ── layout ───────────────────────────────────────────────────────────────────────────────
describe("layoutDay", () => {
  it("gives every non-overlapping appointment the full width", () => {
    const laid = layoutDay([A({ id: "a", startMin: 600, durationMin: 60 }), A({ id: "b", startMin: 660, durationMin: 60 })]);
    expect(laid.map((l) => [l.appt.id, l.col, l.cols])).toEqual([["a", 0, 1], ["b", 0, 1]]);
  });

  it("puts overlapping blocks side by side rather than hiding one behind the other", () => {
    // Forward bookings can't clash, but imported data and duration edits can produce one.
    // Stacking them invisibly would hide a real problem from whoever is running the day.
    const laid = layoutDay([A({ id: "a", startMin: 600, durationMin: 60 }), A({ id: "b", startMin: 630, durationMin: 60 })]);
    expect(laid.map((l) => [l.appt.id, l.col, l.cols])).toEqual([["a", 0, 2], ["b", 1, 2]]);
  });

  it("reuses a column once the earlier appointment has ended", () => {
    const laid = layoutDay([
      A({ id: "a", startMin: 600, durationMin: 60 }), // 10:00-11:00
      A({ id: "b", startMin: 630, durationMin: 60 }), // 10:30-11:30 → col 1
      A({ id: "c", startMin: 660, durationMin: 30 }), // 11:00-11:30 → col 0 is free again
    ]);
    const byId = Object.fromEntries(laid.map((l) => [l.appt.id, l]));
    expect(byId.c.col).toBe(0);
    expect(byId.c.cols).toBe(2);
  });

  it("keeps separate clusters independent, so one clash doesn't squeeze the whole day", () => {
    const laid = layoutDay([
      A({ id: "a", startMin: 600, durationMin: 60 }),
      A({ id: "b", startMin: 630, durationMin: 60 }), // clashes with a
      A({ id: "z", startMin: 900, durationMin: 30 }), // hours later, alone
    ]);
    const byId = Object.fromEntries(laid.map((l) => [l.appt.id, l]));
    expect(byId.z.cols).toBe(1); // full width, not squeezed to half by an unrelated clash
    expect(byId.a.cols).toBe(2);
  });

  it("handles an empty day", () => {
    expect(layoutDay([])).toEqual([]);
    expect(layoutDay(null)).toEqual([]);
  });

  it("returns every appointment it was given", () => {
    const day = [A({ id: "a" }), A({ id: "b", startMin: 630 }), A({ id: "c", startMin: 900 })];
    expect(layoutDay(day)).toHaveLength(3);
  });
});

// ── dates ────────────────────────────────────────────────────────────────────────────────
describe("weekStrip", () => {
  it("returns Monday-first week containing the date", () => {
    // 2026-07-17 is a Friday.
    expect(weekStrip("2026-07-17")).toEqual([
      "2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16", "2026-07-17", "2026-07-18", "2026-07-19",
    ]);
  });

  it("treats Sunday as the END of its week, not the start", () => {
    // 2026-07-19 is a Sunday: it belongs to the week that began Monday the 13th.
    expect(weekStrip("2026-07-19")[0]).toBe("2026-07-13");
    expect(weekStrip("2026-07-19")[6]).toBe("2026-07-19");
  });

  it("stays in LOCAL time across a month boundary", () => {
    // The bug this guards: toISOString() converts to UTC and hands back the previous day for
    // anywhere east of Greenwich — i.e. for every user of this app.
    expect(weekStrip("2026-08-01")).toContain("2026-08-01");
    expect(weekStrip("2026-03-01")).toContain("2026-03-01");
  });

  it("returns [] for a junk date", () => expect(weekStrip("nonsense")).toEqual([]));
});

describe("addDays", () => {
  it("moves forward and back", () => {
    expect(addDays("2026-07-17", 1)).toBe("2026-07-18");
    expect(addDays("2026-07-17", -1)).toBe("2026-07-16");
    expect(addDays("2026-07-17", 0)).toBe("2026-07-17");
  });

  it("rolls over months and years", () => {
    expect(addDays("2026-07-31", 1)).toBe("2026-08-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("handles a leap day", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });

  it("passes junk through rather than throwing", () => expect(addDays("nonsense", 1)).toBe("nonsense"));
});

describe("dayStats", () => {
  const list = [
    A({ id: "1", status: "booked" }),
    A({ id: "2", status: "completed" }),
    A({ id: "3", status: "no-show" }),
    A({ id: "4", status: "cancelled" }),
    A({ id: "5", status: "blocked" }),
    A({ id: "6", status: "booked", date: "2026-07-21" }),
  ];

  it("counts the day's outcomes and excludes blocked time", () => {
    // Blocked time isn't a customer, so it must not inflate "appointments today".
    expect(dayStats(list, "2026-07-20")).toEqual({ total: 4, booked: 1, completed: 1, noShow: 1, cancelled: 1 });
  });

  it("returns zeros for an empty day", () => {
    expect(dayStats(list, "2026-01-01")).toEqual({ total: 0, booked: 0, completed: 0, noShow: 0, cancelled: 0 });
    expect(dayStats(null, "2026-01-01").total).toBe(0);
  });
});
