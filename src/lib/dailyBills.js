// Daily-Need-Bills — day-to-day vendor bills for daily-need purchases.
//
// This slice (shop/dailyBills) is the SINGLE SOURCE OF TRUTH for daily-need data; it carries
// a few fields the Vendor Bills slice doesn't (paymentMethod, billNumber, notes). Every entry
// is MIRRORED into the existing `vendorBills` slice so both views stay in sync without a second
// hand-entry. The mirror reuses the SAME id (deterministic 1:1 link) and is stamped
// source: "daily-need" so it's traceable and never duplicated.
//
// All functions here are PURE (no Firebase, no Date.now) so they unit-test cleanly; the React
// layer supplies ids/timestamps and pushes both slices through the normal sync.js pipeline.

// Round money to 2dp, mirroring the app's `money()` helper (kept local so this module is pure).
export const dailyMoney = (n) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round((v + Number.EPSILON) * 100) / 100 : 0;
};

// Line total from quantity × unit price (0 unless BOTH are positive). When it applies, this is
// the authoritative bill total, so the Amount field auto-reflects it.
export const lineTotal = (qty, unitPrice) => {
  const q = Number(qty), p = Number(unitPrice);
  return q > 0 && p > 0 ? dailyMoney(q * p) : 0;
};
// The bill total that actually applies: qty × price when both are given, else the typed amount.
export const effectiveAmount = (form) => {
  const lt = lineTotal(form.qty, form.unitPrice);
  return lt > 0 ? lt : dailyMoney(form.billAmount);
};

export const PAYMENT_METHODS = ["Cash", "UPI", "Bank Transfer", "Credit", "Cheque"];
export const PAYMENT_STATUS = ["Paid", "Pending", "Partial"];
export const DAILY_CATEGORIES = ["Water-Bottles", "Dairy-Milk-Dahi", "Bakery-BreadnAll", "Dairy", "Vegetables", "Groceries", "Packaging", "Other"];

// Suggested items per category — the Item field is driven by the chosen category. This is a
// seed catalogue; the field still accepts free text so new items can be typed without a code
// change. Categories not listed here simply have no suggestions (free text only).
export const DAILY_ITEMS = {
  "Water-Bottles": ["Water Bootle - 20ltr"],
  "Dairy-Milk-Dahi": [
    "Amul Milk - 0.5ltr",
    "Chitale Milk - 0.5ltr",
    "Gokul Milk - 0.5ltr",
    "Chitale Dahi - 400gm",
    "Taak - 500ml",
  ],
};
// Items suggested for a category (empty array when none are seeded yet).
export const itemsForCategory = (cat) => DAILY_ITEMS[cat] || [];

// A daily-need purchase is always a stock purchase from the Vendor-Bills taxonomy's point of
// view; Packaging is the one category both taxonomies share, so it maps straight across.
// (Any category not listed here still falls back to "Stock purchase" in dailyToVendorBill.)
export const DAILY_TO_BILL_CATEGORY = {
  Packaging: "Packaging",
  "Water-Bottles": "Stock purchase",
  "Dairy-Milk-Dahi": "Stock purchase",
  "Bakery-BreadnAll": "Stock purchase",
  Dairy: "Stock purchase",
  Vegetables: "Stock purchase",
  Groceries: "Stock purchase",
  Other: "Stock purchase",
};

// paymentStatus (Paid|Pending|Partial) → vendorBills status (paid|partial|unpaid).
export const DAILY_TO_BILL_STATUS = { Paid: "paid", Pending: "unpaid", Partial: "partial" };
// …and back, for propagating a Vendor-Bills-side status edit onto the daily record.
export const BILL_TO_DAILY_STATUS = { paid: "Paid", unpaid: "Pending", partial: "Partial" };

// Blank form defaults. `date`/`today` are injected so this stays pure & testable.
// Defaults to the first category so its item suggestions show immediately.
export const blankDailyBill = (today = "") => ({
  category: DAILY_CATEGORIES[0],
  itemName: "",
  qty: "",
  unitPrice: "",
  vendorName: "",
  billAmount: "",
  paymentMethod: PAYMENT_METHODS[0],
  paymentStatus: PAYMENT_STATUS[0],
  paidAmount: "",
  date: today,
  billNumber: "",
  notes: "",
});

// Validate a form. Returns an error string, or "" when valid.
export function validateDailyBill(form) {
  if (!String(form.vendorName || "").trim()) return "Vendor name is required.";
  const amount = effectiveAmount(form);
  if (!(amount > 0)) return "Enter a bill amount greater than 0 (or set item price and qty).";
  if (!PAYMENT_METHODS.includes(form.paymentMethod)) return "Pick a valid payment method.";
  if (!PAYMENT_STATUS.includes(form.paymentStatus)) return "Pick a valid payment status.";
  if (form.paymentStatus === "Partial") {
    const paid = Number(form.paidAmount);
    if (!(paid > 0)) return "Enter how much has been paid so far.";
    if (paid >= amount) return "Paid-so-far must be less than the bill amount for a partial bill.";
  }
  return "";
}

// How much is still owed on a daily bill (paid → 0, partial → amount − paid, pending → full).
export function dailyOutstanding(b) {
  const amt = Number(b.billAmount) || 0;
  if (b.paymentStatus === "Paid") return 0;
  if (b.paymentStatus === "Partial") return Math.max(0, amt - (Number(b.paidAmount) || 0));
  return amt;
}

// Build a clean daily-bill record from a form. `id`/`now` are injected by the caller.
// `existing` (on edit) preserves createdAt.
export function makeDailyBill(form, { id, now, existing } = {}) {
  const amount = effectiveAmount(form); // qty × price when both set, else the typed amount
  const status = form.paymentStatus;
  const qtyNum = Number(form.qty);
  const priceNum = Number(form.unitPrice);
  return {
    id,
    vendorName: String(form.vendorName || "").trim(),
    billAmount: amount,
    unitPrice: Number.isFinite(priceNum) && priceNum > 0 ? dailyMoney(priceNum) : 0, // 0 = not specified
    paymentMethod: form.paymentMethod,
    paymentStatus: status,
    // paidAmount is only meaningful for a partial bill; paid → full, pending → 0.
    paidAmount: status === "Partial" ? dailyMoney(form.paidAmount || 0) : status === "Paid" ? amount : 0,
    date: form.date,
    category: form.category || "Other",
    itemName: String(form.itemName || "").trim(),
    qty: Number.isFinite(qtyNum) && qtyNum > 0 ? qtyNum : 0, // 0 = not specified
    billNumber: String(form.billNumber || "").trim(),
    notes: String(form.notes || "").trim(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    source: "daily-need",
  };
}

// Map a daily-need record → its mirrored vendorBills record (SAME id, marked & back-linked).
// The extra daily-only fields ride along so a backup/export never loses them.
export function dailyToVendorBill(d) {
  return {
    id: d.id,
    vendor: d.vendorName,
    date: d.date,
    amount: dailyMoney(d.billAmount),
    category: DAILY_TO_BILL_CATEGORY[d.category] || "Stock purchase",
    status: DAILY_TO_BILL_STATUS[d.paymentStatus] || "unpaid",
    paidAmount: Number(d.paidAmount) || 0,
    dueDate: "",
    // Traceability + the daily-only extras (Vendor Bills won't show them, but they survive).
    source: "daily-need",
    sourceId: d.id,
    paymentMethod: d.paymentMethod,
    itemName: d.itemName || "",
    qty: d.qty || 0,
    unitPrice: d.unitPrice || 0,
    billNumber: d.billNumber || "",
    notes: d.notes || "",
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

// Upsert a mirror into a vendorBills array (replace the row with the same id, else append).
export function upsertMirror(bills, mirror) {
  const i = bills.findIndex((b) => b.id === mirror.id);
  if (i === -1) return [...bills, mirror];
  const next = bills.slice();
  next[i] = { ...bills[i], ...mirror };
  return next;
}

// Propagate a Vendor-Bills-side edit of a synced row back onto its daily record, so editing
// from either side stays consistent. Only the cleanly-reversible fields are carried back;
// category is left alone (the daily taxonomy is finer-grained than the bill taxonomy).
export function applyVendorEditToDaily(daily, vb, now) {
  return {
    ...daily,
    vendorName: vb.vendor ?? daily.vendorName,
    date: vb.date ?? daily.date,
    billAmount: dailyMoney(vb.amount),
    paymentStatus: BILL_TO_DAILY_STATUS[vb.status] || daily.paymentStatus,
    paidAmount: Number(vb.paidAmount) || 0,
    updatedAt: now,
  };
}
