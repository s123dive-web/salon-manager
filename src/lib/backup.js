// JSON and XLSX backup / restore for ALL store data.
//
// GOAL: a backup is a complete, restorable snapshot. If the cloud database is ever lost or
// corrupted, importing either file must rebuild every record the owner ever entered —
// inventory (with batches & expiry), full sales history, udhari/credit (customers, part
// payments and the dated repayment ledger), expenses, vendor & daily bills, logs and
// owner-added categories — with no silent field loss.
//
// JSON is the authoritative lossless format: it serialises the record arrays verbatim.
// XLSX is human-readable in Excel; nested data that doesn't fit one flat grid is split into
// its own sheet keyed back to its parent (Batches→item, Repayments→bill) so the XLSX
// round-trip is lossless too. exportXlsx/importXlsx are thin wrappers over the pure
// buildWorkbook/parseWorkbook so the round-trip can be unit-tested without a file.
import * as XLSX from "xlsx";

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v) => (v == null ? "" : String(v)).trim();
// A spreadsheet cell holds a value when it isn't blank; "0" counts, "" does not. Lets us tell
// "field was absent in this backup" (omit → preserve the record's original shape) from "0".
const has = (v) => v !== undefined && v !== null && String(v) !== "";

// ---- JSON (authoritative, lossless) ----
export function exportJson(data, filename) {
  const blob = new Blob([JSON.stringify({ ...data, exportedAt: new Date().toISOString() }, null, 2)], {
    type: "application/json",
  });
  triggerDownload(blob, filename);
}

// ---- XLSX ----
// Pure: assemble the multi-sheet workbook. Exported for round-trip tests.
export function buildWorkbook({ items = [], sales = [], expenses = [], logs = [], vendorBills = [], dailyBills = [], customCats = [] }) {
  const wb = XLSX.utils.book_new();
  const add = (name, rows, template) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [template]), name);

  // Items — one row per item. Batches live in their own sheet (see below).
  add(
    "Items",
    items.map((i) => ({
      id: i.id, name: i.name, code: i.code || "",
      // Additional barcodes (beyond the primary `code`) as a comma-separated list.
      barcodes: (Array.isArray(i.barcodes) ? i.barcodes : []).filter(Boolean).join(", "),
      category: i.category, unit: i.unit,
      buyPrice: i.buyPrice, sellPrice: i.sellPrice, mrp: i.mrp ?? "", stock: i.stock, lowAt: i.lowAt,
      icon: i.icon || "", createdAt: i.createdAt || "", updatedAt: i.updatedAt || "",
    })),
    { id: "", name: "", code: "", barcodes: "", category: "", unit: "", buyPrice: "", sellPrice: "", mrp: "", stock: "", lowAt: "", icon: "", createdAt: "", updatedAt: "" }
  );

  // Batches — the dated stock detail (qty / expiry / date added) keyed back to its item.
  const batchRows = [];
  items.forEach((i) =>
    (Array.isArray(i.batches) ? i.batches : []).forEach((b) =>
      batchRows.push({ itemId: i.id, batchId: b.id || "", qty: b.qty ?? "", expiry: b.expiry || "", addedOn: b.addedOn || "" })
    )
  );
  add("Batches", batchRows, { itemId: "", batchId: "", qty: "", expiry: "", addedOn: "" });

  // Sales — one row per line item, keyed by Bill ID. Bill-level fields (payment, customer,
  // udhari paid, discount…) repeat across the bill's lines and are read from the first row on
  // import. The dated repayment ledger goes to its own Repayments sheet.
  const saleRows = [];
  sales.forEach((s) =>
    (s.lines || []).forEach((l) =>
      saleRows.push({
        billId: s.id, date: s.date, time: s.time,
        payment: s.payment || "", customer: s.customer || "", mobile: s.mobile || "",
        item: l.name, qty: l.qty, unit: l.unit, price: l.price,
        buyPrice: l.buyPrice ?? "", amount: l.amount, misc: l.misc ? 1 : "",
        subtotal: s.subtotal ?? "", discount: s.discount ?? "", discountPct: s.discountPct ?? "",
        billTotal: s.total, billProfit: s.profit,
        paid: s.paid ?? "", paidMode: s.paidMode || "",
      })
    )
  );
  add(
    "Sales",
    saleRows,
    { billId: "", date: "", time: "", payment: "", customer: "", mobile: "", item: "", qty: "", unit: "", price: "", buyPrice: "", amount: "", misc: "", subtotal: "", discount: "", discountPct: "", billTotal: "", billProfit: "", paid: "", paidMode: "" }
  );

  // Repayments — the dated udhari repayment ledger (who paid how much, when, how), keyed to the bill.
  const repayRows = [];
  sales.forEach((s) =>
    (Array.isArray(s.payments) ? s.payments : []).forEach((p) =>
      repayRows.push({ billId: s.id, paymentId: p.id || "", date: p.date || "", time: p.time || "", amount: p.amount ?? "", mode: p.mode || "" })
    )
  );
  add("Repayments", repayRows, { billId: "", paymentId: "", date: "", time: "", amount: "", mode: "" });

  add("Expenses", expenses, { id: "", date: "", desc: "", amount: "" });
  add("Logs", logs, { id: "", at: "", date: "", time: "", type: "", message: "" });

  add(
    "VendorBills",
    (vendorBills || []).map((b) => ({
      id: b.id, vendor: b.vendor, date: b.date, amount: b.amount, category: b.category || "",
      status: b.status || "", paidAmount: b.paidAmount ?? "", dueDate: b.dueDate || "",
      fileName: b.fileName || "", fileURL: b.fileURL || "", filePath: b.filePath || "",
      // "daily-need" mirror marker + the extra fields the mirror carries, so a vendorBills
      // record round-trips in full (they ride along even though the Vendor Bills UI ignores them).
      source: b.source || "", sourceId: b.sourceId || "",
      paymentMethod: b.paymentMethod || "", itemName: b.itemName || "", qty: b.qty ?? "", unitPrice: b.unitPrice ?? "",
      billNumber: b.billNumber || "", notes: b.notes || "", createdAt: b.createdAt ?? "", updatedAt: b.updatedAt ?? "",
    })),
    { id: "", vendor: "", date: "", amount: "", category: "", status: "", paidAmount: "", dueDate: "", fileName: "", fileURL: "", filePath: "", source: "", sourceId: "", paymentMethod: "", itemName: "", qty: "", unitPrice: "", billNumber: "", notes: "", createdAt: "", updatedAt: "" }
  );

  add(
    "DailyBills",
    (dailyBills || []).map((b) => ({
      id: b.id, vendorName: b.vendorName, date: b.date, billAmount: b.billAmount,
      paymentMethod: b.paymentMethod || "", paymentStatus: b.paymentStatus || "", paidAmount: b.paidAmount ?? "",
      category: b.category || "", itemName: b.itemName || "", qty: b.qty ?? "", unitPrice: b.unitPrice ?? "", billNumber: b.billNumber || "", notes: b.notes || "",
      createdAt: b.createdAt ?? "", updatedAt: b.updatedAt ?? "",
    })),
    { id: "", vendorName: "", date: "", billAmount: "", paymentMethod: "", paymentStatus: "", paidAmount: "", category: "", itemName: "", qty: "", unitPrice: "", billNumber: "", notes: "", createdAt: "", updatedAt: "" }
  );

  // Categories — owner-added categories that have no item yet (they aren't recoverable from
  // any item row, so they'd be lost otherwise).
  add("Categories", (customCats || []).filter(Boolean).map((name) => ({ name })), { name: "" });

  return wb;
}

export function exportXlsx(data, filename) {
  XLSX.writeFile(buildWorkbook(data), filename);
}

// Pure: reconstruct the slices from a parsed workbook. Exported for round-trip tests.
export function parseWorkbook(wb) {
  const sheet = (name) => (wb.Sheets[name] ? XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: "" }) : []);

  // Batches, grouped by their item id, to re-attach to each item.
  const batchesByItem = new Map();
  sheet("Batches").forEach((r) => {
    const itemId = str(r.itemId);
    if (!itemId) return;
    if (!batchesByItem.has(itemId)) batchesByItem.set(itemId, []);
    batchesByItem.get(itemId).push({ id: str(r.batchId) || rid(), qty: num(r.qty), expiry: str(r.expiry), addedOn: str(r.addedOn) });
  });

  const items = sheet("Items")
    .filter((r) => str(r.name))
    .map((r) => {
      const id = r.id || rid();
      const item = {
        id, name: str(r.name), code: String(r.code || ""),
        // Split the additional-barcodes cell back into an array (barcodes carry no spaces/commas).
        barcodes: String(r.barcodes || "").split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean),
        category: r.category || "Other",
        unit: r.unit || "pc", buyPrice: num(r.buyPrice), sellPrice: num(r.sellPrice), stock: num(r.stock),
        lowAt: num(r.lowAt), batches: batchesByItem.get(String(id)) || [],
        createdAt: r.createdAt || "", updatedAt: r.updatedAt || "",
      };
      if (has(r.mrp)) item.mrp = num(r.mrp);
      if (has(r.icon)) item.icon = str(r.icon);
      return item;
    });

  // Repayment ledgers, grouped by bill id, to re-attach to each udhari bill.
  const paymentsByBill = new Map();
  sheet("Repayments").forEach((r) => {
    const billId = str(r.billId);
    if (!billId) return;
    if (!paymentsByBill.has(billId)) paymentsByBill.set(billId, []);
    paymentsByBill.get(billId).push({ id: str(r.paymentId) || rid(), date: str(r.date), time: str(r.time), amount: num(r.amount), mode: str(r.mode) || "—" });
  });

  // Rebuild bills by grouping flattened Sales rows on billId; bill-level fields come from the
  // first row seen for each bill. Fields are only re-added when present, preserving the record's
  // original shape (a plain cash bill stays plain; only discounted/udhari bills carry extras).
  const billMap = new Map();
  sheet("Sales").forEach((r) => {
    const billId = str(r.billId);
    if (!billId) return;
    if (!billMap.has(billId)) {
      const bill = { id: billId, date: r.date, time: r.time, lines: [], total: num(r.billTotal), profit: num(r.billProfit) };
      if (has(r.payment)) bill.payment = str(r.payment);
      if (has(r.customer)) bill.customer = str(r.customer);
      if (has(r.mobile)) bill.mobile = str(r.mobile);
      if (num(r.discount) > 0) {
        bill.subtotal = num(r.subtotal);
        bill.discount = num(r.discount);
        if (num(r.discountPct) > 0) bill.discountPct = num(r.discountPct);
      }
      if (bill.payment === "Udhari") {
        bill.paid = num(r.paid);
        if (has(r.paidMode)) bill.paidMode = str(r.paidMode);
        const ledger = paymentsByBill.get(billId);
        if (ledger && ledger.length) bill.payments = ledger;
      }
      billMap.set(billId, bill);
    }
    const line = { name: r.item, qty: num(r.qty), unit: r.unit || "pc", price: num(r.price), amount: num(r.amount) };
    if (has(r.buyPrice)) line.buyPrice = num(r.buyPrice);
    if (r.misc === true || num(r.misc) === 1 || String(r.misc).toLowerCase() === "true") line.misc = true;
    billMap.get(billId).lines.push(line);
  });
  const sales = [...billMap.values()];

  const expenses = sheet("Expenses")
    .filter((r) => str(r.desc))
    .map((r) => ({ id: r.id || rid(), date: r.date, desc: String(r.desc), amount: num(r.amount) }));

  const logs = sheet("Logs")
    .filter((r) => r.type)
    .map((r) => ({ id: r.id || rid(), at: num(r.at), date: r.date, time: r.time, type: r.type, message: r.message }));

  const vendorBills = sheet("VendorBills")
    .filter((r) => str(r.vendor) || r.fileURL)
    .map((r) => {
      const b = {
        id: r.id || rid(), vendor: str(r.vendor), date: r.date, amount: num(r.amount),
        category: r.category || "", status: r.status || "unpaid", paidAmount: num(r.paidAmount), dueDate: r.dueDate || "",
        fileName: r.fileName || "", fileURL: r.fileURL || "", filePath: r.filePath || "",
      };
      if (str(r.source) === "daily-need") {
        b.source = "daily-need";
        b.sourceId = str(r.sourceId) || b.id;
        // The daily-only extras the mirror carries — preserved so vendorBills round-trips in full.
        if (has(r.paymentMethod)) b.paymentMethod = str(r.paymentMethod);
        if (has(r.itemName)) b.itemName = str(r.itemName);
        if (has(r.qty)) b.qty = num(r.qty);
        if (has(r.unitPrice)) b.unitPrice = num(r.unitPrice);
        if (has(r.billNumber)) b.billNumber = str(r.billNumber);
        if (has(r.notes)) b.notes = str(r.notes);
        if (has(r.createdAt)) b.createdAt = num(r.createdAt) || r.createdAt;
        if (has(r.updatedAt)) b.updatedAt = num(r.updatedAt) || r.updatedAt;
      }
      return b;
    });

  const dailyBills = sheet("DailyBills")
    .filter((r) => str(r.vendorName))
    .map((r) => ({
      id: r.id || rid(), vendorName: str(r.vendorName), date: r.date, billAmount: num(r.billAmount),
      paymentMethod: r.paymentMethod || "Cash", paymentStatus: r.paymentStatus || "Paid", paidAmount: num(r.paidAmount),
      category: r.category || "Other", itemName: r.itemName || "", qty: num(r.qty), unitPrice: num(r.unitPrice), billNumber: r.billNumber || "", notes: r.notes || "",
      createdAt: num(r.createdAt) || "", updatedAt: num(r.updatedAt) || "", source: "daily-need",
    }));

  const customCats = sheet("Categories").map((r) => str(r.name)).filter(Boolean);

  return { items, sales, expenses, logs, vendorBills, dailyBills, customCats };
}

export async function importXlsx(file) {
  return parseWorkbook(XLSX.read(await file.arrayBuffer(), { type: "array" }));
}

function rid() {
  return Math.random().toString(36).slice(2, 10);
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
