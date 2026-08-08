import { describe, it, expect } from "vitest";
import {
  ROLES,
  ACTIONS,
  can,
  isRole,
  resolveRole,
  isBootstrap,
  blankUser,
  validateUserChange,
  GRANTABLE,
  CONFIGURABLE_ROLES,
  ACTION_LABELS,
  FEATURE_GROUPS,
  roleDefaults,
  effectivePermissions,
  sanitizePermissions,
} from "./roles.js";

// Actions a worker must NEVER reach — not by default, and not even if the owner (or a
// hand-edited config) tries to switch them on, because database.rules.json refuses them
// server-side. This list is the spec: anything here becoming reachable is a security
// regression and these tests are what catch it.
const NEVER_DELEGABLE = [
  "finance.view",
  "stats.view",
  "expenses.manage",
  "vendorBills.manage",
  "services.manage",
  "staff.manage",
  "staff.payouts",
  "loyalty.configure",
  "packages.manage",
  "reminders.templates",
  "settings.manage",
  "users.manage",
  "backup.use",
  "sales.delete",
];

// Withheld from workers by DEFAULT, but the owner is allowed to hand these out from
// Settings → Users & roles → Feature access, because the rules already permit them.
const OFF_BY_DEFAULT = [
  "udhari.manage",
  "reminders.use",
  "logs.view",
  "customers.browse",
  "sales.edit",
  "billing.backdate",
];

// What a worker cannot do with the built-in matrix alone — the union of the two above.
const OWNER_ONLY = [...NEVER_DELEGABLE, ...OFF_BY_DEFAULT];

describe("isRole", () => {
  it("accepts the three known roles", () => {
    expect(ROLES).toEqual(["owner", "biller", "inventory"]);
    ROLES.forEach((r) => expect(isRole(r)).toBe(true));
  });

  it("rejects anything else", () => {
    [undefined, null, "", "admin", "Owner", "staff", 0, {}].forEach((r) =>
      expect(isRole(r)).toBe(false)
    );
  });
});

describe("can — owner", () => {
  it("is allowed every declared action", () => {
    ACTIONS.forEach((a) => expect(can("owner", a)).toBe(true));
  });

  it("is allowed a newly added action by default (owner is never locked out)", () => {
    // owner grants are `null` (= everything) rather than an enumerated list, so adding
    // an action to ACTIONS cannot accidentally exclude the owner.
    expect(can("owner", ACTIONS[ACTIONS.length - 1])).toBe(true);
  });
});

describe("can — biller", () => {
  it("can run the POS and take appointments", () => {
    [
      "billing.use",
      "billing.discount",
      "appointments.view",
      "appointments.edit",
      "customers.pick",
      "sales.view",
    ].forEach((a) => expect(can("biller", a)).toBe(true));
  });

  it("cannot reach any owner-only action", () => {
    OWNER_ONLY.forEach((a) => expect(can("biller", a)).toBe(false));
  });

  it("cannot touch inventory duties", () => {
    ["inventory.edit", "alerts.view", "barcode.use", "import.use"].forEach((a) =>
      expect(can("biller", a)).toBe(false)
    );
  });

  it("can look up a customer to bill them but cannot browse the customer database", () => {
    expect(can("biller", "customers.pick")).toBe(true);
    expect(can("biller", "customers.browse")).toBe(false);
  });

  it("can view a sale to reprint it but cannot edit or delete it", () => {
    expect(can("biller", "sales.view")).toBe(true);
    expect(can("biller", "sales.edit")).toBe(false);
    expect(can("biller", "sales.delete")).toBe(false);
  });
});

describe("can — inventory", () => {
  it("is a strict superset of biller", () => {
    ACTIONS.filter((a) => can("biller", a)).forEach((a) =>
      expect(can("inventory", a)).toBe(true)
    );
  });

  it("adds exactly the stock duties and nothing more", () => {
    const extra = ACTIONS.filter((a) => can("inventory", a) && !can("biller", a));
    expect(extra.sort()).toEqual(
      ["alerts.view", "barcode.use", "import.use", "inventory.edit", "inventory.view"].sort()
    );
  });

  it("cannot reach any owner-only action", () => {
    OWNER_ONLY.forEach((a) => expect(can("inventory", a)).toBe(false));
  });
});

describe("can — fails closed", () => {
  it("denies unknown roles", () => {
    ACTIONS.forEach((a) => {
      expect(can("admin", a)).toBe(false);
      expect(can(null, a)).toBe(false);
      expect(can(undefined, a)).toBe(false);
    });
  });

  it("denies unknown actions for every role, including owner", () => {
    ROLES.forEach((r) => {
      expect(can(r, "totally.made.up")).toBe(false);
      expect(can(r, "")).toBe(false);
      expect(can(r, undefined)).toBe(false);
    });
  });
});

describe("resolveRole", () => {
  it("returns the role for an active user", () => {
    expect(resolveRole({ role: "biller", active: true })).toBe("biller");
  });

  it("treats a missing `active` flag as active (legacy records)", () => {
    expect(resolveRole({ role: "inventory" })).toBe("inventory");
  });

  it("returns null for a deactivated user", () => {
    expect(resolveRole({ role: "owner", active: false })).toBe(null);
  });

  it("returns null for a missing record or an unknown role", () => {
    expect(resolveRole(null)).toBe(null);
    expect(resolveRole(undefined)).toBe(null);
    expect(resolveRole({})).toBe(null);
    expect(resolveRole({ role: "superuser", active: true })).toBe(null);
  });
});

describe("isBootstrap", () => {
  it("is true only when no users exist at all", () => {
    expect(isBootstrap(null)).toBe(true);
    expect(isBootstrap(undefined)).toBe(true);
    expect(isBootstrap({})).toBe(true);
  });

  it("is false once anyone is registered", () => {
    expect(isBootstrap({ u1: { role: "owner", active: true } })).toBe(false);
    // Even if the only user is deactivated, the shop is past bootstrap — otherwise
    // deactivating everyone would re-open self-registration to the next stranger.
    expect(isBootstrap({ u1: { role: "owner", active: false } })).toBe(false);
  });
});

describe("blankUser", () => {
  it("defaults to the least-privileged role", () => {
    const u = blankUser("2026-07-17");
    expect(u.role).toBe("biller");
    expect(can(u.role, "settings.manage")).toBe(false);
    expect(u.active).toBe(true);
    expect(u.createdAt).toBe("2026-07-17");
  });
});

describe("validateUserChange — the owner cannot orphan the shop", () => {
  const soleOwner = { u1: { email: "a@x.com", role: "owner", active: true } };
  const twoOwners = {
    u1: { email: "a@x.com", role: "owner", active: true },
    u2: { email: "b@x.com", role: "owner", active: true },
  };

  it("blocks demoting the only active owner", () => {
    expect(validateUserChange(soleOwner, "u1", { role: "biller", active: true })).toMatch(
      /only active owner/i
    );
  });

  it("blocks deactivating the only active owner", () => {
    expect(validateUserChange(soleOwner, "u1", { role: "owner", active: false })).toMatch(
      /only active owner/i
    );
  });

  it("allows demoting an owner when another active owner remains", () => {
    expect(validateUserChange(twoOwners, "u1", { role: "biller", active: true })).toBe(null);
  });

  it("does not count a deactivated owner as a remaining owner", () => {
    const users = {
      u1: { role: "owner", active: true },
      u2: { role: "owner", active: false },
    };
    expect(validateUserChange(users, "u1", { role: "biller", active: true })).toMatch(
      /only active owner/i
    );
  });

  it("allows an owner to keep being an owner (no-op edits pass)", () => {
    expect(validateUserChange(soleOwner, "u1", { role: "owner", active: true })).toBe(null);
  });

  it("allows changing a non-owner freely", () => {
    const users = { ...soleOwner, u2: { role: "biller", active: true } };
    expect(validateUserChange(users, "u2", { role: "inventory", active: true })).toBe(null);
    expect(validateUserChange(users, "u2", { role: "biller", active: false })).toBe(null);
  });

  it("allows adding a brand-new user", () => {
    expect(validateUserChange(soleOwner, "newUid", { role: "owner", active: true })).toBe(null);
  });
});

// ── Settings → Feature access: the owner's per-role switches ───────────────────────────
// These are the guarantees the panel rests on. The important one is not "a toggle works" —
// it is that a toggle can never reach past what database.rules.json already permits, so the
// UI cannot offer a switch that appears to work and then fails at the counter.

describe("GRANTABLE — the envelope the owner may move features inside", () => {
  it("covers exactly the worker roles; the owner has nothing to configure", () => {
    expect(CONFIGURABLE_ROLES).toEqual(["biller", "inventory"]);
    expect(GRANTABLE.owner).toBeUndefined();
  });

  it("only ever names real actions", () => {
    CONFIGURABLE_ROLES.forEach((r) =>
      GRANTABLE[r].forEach((a) => expect(ACTIONS).toContain(a))
    );
  });

  it("is a superset of what the role already holds — every default is switchable OFF", () => {
    // If a default sat outside the envelope, the panel would show it ticked and refuse to
    // untick it, which reads as a broken checkbox.
    CONFIGURABLE_ROLES.forEach((r) =>
      roleDefaults(r).forEach((a) => expect(GRANTABLE[r]).toContain(a))
    );
  });

  it("excludes every action the database refuses a worker", () => {
    CONFIGURABLE_ROLES.forEach((r) =>
      NEVER_DELEGABLE.forEach((a) => expect(GRANTABLE[r]).not.toContain(a))
    );
  });

  it("keeps stock WRITES out of the biller's envelope — shop/items is owner|inventory", () => {
    ["inventory.edit", "barcode.use", "import.use"].forEach((a) => {
      expect(GRANTABLE.biller).not.toContain(a);
      expect(GRANTABLE.inventory).toContain(a);
    });
  });

  it("keeps the money slices out of both, so sync.js readableSlices never has to know", () => {
    // readableSlices() gates expenses/vendorBills/dailyBills on the bare role. That stays
    // correct only while no money action is switchable.
    ["expenses.manage", "vendorBills.manage"].forEach((a) =>
      CONFIGURABLE_ROLES.forEach((r) => expect(GRANTABLE[r]).not.toContain(a))
    );
  });
});

describe("can — with the owner's switches", () => {
  it("is unchanged when there are no switches", () => {
    // The regression that matters most: a shop that never opens the panel must behave
    // exactly as it did before the panel existed.
    [undefined, null, {}, { biller: {} }, "nonsense", 7].forEach((overrides) =>
      ROLES.forEach((r) =>
        ACTIONS.forEach((a) => expect(can(r, a, overrides)).toBe(can(r, a)))
      )
    );
  });

  it("grants a withheld feature when the owner switches it on", () => {
    const perms = { biller: { "customers.browse": true, "sales.edit": true } };
    expect(can("biller", "customers.browse", perms)).toBe(true);
    expect(can("biller", "sales.edit", perms)).toBe(true);
    // and leaves the rest of the role alone
    expect(can("biller", "sales.delete", perms)).toBe(false);
    expect(can("biller", "billing.use", perms)).toBe(true);
  });

  it("revokes a default feature when the owner switches it off", () => {
    const perms = { biller: { "billing.discount": false, "appointments.edit": false } };
    expect(can("biller", "billing.discount", perms)).toBe(false);
    expect(can("biller", "appointments.edit", perms)).toBe(false);
    expect(can("biller", "appointments.view", perms)).toBe(true);
  });

  it("applies each role's switches only to that role", () => {
    const perms = { inventory: { "logs.view": true } };
    expect(can("inventory", "logs.view", perms)).toBe(true);
    expect(can("biller", "logs.view", perms)).toBe(false);
  });

  it("IGNORES a switch for anything outside that role's envelope", () => {
    // The fail-closed case that matters: a permissions blob hand-edited into the Firebase
    // console must not be able to grant what the security rules would refuse anyway.
    const forged = Object.fromEntries(
      CONFIGURABLE_ROLES.map((r) => [r, Object.fromEntries(NEVER_DELEGABLE.map((a) => [a, true]))])
    );
    CONFIGURABLE_ROLES.forEach((r) =>
      NEVER_DELEGABLE.forEach((a) => expect(can(r, a, forged)).toBe(false))
    );
  });

  it("cannot restrict the owner — no setting locks an owner out of their own shop", () => {
    const hostile = { owner: Object.fromEntries(ACTIONS.map((a) => [a, false])) };
    ACTIONS.forEach((a) => expect(can("owner", a, hostile)).toBe(true));
  });

  it("still fails closed on unknown roles, unknown actions and non-boolean switches", () => {
    const perms = { biller: { "customers.browse": "yes", "sales.edit": 1, "logs.view": null } };
    expect(can("admin", "billing.use", { admin: { "billing.use": true } })).toBe(false);
    expect(can("biller", "totally.made.up", { biller: { "totally.made.up": true } })).toBe(false);
    // A non-boolean is not an instruction — fall back to the default.
    ["customers.browse", "sales.edit", "logs.view"].forEach((a) =>
      expect(can("biller", a, perms)).toBe(false)
    );
  });
});

describe("effectivePermissions", () => {
  it("with no switches, matches the built-in defaults exactly", () => {
    CONFIGURABLE_ROLES.forEach((r) =>
      expect(effectivePermissions(r).sort()).toEqual(roleDefaults(r).sort())
    );
  });

  it("reflects a grant and a revocation together", () => {
    const perms = { biller: { "customers.browse": true, "billing.discount": false } };
    const got = effectivePermissions("biller", perms);
    expect(got).toContain("customers.browse");
    expect(got).not.toContain("billing.discount");
  });

  it("gives the owner everything", () => {
    expect(effectivePermissions("owner")).toEqual(ACTIONS);
  });
});

describe("sanitizePermissions", () => {
  it("returns an empty map for anything that isn't a permissions blob", () => {
    [undefined, null, "", 0, [], "x", { biller: "nope" }].forEach((raw) =>
      expect(sanitizePermissions(raw)).toEqual({})
    );
  });

  it("keeps booleans inside the envelope and drops everything else", () => {
    const raw = {
      biller: {
        "customers.browse": true, // in the envelope → kept
        "expenses.manage": true, // owner-only → dropped
        "inventory.edit": true, // inventory's envelope, not biller's → dropped
        "sales.view": "yes", // not a boolean → dropped
        "made.up": true, // not an action → dropped
      },
      owner: { "billing.use": false }, // the owner isn't configurable → dropped
      stranger: { "billing.use": false }, // not a role → dropped
    };
    expect(sanitizePermissions(raw)).toEqual({ biller: { "customers.browse": true } });
  });

  it("round-trips a clean map unchanged", () => {
    const clean = { biller: { "sales.edit": true }, inventory: { "import.use": false } };
    expect(sanitizePermissions(clean)).toEqual(clean);
  });
});

describe("the Feature access panel's own metadata", () => {
  it("labels every switchable action", () => {
    new Set([...GRANTABLE.biller, ...GRANTABLE.inventory]).forEach((a) => {
      expect(ACTION_LABELS[a], `no label for ${a}`).toBeTruthy();
      expect(ACTION_LABELS[a].label).toBeTruthy();
    });
  });

  it("lists every switchable action in exactly one group", () => {
    const grouped = FEATURE_GROUPS.flatMap((g) => g.actions);
    expect(new Set(grouped).size).toBe(grouped.length); // no duplicates
    expect(grouped.sort()).toEqual([...new Set([...GRANTABLE.biller, ...GRANTABLE.inventory])].sort());
  });
});
