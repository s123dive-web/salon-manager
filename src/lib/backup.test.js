import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { buildWorkbook, parseWorkbook } from "./backup.js";

// Round-trip through a real .xlsx byte buffer (not just the in-memory workbook), so the test
// exercises the exact serialisation the download/restore path uses — cell types included.
const roundTrip = (data) => parseWorkbook(XLSX.read(XLSX.write(buildWorkbook(data), { type: "buffer", bookType: "xlsx" }), { type: "buffer" }));

// A fixture that touches every field a restore must preserve.
const fixture = () => ({
  items: [
    {
      id: "itm1", name: "Amul Milk 500ml", code: "8901234567890", barcodes: ["123", "456"],
      category: "Dairy", unit: "packet", buyPrice: 25, sellPrice: 30, mrp: 32, stock: 12, lowAt: 5,
      icon: "🥛", createdAt: "2026-07-01", updatedAt: "2026-07-05",
      batches: [
        { id: "b1", qty: 7, expiry: "2026-07-10", addedOn: "2026-07-04" },
        { id: "b2", qty: 5, expiry: "2026-07-12", addedOn: "2026-07-05" },
      ],
    },
    // No batches, no mrp, no icon — must stay that way (no fields invented on restore).
    { id: "itm2", name: "Loose Sugar", code: "", barcodes: [], category: "Grocery", unit: "kg", buyPrice: 40, sellPrice: 48, stock: 0, lowAt: 3, batches: [], createdAt: "2026-07-02", updatedAt: "2026-07-02" },
  ],
  sales: [
    // Plain UPI bill — must NOT gain customer/paid/discount fields on restore.
    {
      id: "sale1", date: "2026-07-05", time: "11:20 am",
      lines: [{ name: "Amul Milk 500ml", qty: 2, unit: "packet", price: 30, buyPrice: 25, amount: 60 }],
      total: 60, profit: 10, payment: "UPI",
    },
    // Udhari bill with a part-payment, a discount, and a two-entry repayment ledger.
    {
      id: "sale2", date: "2026-07-06", time: "6:45 pm",
      lines: [
        { name: "Loose Sugar", qty: 3, unit: "kg", price: 48, buyPrice: 40, amount: 144 },
        { name: "Delivery", qty: 1, unit: "pc", price: 20, buyPrice: 0, amount: 20, misc: true },
      ],
      subtotal: 164, discount: 14, discountPct: 8.54, total: 150, profit: 44,
      payment: "Udhari", customer: "Ramesh", mobile: "9876543210",
      paid: 50, paidMode: "Cash",
      payments: [
        { id: "p1", date: "2026-07-06", time: "6:45 pm", amount: 30, mode: "Cash" },
        { id: "p2", date: "2026-07-08", time: "10:00 am", amount: 20, mode: "UPI" },
      ],
    },
  ],
  expenses: [{ id: "e1", date: "2026-07-01", desc: "Shelving", amount: 5000 }],
  logs: [{ id: "l1", at: 1720000000000, date: "2026-07-05", time: "11:20 am", type: "sale", message: "Bill ₹60" }],
  vendorBills: [
    { id: "vb1", vendor: "Metro Cash", date: "2026-07-03", amount: 8000, category: "Stock purchase", status: "partial", paidAmount: 3000, dueDate: "2026-07-20", fileName: "bill.pdf", fileURL: "https://x/y", filePath: "bills/vb1" },
    // A daily-need mirror row carrying the daily-only extras.
    { id: "db1", vendor: "Chitale", date: "2026-07-06", amount: 300, category: "Stock purchase", status: "paid", paidAmount: 300, dueDate: "", fileName: "", fileURL: "", filePath: "", source: "daily-need", sourceId: "db1", paymentMethod: "Cash", itemName: "Chitale Milk", qty: 10, unitPrice: 30, billNumber: "C-9", notes: "morning", createdAt: 1720200000000, updatedAt: 1720200000000 },
  ],
  dailyBills: [
    { id: "db1", vendorName: "Chitale", date: "2026-07-06", billAmount: 300, paymentMethod: "Cash", paymentStatus: "Paid", paidAmount: 300, category: "Dairy-Milk-Dahi", itemName: "Chitale Milk", qty: 10, unitPrice: 30, billNumber: "C-9", notes: "morning", createdAt: 1720200000000, updatedAt: 1720200000000, source: "daily-need" },
  ],
  customCats: ["Frozen Snacks", "Pooja Items"],
});

describe("backup XLSX round-trip", () => {
  it("preserves inventory batches, expiry, mrp and icon", () => {
    const { items } = roundTrip(fixture());
    const m = items.find((i) => i.id === "itm1");
    expect(m.batches).toEqual([
      { id: "b1", qty: 7, expiry: "2026-07-10", addedOn: "2026-07-04" },
      { id: "b2", qty: 5, expiry: "2026-07-12", addedOn: "2026-07-05" },
    ]);
    expect(m.mrp).toBe(32);
    expect(m.icon).toBe("🥛");
    expect(m.barcodes).toEqual(["123", "456"]);
  });

  it("does not invent batches/mrp/icon on an item that never had them", () => {
    const { items } = roundTrip(fixture());
    const s = items.find((i) => i.id === "itm2");
    expect(s.batches).toEqual([]);
    expect(s).not.toHaveProperty("mrp");
    expect(s).not.toHaveProperty("icon");
  });

  it("fully preserves udhari credit: payment, customer, paid, and the repayment ledger", () => {
    const { sales } = roundTrip(fixture());
    const u = sales.find((s) => s.id === "sale2");
    expect(u.payment).toBe("Udhari");
    expect(u.customer).toBe("Ramesh");
    expect(u.mobile).toBe("9876543210");
    expect(u.paid).toBe(50);
    expect(u.paidMode).toBe("Cash");
    expect(u.payments).toEqual([
      { id: "p1", date: "2026-07-06", time: "6:45 pm", amount: 30, mode: "Cash" },
      { id: "p2", date: "2026-07-08", time: "10:00 am", amount: 20, mode: "UPI" },
    ]);
    // Outstanding (total − paid) reconstructs correctly — the whole point of the backup.
    expect(u.total - u.paid).toBe(100);
  });

  it("preserves per-bill discount fields and per-line buyPrice / misc marker", () => {
    const { sales } = roundTrip(fixture());
    const u = sales.find((s) => s.id === "sale2");
    expect(u.subtotal).toBe(164);
    expect(u.discount).toBe(14);
    expect(u.discountPct).toBe(8.54);
    expect(u.lines[0].buyPrice).toBe(40);
    expect(u.lines[1].misc).toBe(true);
    expect(u.lines[0]).not.toHaveProperty("misc");
  });

  it("keeps a plain UPI bill plain (no udhari/discount fields invented)", () => {
    const { sales } = roundTrip(fixture());
    const p = sales.find((s) => s.id === "sale1");
    expect(p.payment).toBe("UPI");
    expect(p).not.toHaveProperty("customer");
    expect(p).not.toHaveProperty("paid");
    expect(p).not.toHaveProperty("subtotal");
    expect(p).not.toHaveProperty("discount");
    expect(p.lines[0].buyPrice).toBe(25);
  });

  it("preserves expenses, logs, vendor bills and daily-bill extras", () => {
    const { expenses, logs, vendorBills, dailyBills } = roundTrip(fixture());
    expect(expenses).toEqual([{ id: "e1", date: "2026-07-01", desc: "Shelving", amount: 5000 }]);
    expect(logs[0]).toMatchObject({ id: "l1", at: 1720000000000, type: "sale", message: "Bill ₹60" });
    const mirror = vendorBills.find((b) => b.id === "db1");
    expect(mirror.source).toBe("daily-need");
    expect(mirror.itemName).toBe("Chitale Milk");
    expect(mirror.notes).toBe("morning");
    const daily = dailyBills.find((b) => b.id === "db1");
    expect(daily).toMatchObject({ vendorName: "Chitale", billNumber: "C-9", qty: 10, unitPrice: 30, notes: "morning", source: "daily-need" });
  });

  it("preserves owner-added categories that have no item yet", () => {
    const { customCats } = roundTrip(fixture());
    expect(customCats).toEqual(["Frozen Snacks", "Pooja Items"]);
  });

  it("handles a completely empty store without crashing", () => {
    const out = roundTrip({});
    expect(out).toEqual({ items: [], sales: [], expenses: [], logs: [], vendorBills: [], dailyBills: [], customCats: [] });
  });

  it("still reads a legacy workbook that lacks the new sheets/columns", () => {
    // Simulate an older backup: only Items (no mrp/icon/batches) and Sales (old columns, no payment).
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ id: "x1", name: "Old Item", code: "", barcodes: "", category: "Grocery", unit: "pc", buyPrice: 10, sellPrice: 15, stock: 4, lowAt: 5, createdAt: "", updatedAt: "" }]), "Items");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ billId: "o1", date: "2026-01-01", time: "9:00 am", item: "Old Item", qty: 1, unit: "pc", price: 15, amount: 15, billTotal: 15, billProfit: 5 }]), "Sales");
    const { items, sales } = parseWorkbook(XLSX.read(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }), { type: "buffer" }));
    expect(items[0]).toMatchObject({ id: "x1", name: "Old Item", batches: [] });
    expect(sales[0]).toMatchObject({ id: "o1", total: 15, profit: 5 });
    expect(sales[0]).not.toHaveProperty("payment");
    expect(sales[0].lines[0]).toMatchObject({ name: "Old Item", qty: 1 });
  });
});
