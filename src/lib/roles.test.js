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
} from "./roles.js";

// The actions a worker must NEVER reach. This list is the spec: if a change to the
// matrix lets a biller or inventory user touch any of these, that is a security
// regression and this test is the thing that catches it.
const OWNER_ONLY = [
  "finance.view",
  "stats.view",
  "expenses.manage",
  "vendorBills.manage",
  "udhari.manage",
  "services.manage",
  "staff.manage",
  "staff.payouts",
  "loyalty.configure",
  "packages.manage",
  "reminders.use",
  "settings.manage",
  "users.manage",
  "backup.use",
  "logs.view",
  "customers.browse",
  "sales.edit",
  "sales.delete",
  "billing.backdate",
];

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
