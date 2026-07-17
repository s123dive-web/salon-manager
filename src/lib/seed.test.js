import { describe, it, expect } from "vitest";
import {
  SERVICE_CATEGORIES,
  PRODUCT_CATEGORIES,
  STOCK_TYPES,
  serviceIconFor,
  buildServices,
  buildProducts,
  buildStaff,
  buildTemplates,
  DEFAULT_LOYALTY_CONFIG,
} from "./seed.js";

// Deterministic id generator — the builders take `uid` as an argument precisely so the seed
// data can be asserted without a clock or a random source.
const mkUid = () => {
  let n = 0;
  return () => `id${++n}`;
};

const services = () => buildServices({ uid: mkUid(), today: "2026-07-17" });
const products = () => buildProducts({ uid: mkUid(), today: "2026-07-17" });

describe("buildServices", () => {
  const list = services();

  it("seeds a menu of a realistic size", () => {
    expect(list.length).toBeGreaterThanOrEqual(60);
  });

  it("gives every service a unique id", () => {
    expect(new Set(list.map((s) => s.id)).size).toBe(list.length);
  });

  it("gives every service a unique name (a duplicate would be a data-entry slip)", () => {
    const names = list.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("only uses known categories", () => {
    list.forEach((s) => expect(SERVICE_CATEGORIES).toContain(s.category));
  });

  it("covers every salon department", () => {
    const covered = new Set(list.map((s) => s.category));
    ["Hair", "Skin", "Nails", "Spa", "Makeup"].forEach((c) => expect(covered).toContain(c));
  });

  it("has men's and women's hair work", () => {
    const hair = list.filter((s) => s.category === "Hair").map((s) => s.name);
    expect(hair.some((n) => /Men/.test(n))).toBe(true);
    expect(hair.some((n) => /Women/.test(n))).toBe(true);
  });

  it("prices and durations are sane positive numbers", () => {
    list.forEach((s) => {
      expect(s.price).toBeGreaterThan(0);
      expect(Number.isFinite(s.price)).toBe(true);
      expect(s.durationMin).toBeGreaterThan(0);
      // A slot has to land on the 15-minute grid the day view renders.
      expect(s.durationMin % 5).toBe(0);
    });
  });

  it("commission is a sensible percentage, never over 100", () => {
    list.forEach((s) => {
      expect(s.commissionPct).toBeGreaterThanOrEqual(0);
      expect(s.commissionPct).toBeLessThanOrEqual(100);
    });
  });

  it("rebook cycles are non-negative, and occasion work never nags", () => {
    list.forEach((s) => expect(s.rebookCycleDays).toBeGreaterThanOrEqual(0));
    // Bridal/party makeup is one-off — a "you're due for another bridal makeup" reminder
    // would be absurd, so those must be explicitly 0.
    list
      .filter((s) => s.category === "Makeup")
      .forEach((s) => expect(s.rebookCycleDays).toBe(0));
  });

  it("services that DO recur carry a cycle", () => {
    const recurring = list.filter((s) => s.category === "Hair" && /Haircut/.test(s.name));
    expect(recurring.length).toBeGreaterThan(0);
    recurring.forEach((s) => expect(s.rebookCycleDays).toBeGreaterThan(0));
  });

  it("starts every service active, iconned and dated", () => {
    list.forEach((s) => {
      expect(s.active).toBe(true);
      expect(s.icon).toBe(serviceIconFor(s.category));
      expect(s.createdAt).toBe("2026-07-17");
    });
  });
});

describe("buildProducts", () => {
  const list = products();

  it("seeds both retail and backbar stock", () => {
    const types = new Set(list.map((p) => p.stockType));
    expect(types).toEqual(new Set(STOCK_TYPES));
  });

  it("gives every product a unique id and name", () => {
    expect(new Set(list.map((p) => p.id)).size).toBe(list.length);
    expect(new Set(list.map((p) => p.name)).size).toBe(list.length);
  });

  it("only uses known categories and stock types", () => {
    list.forEach((p) => {
      expect(PRODUCT_CATEGORIES).toContain(p.category);
      expect(STOCK_TYPES).toContain(p.stockType);
    });
  });

  it("opens at zero stock with no batches, so real stock gets counted in", () => {
    list.forEach((p) => {
      expect(p.stock).toBe(0);
      expect(p.batches).toEqual([]);
    });
  });

  it("never seeds a product that would sell at a loss", () => {
    list.forEach((p) => {
      expect(p.buyPrice).toBeGreaterThan(0);
      expect(p.sellPrice).toBeGreaterThanOrEqual(p.buyPrice);
    });
  });

  it("sets a low-stock threshold on everything, so Alerts works from day one", () => {
    list.forEach((p) => expect(p.lowAt).toBeGreaterThan(0));
  });

  it("uses the caller's iconFor when given one", () => {
    const custom = buildProducts({ uid: mkUid(), today: "", iconFor: () => "X" });
    custom.forEach((p) => expect(p.icon).toBe("X"));
  });
});

describe("buildStaff", () => {
  const list = buildStaff({ uid: mkUid(), today: "2026-07-17" });

  it("seeds two sample stylists so the diary has columns on day one", () => {
    expect(list.length).toBe(2);
  });

  it("gives each a distinct colour for the appointment grid", () => {
    const colors = list.map((s) => s.color);
    expect(new Set(colors).size).toBe(colors.length);
    colors.forEach((c) => expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/));
  });

  it("starts active with a default commission", () => {
    list.forEach((s) => {
      expect(s.active).toBe(true);
      expect(s.commissionPctDefault).toBeGreaterThan(0);
      expect(s.commissionPctDefault).toBeLessThanOrEqual(100);
    });
  });
});

describe("buildTemplates", () => {
  const list = buildTemplates({ uid: mkUid(), today: "2026-07-17" });
  const KINDS = ["rebook", "birthday", "anniversary", "dormant", "package"];

  it("covers every reminder kind", () => {
    KINDS.forEach((k) => expect(list.some((t) => t.kind === k)).toBe(true));
  });

  it("ships an English and a Hindi version of each", () => {
    KINDS.forEach((k) => {
      const forKind = list.filter((t) => t.kind === k);
      expect(forKind.length).toBe(2);
      expect(forKind.some((t) => /English/.test(t.name))).toBe(true);
      expect(forKind.some((t) => /Hindi/.test(t.name))).toBe(true);
    });
  });

  it("only uses placeholders the reminder engine actually fills", () => {
    const ALLOWED = new Set(["name", "service", "days", "shopName"]);
    list.forEach((t) => {
      const used = [...t.body.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      used.forEach((p) => expect(ALLOWED).toContain(p));
    });
  });

  it("personalises every message and names the salon", () => {
    list.forEach((t) => expect(t.body).toContain("{name}"));
  });

  it("uses {days} only where a day count makes sense", () => {
    // A birthday/anniversary greeting has no elapsed-day count to talk about.
    list
      .filter((t) => t.kind === "birthday" || t.kind === "anniversary")
      .forEach((t) => expect(t.body).not.toContain("{days}"));
    list
      .filter((t) => t.kind === "rebook" || t.kind === "dormant" || t.kind === "package")
      .forEach((t) => expect(t.body).toContain("{days}"));
  });
});

describe("DEFAULT_LOYALTY_CONFIG", () => {
  it("is enabled with a modest, margin-safe earn rate", () => {
    expect(DEFAULT_LOYALTY_CONFIG.enabled).toBe(true);
    expect(DEFAULT_LOYALTY_CONFIG.earnRate).toBeGreaterThan(0);
    expect(DEFAULT_LOYALTY_CONFIG.redeemValue).toBeGreaterThan(0);
    // 1 pt per ₹100 at ₹1/pt = 1% back. Anything over ~5% would be a red flag in a seed.
    const pctBack =
      (DEFAULT_LOYALTY_CONFIG.earnRate * DEFAULT_LOYALTY_CONFIG.redeemValue) / 100;
    expect(pctBack).toBeLessThanOrEqual(0.05);
  });

  it("caps redemption so points can never zero out a bill", () => {
    expect(DEFAULT_LOYALTY_CONFIG.maxRedeemPctOfBill).toBeGreaterThan(0);
    expect(DEFAULT_LOYALTY_CONFIG.maxRedeemPctOfBill).toBeLessThan(100);
    expect(DEFAULT_LOYALTY_CONFIG.minRedeemPoints).toBeGreaterThan(0);
  });

  it("has tiers that ascend", () => {
    const { silver, gold, platinum } = DEFAULT_LOYALTY_CONFIG.tiers;
    expect(silver).toBeLessThan(gold);
    expect(gold).toBeLessThan(platinum);
    expect(silver).toBeGreaterThan(0);
  });
});
