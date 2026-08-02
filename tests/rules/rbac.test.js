/**
 * RBAC assertions against the real database.rules.json.
 *
 * The question every spec here answers is "what does the DATABASE allow", not "what does
 * the UI offer". src/lib/roles.js is the UI mirror and is tested separately; where the two
 * disagree, the divergence is called out in a comment and in the README.
 */
import { describe, it, expect } from "vitest";
import { ref, get, set } from "firebase/database";
import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import {
  UID,
  asOwner,
  asBiller,
  asInventory,
  seed,
  readAsAdmin,
  useRulesHarness,
} from "./setup.js";

useRulesHarness();

const SALE_ID = "sale-001";
const BILLERS_SALE = {
  total: 500,
  createdBy: UID.biller,
  at: "2026-02-01T10:00:00.000Z",
  items: { line1: { name: "Haircut", price: 500 } },
};

describe("money slices are owner-only", () => {
  // #1
  it("denies a biller reading shop/expenses", async () => {
    await seed("shop/expenses", { exp1: { amount: 1200, note: "electricity" } });
    await assertFails(get(ref(asBiller(), "shop/expenses")));
  });

  // #2
  it("denies a biller reading shop/vendorBills", async () => {
    await seed("shop/vendorBills", { vb1: { vendor: "Loreal", amount: 8000 } });
    await assertFails(get(ref(asBiller(), "shop/vendorBills")));
  });
});

describe("stock", () => {
  // #3
  it("allows an inventory user to write shop/items/<id>", async () => {
    await assertSucceeds(
      set(ref(asInventory(), "shop/items/itm-1"), { name: "Shampoo", stock: 12, price: 450 }),
    );
  });

  // #4
  it("denies a biller writing shop/items/<id>", async () => {
    await assertFails(
      set(ref(asBiller(), "shop/items/itm-1"), { name: "Shampoo", stock: 12, price: 450 }),
    );
  });
});

describe("sales: create/edit vs delete", () => {
  // #5
  it("denies a biller deleting a bill", async () => {
    await seed(`shop/sales/${SALE_ID}`, BILLERS_SALE);
    await assertFails(set(ref(asBiller(), `shop/sales/${SALE_ID}`), null));
    // The bill is still there — the rule refused, it did not silently no-op.
    expect(await readAsAdmin(`shop/sales/${SALE_ID}`)).not.toBeNull();
  });

  // #6
  it("allows an owner deleting a bill", async () => {
    await seed(`shop/sales/${SALE_ID}`, BILLERS_SALE);
    await assertSucceeds(set(ref(asOwner(), `shop/sales/${SALE_ID}`), null));
    expect(await readAsAdmin(`shop/sales/${SALE_ID}`)).toBeNull();
  });

  // #7 — DOCUMENTED DIVERGENCE.
  //
  // The rule on shop/sales/$id is:
  //   active user && (newData.exists() || role === 'owner')
  // `newData.exists()` is what separates a delete from a create/update, so it gates
  // DELETES only. Any active user — biller included — may overwrite an existing bill,
  // including one they did not create.
  //
  // The README's role table lists "Edit or delete a bill" as owner-only, and that is true
  // of the UI (roles.js gates `sales.edit`), but the DATABASE only enforces the delete
  // half. Editing is an app-layer control, not a server-side boundary. Asserted here as
  // ALLOW so the suite documents real behaviour; if this is ever tightened in the rules,
  // this spec is the one that should flip.
  it("ALLOWS a biller to edit an existing bill (delete-only gate — see FINDING R1)", async () => {
    await seed(`shop/sales/${SALE_ID}`, BILLERS_SALE);
    await assertSucceeds(
      set(ref(asBiller(), `shop/sales/${SALE_ID}`), { ...BILLERS_SALE, total: 50 }),
    );
    expect(await readAsAdmin(`shop/sales/${SALE_ID}`)).toMatchObject({ total: 50 });
  });

  it("ALLOWS a biller to edit a bill they did not create (same gate, wider blast radius)", async () => {
    await seed(`shop/sales/${SALE_ID}`, { ...BILLERS_SALE, createdBy: UID.owner });
    await assertSucceeds(
      set(ref(asBiller(), `shop/sales/${SALE_ID}`), { total: 1, createdBy: UID.owner }),
    );
  });
});

describe("owner-only configuration", () => {
  // #8
  it("denies a biller writing shop/config", async () => {
    await assertFails(set(ref(asBiller(), "shop/config"), { name: "Pwned Salon" }));
  });

  // #9
  it("denies a biller writing another user's record", async () => {
    await assertFails(
      set(ref(asBiller(), `shop/users/${UID.stranger}`), {
        email: "mole@salon.test",
        role: "owner",
        active: true,
      }),
    );
    expect(await readAsAdmin(`shop/users/${UID.stranger}`)).toBeNull();
  });

  it("denies a biller promoting themselves to owner", async () => {
    await assertFails(
      set(ref(asBiller(), `shop/users/${UID.biller}`), {
        email: "biller@salon.test",
        role: "owner",
        active: true,
      }),
    );
    expect(await readAsAdmin(`shop/users/${UID.biller}/role`)).toBe("biller");
  });
});

describe("POS read dependencies", () => {
  // #10
  it("allows a biller to read shop/services and shop/customers", async () => {
    await seed("shop/services", { svc1: { name: "Haircut", price: 500 } });
    await seed("shop/customers", { cus1: { name: "Asha", phone: "9990001111" } });

    await assertSucceeds(get(ref(asBiller(), "shop/services")));
    await assertSucceeds(get(ref(asBiller(), "shop/customers")));
  });

  it("still denies a biller WRITING shop/services (read-only catalogue)", async () => {
    await assertFails(set(ref(asBiller(), "shop/services/svc1"), { name: "Free", price: 0 }));
  });
});
