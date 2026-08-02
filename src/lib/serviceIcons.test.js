import { describe, it, expect } from "vitest";
import {
  ICON_KEYS, ICON_LABELS, CATEGORY_FALLBACK, KEYWORD_RULES,
  isIconKey, normalizeName, resolveIcon, resolveIconFor,
} from "./serviceIcons.js";
import { buildServices, SERVICE_CATEGORIES, serviceIconFor } from "./seed.js";
import { serviceToCartLine } from "./salon.js";
import { mergeRemote } from "./sync.js";

const mkUid = () => { let n = 0; return () => `id${++n}`; };
const seeded = buildServices({ uid: mkUid(), today: "2026-08-02" });

describe("the registry itself", () => {
  it("has exactly the icons the drawing layer knows how to draw", () => {
    expect(new Set(ICON_KEYS).size).toBe(ICON_KEYS.length);
    expect(ICON_KEYS).toContain("defaultService");
  });

  it("labels every icon, for the override picker", () => {
    ICON_KEYS.forEach((k) => expect(ICON_LABELS[k], `no label for ${k}`).toBeTruthy());
  });

  it("only ever resolves to a known icon — every rule and fallback names a real key", () => {
    KEYWORD_RULES.forEach((r) => expect(ICON_KEYS, `rule → ${r.icon}`).toContain(r.icon));
    Object.values(CATEGORY_FALLBACK).forEach((v) => expect(ICON_KEYS).toContain(v));
  });

  it("covers every seed category, so a nameless service still gets something", () => {
    SERVICE_CATEGORIES.forEach((c) => expect(CATEGORY_FALLBACK[c], `no fallback for ${c}`).toBeTruthy());
  });

  it("keeps keywords normalised — an un-normalised keyword can never match", () => {
    KEYWORD_RULES.forEach((r) =>
      r.keywords.forEach((kw) => expect(normalizeName(kw).trim(), `"${kw}"`).toBe(kw))
    );
  });

  it("knows an icon key from an emoji", () => {
    expect(isIconKey("haircut")).toBe(true);
    expect(isIconKey("💇")).toBe(false);
    expect(isIconKey("")).toBe(false);
    expect(isIconKey(undefined)).toBe(false);
  });
});

describe("normalizeName", () => {
  it("is case, whitespace, dash and punctuation tolerant", () => {
    expect(normalizeName("Haircut Women — Layer / Step Cut")).toBe(" haircut women layer step cut ");
    expect(normalizeName("  HAIR   SPA  ")).toBe(" hair spa ");
    expect(normalizeName("De-Tan Pack (Face)")).toBe(" de tan pack face ");
    expect(normalizeName(null)).toBe("  ");
  });

  it("makes spelling of the same service irrelevant", () => {
    const one = resolveIconFor("hair-spa");
    expect(one).toBe(resolveIconFor("  Hair   Spa  "));
    expect(one).toBe(resolveIconFor("HAIR SPA — ADVANCED"));
  });
});

describe("resolveIcon — the seed menu", () => {
  // The bar the icon system has to clear to be worth having: a salon that never touches the
  // icon picker should still see a meaningful glyph on nearly every line of its menu.
  it("resolves at least 90% of the seeded menu to a real icon, not the default", () => {
    const resolved = seeded.map((s) => resolveIcon(s));
    const meaningful = resolved.filter((k) => k !== "defaultService");
    const pct = (meaningful.length / resolved.length) * 100;
    const misses = seeded.filter((s) => resolveIcon(s) === "defaultService").map((s) => s.name);
    expect(pct, `fell back to default: ${misses.join(", ") || "none"}`).toBeGreaterThanOrEqual(90);
  });

  it("never returns anything but a known icon key", () => {
    seeded.forEach((s) => expect(ICON_KEYS, s.name).toContain(resolveIcon(s)));
  });

  it("ignores the legacy emoji every seeded service carries in `icon`", () => {
    // Seed services ship `icon: "💇"` and friends. If that were treated as an override, every
    // service in a fresh salon would render the default glyph.
    expect(seeded.every((s) => typeof s.icon === "string" && !isIconKey(s.icon))).toBe(true);
    expect(resolveIcon(seeded.find((s) => s.name === "Haircut Men"))).toBe("haircut");
  });

  it("is deterministic — same service, same icon, every call", () => {
    const once = seeded.map((s) => resolveIcon(s));
    const twice = seeded.map((s) => resolveIcon({ ...s }));
    expect(twice).toEqual(once);
  });
});

describe("resolveIcon — the names that are genuinely ambiguous", () => {
  // Each of these pins one ordering constraint in KEYWORD_RULES. Reordering the table to fix
  // some future service must not silently break one of these.
  const pinned = [
    ["Hair Spa — Basic", "hairTreatment"],       // not `spa`
    ["Hair Spa — Men", "hairTreatment"],
    ["Manicure — Spa", "manicure"],              // not `spa`
    ["Pedicure — Spa", "pedicure"],
    ["Body Massage — Aroma (90 min)", "massage"],// not `spa`
    ["Body Polishing", "bodyScrub"],             // not `spa`, and not `nailArt` via "polish"
    ["Nail Cut & File", "manicure"],             // not `haircut` via "cut"
    ["Nail Polish Application", "nailArt"],
    ["Beard Colour", "beard"],                   // not `hairColor`
    ["Beard Trim & Shape", "beard"],             // not `haircut` via "trim"
    ["Clean Shave", "beard"],                    // not `cleanup` via "clean"
    ["Haircut Women — Advanced Style Cut", "haircut"], // not `hairStyle` via "style"
    ["Hair Wash & Blow Dry", "hairStyle"],       // the blow-dry is the service; the wash is not
    ["Hair Wash — Women", "hairTreatment"],
    ["Threading — Full Face", "threading"],      // not `facial` via "face"
    ["Face Wax", "waxing"],                      // not `facial`
    ["Bleach — Face", "bleach"],                 // not `facial`
    ["De-Tan Pack — Face", "bleach"],
    ["Head Massage (30 min)", "massage"],        // not a hair treatment
    ["Foot Reflexology", "massage"],             // not `pedicure` via "foot"
    ["Hair Styling — Updo", "hairStyle"],        // sits in the Makeup category
    ["Saree Draping", "bridal"],
    ["Bridal Makeup — HD", "bridal"],            // not `makeup`
    ["Party Makeup", "makeup"],
    ["Root Touch-up (ammonia-free)", "hairColor"],
    ["Smoothening", "hairTreatment"],
    ["Ironing / Straightening (temporary)", "hairStyle"],
  ];
  it.each(pinned)("%s → %s", (name, icon) => {
    expect(resolveIcon({ name, category: "" })).toBe(icon);
  });
});

describe("resolveIcon — Hinglish", () => {
  const hinglish = [
    ["Champi (head massage)", "massage"],
    ["Sar ki Malish", "massage"],
    ["Katori Wax — Full Arms", "waxing"],
    ["Mehendi — Bridal Hands", "mehendi"],  // mehendi beats bridal: it is the work being done
    ["Mehandi Design", "mehendi"],
    ["Henna Hair Pack", "mehendi"],
    ["Dulhan Package", "bridal"],
    ["Daadhi Setting", "beard"],
  ];
  it.each(hinglish)("%s → %s", (name, icon) => {
    expect(resolveIcon({ name })).toBe(icon);
  });
});

describe("resolveIcon — fallbacks", () => {
  it("falls back to the category when the name says nothing", () => {
    expect(resolveIcon({ name: "Signature Ritual No. 4", category: "Spa" })).toBe("spa");
    expect(resolveIcon({ name: "ABCD", category: "Nails" })).toBe("manicure");
    expect(resolveIcon({ name: "", category: "Skin" })).toBe("facial");
    expect(resolveIcon({ name: "zzz", category: "hair" })).toBe("haircut"); // restored backups shout
  });

  it("unknown name + unknown category → defaultService", () => {
    expect(resolveIcon({ name: "Zzz Qqq", category: "Wellness Rituals" })).toBe("defaultService");
    expect(resolveIcon({ name: "", category: "" })).toBe("defaultService");
    expect(resolveIcon({ name: "Whatever", category: "Other" })).toBe("defaultService");
  });

  it("never throws on junk", () => {
    [null, undefined, 0, "", [], { name: 42 }, { name: {} }].forEach((junk) =>
      expect(ICON_KEYS).toContain(resolveIcon(junk))
    );
  });
});

describe("resolveIcon — the owner's override", () => {
  it("wins over the name", () => {
    expect(resolveIcon({ name: "Haircut Men", icon: "mehendi" })).toBe("mehendi");
  });

  it("wins over the category", () => {
    expect(resolveIcon({ name: "Zzz", category: "Spa", icon: "bridal" })).toBe("bridal");
  });

  it("is ignored when it is not a real icon key", () => {
    expect(resolveIcon({ name: "Haircut Men", icon: "💇" })).toBe("haircut");
    expect(resolveIcon({ name: "Haircut Men", icon: "scissors" })).toBe("haircut");
  });
});

describe("the override is an ordinary field", () => {
  it("survives the sync three-way merge without any special handling", () => {
    // Guard for Phase 4.3: `icon` needs no case in mergeRemote. A field the owner changed
    // locally is applied on top of whatever the cloud has, like price or duration.
    const base = { s1: { id: "s1", name: "Haircut Men", price: 250, icon: "💇" } };
    const ours = { s1: { ...base.s1, icon: "mehendi" } };                 // this device: chose an icon
    const theirs = { s1: { ...base.s1, price: 300 } };                    // other device: raised the price
    const merged = mergeRemote(base, theirs, ours);
    expect(merged.s1).toEqual({ id: "s1", name: "Haircut Men", price: 300, icon: "mehendi" });
    expect(resolveIcon(merged.s1)).toBe("mehendi");
  });

  it("loses to a remote override only when this device did not touch it", () => {
    const base = { s1: { id: "s1", name: "Haircut Men", icon: "💇" } };
    const theirs = { s1: { ...base.s1, icon: "bridal" } };
    const merged = mergeRemote(base, theirs, { s1: { ...base.s1 } });
    expect(resolveIcon(merged.s1)).toBe("bridal");
  });
});

describe("printed receipts are left alone", () => {
  it("bills an emoji, never an icon key — a receipt cannot print 'manicure'", () => {
    const withOverride = { id: "s1", name: "Nail Cut & File", category: "Nails", price: 200, icon: "manicure" };
    expect(serviceToCartLine(withOverride).icon).toBe(serviceIconFor("Nails"));
    // The legacy emoji still wins where there is no override.
    expect(serviceToCartLine({ ...withOverride, icon: "✂️" }).icon).toBe("✂️");
    expect(serviceToCartLine({ ...withOverride, icon: "" }).icon).toBe(serviceIconFor("Nails"));
  });
});

describe("resolveIcon — inventory items", () => {
  it("splits retail from backbar on stockType, whatever the bottle is called", () => {
    expect(resolveIcon({ name: "Professional Shampoo 300ml", stockType: "retail" })).toBe("retailProduct");
    expect(resolveIcon({ name: "Backbar Shampoo 5L", stockType: "backbar" })).toBe("backbarProduct");
  });

  it("still lets an explicit override through", () => {
    expect(resolveIcon({ name: "Rica Wax Tin 800ml", stockType: "backbar", icon: "waxing" })).toBe("waxing");
  });
});
