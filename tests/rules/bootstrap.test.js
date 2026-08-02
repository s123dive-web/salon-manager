/**
 * Bootstrap and lockout assertions.
 *
 * The bootstrap rule is the one place the rules deliberately open up: while shop/users is
 * empty, an authenticated user may claim their own uid as owner. Getting this wrong in
 * either direction is severe — too tight and the shop can never be claimed without a
 * console visit, too loose and anyone can seize a live shop.
 *
 * `useRulesHarness({ seed: false })` leaves shop/users EMPTY after each clear; specs that
 * need a populated roster call seedUsers() themselves.
 */
import { describe, it, expect } from "vitest";
import { ref, get, set } from "firebase/database";
import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import {
  UID,
  USERS,
  asOwner,
  asUser,
  asUnauth,
  seed,
  seedUsers,
  readAsAdmin,
  useRulesHarness,
} from "./setup.js";

useRulesHarness({ seed: false });

const FIRST_OWNER = "uid-first-owner";
const ownerRecord = (email = "first@salon.test") => ({
  email,
  name: "First Owner",
  role: "owner",
  active: true,
  createdAt: "2026-01-01T09:00:00.000Z",
});

describe("bootstrap: claiming an unowned shop", () => {
  // Phase 3 #1
  it("allows the first authenticated user to self-register as owner while shop/users is empty", async () => {
    expect(await readAsAdmin("shop/users")).toBeNull();

    await assertSucceeds(
      set(ref(asUser(FIRST_OWNER), `shop/users/${FIRST_OWNER}`), ownerRecord()),
    );
    expect(await readAsAdmin(`shop/users/${FIRST_OWNER}/role`)).toBe("owner");
  });

  it("denies claiming a uid that is not your own, even while empty", async () => {
    await assertFails(set(ref(asUser(FIRST_OWNER), `shop/users/${UID.stranger}`), ownerRecord()));
  });

  it("denies self-registering as anything other than an active owner", async () => {
    // role must be 'owner' AND active must be true — a self-registered biller would
    // leave the shop unclaimable by anyone but a console admin.
    await assertFails(
      set(ref(asUser(FIRST_OWNER), `shop/users/${FIRST_OWNER}`), {
        ...ownerRecord(),
        role: "biller",
      }),
    );
    await assertFails(
      set(ref(asUser(FIRST_OWNER), `shop/users/${FIRST_OWNER}`), {
        ...ownerRecord(),
        active: false,
      }),
    );
  });

  // Phase 3 #2
  it("denies the same write once shop/users is non-empty and the actor is a biller", async () => {
    await seedUsers();

    await assertFails(
      set(ref(asUser(UID.biller), `shop/users/${UID.biller}`), {
        email: "biller@salon.test",
        name: "Biller",
        role: "owner",
        active: true,
      }),
    );
    expect(await readAsAdmin(`shop/users/${UID.biller}/role`)).toBe("biller");
  });

  it("denies a brand-new signed-in user registering themselves once the shop is claimed", async () => {
    await seedUsers();

    await assertFails(set(ref(asUser(UID.stranger), `shop/users/${UID.stranger}`), ownerRecord()));
    expect(await readAsAdmin(`shop/users/${UID.stranger}`)).toBeNull();
  });
});

describe("unauthenticated access", () => {
  // Phase 3 #3
  const SLICES = [
    "shop/users",
    "shop/config",
    "shop/items",
    "shop/sales",
    "shop/customers",
    "shop/services",
    "shop/staff",
    "shop/packages",
    "shop/appointments",
    "shop/expenses",
    "shop/vendorBills",
    "shop/dailyBills",
    "shop/logs",
  ];

  it.each(SLICES)("denies an unauthenticated read of %s", async (slice) => {
    await seedUsers();
    await seed(slice, { probe: { value: 1 } });

    await assertFails(get(ref(asUnauth(), slice)));
  });

  it("denies an unauthenticated read of shop/ and of the root", async () => {
    await seedUsers();
    await assertFails(get(ref(asUnauth(), "shop")));
    await assertFails(get(ref(asUnauth(), "/")));
  });

  it("denies an unauthenticated read even while shop/users is empty", async () => {
    // The empty-node read allowance is `auth != null && !data.exists()` — the auth check
    // comes first, so bootstrap does not open a hole for anonymous readers.
    await assertFails(get(ref(asUnauth(), "shop/users")));
  });
});

describe("last-owner lockout", () => {
  // Phase 3 #4 — DOCUMENTED DIVERGENCE.
  //
  // The README states: "The owner can't lock themselves out: demoting or deactivating the
  // last active owner is refused, because there would be nobody left who can manage users
  // and no console-free way back."
  //
  // That is enforced in the APP only. The rule on shop/users/$uid asks one question —
  // "is the actor an active owner?" — and nothing about the resulting state of the node.
  // RTDB rules cannot count siblings matching a predicate (no query-shaped conditions), so
  // "is there another active owner left" is not expressible here; it would need a schema
  // change (e.g. a maintained shop/ownerCount) or a Cloud Function.
  //
  // Asserted as ALLOW to record real behaviour. See FINDING R2 — NOT fixed in the rules,
  // because any fix is a schema change, not a trivially safe edit.

  it("ALLOWS the last active owner to demote themselves to biller (app-layer guard only — FINDING R2)", async () => {
    await seedUsers();
    expect(await readAsAdmin(`shop/users/${UID.owner}/role`)).toBe("owner");

    await assertSucceeds(
      set(ref(asOwner(), `shop/users/${UID.owner}`), {
        ...USERS[UID.owner],
        role: "biller",
      }),
    );

    // The shop now has zero owners: nobody can add users, change config, or read the
    // money slices. Recovery requires the Firebase console.
    const roster = await readAsAdmin("shop/users");
    const owners = Object.values(roster).filter((u) => u.role === "owner" && u.active === true);
    expect(owners).toHaveLength(0);
  });

  it("ALLOWS the last active owner to deactivate themselves (same gap — FINDING R2)", async () => {
    await seedUsers();

    await assertSucceeds(
      set(ref(asOwner(), `shop/users/${UID.owner}`), {
        ...USERS[UID.owner],
        active: false,
      }),
    );

    const roster = await readAsAdmin("shop/users");
    const owners = Object.values(roster).filter((u) => u.role === "owner" && u.active === true);
    expect(owners).toHaveLength(0);
  });

  it("ALLOWS the last active owner to delete their own record (same gap — FINDING R2)", async () => {
    await seedUsers();

    await assertSucceeds(set(ref(asOwner(), `shop/users/${UID.owner}`), null));
    expect(await readAsAdmin(`shop/users/${UID.owner}`)).toBeNull();
  });

  it("a demoted owner really has lost owner powers (the lockout is not cosmetic)", async () => {
    await seedUsers();
    await set(ref(asOwner(), `shop/users/${UID.owner}`), {
      ...USERS[UID.owner],
      role: "biller",
    });

    // Same uid, same session — the rules re-derive the role on every operation.
    await assertFails(set(ref(asOwner(), "shop/config"), { name: "Still in charge?" }));
    await assertFails(get(ref(asOwner(), "shop/expenses")));
  });
});

describe("deactivated users", () => {
  it("denies a deactivated owner everything an active owner could do", async () => {
    await seedUsers({
      ...USERS,
      [UID.owner]: { ...USERS[UID.owner], active: false },
    });

    await assertFails(get(ref(asOwner(), "shop/expenses")));
    await assertFails(set(ref(asOwner(), "shop/config"), { name: "Nope" }));
    await assertFails(set(ref(asOwner(), "shop/items/itm-1"), { name: "Nope" }));
  });

  it("still lets a deactivated user read their OWN record, so the app can explain why", async () => {
    await seedUsers({
      ...USERS,
      [UID.biller]: { ...USERS[UID.biller], active: false },
    });

    await assertSucceeds(get(ref(asUser(UID.biller), `shop/users/${UID.biller}`)));
  });
});
