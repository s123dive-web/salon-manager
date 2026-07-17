import { useState, useEffect, useMemo, useRef, useCallback, Fragment } from "react";
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, LineChart, Line,
  ComposedChart, Treemap, ReferenceLine,
  XAxis, YAxis, Tooltip, CartesianGrid, PieChart, Pie, Cell, Legend,
} from "recharts";
import JsBarcode from "jsbarcode";
import qrcode from "qrcode-generator";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail, EmailAuthProvider, reauthenticateWithCredential, createUserWithEmailAndPassword, getAuth } from "firebase/auth";
import { deleteApp } from "firebase/app";
import { auth, isFirebaseConfigured, secondaryApp } from "./lib/firebase.js";
import {
  SLICES, toMap, mapToArray, isLegacyShape, buildSliceUpdate, mergeRemote,
  writeSlice, overwriteSlice, subscribeSlice, subscribeConnection,
  subscribeConfig, writeConfig, readableSlices,
  subscribeUsers, subscribeOwnUser, writeUser, updateUser, readUsersOnce,
} from "./lib/sync.js";
import { parseFile, parseRawText } from "./lib/parse.js";
import { itemBarcodes, findItemByBarcode, findBarcodeClash, cleanBarcodeList, parseBarcodeText, withBarcodeSep, looksLikeBarcode } from "./lib/barcodes.js";
import { exportJson, exportXlsx, importXlsx } from "./lib/backup.js";
import { can, ROLE_LABELS, ROLE_DESCRIPTIONS, ROLES, resolveRole, isBootstrap, validateUserChange } from "./lib/roles.js";
import {
  PRODUCT_CATEGORIES, PRODUCT_CATEGORY_ICONS, SERVICE_CATEGORIES, serviceIconFor,
  buildProducts, buildServices, buildStaff, buildTemplates,
} from "./lib/seed.js";
import {
  normalizePhone, isValidPhone, formatPhone, blankCustomer, searchCustomers,
  reconcileCustomers, billsForCustomer, toDayMonth, fromDayMonth, isValidDayMonth,
} from "./lib/customers.js";
import {
  blankService, validateService, makeService, activeServices,
  blankStaff, validateStaff, makeStaff, activeStaff, staffById, staffName,
  serviceToCartLine, isServiceLine, STAFF_COLORS,
} from "./lib/salon.js";
import { uploadBillProof, deleteBillProof, PROOF_ACCEPT, MAX_PROOF_BYTES } from "./lib/bills.js";
// NOTE: src/lib/dailyBills.js (and its test suite) is carried over intact from the grocery core,
// but Salon Manager does not ship the Daily-Need Bills section — a salon's consumable purchases
// go through Vendor Bills. The module stays so that a grocery-era backup still restores, and so
// the section can be revived without rewriting its validated mappers.
import {
  formatINR, inrCompact, summarize, dailyRevenueSeries, monthlyRevenueProfit,
  salesHeatmap, topItems as topItemsBy, paymentBreakdown, udhariOutstandingSeries,
  inventoryValue, inventoryByCategory, deadStock, breakEvenSeries, breakEvenEstimate,
  expenseTotal, expenseByMonth, expenseBreakdown,
  DOW, DOW_ORDER, hourLabel,
} from "./lib/stats.js";
// Auto-generated from git history at build time — see scripts/vite-changelog-plugin.js.
// Shape: { repoUrl, entries: [[date, summary, shortSha], ...] } (newest first).
import CHANGELOG_DATA from "virtual:changelog";

// ---------- helpers ----------
const INR = (n) =>
  "₹" + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
// Round money to 2 decimals so bill totals don't drift (e.g. 0.1 + 0.2 = 0.30000004).
// A non-numeric input collapses to 0 rather than poisoning a total with NaN.
const money = (n) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round((v + Number.EPSILON) * 100) / 100 : 0;
};
// Local calendar date as YYYY-MM-DD. MUST be local, not toISOString() (which is UTC)
// — otherwise early-morning sales in IST get filed under the previous day.
const dateStr = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayStr = () => dateStr(new Date());
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
// A short, human-readable bill reference derived from the (already-unique) sale id: last 6 chars,
// upper-cased. Printed on the receipt AND stamped into the UPI note so a received payment can be
// matched back to its bill. Unique enough for a shop's day-to-day reconciliation.
const billRef = (sale) => String((sale && sale.id) || "").slice(-6).toUpperCase();
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Brand + payment assets (served from /public). BASE_URL is "/" in dev and the repo
// sub-path on GitHub Pages, so these resolve correctly in both. assetUrl() makes them
// absolute for the print window (about:blank, which can't resolve relative paths).
const BASE = import.meta.env.BASE_URL;
const LOGO_SRC = BASE + "logo.jpg";
const PAYMENT_QR_SRC = BASE + "payment-qr.jpg";
const assetUrl = (p) => (typeof location !== "undefined" ? location.origin : "") + p;

// Build a UPI "pay" deep link (upi://pay?…). Encoding an amount (am=) makes the customer's UPI
// app (PhonePe/GPay/Paytm…) open with the bill total already filled in — they just confirm & pay.
// Returns "" when there's no VPA to pay to (caller then falls back to the static QR image).
// Spaces are %20-encoded via encodeURIComponent (NOT "+") — some UPI apps read a literal "+" in
// the payee name / note instead of treating it as a space.
function upiPayUri({ vpa, name, amount, note } = {}) {
  const pa = (vpa || "").trim();
  if (!pa) return "";
  // pa (the VPA) is left raw — UPI apps expect a literal "@" here, not "%40"; the field is
  // charset-validated (isValidUpiId) before it's ever saved. pn/tn are free text → encoded.
  const parts = [`pa=${pa}`];
  const pn = (name || "").trim();
  if (pn) parts.push(`pn=${encodeURIComponent(pn)}`);
  const am = Number(amount);
  if (Number.isFinite(am) && am > 0) parts.push(`am=${am.toFixed(2)}`);
  parts.push("cu=INR");
  const tn = (note || "").trim();
  if (tn) parts.push(`tn=${encodeURIComponent(tn)}`);
  return "upi://pay?" + parts.join("&");
}

// Render text to a QR as a data-URL image (GIF), generated locally — nothing leaves the device.
// cellSize = pixels per module, margin = quiet-zone modules (min 2 so scanners lock on). Kept
// small; callers upscale the <img> with image-rendering:pixelated so it stays crisp on screen and
// on the 203dpi thermal head. Level "M" tolerates ~15% smudging on cheap receipt paper. typeNumber
// 0 auto-sizes to the smallest version that fits the string.
function qrDataUrl(text, cellSize = 6, margin = 2) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createDataURL(cellSize, margin);
}

// A blank string, or a UPI VPA like prakashmart@okhdfcbank / 9876543210@ybl: a permissive handle
// (letters, digits, dot, hyphen, underscore) before an alphanumeric bank/PSP suffix that starts
// with a letter. Used to sanity-check the field before saving; blank is allowed (feature is off).
const isValidUpiId = (s) => {
  const v = (s || "").trim();
  if (!v) return true;
  return /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/.test(v);
};

// Print an HTML document via a hidden iframe. Mobile browsers block window.open popups,
// so the old "open a new window and print" approach silently failed on phones — an iframe
// prints from within the current page (the click is a user gesture) and works everywhere.
function printHtml(html, title) {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  Object.assign(iframe.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0" });

  let cleaned = false;
  const cleanup = () => { if (cleaned) return; cleaned = true; try { document.body.removeChild(iframe); } catch { /* already gone */ } };

  iframe.onload = () => {
    // Small delay so logo/QR images finish painting before the print dialog opens.
    setTimeout(() => {
      try {
        const win = iframe.contentWindow;
        win.focus();
        win.onafterprint = cleanup;
        win.print();
        setTimeout(cleanup, 60000); // safety net: afterprint doesn't fire on every mobile browser
      } catch (err) {
        console.error("print failed", err);
        cleanup();
        const w = window.open("", "_blank"); // last-ditch fallback
        if (w) { w.document.write(html); w.document.close(); }
      }
    }, 250);
  };

  document.body.appendChild(iframe);
  // srcdoc gives a single load event after content + images, and works on mobile Safari/Chrome.
  iframe.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title || "Print")}</title></head><body>${html}</body></html>`;
}

// Build a thermal-style receipt and send it to the printer.
// PRESENTATION ONLY — this function computes no bill data. Every value below (l.name, l.qty,
// l.price, l.amount, sale.total, discount, payment …) is read straight off the sale and merely
// laid out for a 72mm (80mm paper) ESC/POS thermal printer. See printHtml() for the print
// mechanism (isolated iframe document → no app-UI leakage).
function printReceipt(sale, store = STORE, staff = []) {
  // Custom logo/QR are stored as data URLs (already absolute); the bundled fallbacks are
  // relative /public assets that must be made absolute for the print iframe (about:blank).
  const logoUrl = store.logo ? store.logo : assetUrl(LOGO_SRC);
  const ref = billRef(sale);
  // Dynamic UPI QR: when a VPA is configured, encode this bill's exact total so the customer's app
  // opens with the amount pre-filled. The bill ref rides along as the payment note (tn) so an
  // incoming UPI payment can be reconciled against this printed receipt. Otherwise fall back to the
  // fixed payment-QR image. `dynQr` also drives the caption + pixelated rendering below.
  const upiUri = upiPayUri({ vpa: store.upiId, name: store.upiName || store.name, amount: sale.total, note: ref ? "Bill " + ref : store.name });
  const dynQr = !!upiUri;
  const qrUrl = dynQr ? qrDataUrl(upiUri) : store.paymentQr ? store.paymentQr : assetUrl(PAYMENT_QR_SRC);
  const rows = sale.lines
    .map((l) => {
      // Unit-price subline under the name: preserves the "unit price" field without a 4th column.
      // Skipped for misc/custom-amount lines where a per-unit price isn't meaningful.
      const unit = l.unit ? `/${escapeHtml(String(l.unit))}` : "";
      const sub =
        !l.misc && l.price != null && l.price !== ""
          ? `<span class="sub">@ ${INR(l.price)}${unit}</span>`
          : "";
      // Name the stylist on the receipt. It's what the customer asks for by name next time,
      // and it makes the bill checkable against who actually did the work.
      const by =
        isServiceLine(l) && l.staffId && staffById(staff, l.staffId)
          ? `<span class="sub">by ${escapeHtml(staffName(staff, l.staffId))}</span>`
          : "";
      return `<tr><td class="col-name"><span class="nm">${escapeHtml(l.name)}</span>${sub}${by}</td><td class="col-qty">${escapeHtml(String(l.qty))}</td><td class="col-amt">${INR(l.amount)}</td></tr>`;
    })
    .join("");
  printHtml(
    `<style>
    /* Dedicated 72mm thermal receipt. size:_auto_ height => no blank paper feed; margin:0 =>
       no scaling. Everything is pure #000; print-color-adjust:exact keeps black solid + QR crisp. */
    @page { size: 72mm auto; margin: 0; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 72mm; background: #fff; }
    /* font-weight 600 (renders bold on Courier New) fires more dots per glyph => darker on a
       203dpi thermal head. This is the main lever left for faintness; true density still comes
       from the driver's darkness/speed setting. */
    /* 4mm side padding (not 2mm): the printable area is 72mm but the print head's right/left
       non-printable margins vary, and right-aligned amounts were clipping at the paper edge.
       4mm each side keeps the last digit safely inside the printable window on 80mm rolls. */
    body { width: 72mm; padding: 3mm 4mm 8mm; color: #000;
      font-family: 'Courier New', Courier, monospace; font-size: 12px; font-weight: 600; line-height: 1.35;
      -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .logo { display:block; margin:0 auto 1mm; height:12mm; object-fit:contain; }
    /* Header/address use a Devanagari-capable stack so a Marathi/Hindi shop name renders. */
    .shop { text-align:center; font-weight:700; font-size:15px; line-height:1.2;
      font-family:'Nirmala UI','Segoe UI','Courier New',monospace; }
    .addr { text-align:center; font-size:11px; line-height:1.3; margin-top:1px;
      font-family:'Nirmala UI','Segoe UI','Courier New',monospace; }
    .meta { text-align:center; font-size:11px; line-height:1.3; margin-top:1px; }
    .rule { border-top:1px dashed #000; margin:2mm 0; }
    /* Fixed columns => name/qty/amount stay aligned no matter how names wrap. */
    table.items { width:100%; border-collapse:collapse; table-layout:fixed; }
    table.items td { vertical-align:top; padding:1px 0; font-size:12px; }
    .col-name { padding-right:1.5mm; overflow-wrap:break-word; }
    .col-name .nm { display:block; padding-left:2.5mm; text-indent:-2.5mm; overflow-wrap:anywhere; } /* hanging indent on wrap, never truncated */
    .col-name .sub { display:block; padding-left:2.5mm; font-size:11px; }
    .col-qty { width:8mm; text-align:right; white-space:nowrap; padding-right:1.5mm; }
    .col-amt { width:18mm; text-align:right; white-space:nowrap; } /* ₹ stays attached to the number */
    tr.tot td { border-top:1px dashed #000; font-weight:700; font-size:14px; padding-top:2px; }
    .ft { text-align:center; font-size:12px; margin-top:2mm; }
    .qr { text-align:center; margin-top:3mm; }
    .qr img { width:40mm; height:40mm; object-fit:contain; }
    /* A locally-generated QR is a tiny raster upscaled to 40mm — nearest-neighbour keeps the
       modules square and sharp on the thermal head. Not applied to a photo/uploaded QR image. */
    .qr img.gen { image-rendering: pixelated; image-rendering: crisp-edges; }
    .qr .cap { font-size:11px; font-weight:700; margin-top:1mm; }
    </style>
    <img class="logo" src="${logoUrl}" alt="" onerror="this.style.display='none'" />
    <div class="shop">${escapeHtml(store.name)}</div>
    <div class="addr">${escapeHtml(store.address)}</div>
    ${store.phone ? `<div class="addr">☎ ${escapeHtml(store.phone)}</div>` : ""}
    <div class="meta">${ref ? `Bill #${escapeHtml(ref)} &nbsp; ` : ""}${escapeHtml(sale.date)} &nbsp; ${escapeHtml(sale.time)}</div>
    <div class="rule"></div>
    <table class="items">${rows}
    ${sale.discount > 0 ? `<tr><td class="col-name">Subtotal</td><td class="col-qty"></td><td class="col-amt">${INR(sale.subtotal != null ? sale.subtotal : money((sale.total || 0) + sale.discount))}</td></tr>
    <tr><td class="col-name">Discount${sale.discountPct ? " (" + sale.discountPct + "%)" : ""}</td><td class="col-qty"></td><td class="col-amt">−${INR(sale.discount)}</td></tr>` : ""}
    <tr class="tot"><td class="col-name">TOTAL</td><td class="col-qty"></td><td class="col-amt">${INR(sale.total)}</td></tr>
    </table>
    ${sale.payment ? `<div class="meta">Paid via ${escapeHtml(sale.payment)}${sale.customer ? " — " + escapeHtml(sale.customer) : ""}</div>` : ""}
    ${sale.customer || sale.mobile ? `<div class="meta">Customer: ${escapeHtml(sale.customer || "—")}${sale.mobile ? " · " + escapeHtml(sale.mobile) : ""}</div>` : ""}
    ${sale.payment === "Udhari" ? `<div class="meta">Paid now: ${INR(sale.paid || 0)}${sale.paidMode ? " (" + escapeHtml(sale.paidMode) + ")" : ""} &nbsp; Balance due: ${INR(Math.max(0, (sale.total || 0) - (sale.paid || 0)))}</div>` : ""}
    <div class="rule"></div>
    <div class="ft">Thank you! Please visit again.</div>
    <div class="qr">
      <img class="${dynQr ? "gen" : ""}" src="${qrUrl}" alt="Scan to pay" onerror="this.style.display='none'" />
      <div class="cap">Scan to Pay${dynQr ? " " + INR(sale.total) : ""} · PhonePe / UPI</div>
    </div>`,
    "Receipt"
  );
}

// The Scan-to-Pay QR shown live in the billing panel while payment = UPI. When a UPI ID is set it
// renders an amount-encoded QR (regenerated as the cart total changes) so the customer's app opens
// pre-filled; otherwise it shows the fixed payment-QR image, exactly as before. `amount` is the
// live bill total — 0 (empty cart) drops the `am` param, showing a plain pay-to-shop QR.
function UpiQrPreview({ store, amount }) {
  // No note here: the sale isn't created until "Complete sale", so there's no bill ref yet. The
  // printed receipt (printReceipt) is where the bill ref gets stamped into the UPI note.
  const uri = upiPayUri({ vpa: store.upiId, name: store.upiName || store.name, amount });
  const src = useMemo(
    () => (uri ? qrDataUrl(uri) : store.paymentQr || PAYMENT_QR_SRC),
    [uri, store.paymentQr],
  );
  const amt = uri && Number(amount) > 0 ? " " + INR(amount) : "";
  return (
    <div style={{ textAlign: "center", marginTop: 10, padding: 8, background: "#fff", border: "1px solid #E2EAE3", borderRadius: 10 }}>
      <img src={src} alt="Scan to pay" style={{ width: 150, height: 150, objectFit: "contain", imageRendering: uri ? "pixelated" : "auto" }} />
      <div style={{ fontSize: 11.5, fontWeight: 700, color: "#3A5547" }}>Scan to Pay{amt} · PhonePe / UPI</div>
    </div>
  );
}
const UNITS = ["pc", "kg", "g", "L", "ml", "packet", "dozen", "box"];
// Product categories for salon RETAIL + BACKBAR stock. The salon's SERVICE menu is a separate
// slice with its own categories (Hair/Skin/Nails/Spa/Makeup) — see src/lib/seed.js. These are
// only for things that sit on a shelf and get counted.
const CATEGORIES = PRODUCT_CATEGORIES;
// A small emoji icon per category (used in place of product photos).
const CATEGORY_ICONS = PRODUCT_CATEGORY_ICONS;
const iconFor = (category) => CATEGORY_ICONS[category] || "📦";

// localStorage key for shop-owner-added categories (custom categories with no item yet).
const CUSTOM_CATS_KEY = "slm-custom-cats-v1";

// The full category list shown in every dropdown = the built-in CATEGORIES, plus any category
// already present on an item, plus custom categories the owner added. De-duped case-insensitively,
// built-in order preserved, extras appended, and "Other" kept last. Passing items + custom here is
// what makes a newly added category show up everywhere (add/edit item, filters) at once — and lets
// a category created on one device appear on others as soon as an item using it syncs in.
function catList(items = [], custom = []) {
  const seen = new Set();
  const out = [];
  const add = (c) => {
    const t = (c == null ? "" : String(c)).trim();
    if (!t) return;
    const k = t.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(t);
  };
  CATEGORIES.filter((c) => c !== "Other").forEach(add);
  items.forEach((i) => add(i.category));
  custom.forEach(add);
  add("Other"); // always last
  return out;
}

// An icon is "auto" (safe to swap when the category changes) when it's blank or still equals
// the category's default emoji. A hand-typed custom emoji differs from the default → preserved.
const isAutoIcon = (icon, category) => {
  const t = (icon || "").trim();
  return !t || t === iconFor(category);
};

// Keyword → category guesses for the Add-item form. Ordered: more specific entries first so the
// right one wins (e.g. "ice cream" before generic terms, "dairy milk" before "milk", "chilli
// powder" before "chilli"). Single-word keys match on word boundaries; multi-word / punctuated
// keys match as substrings.
// Keyword → category guesses for the Add-item form. Ordered: more specific entries first so the
// right one wins ("nail polish remover" before "polish", "hair colour" before "colour"). Single-word
// keys match on word boundaries; multi-word / punctuated keys match as substrings.
const CATEGORY_KEYWORDS = [
  ["nail polish", "Nail Care"], ["nail paint", "Nail Care"], ["nail art", "Nail Care"], ["cuticle", "Nail Care"], ["acetone", "Nail Care"], ["nail", "Nail Care"], ["manicure", "Nail Care"], ["pedicure", "Nail Care"],
  ["hair colour", "Colour & Chemicals"], ["hair color", "Colour & Chemicals"], ["developer", "Colour & Chemicals"], ["peroxide", "Colour & Chemicals"], ["ammonia", "Colour & Chemicals"], ["bleach", "Colour & Chemicals"], ["keratin", "Colour & Chemicals"], ["smoothening", "Colour & Chemicals"], ["rebonding", "Colour & Chemicals"], ["botox", "Colour & Chemicals"], ["majirel", "Colour & Chemicals"], ["toner", "Colour & Chemicals"], ["highlight", "Colour & Chemicals"],
  ["shampoo", "Hair Care"], ["conditioner", "Hair Care"], ["hair mask", "Hair Care"], ["hair spa", "Hair Care"], ["hair oil", "Hair Care"], ["hair serum", "Hair Care"], ["serum", "Hair Care"], ["argan", "Hair Care"], ["dandruff", "Hair Care"], ["scalp", "Hair Care"], ["hair", "Hair Care"],
  ["sunscreen", "Skin Care"], ["spf", "Skin Care"], ["face wash", "Skin Care"], ["facewash", "Skin Care"], ["facial", "Skin Care"], ["cleanser", "Skin Care"], ["moisturiser", "Skin Care"], ["moisturizer", "Skin Care"], ["cream", "Skin Care"], ["lotion", "Skin Care"], ["scrub", "Skin Care"], ["face pack", "Skin Care"], ["de-tan", "Skin Care"], ["detan", "Skin Care"], ["vitamin c", "Skin Care"], ["salicylic", "Skin Care"], ["skin", "Skin Care"],
  ["rica", "Waxing & Threading"], ["wax", "Waxing & Threading"], ["waxing", "Waxing & Threading"], ["thread", "Waxing & Threading"], ["strip", "Waxing & Threading"], ["razor", "Waxing & Threading"],
  ["massage oil", "Spa & Massage"], ["aroma", "Spa & Massage"], ["essential oil", "Spa & Massage"], ["massage", "Spa & Massage"], ["spa", "Spa & Massage"],
  ["cotton", "Consumables"], ["tissue", "Consumables"], ["towel", "Consumables"], ["glove", "Consumables"], ["apron", "Consumables"], ["cape", "Consumables"], ["disposable", "Consumables"], ["sanitizer", "Consumables"], ["foil", "Consumables"],
  ["scissor", "Tools & Styling"], ["trimmer", "Tools & Styling"], ["clipper", "Tools & Styling"], ["dryer", "Tools & Styling"], ["straightener", "Tools & Styling"], ["tong", "Tools & Styling"], ["curler", "Tools & Styling"], ["comb", "Tools & Styling"], ["brush", "Tools & Styling"], ["roller", "Tools & Styling"], ["clip", "Tools & Styling"], ["gel", "Tools & Styling"], ["hair spray", "Tools & Styling"], ["styling", "Tools & Styling"], ["pomade", "Tools & Styling"],
];

// Guess a category from a typed item name: keyword map first, then a shared-token match against
// the store's existing items. Returns null when nothing is confident enough (caller keeps the
// current default). Used only for NEW items in the Add form.
function guessCategory(name, items = []) {
  const n = (name || "").toLowerCase().trim();
  if (n.length < 2) return null;
  for (const [kw, cat] of CATEGORY_KEYWORDS) {
    const hit = /[^a-z0-9]/.test(kw) ? n.includes(kw) : new RegExp(`\\b${kw}\\b`).test(n);
    if (hit) return cat;
  }
  // Fallback: an existing item that shares a 4+ char word with the typed name.
  const tokens = n.split(/[^a-z0-9]+/).filter((t) => t.length >= 4);
  if (tokens.length) {
    const hit = items.find((i) => { const itn = (i.name || "").toLowerCase(); return tokens.some((t) => itn.includes(t)); });
    if (hit) return hit.category || null;
  }
  return null;
}

// Catalog tuned for a Pashan–Baner (Pune) society convenience store:
// top-up shoppers, kids' favourites, always-moving chilled stock.
// The opening product shelf: retail lines a salon actually resells, plus the backbar stock it
// consumes while working. Built in src/lib/seed.js so the data stays pure and testable.
// Every item starts at 0 stock — the salon counts its real opening stock in.
const SEED_ITEMS = buildProducts({ uid, today: todayStr(), iconFor });

// The opening service menu, sample stylists and reminder templates. Same first-run-only
// discipline as the product shelf: written once when the slice is empty, never on top of a
// salon that has already edited its own menu.
const SEED_SERVICES = buildServices({ uid, today: todayStr() });
const SEED_STAFF = buildStaff({ uid, today: todayStr() });
const SEED_TEMPLATES = buildTemplates({ uid, today: todayStr() });

// Categories of activity recorded in the global Activity Log.
const LOG_TYPES = ["sale", "inventory", "expense", "import", "backup", "bill", "settings"];

// Salon identity — DEFAULTS only, and deliberately generic: this app is meant to be reusable by
// any salon, so nothing here names a particular business. Every field is overridden by the owner
// from Settings; the saved config lives at shop/config (see effectiveStore()) and syncs across
// devices. `logo`/`paymentQr` blank => the bundled /public asset is used; a custom upload is
// stored inline as a data URL. `pcIp` is the counter PC's LAN address (e.g. for a local print
// server). Fill these in from Settings before the first receipt is printed.
const STORE = {
  name: "Salon Manager",
  tagline: "Hair · Skin · Nails · Spa",
  address: "",
  phone: "",
  pcIp: "",
  logo: "",       // "" => default logo.jpg asset; otherwise a data URL
  paymentQr: "",  // "" => default payment-qr.jpg asset; otherwise a data URL
  upiId: "",      // UPI VPA (e.g. salon@okhdfcbank). Set => bills show an amount-encoded QR; "" => static image
  upiName: "",    // payee name shown in the customer's UPI app; "" => fall back to the salon name
};

// localStorage key + reader for the salon config. Cached separately from the data cache so the
// pre-auth Login screen can brand itself with the owner's saved salon name/logo instantly.
const CONFIG_CACHE_KEY = "slm-config-v1";
const readCachedConfig = () => {
  try { const c = JSON.parse(localStorage.getItem(CONFIG_CACHE_KEY) || "null"); return c && typeof c === "object" ? c : {}; }
  catch { return {}; }
};

// Built-in defaults with any owner-set config layered on. A blank/whitespace config field falls
// back to the default so the header and receipt are never left empty. logo/paymentQr keep "" when
// unset (callers fall back to the bundled asset). Used everywhere the store identity is shown.
function effectiveStore(config = {}) {
  const pick = (v, d) => (typeof v === "string" && v.trim() ? v : d);
  return {
    name: pick(config.name, STORE.name),
    tagline: pick(config.tagline, STORE.tagline),
    address: pick(config.address, STORE.address),
    phone: pick(config.phone, STORE.phone),
    pcIp: pick(config.pcIp, STORE.pcIp),
    logo: pick(config.logo, ""),
    paymentQr: pick(config.paymentQr, ""),
    upiId: pick(config.upiId, ""),
    upiName: pick(config.upiName, ""),
  };
}

// A blank string, or a dotted IPv4 (each octet 0-255), optionally with a :port. Used to keep the
// shop PC IP field sane before saving. Hostnames aren't accepted — the field is labelled "IP".
const isValidPcIp = (s) => {
  const v = (s || "").trim();
  if (!v) return true;
  const [host, port, ...rest] = v.split(":");
  if (rest.length) return false;
  if (port !== undefined && !/^\d{1,5}$/.test(port)) return false;
  const oct = host.split(".");
  return oct.length === 4 && oct.every((o) => /^\d{1,3}$/.test(o) && +o >= 0 && +o <= 255);
};

// Read an <input type=file> image and return a downscaled JPEG data URL (fit within maxDim, white
// background so transparency doesn't print black on the thermal receipt). Downscaling keeps the
// stored logo/QR at a few KB — small enough to live inline in RTDB config + localStorage, instead
// of shipping the full-resolution file to every device.
function imageFileToDataUrl(file, maxDim, quality = 0.85) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type || !file.type.startsWith("image/")) return reject(new Error("Not an image file"));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the file"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Could not decode the image"));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ---------- stock / expiry batch helpers ----------
// Each item tracks stock as dated batches { id, qty, expiry, addedOn }; `stock` is the
// cached sum. Adding stock appends a batch; selling depletes batches FIFO by expiry.
const batchSort = (a, b) => (String(a.expiry || "9999-99-99") < String(b.expiry || "9999-99-99") ? -1 : 1);

// Coerce an item's money/quantity fields to real numbers. Firebase, legacy data and
// spreadsheet imports can store stock/prices as STRINGS; left untouched they silently
// corrupt every downstream calculation (stock value, profit, sorting) and can concatenate
// in addBatch. Applied at each point raw item data enters React state so the rest of the
// app can trust these fields are numbers. A blank/garbage value collapses to 0.
const numify = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
function normalizeItem(i) {
  if (!i || typeof i !== "object") return i;
  const out = { ...i, buyPrice: numify(i.buyPrice), sellPrice: numify(i.sellPrice), stock: numify(i.stock) };
  if (i.mrp !== undefined) out.mrp = numify(i.mrp);
  if (Array.isArray(i.batches)) out.batches = i.batches.map((b) => ({ ...b, qty: numify(b.qty) }));
  return out;
}
const normalizeItems = (arr) => (Array.isArray(arr) ? arr.map(normalizeItem) : arr);

function addBatch(item, qty, expiry, date) {
  const q = +qty || 0;
  if (q <= 0) return item;
  const batches = [...(item.batches || []), { id: uid(), qty: q, expiry: expiry || "", addedOn: date || todayStr() }];
  // (+item.stock || 0), NOT (item.stock || 0): if stock is a STRING (legacy/imported/cloud
  // data), a bare `+` concatenates ("5" + 5 → "55") and snowballs a stock into a nonsense
  // multi-billion figure over repeated restocks/scans. Coerce to a real number first.
  return { ...item, batches, stock: (+item.stock || 0) + q, updatedAt: date || todayStr() };
}

function removeStock(item, qty, date) {
  let need = +qty || 0;
  const out = [];
  [...(item.batches || [])].sort(batchSort).forEach((b) => {
    if (need <= 0) return out.push(b);
    if (b.qty <= need) { need -= b.qty; } // consume whole batch
    else { out.push({ ...b, qty: b.qty - need }); need = 0; }
  });
  // `stock` is the authoritative count; batches track only the dated portion (addBatch can
  // raise stock without a matching batch), so decrement stock directly rather than from the
  // batch sum — otherwise legacy stock that predates any batch would be lost on a sale.
  return { ...item, batches: out, stock: Math.max(0, (item.stock || 0) - (+qty || 0)), updatedAt: date || todayStr() };
}

// Days until the earliest batch expiry (null if no dated batches; negative = expired).
function daysToExpiry(item) {
  const dates = (item.batches || []).filter((b) => b.expiry).map((b) => b.expiry).sort();
  if (!dates.length) return null;
  return Math.round((new Date(dates[0] + "T00:00") - new Date(todayStr() + "T00:00")) / 86400000);
}

// ---------- authentication (Firebase email/password) ----------
// Real server-side auth via Firebase. Data is gated by the database security rules
// (locked to the shop owner's email), so it is genuinely private — not just a UI gate.
const AUTH_ERRORS = {
  "auth/invalid-credential": "Incorrect email or password.",
  "auth/wrong-password": "Incorrect email or password.",
  "auth/user-not-found": "No account with that email.",
  "auth/invalid-email": "That email address looks invalid.",
  "auth/missing-password": "Please enter your password.",
  "auth/too-many-requests": "Too many attempts — please wait a minute and retry.",
  "auth/network-request-failed": "Network error — check your internet connection.",
  "auth/unauthorized-domain": "This web address isn't authorised in Firebase Auth settings.",
};
const authMessage = (code) => AUTH_ERRORS[code] || "Could not sign in. Please try again.";

function Login() {
  const [email, setEmail] = useState("");
  const [pwd, setPwd] = useState("");
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  // Brand the sign-in card with the owner's saved settings (from the local cache — the cloud
  // config lives behind auth, so this is the best we have pre-login). Falls back to defaults.
  const store = effectiveStore(readCachedConfig());
  const loginLogo = store.logo || LOGO_SRC;

  const submit = async (e) => {
    e?.preventDefault();
    // Without this the SDK throws auth/invalid-api-key, which reads like a bug rather than
    // "nobody has connected this app to a Firebase project yet".
    if (!isFirebaseConfigured) return setErr("This app isn't connected to a Firebase project yet — see src/lib/firebase.js.");
    setBusy(true); setErr(""); setInfo("");
    try {
      await signInWithEmailAndPassword(auth, email.trim(), pwd);
      // App's auth listener swaps to the dashboard on success.
    } catch (ex) {
      setErr(authMessage(ex.code));
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!email.trim()) return setErr("Enter your email above first, then tap reset.");
    try {
      await sendPasswordResetEmail(auth, email.trim());
      setErr(""); setInfo("Password reset link sent to " + email.trim());
    } catch (ex) { setErr(authMessage(ex.code)); }
  };

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#10331F", padding: 16 }}>
      <style>{CSS}</style>
      <form onSubmit={submit} style={{ background: "#fff", borderRadius: 16, padding: "26px 24px", width: "min(380px, 94vw)", boxShadow: "0 12px 40px rgba(0,0,0,.3)" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <img src={loginLogo} alt={store.name} style={{ width: 52, height: 52, borderRadius: 12, objectFit: "contain", flexShrink: 0 }} />
          <div>
            <div style={{ fontWeight: 800, fontSize: 18, letterSpacing: "-0.02em" }}>{store.name}</div>
            <div style={{ fontSize: 11.5, color: "#8A9C90" }}>{store.address}</div>
          </div>
        </div>
        <h2 style={{ fontSize: 16, margin: "18px 0 12px" }}>Sign in</h2>
        {!isFirebaseConfigured && (
          <div style={{ background: "#FFF6E5", border: "1px solid #F0D9A8", borderRadius: 9, padding: "10px 12px", marginBottom: 12, fontSize: 12.5, color: "#7A5B14", lineHeight: 1.6 }}>
            <b>Not connected yet.</b> This build still has the placeholder Firebase config, so
            sign-in and sync are inactive. Create a Firebase project and fill in
            {" "}<code>src/lib/firebase.js</code> — the setup steps are in that file and in the README.
          </div>
        )}
        <Field label="Email"><input className="input" type="email" value={email} autoComplete="username" autoFocus onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Password"><input className="input" type="password" value={pwd} autoComplete="current-password" onChange={(e) => setPwd(e.target.value)} /></Field>
        {err && <div style={{ color: "#C44536", fontSize: 13, marginBottom: 8 }}>{err}</div>}
        {info && <div style={{ color: "#1B5E43", fontSize: 13, marginBottom: 8 }}>{info}</div>}
        <button className="btn primary big" type="submit" style={{ width: "100%" }} disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        <button type="button" onClick={reset} style={{ display: "block", background: "none", border: "none", color: "#1B5E43", fontSize: 12, marginTop: 10, cursor: "pointer", padding: 0 }}>Forgot password? Email me a reset link</button>
        <div style={{ fontSize: 11, color: "#8A9C90", marginTop: 12, lineHeight: 1.5 }}>
          Sign in with your shop account. Your data syncs live across every device that signs in.
        </div>
      </form>
    </div>
  );
}

// ---------- root: Firebase auth gate ----------
export default function App() {
  const [user, setUser] = useState(undefined); // undefined = checking, null = signed out
  useEffect(() => onAuthStateChanged(auth, setUser), []);
  if (user === undefined) {
    return <Splash>Loading…</Splash>;
  }
  if (!user) return <Login />;
  return <RoleGate user={user} onLogout={() => signOut(auth)} />;
}

const Splash = ({ children }) => (
  <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#10331F", color: "#BCD2C4", fontFamily: "system-ui, sans-serif", padding: 24, textAlign: "center" }}>
    {children}
  </div>
);

// Why the signed-in user can't get in. Being authenticated is not the same as being staff.
const DENIED_MESSAGES = {
  "not-invited":
    "This account isn't set up for this salon yet. Ask the owner to add you under Settings → Users.",
  deactivated:
    "This account has been deactivated. Ask the owner to re-activate it under Settings → Users.",
  error:
    "Couldn't check your access — the salon database may be unreachable, or the security rules may not be deployed yet.",
};

// ---------- role gate ----------
// Signing in proves WHO you are; this resolves WHAT you may do, and nothing renders until it
// has. Rendering the shell first and hiding tabs afterwards would flash owner-only views at a
// worker on a slow connection, so the gate is a hard barrier rather than a filter.
//
// Bootstrap: the very first user to sign in while shop/users is empty claims owner. That is how
// a fresh deployment gets its first owner with no Firebase console visit, and it mirrors the
// bootstrap rule in database.rules.json. Once anyone is registered, the node locks down.
function RoleGate({ user, onLogout }) {
  const [state, setState] = useState({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    let claiming = false;

    // Claim ownership of an un-claimed salon. Only reached when this user has no record.
    const tryBootstrap = async () => {
      if (claiming) return; // the listener re-fires on our own write; claim once
      claiming = true;
      try {
        const usersMap = await readUsersOnce();
        if (cancelled) return;
        if (!isBootstrap(usersMap)) return setState({ phase: "denied", reason: "not-invited" });
        await writeUser(user.uid, {
          email: user.email || "",
          name: "",
          role: "owner",
          active: true,
          createdAt: todayStr(),
        });
        // The subscription below re-fires with the new record and lets us in — no setState here.
      } catch {
        // A rejected read IS the answer: the rules only allow reading shop/users while it is
        // empty, so being refused means the salon already has an owner and we aren't on the list.
        if (!cancelled) setState({ phase: "denied", reason: "not-invited" });
      }
    };

    // Every authenticated user may read their OWN record even before they have one (see the
    // $uid .read rule), which is what makes "you aren't set up yet" distinguishable from
    // "the network is down". Staying subscribed also means a live demotion or deactivation
    // takes effect immediately, without waiting for a reload.
    const unsub = subscribeOwnUser(
      user.uid,
      (record) => {
        if (cancelled) return;
        if (!record) return void tryBootstrap();
        const role = resolveRole(record);
        setState(role ? { phase: "ready", role, record } : { phase: "denied", reason: "deactivated" });
      },
      () => { if (!cancelled) setState({ phase: "denied", reason: "error" }); }
    );

    return () => { cancelled = true; unsub(); };
  }, [user.uid, user.email]);

  if (state.phase === "loading") return <Splash>Checking your access…</Splash>;

  if (state.phase === "denied") {
    return (
      <Splash>
        <div style={{ maxWidth: 420 }}>
          <div style={{ fontSize: 34, marginBottom: 10 }}>🔒</div>
          <div style={{ fontWeight: 800, fontSize: 18, color: "#fff", marginBottom: 8 }}>No access</div>
          <p style={{ fontSize: 13.5, lineHeight: 1.6, marginBottom: 6 }}>{DENIED_MESSAGES[state.reason]}</p>
          <p style={{ fontSize: 12, opacity: 0.75, marginBottom: 18 }}>Signed in as {user.email}</p>
          <button className="btn" onClick={onLogout} style={{ cursor: "pointer" }}>Sign out</button>
        </div>
        <style>{CSS}</style>
      </Splash>
    );
  }

  return <StoreManager user={user} role={state.role} onLogout={onLogout} />;
}

// ---------- main app ----------
// Feature flags for deprecating a section from the live UI WITHOUT deleting its
// code. A tab listed here as `false` is dropped from the sidebar and its render
// branch is skipped; the component and all its logic stay intact below. To bring
// a section back, flip its flag to `true` (or remove the line).
const FEATURES = {
  finance: false, // deprecated 2026 — kept for a possible future revival
};
// A tab is shown unless a flag explicitly turns it off.
const tabEnabled = (k) => FEATURES[k] !== false;

// Top-level sidebar destinations, plus the secondary group tucked under "Other".
// Both feed the same `tab` switch below — grouping is purely a nav-rendering concern.
//
// The 4th element is the permission required to reach the tab (null = everyone). It is the
// SAME action the view's own guard checks, so hiding a tab and blocking the view can't drift
// apart. Hiding alone is not enough: `tab` is state, so every gated branch in the render
// switch re-checks with can() — see viewFor() below.
const TOP_TABS = [
  ["dashboard", "⌂", "Dashboard", null],
  ["billing", "₹", "Billing (POS)", "billing.use"],
  ["customers", "👤", "Customers", "customers.browse"],
  ["inventory", "▦", "Inventory", "inventory.view"],
  ["sales", "⊟", "Sales History", "sales.view"],
  ["finance", "∑", "Finance", "finance.view"],
  ["stats", "📊", "Stats", "stats.view"],
  ["udhari", "💳", "Udhari (Credit)", "udhari.manage"],
  ["expense", "⊝", "Add Expense", "expenses.manage"],
];
const OTHER_TABS = [
  ["services", "✂", "Services", "services.manage"],
  ["staff", "🧑‍🎨", "Staff", "staff.manage"],
  ["alerts", "⚠", "Alerts", "alerts.view"],
  ["vendorbills", "🧾", "Vendor Bills", "vendorBills.manage"],
  ["raw", "⇪", "Data Import", "import.use"],
  ["barcode", "▥", "Barcode Creator", "barcode.use"],
  ["logs", "❑", "Activity Log", "logs.view"],
  ["changelog", "🗒", "App Change Log", null],
  ["settings", "🏪", "Salon Settings", "settings.manage"],
  ["admin", "⚙", "Admin", "settings.manage"],
];

// A tab is reachable when its feature flag is on AND the signed-in role holds its permission.
const tabAllowed = (role, [k, , , action]) => tabEnabled(k) && (!action || can(role, action));

// Slices that get seeded on first run, and the permission required to write that seed. A role
// without the permission simply doesn't seed — it waits for an owner to sign in and do it —
// rather than firing a write the rules will bounce.
const SEEDERS = {
  items: { build: () => SEED_ITEMS, action: "inventory.edit" },
  services: { build: () => SEED_SERVICES, action: "services.manage" },
  staff: { build: () => SEED_STAFF, action: "staff.manage" },
  messageTemplates: { build: () => SEED_TEMPLATES, action: "reminders.use" },
};

function StoreManager({ user, role, onLogout }) {
  const [tab, setTab] = useState("dashboard");
  const [otherOpen, setOtherOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [sales, setSales] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [logs, setLogs] = useState([]);
  const [bills, setBills] = useState([]); // vendor purchase bills (vendorBills slice)
  const [dailyBills, setDailyBills] = useState([]); // legacy daily-need bills; mirrors into vendorBills
  // ---- salon slices ----
  const [customers, setCustomers] = useState([]);
  const [services, setServices] = useState([]);
  const [staff, setStaff] = useState([]);
  const [appointments, setAppointments] = useState([]);
  const [packages, setPackages] = useState([]);
  const [customerPackages, setCustomerPackages] = useState([]);
  const [messageTemplates, setMessageTemplates] = useState([]);
  // Owner-added categories that have no item yet (device-local; once an item uses one it also
  // rides along in the synced items data). Merged with the built-ins + item categories below.
  const [customCats, setCustomCats] = useState(() => {
    try { const c = JSON.parse(localStorage.getItem(CUSTOM_CATS_KEY) || "[]"); return Array.isArray(c) ? c.filter((x) => typeof x === "string") : []; }
    catch { return []; }
  });
  // Store identity/branding (shop name, address, logo, PC IP …). A singleton synced at
  // shop/config — see the dedicated effect below. Seeded from the local cache for instant paint.
  const [config, setConfig] = useState(() => readCachedConfig());
  const [loaded, setLoaded] = useState(false);
  const [toast, setToast] = useState(null);

  // ---- Realtime Database sync (live across every signed-in device) ----
  // Every record (item/sale/expense/log) lives at its own keyed node — shop/<slice>/<id> —
  // so concurrent edits from different devices to different records merge instead of
  // clobbering. Writes are field-level deltas; incoming snapshots are 3-way merged with any
  // un-pushed local edits. A localStorage cache gives instant first paint and offline reads.
  // See src/lib/sync.js for the array↔map bridge.
  const CACHE_KEY = "slm-cache-v1";
  // Last cloud map / first-snapshot flag, per slice. Built from SLICES so adding a slice can't
  // leave a hole here that silently disables its delta pushes.
  const lastRemote = useRef(Object.fromEntries(SLICES.map((s) => [s, {}])));
  const synced = useRef(Object.fromEntries(SLICES.map((s) => [s, false])));
  const seeded = useRef({}); // slice → true once this device has written that slice's seed
  const configSynced = useRef(false);        // have we read shop/config from the cloud at least once?
  const lastConfig = useRef(JSON.stringify(readCachedConfig())); // last config JSON reconciled with the cloud (blocks echo writes)
  const [online, setOnline] = useState(true);

  // The one place that maps a slice name → its React setter. Everything below (cache, sync,
  // push) drives off this, so a new slice is wired in exactly one place.
  const SETTERS = useMemo(() => ({
    items: setItems, sales: setSales, expenses: setExpenses, logs: setLogs,
    vendorBills: setBills, dailyBills: setDailyBills,
    customers: setCustomers, services: setServices, staff: setStaff,
    appointments: setAppointments, packages: setPackages,
    customerPackages: setCustomerPackages, messageTemplates: setMessageTemplates,
  }), []);

  // Slices this role may READ, and therefore subscribe to. Subscribing to a slice the rules
  // deny would spam permission-denied and pop a sync-error toast at the counter, so a worker
  // simply never asks for the money slices. Mirrors database.rules.json.
  const mySlices = useMemo(() => readableSlices(role), [role]);

  // Always-current local state, readable from inside async listeners (for the merge).
  const dataRef = useRef({});
  dataRef.current = { items, sales, expenses, logs, vendorBills: bills, dailyBills, customers, services, staff, appointments, packages, customerPackages, messageTemplates };
  const notifyRef = useRef(null);

  // 1) Instant paint from the local cache. Only restores slices this role may read — otherwise
  //    a cache left behind by an owner on a shared counter device would show a worker the
  //    expense book. The cache is written with the same filter (see the write effect below).
  useEffect(() => {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (c) {
        for (const slice of mySlices) {
          const cached = c[slice];
          if (!Array.isArray(cached)) continue;
          SETTERS[slice](slice === "items" ? normalizeItems(cached) : cached);
        }
      }
    } catch (e) { console.error("cache read failed", e); }
    setLoaded(true);
  }, [mySlices, SETTERS]);

  // 2) Subscribe to the cloud; changes from any device flow in live.
  useEffect(() => {
    const unsubs = mySlices.map((slice) =>
      subscribeSlice(
        slice,
        (val) => {
          // First run anywhere: seed this slice once, then write it to the cloud. Seeding is a
          // privileged write (the catalogue is owner/inventory territory), so a role without
          // the permission just marks itself synced and waits — an unprivileged seed attempt
          // would be rejected and would leave the local list out of step with the cloud.
          const seeder = SEEDERS[slice];
          if (seeder && val === null) {
            if (seeded.current[slice] || !can(role, seeder.action)) {
              synced.current[slice] = true;
              return;
            }
            seeded.current[slice] = true;
            const map = toMap(seeder.build());
            lastRemote.current[slice] = map;
            synced.current[slice] = true;
            const next = mapToArray(slice, map);
            SETTERS[slice](slice === "items" ? normalizeItems(next) : next);
            overwriteSlice(slice, map).catch((e) => console.error("seed write failed", slice, e));
            return;
          }
          const theirs = toMap(val);
          // One-time migration of legacy array / numeric-keyed data → keyed-by-id map.
          if (isLegacyShape(val, theirs)) {
            overwriteSlice(slice, theirs).catch((e) => console.error("migrate failed", slice, e));
          }
          const base = lastRemote.current[slice];
          const wasSynced = synced.current[slice];
          lastRemote.current[slice] = theirs;
          synced.current[slice] = true;
          // Merge against the TRUE current state via the functional updater — NOT a ref that
          // may lag a just-dispatched local edit by a render. This is what stops an incoming
          // snapshot from silently reverting an edit/restock/delete made a moment earlier.
          SETTERS[slice]((curr) => {
            const next = mapToArray(slice, wasSynced ? mergeRemote(base, theirs, toMap(curr)) : theirs);
            return slice === "items" ? normalizeItems(next) : next;
          });
        },
        (err) => {
          console.error("sync read failed", slice, err);
          notifyRef.current?.("⚠ Cloud sync error — check your connection or account access.");
        }
      )
    );
    const unsubConn = subscribeConnection(setOnline);
    return () => { unsubs.forEach((u) => u()); unsubConn(); };
  }, [mySlices, role, SETTERS]);

  // 3) Push field-level deltas to the cloud when a slice changes locally (after the first
  //    cloud snapshot). buildSliceUpdate skips no-op echoes, so this is loop-safe.
  const pushSlice = useCallback((slice, value) => {
    if (!synced.current[slice]) return; // don't write before we've read the cloud once
    const { updates, nextMap, changed } = buildSliceUpdate(lastRemote.current[slice], value);
    if (!changed) return;
    lastRemote.current[slice] = nextMap; // optimistic; the echo snapshot confirms it
    writeSlice(slice, updates).catch((e) => {
      console.error("sync write failed", slice, e);
      notify("⚠ Couldn't sync to cloud — saved on this device, will retry when back online.");
    });
  }, []);
  useEffect(() => { if (!loaded) return; const t = setTimeout(() => pushSlice("items", items), 300); return () => clearTimeout(t); }, [items, loaded, pushSlice]);
  useEffect(() => { if (!loaded) return; const t = setTimeout(() => pushSlice("sales", sales), 300); return () => clearTimeout(t); }, [sales, loaded, pushSlice]);
  useEffect(() => { if (!loaded) return; const t = setTimeout(() => pushSlice("expenses", expenses), 300); return () => clearTimeout(t); }, [expenses, loaded, pushSlice]);
  useEffect(() => { if (!loaded) return; const t = setTimeout(() => pushSlice("logs", logs), 300); return () => clearTimeout(t); }, [logs, loaded, pushSlice]);
  useEffect(() => { if (!loaded) return; const t = setTimeout(() => pushSlice("vendorBills", bills), 300); return () => clearTimeout(t); }, [bills, loaded, pushSlice]);
  useEffect(() => { if (!loaded) return; const t = setTimeout(() => pushSlice("dailyBills", dailyBills), 300); return () => clearTimeout(t); }, [dailyBills, loaded, pushSlice]);
  useEffect(() => { if (!loaded) return; const t = setTimeout(() => pushSlice("customers", customers), 300); return () => clearTimeout(t); }, [customers, loaded, pushSlice]);
  useEffect(() => { if (!loaded) return; const t = setTimeout(() => pushSlice("services", services), 300); return () => clearTimeout(t); }, [services, loaded, pushSlice]);
  useEffect(() => { if (!loaded) return; const t = setTimeout(() => pushSlice("staff", staff), 300); return () => clearTimeout(t); }, [staff, loaded, pushSlice]);
  useEffect(() => { if (!loaded) return; const t = setTimeout(() => pushSlice("appointments", appointments), 300); return () => clearTimeout(t); }, [appointments, loaded, pushSlice]);
  useEffect(() => { if (!loaded) return; const t = setTimeout(() => pushSlice("packages", packages), 300); return () => clearTimeout(t); }, [packages, loaded, pushSlice]);
  useEffect(() => { if (!loaded) return; const t = setTimeout(() => pushSlice("customerPackages", customerPackages), 300); return () => clearTimeout(t); }, [customerPackages, loaded, pushSlice]);
  useEffect(() => { if (!loaded) return; const t = setTimeout(() => pushSlice("messageTemplates", messageTemplates), 300); return () => clearTimeout(t); }, [messageTemplates, loaded, pushSlice]);

  // 3b) Store config is a singleton, not a keyed slice — subscribe/write it whole. Incoming
  //     cloud values update state and the pre-auth cache; local edits push back (the lastConfig
  //     guard skips the echo write when the change we're seeing is the one we just received).
  useEffect(() => {
    const unsub = subscribeConfig(
      (val) => {
        configSynced.current = true;
        const next = val && typeof val === "object" ? val : {};
        lastConfig.current = JSON.stringify(next);
        setConfig(next);
        try { localStorage.setItem(CONFIG_CACHE_KEY, lastConfig.current); } catch (e) { console.error("config cache write failed", e); }
      },
      (err) => { console.error("config sync read failed", err); }
    );
    return () => unsub();
  }, []);
  useEffect(() => {
    if (!loaded || !configSynced.current) return;
    const s = JSON.stringify(config ?? {});
    try { localStorage.setItem(CONFIG_CACHE_KEY, s); } catch (e) { console.error("config cache write failed", e); }
    if (s === lastConfig.current) return; // echo of a value we already have in the cloud
    const t = setTimeout(() => {
      lastConfig.current = s;
      writeConfig(config).catch((e) => {
        console.error("config sync write failed", e);
        notify("⚠ Couldn't sync settings — saved on this device, will retry when back online.");
      });
    }, 300);
    return () => clearTimeout(t);
  }, [config, loaded]);

  // 4) Mirror to a local cache (instant next paint + offline reads + no data loss on close).
  //    Only the slices this role may read are cached: the counter tablet is a shared device, so
  //    an owner's session must not leave the expense book sitting in localStorage for whoever
  //    signs in next. The read effect applies the same filter on the way back in.
  useEffect(() => {
    if (!loaded) return;
    const writeCache = () => {
      try {
        const snapshot = {};
        for (const slice of mySlices) snapshot[slice] = dataRef.current[slice];
        localStorage.setItem(CACHE_KEY, JSON.stringify(snapshot));
      } catch (e) { console.error("cache write failed", e); }
    };
    const t = setTimeout(writeCache, 400);
    const onHide = () => { if (document.visibilityState === "hidden") writeCache(); };
    window.addEventListener("beforeunload", writeCache);
    window.addEventListener("pagehide", writeCache);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      clearTimeout(t);
      window.removeEventListener("beforeunload", writeCache);
      window.removeEventListener("pagehide", writeCache);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [items, sales, expenses, logs, bills, dailyBills, customers, services, staff, appointments, packages, customerPackages, messageTemplates, loaded, mySlices]);

  const toastTimer = useRef(null);
  const notify = (msg) => {
    if (toastTimer.current) clearTimeout(toastTimer.current); // don't let an old timer cut a new toast short
    setToast(msg);
    toastTimer.current = setTimeout(() => { setToast(null); toastTimer.current = null; }, 2200);
  };
  notifyRef.current = notify; // let the cloud listener surface errors via the same toast

  // Persist owner-added categories locally; the full list shown everywhere merges these with the
  // built-ins and any category already on an item.
  useEffect(() => { try { localStorage.setItem(CUSTOM_CATS_KEY, JSON.stringify(customCats)); } catch (e) { console.error("custom cats write failed", e); } }, [customCats]);
  const cats = useMemo(() => catList(items, customCats), [items, customCats]);

  // Effective store identity (defaults + owner config). Drives the sidebar brand, the receipt,
  // and anywhere the shop name/logo/address appears.
  const store = useMemo(() => effectiveStore(config), [config]);

  // Prompt for and add a new category. Returns the canonical name to select (existing match if it's
  // a duplicate, the new name otherwise), or null if cancelled/blank. Used by the Add/Edit forms.
  const addCategory = useCallback(() => {
    const raw = window.prompt("New category name:");
    if (raw == null) return null;
    const name = raw.trim();
    if (!name) return null;
    const existing = catList(dataRef.current.items, customCats).find((c) => c.toLowerCase() === name.toLowerCase());
    if (existing) { notifyRef.current?.(`“${existing}” already exists.`); return existing; }
    setCustomCats((cs) => [...cs, name]);
    notifyRef.current?.(`Category “${name}” added.`);
    return name;
  }, [customCats]);

  const resetMyPassword = async () => {
    if (!user?.email) return;
    if (!confirm(`Send a password reset link to ${user.email}?`)) return;
    try { await sendPasswordResetEmail(auth, user.email); notify("Reset link sent to " + user.email); }
    catch (e) { console.error("reset failed", e); notify("⚠ Could not send reset email."); }
  };

  // Append an entry to the global activity log (newest first; capped to protect storage).
  const addLog = (type, message) => {
    const now = new Date();
    setLogs((l) =>
      [
        {
          id: uid(),
          at: now.getTime(),
          date: todayStr(),
          time: now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
          type,
          message,
        },
        ...l,
      ].slice(0, 2000)
    );
  };

  const exportData = (fmt) => {
    const data = { items, sales, expenses, logs, vendorBills: bills, dailyBills, customCats };
    const slug = (store.name || "salon").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "salon";
    const fname = `${slug}-${todayStr()}.${fmt === "xlsx" ? "xlsx" : "json"}`;
    try {
      if (fmt === "xlsx") exportXlsx(data, fname);
      else exportJson(data, fname);
      addLog("backup", `Backup downloaded (${fmt.toUpperCase()})`);
      notify(`Backup downloaded (${fmt.toUpperCase()})`);
    } catch (err) {
      console.error("backup failed", err);
      notify("⚠ Could not create the backup file.");
    }
  };

  const importData = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = ""; // allow re-importing the same file later
    if (!f) return;
    try {
      const ext = (f.name.split(".").pop() || "").toLowerCase();
      const d = ext === "xlsx" || ext === "xls" ? await importXlsx(f) : JSON.parse(await f.text());
      if (!d || !Array.isArray(d.items)) throw new Error("bad file");
      if (!confirm("Restore this backup? It will REPLACE all current data on this device.")) return;
      setItems(normalizeItems(d.items));
      setSales(Array.isArray(d.sales) ? d.sales : []);
      setExpenses(Array.isArray(d.expenses) ? d.expenses : []);
      setLogs(Array.isArray(d.logs) ? d.logs : []);
      setBills(Array.isArray(d.vendorBills) ? d.vendorBills : []);
      setDailyBills(Array.isArray(d.dailyBills) ? d.dailyBills : []);
      // Owner-added categories with no item yet — only overwrite when the backup carries them,
      // so restoring an older backup (which predates this field) doesn't wipe current categories.
      if (Array.isArray(d.customCats)) setCustomCats(d.customCats.filter((x) => typeof x === "string"));
      addLog("backup", `Backup restored (${ext.toUpperCase()})`);
      notify("Backup restored");
    } catch (err) {
      console.error("restore failed", err);
      notify("⚠ That file is not a valid backup.");
    }
  };

  // Keep every customer's denormalized visit/spend stats in step with the bills.
  //
  // This lives HERE, at the shell, rather than at each call site that touches a bill — billing,
  // a Sales History edit, a delete, a split, a restore, an incoming sync from another device.
  // Any of those can change what a customer has spent, and a reversal bolted onto each one is
  // a reversal waiting to be forgotten. Reconciling from the bills themselves means there is
  // no reversal to forget: delete a bill and the stats simply recompute without it.
  //
  // reconcileCustomers returns the same array reference when nothing changed, so this settles
  // after one pass instead of pushing a write to the cloud on every render.
  useEffect(() => {
    if (!loaded || !synced.current.customers || !synced.current.sales) return;
    setCustomers((cs) => reconcileCustomers(cs, sales));
  }, [sales, customers, loaded]);

  const lowStock = items.filter((i) => i.stock <= i.lowAt);
  const alertCount = lowStock.length + items.filter((i) => { const d = daysToExpiry(i); return d != null && d <= 30; }).length;

  // The rails this role actually sees. Hiding a tab is a convenience, not the control — the
  // render switch below re-checks every gated view with can(), because `tab` is just state and
  // could be set to anything.
  const myTopTabs = useMemo(() => TOP_TABS.filter((t) => tabAllowed(role, t)), [role]);
  const myOtherTabs = useMemo(() => OTHER_TABS.filter((t) => tabAllowed(role, t)), [role]);

  // If the active tab isn't allowed (a live demotion, or a stale tab from a previous session),
  // fall back to the dashboard rather than rendering a blank main pane.
  useEffect(() => {
    const all = [...TOP_TABS, ...OTHER_TABS];
    const current = all.find(([k]) => k === tab);
    if (current && !tabAllowed(role, current)) setTab("dashboard");
  }, [role, tab]);

  // Show the "Other" sub-list when the user toggled it open, or whenever an active tab
  // lives inside it (so the current page is never hidden behind a collapsed group).
  const showOther = otherOpen || myOtherTabs.some(([k]) => k === tab);

  // ---- the render switch, with a permission guard on every gated view ----
  // `guard` is the second enforcement layer. The nav already hides what a role can't reach, but
  // `tab` is ordinary state: hiding a button is not a control. Each branch names the SAME action
  // its nav entry declares, so a tab and its view can never drift out of step.
  const guard = (action, node) => (can(role, action) ? node : <NoAccess role={role} />);
  const dashboard = (
    <Dashboard items={items} sales={sales} lowStock={can(role, "inventory.view") ? lowStock : []} goBilling={() => setTab("billing")} role={role} />
  );
  const VIEWS = {
    dashboard: () => dashboard,
    billing: () => guard("billing.use", <Billing items={items} sales={sales} services={services} staff={staff} customers={customers} setItems={setItems} setSales={setSales} setCustomers={setCustomers} store={store} notify={notify} log={addLog} role={role} />),
    customers: () => guard("customers.browse", <Customers customers={customers} sales={sales} services={services} staff={staff} setCustomers={setCustomers} notify={notify} log={addLog} />),
    services: () => guard("services.manage", <Services services={services} setServices={setServices} notify={notify} log={addLog} />),
    staff: () => guard("staff.manage", <Staff staff={staff} setStaff={setStaff} notify={notify} log={addLog} />),
    raw: () => guard("import.use", <RawData items={items} setItems={setItems} setSales={setSales} setExpenses={setExpenses} notify={notify} log={addLog} />),
    inventory: () => guard("inventory.view", <Inventory items={items} setItems={setItems} notify={notify} log={addLog} cats={cats} onAddCategory={addCategory} role={role} />),
    alerts: () => guard("alerts.view", <Alerts items={items} goInventory={() => setTab("inventory")} cats={cats} />),
    barcode: () => guard("barcode.use", <BarcodeCreator items={items} setItems={setItems} store={store} notify={notify} log={addLog} />),
    sales: () => guard("sales.view", <SalesHistory sales={sales} items={items} staff={staff} setSales={setSales} setItems={setItems} store={store} notify={notify} log={addLog} role={role} />),
    finance: () => (tabEnabled("finance") ? guard("finance.view", <Finance sales={sales} expenses={expenses} />) : dashboard),
    stats: () => guard("stats.view", <Stats sales={sales} expenses={expenses} items={items} />),
    udhari: () => guard("udhari.manage", <Udhari sales={sales} setSales={setSales} notify={notify} log={addLog} />),
    expense: () => guard("expenses.manage", <Expenses expenses={expenses} setExpenses={setExpenses} notify={notify} log={addLog} />),
    vendorbills: () => guard("vendorBills.manage", <VendorBills bills={bills} setBills={setBills} setDailyBills={setDailyBills} online={online} notify={notify} log={addLog} />),
    logs: () => guard("logs.view", <Logs logs={logs} setLogs={setLogs} notify={notify} />),
    changelog: () => <Changelog />,
    settings: () => guard("settings.manage", <StoreConfig config={config} setConfig={setConfig} notify={notify} log={addLog} user={user} role={role} />),
    admin: () => guard("settings.manage", <Admin items={items} setItems={setItems} setSales={setSales} setExpenses={setExpenses} setLogs={setLogs} user={user} notify={notify} log={addLog} />),
  };
  const view = (VIEWS[tab] || VIEWS.dashboard)();

  return (
    <div className="app" style={S.app}>
      <style>{CSS}</style>
      {/* sidebar */}
      <nav className="nav" style={S.nav}>
        <div style={S.logo}>
          <img src={store.logo || LOGO_SRC} alt={store.name} style={{ width: 42, height: 42, borderRadius: 10, objectFit: "contain", background: "#fff", padding: 2, flexShrink: 0 }} />
          <div>
            <div style={{ fontWeight: 800, fontSize: 14.5, letterSpacing: "-0.02em" }}>{store.name}</div>
            <div style={{ fontSize: 10.5, color: "#9DB5A8", lineHeight: 1.3 }}>{store.address}</div>
          </div>
        </div>
        {myTopTabs.map(([k, ic, label]) => (
          <button key={k} className={"navbtn" + (tab === k ? " active" : "")} onClick={() => setTab(k)}>
            <span style={{ width: 22, display: "inline-block", textAlign: "center" }}>{ic}</span> {label}
            {k === "inventory" && lowStock.length > 0 && (
              <span style={S.badge}>{lowStock.length}</span>
            )}
          </button>
        ))}
        {/* "Other" group — collapses the secondary sections. Auto-opens when one of its
            tabs is active so the current page is always visible in the rail. Hidden outright
            when this role has nothing in it, rather than left as an empty dead-end. */}
        {myOtherTabs.length > 0 && (
          <button
            className={"navbtn" + (showOther ? " active" : "")}
            onClick={() => setOtherOpen((o) => !o)}
            aria-expanded={showOther}
          >
            <span style={{ width: 22, display: "inline-block", textAlign: "center" }}>⋯</span> Other
            <span style={{ marginLeft: "auto", fontSize: 11, opacity: 0.8 }}>{showOther ? "▾" : "▸"}</span>
            {!showOther && alertCount > 0 && <span style={S.badge}>{alertCount}</span>}
          </button>
        )}
        {showOther && myOtherTabs.map(([k, ic, label]) => (
          <button key={k} className={"navbtn sub" + (tab === k ? " active" : "")} onClick={() => setTab(k)}>
            <span style={{ width: 22, display: "inline-block", textAlign: "center" }}>{ic}</span> {label}
            {k === "alerts" && alertCount > 0 && (
              <span style={S.badge}>{alertCount}</span>
            )}
          </button>
        ))}
        {/* Backup/Restore is owner-only: a restore rewrites the whole tree, and an export
            hands the entire salon's books to whoever is holding the phone. */}
        {can(role, "backup.use") && (
          <div style={{ marginTop: "auto", padding: "8px 8px 4px" }}>
            <div style={{ fontSize: 10.5, color: "#6E8A7C", textTransform: "uppercase", letterSpacing: ".06em", padding: "0 6px 4px" }}>Backup</div>
            <div style={{ display: "flex", gap: 6 }}>
              <button className="navbtn" style={{ border: "1px solid #2A5A3E", justifyContent: "center" }} onClick={() => exportData("json")}>⬇ JSON</button>
              <button className="navbtn" style={{ border: "1px solid #2A5A3E", justifyContent: "center" }} onClick={() => exportData("xlsx")}>⬇ XLSX</button>
            </div>
            <label className="navbtn" style={{ border: "1px solid #2A5A3E", justifyContent: "center", cursor: "pointer", marginTop: 6 }}>
              ⬆ Restore (JSON / XLSX)
              <input type="file" accept=".json,.xlsx,.xls,application/json" onChange={importData} style={{ display: "none" }} />
            </label>
          </div>
        )}
        {/* Pushes the footer down when the Backup block above (which normally carries the
            margin-top:auto) is hidden for this role. */}
        <div style={{ display: "flex", gap: 6, padding: "8px 8px 4px", marginTop: can(role, "backup.use") ? 0 : "auto" }}>
          <button className="navbtn" style={{ border: "1px solid #2A5A3E", justifyContent: "center" }} onClick={resetMyPassword}>🔑 Reset</button>
          <button className="navbtn" style={{ border: "1px solid #2A5A3E", justifyContent: "center" }} onClick={onLogout}>⎋ Logout</button>
        </div>
        <div style={{ fontSize: 11, color: "#6E8A7C", padding: "6px 14px 8px" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, marginBottom: 3 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: online ? "#3FB873" : "#C9803A", display: "inline-block" }} />
            {online ? "Online · syncing live" : "Offline · saved on this device"}
          </span>
          <br />
          {user?.email ? <>Signed in as {user.email} · {ROLE_LABELS[role]}.<br /></> : null}
          {can(role, "backup.use") ? "Back up regularly." : null}
        </div>
      </nav>

      {/* main */}
      <main className="main" style={S.main}>
        {!loaded ? <div style={{ padding: 40, color: "#667" }}>Loading salon data…</div> : view}
      </main>

      {toast && <div style={S.toast}>{toast}</div>}
    </div>
  );
}

// Shown when a role reaches a view it may not have. In practice the nav never offers the tab,
// so this is the backstop for a stale tab, a live demotion, or a deep link — not a normal path.
const NoAccess = ({ role }) => (
  <div style={{ padding: "48px 24px", textAlign: "center", color: "#667" }}>
    <div style={{ fontSize: 30, marginBottom: 8 }}>🔒</div>
    <div style={{ fontWeight: 700, fontSize: 16, color: "#334", marginBottom: 6 }}>Not available for your role</div>
    <p style={{ fontSize: 13, lineHeight: 1.6, maxWidth: 380, margin: "0 auto" }}>
      You're signed in as <strong>{ROLE_LABELS[role] || "an unknown role"}</strong>. Ask the owner if you need access to this section.
    </p>
  </div>
);

// ---------- Dashboard ----------
function Dashboard({ items, sales, lowStock, goBilling }) {
  const [date, setDate] = useState(todayStr());
  const isToday = date === todayStr();
  const daySales = sales.filter((s) => s.date === date);
  const rev = money(daySales.reduce((a, s) => a + (s.total || 0), 0));
  const profit = money(daySales.reduce((a, s) => a + (s.profit || 0), 0));
  // Value of on-hand stock at cost. Reuse the shared helper (which coerces every
  // item's buyPrice/stock with Number(..)||0) so one item with a missing/blank
  // price can't turn the whole sum into NaN, and this card always matches the
  // Inventory "Stock value by category" total (inv.cost).
  const stockValue = inventoryValue(items).cost;
  const month = date.slice(0, 7);
  const monthSales = sales.filter((s) => s.date.startsWith(month));
  const monthRev = money(monthSales.reduce((a, s) => a + (s.total || 0), 0));
  const monthProfit = money(monthSales.reduce((a, s) => a + (s.profit || 0), 0));
  // Sales/revenue above are amounts BOOKED (they include Udhari/credit bills at full value).
  // These are the still-unpaid (on-credit) portions, shown as a sub-note so the gap is visible.
  const udhariOf = (list) => money(list.reduce((a, s) => a + (s.payment === "Udhari" ? Math.max(0, (s.total || 0) - (s.paid || 0)) : 0), 0));
  const dayUdhari = udhariOf(daySales);
  const monthUdhari = udhariOf(monthSales);
  const monthName = new Date(date + "T00:00").toLocaleDateString("en-IN", { month: "long" });
  const niceDate = new Date(date + "T00:00").toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const trend = useMemo(() => {
    const d = new Date(); d.setDate(d.getDate() - 13);
    return buildSeries(sales, [], dateStr(d), todayStr());
  }, [sales]);

  // --- "Over time" charts: user picks a period, we show day-wise & week-wise series. ---
  const [period, setPeriod] = useState("7d");
  const [customFrom, setCustomFrom] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 6); return dateStr(d); });
  const [customTo, setCustomTo] = useState(todayStr());
  const range = useMemo(() => {
    if (period === "custom") return { from: customFrom, to: customTo };
    const opt = DASH_PERIODS.find((p) => p[0] === period);
    const d = new Date(); (opt?.[2] || (() => {}))(d);
    return { from: dateStr(d), to: todayStr() };
  }, [period, customFrom, customTo]);
  const dailySeries = useMemo(() => buildDaily(sales, range.from, range.to), [sales, range.from, range.to]);
  const weeklySeries = useMemo(() => buildWeekly(sales, range.from, range.to), [sales, range.from, range.to]);
  const rangeLabel = useMemo(() => {
    const f = (ds) => new Date(ds + "T00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
    return range.from && range.to ? `${f(range.from)} – ${f(range.to)}` : "";
  }, [range]);

  // Fixed monthly overview: one bucket per calendar month from May 2026 through the current
  // month, regardless of the day picker above. Months with no sales show as zero bars.
  const monthly = useMemo(() => {
    const nowKey = todayStr().slice(0, 7);
    const keys = [];
    let y = 2026, m = 5; // start: May 2026
    const [ey, em] = nowKey.split("-").map(Number);
    while (y < ey || (y === ey && m <= em)) {
      keys.push(`${y}-${String(m).padStart(2, "0")}`);
      m++; if (m > 12) { m = 1; y++; }
    }
    const agg = Object.fromEntries(keys.map((k) => [k, { revenue: 0, profit: 0 }]));
    sales.forEach((s) => { const k = (s.date || "").slice(0, 7); if (agg[k]) { agg[k].revenue += s.total || 0; agg[k].profit += s.profit || 0; } });
    return keys.map((k) => ({
      key: k,
      label: new Date(k + "-01T00:00").toLocaleDateString("en-IN", { month: "short", year: "2-digit" }),
      revenue: money(agg[k].revenue),
      profit: money(agg[k].profit),
    }));
  }, [sales]);

  return (
    <div>
      <Header title="Dashboard" sub={niceDate}>
        <label style={{ fontSize: 12, color: "#6B7E74" }}>
          View day{" "}
          <input type="date" className="input" style={{ width: "auto", marginLeft: 4 }} value={date} max={todayStr()} onChange={(e) => setDate(e.target.value)} />
        </label>
      </Header>
      <div style={S.cards}>
        <Card label={isToday ? "Today's sales" : "Sales (this day)"} value={INR(rev)} sub={daySales.length + " bills" + (dayUdhari > 0 ? ` · ${INR(dayUdhari)} on udhari` : "")} />
        <Card label={isToday ? "Today's profit" : "Profit (this day)"} value={<>{INR(profit)} <span style={{ fontSize: 14, fontWeight: 700, opacity: 0.85 }}>({rev > 0 ? Math.round((profit / rev) * 100) : 0}%)</span></>} sub="after item cost · % of sales" accent />
        <Card label={monthName + " revenue"} value={INR(monthRev)} sub={"month to date" + (monthUdhari > 0 ? ` · ${INR(monthUdhari)} on udhari` : "")} />
        <Card label={monthName + " profit"} value={<>{INR(monthProfit)} <span style={{ fontSize: 14, fontWeight: 700, opacity: 0.85 }}>({monthRev > 0 ? Math.round((monthProfit / monthRev) * 100) : 0}%)</span></>} sub="month to date · after item cost · % of sales" accent />
        <Card label="Stock value" value={INR(stockValue)} sub={items.length + " items (at cost)"} />
      </div>

      <div style={{ marginTop: 16 }}>
        <ChartCard title="Sales — last 14 days" height={200}>
          <BarChart data={trend} margin={{ top: 16, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#678" }} interval={0} minTickGap={0} />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} />
            <Bar dataKey="revenue" name="Revenue" fill="#1B5E43" radius={[3, 3, 0, 0]} label={barLabel} />
          </BarChart>
        </ChartCard>
      </div>

      <div style={{ fontSize: 13, fontWeight: 800, color: "#10331F", letterSpacing: ".02em", margin: "22px 0 8px" }}>
        Monthly overview <span style={{ fontWeight: 500, color: "#8A9C90" }}>(from May 2026)</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <ChartCard title="Monthly revenue" height={220}>
          <BarChart data={monthly} margin={{ top: 16, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#678" }} />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} />
            <Bar dataKey="revenue" name="Revenue" fill="#1B5E43" radius={[3, 3, 0, 0]} label={barLabel} />
          </BarChart>
        </ChartCard>
        <ChartCard title="Monthly profit" height={220}>
          <BarChart data={monthly} margin={{ top: 16, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#678" }} />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} />
            <Bar dataKey="profit" name="Profit" fill="#E8A33D" radius={[3, 3, 0, 0]} label={barLabel} />
          </BarChart>
        </ChartCard>
      </div>
      <div style={{ marginTop: 16 }}>
        <ChartCard title="Monthly revenue vs profit" height={240}>
          <BarChart data={monthly} margin={{ top: 16, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#678" }} />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="revenue" name="Revenue" fill="#1B5E43" radius={[3, 3, 0, 0]} label={barLabel} />
            <Bar dataKey="profit" name="Profit" fill="#E8A33D" radius={[3, 3, 0, 0]} label={barLabel} />
          </BarChart>
        </ChartCard>
      </div>

      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, margin: "22px 0 8px" }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: "#10331F", letterSpacing: ".02em" }}>Revenue &amp; profit over time</span>
        <select className="input" style={{ width: "auto" }} value={period} onChange={(e) => setPeriod(e.target.value)}>
          {DASH_PERIODS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
        {period === "custom" && (
          <>
            <input type="date" className="input" style={{ width: "auto" }} value={customFrom} max={customTo || todayStr()} onChange={(e) => setCustomFrom(e.target.value)} />
            <span style={{ color: "#8A9C90" }}>to</span>
            <input type="date" className="input" style={{ width: "auto" }} value={customTo} max={todayStr()} onChange={(e) => setCustomTo(e.target.value)} />
          </>
        )}
        {rangeLabel && <span style={{ fontSize: 12, color: "#8A9C90" }}>{rangeLabel}</span>}
      </div>

      <div style={{ fontSize: 12, fontWeight: 700, color: "#4A5D52", margin: "10px 0 6px" }}>Day wise</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <ChartCard title="Day wise revenue" height={220}>
          <BarChart data={dailySeries} margin={{ top: 16, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#678" }} interval="preserveStartEnd" minTickGap={16} />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} />
            <Bar dataKey="revenue" name="Revenue" fill="#1B5E43" radius={[3, 3, 0, 0]} label={barLabel} />
          </BarChart>
        </ChartCard>
        <ChartCard title="Day wise profit" height={220}>
          <BarChart data={dailySeries} margin={{ top: 16, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#678" }} interval="preserveStartEnd" minTickGap={16} />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} />
            <Bar dataKey="profit" name="Profit" fill="#E8A33D" radius={[3, 3, 0, 0]} label={barLabel} />
          </BarChart>
        </ChartCard>
      </div>
      <div style={{ marginTop: 16 }}>
        <ChartCard title="Day wise revenue vs profit" height={240}>
          <BarChart data={dailySeries} margin={{ top: 16, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#678" }} interval="preserveStartEnd" minTickGap={16} />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="revenue" name="Revenue" fill="#1B5E43" radius={[3, 3, 0, 0]} label={barLabel} />
            <Bar dataKey="profit" name="Profit" fill="#E8A33D" radius={[3, 3, 0, 0]} label={barLabel} />
          </BarChart>
        </ChartCard>
      </div>

      <div style={{ fontSize: 12, fontWeight: 700, color: "#4A5D52", margin: "18px 0 6px" }}>Week wise <span style={{ fontWeight: 500, color: "#8A9C90" }}>(week starting Mon)</span></div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <ChartCard title="Week wise revenue" height={220}>
          <BarChart data={weeklySeries} margin={{ top: 16, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#678" }} interval="preserveStartEnd" minTickGap={16} />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} labelFormatter={(l) => "Week of " + l} />
            <Bar dataKey="revenue" name="Revenue" fill="#1B5E43" radius={[3, 3, 0, 0]} label={barLabel} />
          </BarChart>
        </ChartCard>
        <ChartCard title="Week wise profit" height={220}>
          <BarChart data={weeklySeries} margin={{ top: 16, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#678" }} interval="preserveStartEnd" minTickGap={16} />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} labelFormatter={(l) => "Week of " + l} />
            <Bar dataKey="profit" name="Profit" fill="#E8A33D" radius={[3, 3, 0, 0]} label={barLabel} />
          </BarChart>
        </ChartCard>
      </div>
      <div style={{ marginTop: 16 }}>
        <ChartCard title="Week wise revenue vs profit" height={240}>
          <BarChart data={weeklySeries} margin={{ top: 16, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#678" }} interval="preserveStartEnd" minTickGap={16} />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} labelFormatter={(l) => "Week of " + l} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="revenue" name="Revenue" fill="#1B5E43" radius={[3, 3, 0, 0]} label={barLabel} />
            <Bar dataKey="profit" name="Profit" fill="#E8A33D" radius={[3, 3, 0, 0]} label={barLabel} />
          </BarChart>
        </ChartCard>
      </div>

      <div style={{ marginTop: 16 }}>
        <ChartCard title={`Payments in ${monthName} — Total vs Cash vs UPI`} height={200}>
          {renderPayMix(monthSales)}
        </ChartCard>
      </div>

      <div style={{ marginTop: 16 }}>
        <ChartCard title="Total vs Cash vs UPI — last 14 days" height={200}>
          {renderPayTrend(trend)}
        </ChartCard>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
        <section style={S.panel}>
          <div style={S.panelHead}>
            Low stock — reorder soon
            {lowStock.length > 0 && <span style={{ ...S.badge, position: "static", marginLeft: 8 }}>{lowStock.length}</span>}
          </div>
          {lowStock.length === 0 ? (
            <Empty text="All items are well stocked." />
          ) : (
            lowStock.slice(0, 8).map((i) => (
              <div key={i.id} style={S.row}>
                <span>{i.name}</span>
                <span style={{ color: "#C44536", fontWeight: 700 }}>{i.stock} {i.unit} left</span>
              </div>
            ))
          )}
        </section>
        <section style={S.panel}>
          <div style={S.panelHead}>{isToday ? "Recent bills" : "Bills on this day"}</div>
          {daySales.length === 0 ? (
            <Empty text={isToday ? "No bills yet today." : "No bills on this day."}>
              {isToday && <button className="btn primary" onClick={goBilling}>Start billing</button>}
            </Empty>
          ) : (
            [...daySales].reverse().slice(0, 8).map((s) => (
              <div key={s.id} style={S.row}>
                <span>{s.time} · {s.lines.length} items</span>
                <b>{INR(s.total)}</b>
              </div>
            ))
          )}
        </section>
      </div>
    </div>
  );
}

// ---------- Customer picker ----------
// The front desk's entry point to the customer database, and deliberately the ONLY one a
// biller gets: search and quick-create, never a browsable list. Typing a full unknown number
// offers to create it on the spot, because the moment to capture a customer is while they're
// standing at the counter — not later, never.
//
// A bill with no customer is still valid: a walk-in who won't give a number must not be a
// blocker at the till.
function CustomerPicker({ customers, value, onPick, onCreate, notify }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(null); // a draft customer, when quick-creating
  const [err, setErr] = useState("");
  const boxRef = useRef(null);

  const picked = value ? customers.find((c) => c.phone === value) : null;
  const results = useMemo(() => searchCustomers(customers, q, 6), [customers, q]);

  // A fully-typed number that matches nobody → offer to create it.
  const unknownNumber = useMemo(() => {
    const p = normalizePhone(q);
    return isValidPhone(p) && !customers.some((c) => c.phone === p) ? p : "";
  }, [q, customers]);

  useEffect(() => {
    const onDown = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const pick = (c) => { onPick(c.phone); setQ(""); setOpen(false); };

  const startCreate = (phone) => { setCreating(blankCustomer(phone, todayStr())); setErr(""); setOpen(false); };

  const saveCreate = () => {
    const problem = validateCustomer(creating, customers, true);
    if (problem) return setErr(problem);
    const rec = makeCustomer(creating, { createdAt: todayStr() });
    onCreate(rec);
    onPick(rec.phone);
    notify?.(`✓ ${rec.name} added`);
    setCreating(null);
    setQ("");
  };

  if (picked) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#EEF6F1", border: "1px solid #CFE3D7", borderRadius: 9, padding: "7px 10px" }}>
        <span style={{ width: 26, height: 26, borderRadius: "50%", background: "#1B5E43", color: "#fff", display: "grid", placeItems: "center", fontWeight: 700, fontSize: 12, flexShrink: 0 }}>
          {String(picked.name || "?").trim().charAt(0).toUpperCase()}
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{picked.name}</div>
          <div style={{ fontSize: 11.5, color: "#6B7E74" }}>
            {formatPhone(picked.phone)}
            {picked.totalVisits ? ` · ${picked.totalVisits} visit${picked.totalVisits > 1 ? "s" : ""}` : " · first visit"}
          </div>
        </div>
        <button className="btn ghost" style={{ fontSize: 12 }} onClick={() => onPick("")}>Change</button>
      </div>
    );
  }

  return (
    <div ref={boxRef} style={{ position: "relative" }}>
      <input
        className="input" type="search" placeholder="Search name or phone… (optional)"
        value={q} onFocus={() => setOpen(true)}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (results.length === 1) pick(results[0]);
            else if (unknownNumber) startCreate(unknownNumber);
          }
        }}
      />
      {open && (q.trim() || results.length > 0) && (
        <div style={{ position: "absolute", zIndex: 30, top: "100%", left: 0, right: 0, background: "#fff", border: "1px solid #DDE5DF", borderRadius: 9, marginTop: 4, boxShadow: "0 10px 26px rgba(0,0,0,.13)", overflow: "hidden" }}>
          {results.map((c) => (
            <button
              key={c.phone} onClick={() => pick(c)}
              style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 10px", border: "none", background: "none", cursor: "pointer", borderBottom: "1px solid #F0F4F1" }}
            >
              <div style={{ fontWeight: 600, fontSize: 13 }}>{c.name || "(no name)"}</div>
              <div style={{ fontSize: 11.5, color: "#6B7E74" }}>
                {formatPhone(c.phone)}
                {c.totalVisits ? ` · ${c.totalVisits} visit${c.totalVisits > 1 ? "s" : ""} · ${INR(c.totalSpend || 0)}` : ""}
              </div>
            </button>
          ))}
          {unknownNumber && (
            <button
              onClick={() => startCreate(unknownNumber)}
              style={{ display: "block", width: "100%", textAlign: "left", padding: "9px 10px", border: "none", background: "#F4FAF6", cursor: "pointer", color: "#1B5E43", fontWeight: 600, fontSize: 13 }}
            >
              + Add {formatPhone(unknownNumber)} as a new customer
            </button>
          )}
          {!results.length && !unknownNumber && (
            <div style={{ padding: "9px 10px", fontSize: 12.5, color: "#8A9C90" }}>
              {normalizePhone(q).length >= 4 && !isValidPhone(q) ? "Keep typing the full 10-digit number to add them…" : "No match."}
            </div>
          )}
        </div>
      )}

      {creating && (
        <Modal title="New customer" onClose={() => setCreating(null)}>
          <CustomerForm value={creating} onChange={setCreating} isNew err={err} />
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 14 }}>
            <button className="btn" onClick={() => setCreating(null)}>Cancel</button>
            <button className="btn primary" onClick={saveCreate}>Add & select</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------- Billing / POS ----------
function Billing({ items, sales, services, staff, customers, setItems, setSales, setCustomers, store = STORE, notify, log, role }) {
  const [q, setQ] = useState("");
  const [cart, setCart] = useState([]); // {id, lineType, name, icon, unit, sellPrice, buyPrice, qty, staffId?}
  const [lastSale, setLastSale] = useState(null);
  const [saleDate, setSaleDate] = useState(todayStr()); // back-date a bill if needed
  const [pay, setPay] = useState("UPI"); // UPI | Cash | Udhari
  const [customer, setCustomer] = useState("");
  const [mobile, setMobile] = useState("");
  // The picked customer's phone — the durable link from a bill to a customer record. "" is a
  // legitimate walk-in: someone who won't leave a number must never be a blocker at the till.
  const [customerPhone, setCustomerPhone] = useState("");
  // Which half of the catalogue the search pane is showing. A salon bill is mostly services,
  // so that's the default.
  const [mode, setMode] = useState("service"); // "service" | "product"
  // Who gets attributed (and paid commission for) the next service added. Sticky across adds:
  // one stylist usually does the whole sitting, and re-picking per line would be tedious.
  const [lineStaff, setLineStaff] = useState("");
  const [paidNow, setPaidNow] = useState(""); // Udhari part-payment taken at billing time
  const [paidMode, setPaidMode] = useState("Cash"); // how that part-payment was received (UPI/Cash)
  const [discount, setDiscount] = useState(""); // optional extra discount on the whole bill
  const [discMode, setDiscMode] = useState("₹"); // "₹" = flat amount, "%" = percent of subtotal
  const [miscName, setMiscName] = useState("");
  const [miscPrice, setMiscPrice] = useState("");
  const [miscCode, setMiscCode] = useState(""); // optional barcode → item is catalogued so it scans next time
  const miscNameRef = useRef(null);             // focused when the "not found" modal hands a scan over
  const [stockFor, setStockFor] = useState(null); // item id whose quick "add stock" box is open
  const [stockQty, setStockQty] = useState("");
  const [custFocus, setCustFocus] = useState(false); // customer-name field focused → show suggestions
  const [notFound, setNotFound] = useState(null); // a scanned barcode that matched no product → modal
  const searchRef = useRef(null);
  const notFoundAt = useRef(0); // when the not-found modal opened — used to swallow a scanner's trailing Enter
  useEffect(() => searchRef.current?.focus(), []);
  const showNotFound = (code) => { notFoundAt.current = Date.now(); setNotFound(code); };

  // Unique past customers (name + most-recent non-empty mobile) for the name autocomplete.
  // Sales are appended oldest→newest, so the last seen mobile per name is the most recent.
  const knownCustomers = useMemo(() => {
    const m = new Map();
    sales.forEach((s) => {
      const name = (s.customer || "").trim();
      if (!name) return;
      const key = name.toLowerCase();
      const e = m.get(key) || { name, mobile: "" };
      e.name = name; // keep latest spelling/casing
      if ((s.mobile || "").trim()) e.mobile = s.mobile.trim();
      m.set(key, e);
    });
    return [...m.values()];
  }, [sales]);

  // Suggestions for the currently-typed name (substring match, excluding an exact hit).
  const custSuggestions = useMemo(() => {
    const q = customer.trim().toLowerCase();
    if (!q) return [];
    return knownCustomers
      .filter((c) => c.name.toLowerCase().includes(q) && c.name.toLowerCase() !== q)
      .slice(0, 6);
  }, [customer, knownCustomers]);

  // The customer this bill is for, if one has been picked. null = walk-in.
  const picked = useMemo(
    () => (customerPhone ? customers.find((c) => c.phone === customerPhone) || null : null),
    [customerPhone, customers]
  );

  const bookableStaff = useMemo(() => activeStaff(staff), [staff]);

  // The service menu, filtered by the same search box the products use. Only active services:
  // the menu is what the salon sells today, not what it used to.
  const serviceResults = useMemo(() => {
    const query = q.trim().toLowerCase();
    const live = activeServices(services);
    const matches = query
      ? live.filter((s) => String(s.name || "").toLowerCase().includes(query) || String(s.category || "").toLowerCase().includes(query))
      : live;
    // Group by category so the pane reads like a menu rather than a flat list.
    const m = new Map();
    matches.slice(0, 60).forEach((s) => {
      const k = s.category || "Other";
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(s);
    });
    return [...m.entries()];
  }, [q, services]);

  // Units sold per item name — used for the best-seller ★ and as a tie-breaker.
  const soldQty = useMemo(() => {
    const m = {};
    (sales || []).forEach((s) => (s.lines || []).forEach((l) => { m[l.name] = (m[l.name] || 0) + l.qty; }));
    return m;
  }, [sales]);

  // Most recent sale date per item name — used to surface recently-sold items first.
  const lastSold = useMemo(() => {
    const m = {};
    (sales || []).forEach((s) => (s.lines || []).forEach((l) => {
      if (!m[l.name] || s.date > m[l.name]) m[l.name] = s.date;
    }));
    return m;
  }, [sales]);

  // Only in-stock items are sellable, but sold-out ones stay visible in the picker (greyed,
  // not tappable) so they're one tap from a quick restock — nothing has to be re-created.
  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    const inStock = items.filter((i) => (i.stock || 0) > 0);
    if (s) {
      // A purely numeric query also matches items priced at that amount (sell price or MRP).
      const isNum = /^\d+(\.\d+)?$/.test(s);
      const num = isNum ? +s : null;
      // While searching, also surface out-of-stock items (for reference) — but always last,
      // and on their own budget so a long list of in-stock matches can't crowd them out.
      const matches = items.filter((i) =>
        i.name.toLowerCase().includes(s) ||
        itemBarcodes(i).some((b) => b.toLowerCase().includes(s)) ||
        (isNum && (+i.sellPrice === num || +i.mrp === num)));
      const inStockMatches = matches.filter((i) => (i.stock || 0) > 0);
      const outMatches = matches.filter((i) => (i.stock || 0) <= 0);
      return [...inStockMatches.slice(0, 12), ...outMatches.slice(0, 8)];
    }
    // No search: most recently sold first, then by units sold, then the rest.
    const byActivity = (a, b) => {
      const la = lastSold[a.name] || "", lb = lastSold[b.name] || "";
      if (la !== lb) return la < lb ? 1 : -1; // newer sale date first
      return (soldQty[b.name] || 0) - (soldQty[a.name] || 0);
    };
    // In-stock (sellable) lines lead; sold-out ones follow on their own budget so they stay
    // visible for a quick restock without ever crowding out what can actually be sold.
    const out = items.filter((i) => (i.stock || 0) <= 0).sort(byActivity);
    return [...[...inStock].sort(byActivity).slice(0, 12), ...out.slice(0, 8)];
  }, [q, items, soldQty, lastSold]);

  // Put an item on the bill (or bump its qty if already there). Functional update so rapid
  // clicks / scanner input never read a stale cart.
  const pushToCart = (item) => setCart((cart) => {
    const ex = cart.find((c) => c.id === item.id);
    return ex
      ? cart.map((c) => (c.id === item.id ? { ...c, qty: c.qty + 1 } : c))
      : [...cart, { id: item.id, lineType: "product", name: item.name, icon: item.icon, unit: item.unit, sellPrice: item.sellPrice, buyPrice: item.buyPrice, qty: 1 }];
  });

  const add = (item) => {
    if (item.stock <= 0) return notify("Out of stock: " + item.name);
    const ex = cart.find((c) => c.id === item.id);
    if (ex && ex.qty + 1 > item.stock) return notify("Only " + item.stock + " " + item.unit + " in stock");
    pushToCart(item);
  };

  // Put a service on the bill, attributed to whoever is currently selected. Unlike a product
  // there is no stock to check — labour doesn't run out — and repeating a service (a second
  // threading, say) just bumps the quantity.
  const addService = (service) => setCart((cart) => {
    const ex = cart.find((c) => c.id === service.id);
    return ex
      ? cart.map((c) => (c.id === service.id ? { ...c, qty: c.qty + 1 } : c))
      : [...cart, serviceToCartLine(service, lineStaff)];
  });

  // Re-attribute one service line. Sittings do get split — a colour by one stylist, the
  // blow-dry by another — and commission has to follow the person who actually did the work.
  const setLineStaffFor = (id, staffId) =>
    setCart((cart) => cart.map((c) => (c.id === id ? { ...c, staffId } : c)));

  // Scanning a barcode always adds the item to the bill — even at zero stock. A sold-out item is
  // auto-restocked to SCAN_RESTOCK_QTY (5) so the till isn't blocked; the restock is guarded by a
  // functional updater so a rapid second scan of the same item can't stack another +5.
  const SCAN_RESTOCK_QTY = 5;
  const addScannedItem = (item) => {
    if ((item.stock || 0) <= 0) {
      setItems((list) => list.map((i) => (i.id === item.id && (i.stock || 0) <= 0 ? addBatch(i, SCAN_RESTOCK_QTY, "", todayStr()) : i)));
      log("inventory", `Auto-restocked “${item.name}” to ${SCAN_RESTOCK_QTY} (scanned at billing while out of stock)`);
      notify(`“${item.name}” was out of stock — restocked to ${SCAN_RESTOCK_QTY} and added.`);
      pushToCart(item);
      return;
    }
    add(item);
  };
  const setQty = (id, qty) => {
    const line = cart.find((c) => c.id === id);
    // Misc / custom lines have no inventory item, and a SERVICE has no stock at all — labour
    // doesn't run out. Stock-limiting either would clamp them to 0 and silently drop the line.
    if (line && !line.misc && !isServiceLine(line)) {
      const stock = items.find((i) => i.id === id)?.stock ?? 0;
      if (qty > stock) { notify("Only " + stock + " in stock"); qty = stock; }
    }
    const q = qty;
    setCart((cart) => (q <= 0 ? cart.filter((c) => c.id !== id) : cart.map((c) => (c.id === id ? { ...c, qty: q } : c))));
  };

  // A misc / custom item: only a sell price is required (name optional). It sells like any line but
  // has no catalogue item, so it never touches inventory stock. An optional buy price can be given
  // so the line still contributes an accurate profit; it defaults to 0 (no tracked cost) if blank.
  // Quick restock straight from the billing picker (so a 0-stock item becomes sellable here).
  const quickRestock = (item) => {
    const qty = +stockQty;
    if (!(qty > 0)) return notify("Enter a quantity to add.");
    setItems((list) => list.map((i) => (i.id === item.id ? addBatch(i, qty, "", todayStr()) : i)));
    log("inventory", `Restocked “${item.name}” +${qty} (from billing)`);
    notify(`Added ${qty} ${item.unit} to ${item.name}`);
    setStockFor(null); setStockQty("");
  };

  // Add an item to the bill from the Misc row — and catalogue it. A name + sell price is required;
  // the barcode is optional (given → the item scans directly next time). Rather than a throwaway
  // misc line, this registers a REAL inventory item with an opening stock of 20 and a category
  // auto-guessed from the name, so the shop's catalogue grows as it bills. The cart line is
  // inventory-backed (real id), so completing the sale depletes that stock (20 → 19 …) like any item.
  // Cost/buy price defaults to 80% of the sell price (≈20% margin), since this row has no buy field.
  // If the name/barcode already belongs to a catalogued item, that item is billed instead — no
  // duplicate is created and no extra stock is added.
  const OPENING_STOCK = 20;     // opening stock for a quick-catalogued item
  const BUY_PRICE_RATIO = 0.8;  // default cost = 80% of sell price (≈20% margin)
  const addMisc = () => {
    const price = +miscPrice;
    if (!(price > 0)) return notify("Enter a price for the item.");
    const name = miscName.trim();
    if (!name) return notify("Enter a name for the item.");
    const codes = parseBarcodeText(miscCode); // optional; cleaned + de-duped, first token = primary
    // Already in the catalogue (by barcode, else by name)? Bill that item instead of duplicating it.
    const existing = (codes.length ? findItemByBarcode(items, codes[0]) : null)
      || items.find((i) => normName(i.name) === normName(name));
    if (existing) {
      if ((existing.stock || 0) <= 0) return notify(`“${existing.name}” already exists but is out of stock — restock it from the picker.`);
      add(existing);
      setMiscName(""); setMiscPrice(""); setMiscCode("");
      return;
    }
    // New item: a typed barcode must not already belong to another product.
    const bcClash = findBarcodeClash(codes, items);
    if (bcClash) return notify(`Barcode “${bcClash.code}” already belongs to “${bcClash.item.name}”.`);
    const category = guessCategory(name, items) || "Other"; // auto-corrected from the name
    const sell = money(price);
    const batches = [{ id: uid(), qty: OPENING_STOCK, expiry: "", addedOn: todayStr() }];
    const newItem = {
      name, code: codes[0] || "", barcodes: codes.slice(1), category, unit: "pc",
      icon: iconFor(category), buyPrice: money(sell * BUY_PRICE_RATIO), sellPrice: sell, mrp: sell,
      lowAt: 5, id: uid(), stock: OPENING_STOCK, batches, createdAt: todayStr(),
    };
    setItems((list) => [...list, newItem]);
    pushToCart(newItem); // inventory-backed cart line (real id) → stock depletes on sale
    log("inventory", `Added item “${name}” · ${OPENING_STOCK} pc @ ${INR(sell)} (cost ${INR(newItem.buyPrice)}) · ${category} (from billing${codes[0] ? `, barcode ${codes[0]}` : ""})`);
    notify(`Added “${name}” to inventory (${category}, stock ${OPENING_STOCK}) & this bill`);
    setMiscName(""); setMiscPrice(""); setMiscCode("");
  };

  // Enter fires from a barcode scanner (types the value then sends Enter) or a manual search.
  // 1) Exact barcode match across ALL items → add/increment (the scan path).
  // 2) A barcode-shaped value with no exact match → "No item found" modal (don't guess).
  // 3) A typed search that matched something → add the top result (manual flow, unchanged).
  // 4) Anything else that matched nothing → "No item found" modal too.
  // The value is read from the input's DOM node (not the `q` state) so a fast keyboard-wedge
  // burst is captured in full even if React hasn't re-rendered for the final characters yet.
  // A hit clears the input and keeps it focused for the next scan; a miss opens the modal (which
  // takes focus) and returns focus to the input when dismissed.
  const onSearchKey = (e) => {
    if (e.key !== "Enter") return;
    if (notFound != null) { setQ(""); return; }                                 // modal already open → swallow trailing Enter(s)
    const raw = String(e.target.value ?? q).trim();
    if (!raw) return;
    const hit = findItemByBarcode(items, raw);
    if (hit) { addScannedItem(hit); setQ(""); searchRef.current?.focus(); return; } // known barcode → add (auto-restock if sold out)
    if (looksLikeBarcode(raw)) { setQ(""); showNotFound(raw); return; }         // unmatched scan → not-found modal
    if (results.length > 0) { add(results[0]); setQ(""); searchRef.current?.focus(); return; } // manual search → top match
    setQ(""); showNotFound(raw);                                                // typed query, nothing matched → modal
  };

  const subtotal = money(cart.reduce((a, c) => a + c.sellPrice * c.qty, 0));
  const grossProfit = money(cart.reduce((a, c) => a + (c.sellPrice - c.buyPrice) * c.qty, 0));
  // Optional whole-bill discount, entered as a flat ₹ amount or a % of the subtotal. Clamped to
  // [0, subtotal] so a bill can never go negative; it comes straight off profit (cost is unchanged).
  // `total`/`profit` stay the NET (post-discount) figures so revenue, udhari, stats and history all
  // book the amount actually charged without any downstream change.
  const discNum = Math.max(0, +discount || 0);
  const discountAmt = discMode === "%" ? money(subtotal * Math.min(100, discNum) / 100) : Math.min(subtotal, money(discNum));
  const total = money(subtotal - discountAmt);
  const profit = money(grossProfit - discountAmt);

  const completeSale = () => {
    if (cart.length === 0) return;
    // Every service line must say who performed it, or its commission has nowhere to go and
    // the stylist quietly loses the money. Cheaper to catch here than to reconcile at payout.
    const unassigned = cart.filter((c) => isServiceLine(c) && !c.staffId);
    if (unassigned.length) return notify(`Who did “${unassigned[0].name}”? Pick a staff member for every service.`);
    // Re-check against the latest stock: another device (or a just-synced change) may have
    // reduced it since these lines were added to the cart. Block rather than oversell.
    // Services are exempt — they consume no stock.
    const short = cart
      .filter((c) => !c.misc && !isServiceLine(c))
      .map((c) => ({ c, stock: items.find((i) => i.id === c.id)?.stock ?? 0 }))
      .filter(({ c, stock }) => c.qty > stock);
    if (short.length) {
      const { c, stock } = short[0];
      return notify(`Only ${stock} ${c.unit} of ${c.name} left — adjust the bill.`);
    }
    const now = new Date();
    const backDated = saleDate !== todayStr();
    const sale = {
      id: uid(),
      date: saleDate,
      time: now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) + (backDated ? " (back-dated)" : ""),
      // Snapshot buyPrice onto each line so historical profit stays anchored to the cost at
      // sale time, even if the item's cost is changed (or the item deleted) later.
      //
      // Service lines additionally snapshot staffId and commissionPct: a payout report must
      // reflect the rate that was in force when the work was done, not whatever the owner has
      // set by the time the report is run. Same reasoning as buyPrice.
      lines: cart.map((c) => ({
        name: c.name, qty: c.qty, unit: c.unit, price: c.sellPrice, buyPrice: c.buyPrice,
        amount: money(c.sellPrice * c.qty),
        lineType: isServiceLine(c) ? "service" : "product",
        ...(isServiceLine(c) ? { staffId: c.staffId, commissionPct: c.commissionPct ?? 0, serviceId: c.id } : {}),
        ...(c.misc ? { misc: true } : {}),
      })),
      total, profit,
      // Only recorded when a discount was actually given, so plain bills keep their exact old shape.
      // `subtotal` is the pre-discount amount; `total` above is what the customer paid.
      ...(discountAmt > 0 ? { subtotal, discount: discountAmt, ...(discMode === "%" ? { discountPct: money(discNum) } : {}) } : {}),
      payment: pay,
      // The durable link to the customer record. Legacy `customer`/`mobile` free text is still
      // written alongside it: Udhari groups bills by name, and old bills only have that.
      ...(picked ? { customerPhone: picked.phone, customer: picked.name, mobile: picked.phone } : {}),
      ...(!picked && customer.trim() ? { customer: customer.trim() } : {}),
      ...(!picked && mobile.trim() ? { mobile: mobile.trim() } : {}),
      // For Udhari (credit), record how much was paid now (and via UPI/Cash); rest stays outstanding.
      ...(pay === "Udhari" ? { paid: Math.min(total, Math.max(0, money(+paidNow || 0))) } : {}),
      ...(pay === "Udhari" && +paidNow > 0 ? { paidMode } : {}),
    };
    setSales((s) => [...s, sale]);
    // Deplete stock for PRODUCT lines only. A service id can't collide with an item id, but
    // filtering by line type says the intent out loud rather than relying on that.
    setItems((its) => its.map((i) => {
      const c = cart.find((x) => x.id === i.id && !isServiceLine(x));
      return c ? removeStock(i, c.qty, saleDate) : i; // FIFO deplete batches by expiry
    }));
    setLastSale(sale);
    const nServices = cart.filter(isServiceLine).length;
    const nProducts = cart.length - nServices;
    const what = [nServices ? `${nServices} service(s)` : "", nProducts ? `${nProducts} product(s)` : ""].filter(Boolean).join(" + ");
    log("sale", `Bill ${INR(total)} · ${what} · ${pay}` + (discountAmt > 0 ? ` · disc ${INR(discountAmt)}` : "") + (picked ? ` (${picked.name})` : customer.trim() ? ` (${customer.trim()})` : "") + (backDated ? ` · back-dated to ${saleDate}` : ""));
    setCart([]);
    setQ("");
    setCustomer("");
    setMobile("");
    setCustomerPhone("");
    setPaidNow("");
    setPaidMode("Cash");
    setDiscount("");
    searchRef.current?.focus();
    notify(`Bill saved (${pay}) — ` + INR(total));
  };

  return (
    <div>
      <Header title="Billing" sub={mode === "service" ? "Tap a service to add it to the bill" : "Tap a product to add it to the bill"}>
        {can(role, "billing.backdate") ? (
          <label style={{ fontSize: 12, color: saleDate === todayStr() ? "#6B7E74" : "#C44536", fontWeight: 600 }}>
            Bill date{" "}
            <input type="date" className="input" style={{ width: "auto", marginLeft: 4 }} value={saleDate} max={todayStr()} onChange={(e) => setSaleDate(e.target.value || todayStr())} />
          </label>
        ) : (
          // A worker bills today. Back-dating moves revenue between days and is an owner call.
          <span style={{ fontSize: 12, color: "#6B7E74" }}>Bill date · {saleDate}</span>
        )}
      </Header>
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16 }}>
        {/* service / item picker */}
        <section style={S.panel}>
          {/* A salon bill is mostly services with the odd retail add-on, so the two halves of
              the catalogue get their own pane rather than being mixed into one list. */}
          <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
            {[["service", "✂ Services"], ["product", "🧴 Products"]].map(([m, label]) => (
              <button
                key={m} className={"btn" + (mode === m ? " primary" : "")} style={{ flex: 1 }}
                onClick={() => { setMode(m); setQ(""); searchRef.current?.focus(); }}
              >{label}</button>
            ))}
          </div>
          <input
            ref={searchRef}
            className="input"
            placeholder={mode === "service" ? "Search services…" : "Search name / barcode / price… (Enter adds top match)"}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={mode === "product" ? onSearchKey : undefined}
            aria-label={mode === "service" ? "Search services" : "Search items or scan barcode"}
            style={{ marginBottom: 12 }}
          />

          {mode === "service" ? (
            <>
              {/* Who's doing the work. Sticky across adds — one stylist usually does the whole
                  sitting — but each line can be re-attributed in the cart. */}
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, padding: "8px 10px", background: "#F4F7F4", borderRadius: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 11.5, fontWeight: 700, color: "#465", whiteSpace: "nowrap" }}>Performed by</span>
                <select className="input" style={{ flex: 1, minWidth: 130 }} value={lineStaff} onChange={(e) => setLineStaff(e.target.value)}>
                  <option value="">Choose staff…</option>
                  {bookableStaff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              {bookableStaff.length === 0 && (
                <div style={{ fontSize: 12.5, color: "#B23B2E", marginBottom: 10 }}>
                  No active staff yet — add someone under Staff before billing a service.
                </div>
              )}
              {serviceResults.length === 0 ? (
                <Empty text={services.length ? "No services match." : "No services on the menu yet."} />
              ) : serviceResults.map(([category, list]) => (
                <div key={category} style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#8A9C90", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6 }}>
                    {serviceIconFor(category)} {category}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    {list.map((s) => (
                      <div key={s.id} className="pick" style={{ cursor: "pointer" }} onClick={() => addService(s)}>
                        <div style={{ fontWeight: 700, fontSize: 13.5 }}>{s.name}</div>
                        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 12.5 }}>
                          <span style={{ color: "#1B5E43", fontWeight: 800 }}>{INR(s.price)}</span>
                          <span style={{ color: "#789" }}>{s.durationMin} min</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </>
          ) : (
          <>
          {/* Misc row → quick "add & catalogue": bills the item AND registers it in inventory
              (opening stock 20, auto category). Barcode is optional; given → it scans next time. */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 12, padding: "8px 10px", background: "#F4F7F4", borderRadius: 8 }}>
            <span style={{ fontSize: 11.5, fontWeight: 700, color: "#465", whiteSpace: "nowrap" }}>🧾 Misc</span>
            <input ref={miscNameRef} className="input" style={{ flex: 1, minWidth: 90 }} placeholder="Name" value={miscName} onChange={(e) => setMiscName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addMisc(); }} aria-label="Item name" />
            <input className="input" style={{ flex: 1, minWidth: 100 }} placeholder="Barcode (optional)" value={miscCode} onChange={(e) => setMiscCode(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addMisc(); }} aria-label="Item barcode (optional)" title="Barcode (optional) — scan or type so this item scans next time" />
            <input className="input" style={{ width: 86 }} type="number" min="0" step="0.01" placeholder="₹ sell" value={miscPrice} onChange={(e) => setMiscPrice(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addMisc(); }} aria-label="Item sell price" />
            <button className="btn" onClick={addMisc}>+ Add</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {results.map((i) => {
              const inStock = (i.stock || 0) > 0;
              const editing = stockFor === i.id;
              return (
                <div key={i.id} className="pick" style={{ position: "relative", cursor: inStock ? "pointer" : "default", background: inStock ? undefined : "#F0F2F0" }} onClick={inStock ? () => add(i) : undefined}>
                  <button title="Add stock" aria-label={"Add stock to " + i.name} onClick={(e) => { e.stopPropagation(); setStockFor(editing ? null : i.id); setStockQty(""); }}
                    style={{ position: "absolute", top: 6, right: 6, width: 22, height: 22, borderRadius: 6, border: "1px solid #BBD3C2", background: "#fff", color: "#1B5E43", fontWeight: 800, cursor: "pointer", lineHeight: 1, padding: 0 }}>＋</button>
                  <div style={{ fontWeight: 700, fontSize: 13.5, paddingRight: 26 }}><span style={{ marginRight: 5 }}>{i.icon || "📦"}</span>{i.name}{soldQty[i.name] ? <span style={{ color: "#E8A33D", fontSize: 11, marginLeft: 4 }} title="best-seller">★</span> : null}</div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 12.5 }}>
                    <span style={{ color: "#1B5E43", fontWeight: 800 }}>{INR(i.sellPrice)}<span style={{ color: "#8AA", fontWeight: 500 }}>/{i.unit}</span></span>
                    <span style={{ color: !inStock || i.stock <= i.lowAt ? "#C44536" : "#789", fontWeight: !inStock ? 600 : 400 }}>{!inStock ? "Out of stock" : i.stock + " left"}</span>
                  </div>
                  {editing && (
                    <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center" }}>
                      <input className="input" style={{ padding: "5px 7px", width: 64 }} type="number" min="1" autoFocus placeholder="Qty" value={stockQty}
                        onChange={(e) => setStockQty(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") quickRestock(i); }} />
                      <button className="btn small primary" onClick={() => quickRestock(i)}>Add</button>
                      <button className="btn small ghost" aria-label="Cancel" onClick={() => { setStockFor(null); setStockQty(""); }}>✕</button>
                    </div>
                  )}
                </div>
              );
            })}
            {results.length === 0 && <Empty text="No items match. Add it from Inventory first." />}
          </div>
          </>
          )}
        </section>

        {/* receipt cart */}
        <section style={S.receipt}>
          <div style={S.receiptHead}>CURRENT BILL</div>

          {/* Who the bill is for. Optional — a walk-in who won't leave a number must never be
              a blocker at the till — but capturing it here is what makes every returning-
              customer feature downstream possible. */}
          <div style={{ marginBottom: 10 }}>
            <CustomerPicker
              customers={customers} value={customerPhone} onPick={setCustomerPhone}
              onCreate={(rec) => setCustomers((list) => [...list, rec])}
              notify={notify}
            />
          </div>

          {cart.length === 0 ? (
            <Empty text="Bill is empty. Tap services or products on the left to add.">
              {lastSale && (
                <button className="btn" onClick={() => printReceipt(lastSale, store, staff)}>🖨 Print last bill · {INR(lastSale.total)}</button>
              )}
            </Empty>
          ) : (
            <>
              {cart.map((c) => (
                <div key={c.id} style={{ ...S.rcptLine, flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}><span style={{ marginRight: 4 }}>{c.icon || "📦"}</span>{c.name}</div>
                    <div style={{ fontSize: 11.5, color: "#777" }}>{INR(c.sellPrice)} × {c.qty} {c.unit}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <button className="qty" aria-label={"Decrease " + c.name} onClick={() => setQty(c.id, c.qty - 1)}>−</button>
                    <span style={{ minWidth: 22, textAlign: "center", fontWeight: 700 }}>{c.qty}</span>
                    <button className="qty" aria-label={"Increase " + c.name} onClick={() => setQty(c.id, c.qty + 1)}>+</button>
                  </div>
                  <b style={{ width: 76, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{INR(c.sellPrice * c.qty)}</b>
                  {/* Per-line attribution: a sitting can be split across stylists, and the
                      commission has to follow whoever actually did each piece. */}
                  {isServiceLine(c) && (
                    <select
                      className="input"
                      style={{ flexBasis: "100%", padding: "3px 6px", fontSize: 11.5, marginTop: 4, borderColor: c.staffId ? undefined : "#E0A96D" }}
                      value={c.staffId || ""} onChange={(e) => setLineStaffFor(c.id, e.target.value)}
                      aria-label={"Who performed " + c.name}
                    >
                      <option value="">⚠ Who did this?</option>
                      {bookableStaff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  )}
                </div>
              ))}
              {/* Optional additional discount on the whole bill (₹ off, or a % of the subtotal). */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, paddingTop: 10, borderTop: "1px dashed #E0D9C4" }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: "#6B7E74" }}>Additional discount</span>
                <div style={{ display: "flex", gap: 4, marginLeft: "auto", alignItems: "center" }}>
                  {["₹", "%"].map((m) => (
                    <button key={m} className={"btn small " + (discMode === m ? "primary" : "ghost")} style={{ minWidth: 30 }} onClick={() => setDiscMode(m)} aria-label={m === "₹" ? "Discount in rupees" : "Discount in percent"}>{m}</button>
                  ))}
                  <input className="input" style={{ width: 74 }} type="number" min="0" step="0.01" max={discMode === "%" ? 100 : subtotal} placeholder="0" value={discount} onChange={(e) => setDiscount(e.target.value)} aria-label="Additional discount amount" />
                </div>
              </div>
              {discountAmt > 0 && (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, color: "#6B7E74", marginTop: 8 }}>
                    <span>Subtotal</span><span>{INR(subtotal)}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, color: "#C44536", fontWeight: 600, marginTop: 2 }}>
                    <span>Discount{discMode === "%" && discNum > 0 ? ` (${money(discNum)}%)` : ""}</span><span>−{INR(discountAmt)}</span>
                  </div>
                </>
              )}
              <div style={S.rcptTotal}>
                <span>TOTAL</span>
                <span>{INR(total)}</span>
              </div>
              {/* Profit is hidden during billing; only surfaced as a warning when the bill would
                  run at a loss (e.g. a discount deeper than the margin), so it can't slip by. */}
              {profit < 0 && (
                <div style={{ fontSize: 12, color: "#C44536", fontWeight: 700, textAlign: "right", marginTop: 2 }}>
                  ⚠ This bill is at a loss: {INR(-profit)}
                </div>
              )}
              <div style={{ fontSize: 11, fontWeight: 700, color: "#6B7E74", textTransform: "uppercase", letterSpacing: ".05em", margin: "12px 0 4px" }}>Payment</div>
              <div style={{ display: "flex", gap: 6 }}>
                {["UPI", "Cash", "Udhari"].map((p) => (
                  <button key={p} className={"btn small " + (pay === p ? "primary" : "")} style={{ flex: 1 }} onClick={() => setPay(p)}>
                    {p === "UPI" ? "UPI" : p === "Cash" ? "Cash" : "Udhari"}
                  </button>
                ))}
              </div>
              {/* The free-text name/mobile fields are the pre-customer-database way of putting a
                  name on a bill. They stay for the walk-in who isn't worth a profile — and for
                  Udhari, which groups debts by name and needs SOMETHING to group by. Once a
                  customer is picked they're redundant, and showing both invites two versions of
                  the same person on one bill. */}
              {!picked && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 8 }}>
                  <div style={{ position: "relative" }}>
                    <input className="input" autoComplete="off" placeholder={pay === "Udhari" ? "Customer name (owes)" : "Name (optional)"} value={customer}
                      onChange={(e) => setCustomer(e.target.value)}
                      onFocus={() => setCustFocus(true)}
                      onBlur={() => setTimeout(() => setCustFocus(false), 120)}
                      aria-label="Customer name" />
                    {custFocus && custSuggestions.length > 0 && (
                      <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 30, background: "#fff", border: "1px solid #DDE8DE", borderRadius: 9, marginTop: 2, boxShadow: "0 8px 24px rgba(0,0,0,.14)", overflow: "hidden" }}>
                        {custSuggestions.map((c) => (
                          // onMouseDown (not onClick) so selection fires before the input's blur closes the list.
                          <button key={c.name} type="button"
                            onMouseDown={(e) => { e.preventDefault(); setCustomer(c.name); if (c.mobile) setMobile(c.mobile); setCustFocus(false); }}
                            style={{ display: "flex", justifyContent: "space-between", gap: 8, width: "100%", textAlign: "left", background: "none", border: "none", borderBottom: "1px solid #F0F4F0", padding: "8px 10px", cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}>
                            <span style={{ fontWeight: 600 }}>{c.name}</span>
                            <span style={{ color: "#8A9C90" }}>{c.mobile || "—"}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <input className="input" type="tel" inputMode="numeric" maxLength={15} placeholder="Mobile (optional)" value={mobile} onChange={(e) => setMobile(e.target.value)} aria-label="Customer mobile" />
                </div>
              )}
              {pay === "Udhari" && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input className="input" style={{ flex: 1 }} type="number" min="0" step="0.01" max={total} placeholder="Paid now (optional)" value={paidNow} onChange={(e) => setPaidNow(e.target.value)} aria-label="Amount paid now" />
                    <button className="btn small ghost" onClick={() => setPaidNow(String(total))}>Full</button>
                  </div>
                  {+paidNow > 0 && (
                    <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6 }}>
                      <span style={{ fontSize: 11.5, color: "#6B7E74", fontWeight: 600 }}>Paid via</span>
                      {["UPI", "Cash"].map((m) => (
                        <button key={m} className={"btn small " + (paidMode === m ? "primary" : "ghost")} onClick={() => setPaidMode(m)}>{m}</button>
                      ))}
                    </div>
                  )}
                  <div style={{ fontSize: 12, textAlign: "right", marginTop: 4, color: "#C44536", fontWeight: 600 }}>
                    On credit (udhari): {INR(Math.max(0, money(total - (+paidNow || 0))))}
                    {+paidNow > 0 && <span style={{ color: "#1B5E43", fontWeight: 500 }}> · paid {INR(Math.min(total, money(+paidNow)))} ({paidMode})</span>}
                  </div>
                </div>
              )}
              {pay === "UPI" && <UpiQrPreview store={store} amount={total} />}
              <button className="btn primary big" onClick={completeSale} style={{ marginTop: 12, width: "100%" }}>
                Complete sale · {INR(total)} · {pay}
              </button>
              <button className="btn ghost" onClick={() => { setCart([]); setDiscount(""); }} style={{ marginTop: 8, width: "100%" }}>
                Clear bill
              </button>
            </>
          )}
        </section>
      </div>

      {notFound != null && (
        <Modal title="No item found" onClose={() => { setNotFound(null); searchRef.current?.focus(); }}>
          <div style={{ fontSize: 14, color: "#465", lineHeight: 1.6 }}>
            No item in your inventory matches:
            <div style={{ margin: "10px 0", fontFamily: "monospace", fontSize: 16, fontWeight: 800, textAlign: "center", background: "#F4F7F4", padding: "10px 12px", borderRadius: 8, wordBreak: "break-all" }}>{notFound}</div>
            Add it in the <b>🧾 Misc</b> row (with this barcode) so it scans here next time.
          </div>
          <button
            className="btn primary big" style={{ width: "100%", marginTop: 14 }}
            onClick={() => {
              // Hand the scanned barcode to the Misc row and focus its name field, so an unknown
              // scan becomes a catalogued product (in inventory + on the bill) in one flow.
              const code = notFound;
              setNotFound(null); setMiscCode(code); setMiscName(""); setMiscPrice("");
              setTimeout(() => miscNameRef.current?.focus(), 0);
            }}>＋ Add as new item</button>
          <button
            className="btn big" style={{ width: "100%", marginTop: 8 }}
            onClick={(e) => {
              // A scanner's trailing Enter (CR/LF suffix) lands on a focused button and would dismiss
              // the modal instantly. Ignore a keyboard-triggered click (e.detail === 0) in the first
              // moment after it opens; a real mouse/touch tap (detail ≥ 1) always closes.
              if (e.detail === 0 && Date.now() - notFoundAt.current < 600) return;
              setNotFound(null); searchRef.current?.focus();
            }}>Cancel</button>
        </Modal>
      )}
    </div>
  );
}

// ---------- Inventory ----------
const blankItem = { name: "", code: "", barcodes: [], category: CATEGORIES[0], unit: "pc", icon: "", buyPrice: "", sellPrice: "", mrp: "", stock: "", lowAt: 5, expiry: "" };

// Normalised item name for duplicate detection (trim, lowercase, collapse inner spaces).
const normName = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

// Merge several same-name items into one, preserving stock: sum quantities, combine all
// batches, and keep the most complete pricing/category fields. Keeps the oldest item's id.
function mergeItemGroup(group) {
  const sorted = [...group].sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  const primary = sorted[0];
  const pick = (key) => sorted.map((x) => x[key]).find((v) => v != null && v !== "" && v !== 0);
  // Union every merged item's barcodes so none are lost; the first becomes the primary `code`.
  const allBc = cleanBarcodeList(sorted.flatMap((x) => itemBarcodes(x)));
  return {
    ...primary,
    name: (primary.name || "").trim(),
    code: allBc[0] || "",
    barcodes: allBc.slice(1),
    category: primary.category || pick("category") || "Other",
    unit: primary.unit || pick("unit") || "pc",
    icon: primary.icon || iconFor(primary.category),
    buyPrice: pick("buyPrice") || 0,
    sellPrice: pick("sellPrice") || primary.sellPrice || 0,
    mrp: pick("mrp") || pick("sellPrice") || 0,
    lowAt: Math.max(0, ...sorted.map((x) => +x.lowAt || 0)),
    stock: sorted.reduce((a, x) => a + (+x.stock || 0), 0),
    batches: sorted.flatMap((x) => (Array.isArray(x.batches) ? x.batches : [])),
    updatedAt: todayStr(),
  };
}

function Inventory({ items, setItems, notify, log, cats = CATEGORIES, onAddCategory }) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("All");
  const [form, setForm] = useState(null); // null | {…item, id?}
  const [restock, setRestock] = useState(null); // {id, name, qty, expiry}
  const [open, setOpen] = useState(null); // expanded item id (batch detail)
  const [rowEdit, setRowEdit] = useState(null); // inline row edit draft {id, …editable fields}
  const [batchEdit, setBatchEdit] = useState(null); // inline batch editor {id, untracked, rows:[{id,qty,expiry,addedOn}]}
  const [quickEdit, setQuickEdit] = useState(false); // edit-all-rows mode (no per-row Edit click)
  const [drafts, setDrafts] = useState(null); // { [id]: {icon,name,code,category,unit,buyPrice,sellPrice,stock,createdAt} }
  const [sort, setSort] = useState({ key: "name", dir: 1 }); // dir: 1 asc, -1 desc

  const filtered = items.filter((i) => {
    const term = q.trim().toLowerCase();
    return (
      (cat === "All" || i.category === cat) &&
      (i.name.toLowerCase().includes(term) || itemBarcodes(i).some((b) => b.toLowerCase().includes(term)))
    );
  });

  // Sortable columns. Click a header to sort by it; click again to flip direction.
  const SORT_VALUE = {
    name: (i) => (i.name || "").toLowerCase(),
    category: (i) => (i.category || "").toLowerCase(),
    createdAt: (i) => i.createdAt || "",
    buyPrice: (i) => +i.buyPrice || 0,
    sellPrice: (i) => +i.sellPrice || 0,
    margin: (i) => (+i.sellPrice || 0) - (+i.buyPrice || 0),
    stock: (i) => +i.stock || 0,
  };
  const sorted = useMemo(() => {
    const val = SORT_VALUE[sort.key] || SORT_VALUE.name;
    return [...filtered].sort((a, b) => {
      const x = val(a), y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, sort]);
  const toggleSort = (key) => setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: 1 }));
  const arrow = (key) => (sort.key === key ? (sort.dir === 1 ? " ▲" : " ▼") : "");
  // Plain element helper (not a nested component) so header cells don't remount each render.
  const sortTh = (k, label, align) => (
    <th key={k} onClick={() => toggleSort(k)} style={{ cursor: "pointer", textAlign: align || "left", userSelect: "none", whiteSpace: "nowrap" }} title="Click to sort">
      {label}{arrow(k)}
    </th>
  );

  const save = () => {
    const f = form;
    if (!f.name.trim()) return notify("Item name is required");
    const buy = +f.buyPrice, sell = +f.sellPrice, lowAt = +f.lowAt || 0;
    if (!(sell > 0)) return notify("Selling price must be more than 0");
    if (buy < 0 || sell < 0) return notify("Prices cannot be negative");
    // Block duplicate names (case-insensitive). On edit, ignore the item being edited.
    const nn = normName(f.name);
    const clash = items.find((i) => normName(i.name) === nn && i.id !== f.id);
    if (clash) {
      return notify(f.id
        ? `Another item is already named “${clash.name}”.`
        : `“${clash.name}” already exists — use Restock or edit it instead.`);
    }
    // Barcodes: parse the ";"-separated field, de-dupe, then check uniqueness across every other
    // product so a scanned barcode can only ever resolve to one item. First token = primary `code`.
    const codes = parseBarcodeText(f.barcodeText ?? f.code);
    const bcClash = findBarcodeClash(codes, items, f.id);
    if (bcClash) return notify(`Barcode “${bcClash.code}” already belongs to “${bcClash.item.name}”.`);
    const base = {
      name: f.name.trim(), code: codes[0] || "", barcodes: codes.slice(1), category: f.category, unit: f.unit,
      icon: (f.icon || "").trim() || iconFor(f.category), buyPrice: buy || 0, sellPrice: sell,
      mrp: +f.mrp || sell, lowAt,
    };
    if (f.id) {
      const newStock = Math.max(0, +f.stock || 0);
      const prevForLog = (items.find((i) => i.id === f.id)?.stock) || 0;
      // Functional updater so a live cloud snapshot landing mid-edit can't drop other items;
      // diff is taken from the LIVE stock so reconciliation is correct even if it just changed.
      setItems((list) => list.map((i) => {
        if (i.id !== f.id) return i;
        const diff = newStock - (i.stock || 0);
        let updated = { ...i, ...base, updatedAt: todayStr() };
        // Reconcile batches with the edited stock: grow → new batch, shrink → FIFO deplete.
        if (diff > 0) updated = addBatch(updated, diff, f.expiry, todayStr());
        else if (diff < 0) updated = removeStock(updated, -diff, todayStr());
        return updated;
      }));
      log("inventory", `Edited item “${base.name}”` + (newStock !== prevForLog ? ` · stock ${prevForLog}→${newStock}` : ""));
      notify("Item updated");
    } else {
      const stock = +f.stock || 0;
      const batches = stock > 0 ? [{ id: uid(), qty: stock, expiry: f.expiry || "", addedOn: todayStr() }] : [];
      const newItem = { ...base, id: uid(), stock, batches, createdAt: todayStr() };
      setItems((list) => [...list, newItem]);
      log("inventory", `Added item “${base.name}” · ${stock} ${base.unit} @ ${INR(sell)}` + (f.expiry ? ` (exp ${f.expiry})` : ""));
      notify("Item added to inventory");
    }
    setForm(null);
  };

  const doRestock = () => {
    const qty = +restock.qty;
    if (!(qty > 0)) return notify("Enter quantity to add");
    setItems((list) => list.map((i) => (i.id === restock.id ? addBatch(i, qty, restock.expiry, todayStr()) : i)));
    log("inventory", `Restocked “${restock.name}” +${qty}` + (restock.expiry ? ` (exp ${restock.expiry})` : ""));
    setRestock(null);
    notify("Stock added");
  };

  const del = (i) => {
    if (!confirm("Delete " + i.name + "?")) return;
    setItems((list) => list.filter((x) => x.id !== i.id));
    if (rowEdit?.id === i.id) setRowEdit(null);
    log("inventory", `Deleted item “${i.name}”`);
  };

  // ----- Inline row editing: make every on-screen field editable in place -----
  const startRowEdit = (i) => setRowEdit({
    id: i.id, icon: i.icon || "", name: i.name || "", barcodeText: itemBarcodes(i).join("; "),
    category: i.category || "Other", unit: i.unit || "pc",
    buyPrice: String(i.buyPrice ?? ""), sellPrice: String(i.sellPrice ?? ""),
    stock: String(i.stock ?? 0), createdAt: i.createdAt || todayStr(),
  });
  const saveRowEdit = () => {
    const f = rowEdit;
    if (!f.name.trim()) return notify("Item name is required");
    const buy = +f.buyPrice || 0, sell = +f.sellPrice;
    if (!(sell > 0)) return notify("Selling price must be more than 0");
    if (buy < 0 || sell < 0) return notify("Prices cannot be negative");
    const nn = normName(f.name);
    const clash = items.find((i) => normName(i.name) === nn && i.id !== f.id);
    if (clash) return notify(`Another item is already named “${clash.name}”.`);
    // Multi-barcode: parse the ";"-separated field, de-dupe, and check uniqueness across products.
    const codes = parseBarcodeText(f.barcodeText);
    const bcClash = findBarcodeClash(codes, items, f.id);
    if (bcClash) return notify(`Barcode “${bcClash.code}” already belongs to “${bcClash.item.name}”.`);
    const newStock = Math.max(0, +f.stock || 0);
    const prevForLog = (items.find((i) => i.id === f.id)?.stock) || 0;
    // Functional updater so a live cloud snapshot mid-edit can't drop other items; the stock
    // diff is taken from the LIVE row and reconciled into batches (grow → batch, shrink → FIFO).
    setItems((list) => list.map((i) => {
      if (i.id !== f.id) return i;
      const diff = newStock - (i.stock || 0);
      let updated = {
        ...i,
        icon: (f.icon || "").trim() || iconFor(f.category),
        name: f.name.trim(), code: codes[0] || "", barcodes: codes.slice(1),
        category: f.category, unit: f.unit,
        buyPrice: buy, sellPrice: sell, mrp: +i.mrp || sell,
        createdAt: f.createdAt || i.createdAt, updatedAt: todayStr(),
      };
      if (diff > 0) updated = addBatch(updated, diff, "", todayStr());
      else if (diff < 0) updated = removeStock(updated, -diff, todayStr());
      return updated;
    }));
    log("inventory", `Edited item “${f.name.trim()}”` + (newStock !== prevForLog ? ` · stock ${prevForLog}→${newStock}` : ""));
    setRowEdit(null);
    notify("Item updated");
  };

  // ----- Inline batch editing (the expanded detail): edit every batch's qty / expiry / date -----
  // The editor is the full definition of the item's stock: stock = Σ batch qty on save. Any
  // undated remainder (older stock that predates batches) is pre-loaded as an editable row so
  // nothing is lost and there's no double-counting.
  const startBatchEdit = (i) => {
    const rows = [...(i.batches || [])].sort(batchSort).map((b) => ({ id: b.id, qty: String(b.qty ?? ""), expiry: b.expiry || "", addedOn: b.addedOn || todayStr() }));
    const undated = (i.stock || 0) - (i.batches || []).reduce((a, b) => a + (+b.qty || 0), 0);
    if (undated > 0) rows.push({ id: uid(), qty: String(undated), expiry: "", addedOn: i.createdAt || todayStr() });
    setBatchEdit({ id: i.id, rows });
  };
  const setBatchField = (bid, k, v) => setBatchEdit((be) => ({ ...be, rows: be.rows.map((b) => (b.id === bid ? { ...b, [k]: v } : b)) }));
  const addBatchRow = () => setBatchEdit((be) => ({ ...be, rows: [...be.rows, { id: uid(), qty: "", expiry: "", addedOn: todayStr() }] }));
  const removeBatchRow = (bid) => setBatchEdit((be) => ({ ...be, rows: be.rows.filter((b) => b.id !== bid) }));
  const batchEditSum = batchEdit ? batchEdit.rows.reduce((a, b) => a + (+b.qty || 0), 0) : 0;
  const saveBatchEdit = () => {
    const f = batchEdit;
    const batches = f.rows
      .map((b) => ({ id: b.id, qty: +b.qty || 0, expiry: b.expiry || "", addedOn: b.addedOn || todayStr() }))
      .filter((b) => b.qty > 0); // drop blank / zero-qty rows
    const stock = batches.reduce((a, b) => a + b.qty, 0);
    setItems((list) => list.map((i) => (i.id === f.id ? { ...i, batches, stock, updatedAt: todayStr() } : i)));
    log("inventory", `Edited batches · stock now ${stock}`);
    setBatchEdit(null);
    notify("Batches updated");
  };

  // ----- Quick edit: make every row directly editable at once, applied on one "Save all" -----
  const draftOf = (i) => ({
    icon: i.icon || "", name: i.name || "", barcodeText: itemBarcodes(i).join("; "),
    category: i.category || "Other", unit: i.unit || "pc",
    buyPrice: String(i.buyPrice ?? ""), sellPrice: String(i.sellPrice ?? ""),
    stock: String(i.stock ?? 0), createdAt: i.createdAt || todayStr(),
  });
  const enterQuick = () => {
    const d = {};
    items.forEach((i) => { d[i.id] = draftOf(i); });
    setDrafts(d); setQuickEdit(true); setRowEdit(null); setBatchEdit(null);
  };
  const exitQuick = () => { setQuickEdit(false); setDrafts(null); };
  const setDraft = (id, k, v) => setDrafts((d) => ({ ...d, [id]: { ...d[id], [k]: v } }));
  const saveAllQuick = () => {
    const seen = new Map();
    for (const id of Object.keys(drafts)) {
      const f = drafts[id];
      if (!f.name.trim()) return notify("Every item needs a name.");
      if (!(+f.sellPrice > 0)) return notify(`“${f.name.trim() || "Item"}” needs a selling price greater than 0.`);
      if (+f.buyPrice < 0 || +f.sellPrice < 0) return notify("Prices cannot be negative.");
      const nn = normName(f.name);
      if (seen.has(nn)) return notify(`Duplicate name: “${f.name.trim()}”.`);
      seen.set(nn, id);
    }
    // Barcode uniqueness across the whole catalogue: each edited row's full parsed barcode list,
    // plus the stored barcodes of items left out of the edit. No barcode may belong to two items.
    const bcOwner = new Map(); // normalized barcode → item id
    for (const it of items) {
      const f = drafts[it.id];
      const codes = f ? parseBarcodeText(f.barcodeText) : itemBarcodes(it);
      for (const b of codes) {
        const k = b.toLowerCase();
        const prev = bcOwner.get(k);
        if (prev && prev !== it.id) return notify(`Barcode “${b}” is used by more than one item.`);
        bcOwner.set(k, it.id);
      }
    }
    setItems((list) => list.map((i) => {
      const f = drafts[i.id];
      if (!f) return i; // items added after entering quick edit are left untouched
      const codes = parseBarcodeText(f.barcodeText);
      const newStock = Math.max(0, +f.stock || 0);
      const diff = newStock - (i.stock || 0);
      let updated = {
        ...i,
        icon: (f.icon || "").trim() || iconFor(f.category),
        name: f.name.trim(), code: codes[0] || "", barcodes: codes.slice(1),
        category: f.category, unit: f.unit,
        buyPrice: +f.buyPrice || 0, sellPrice: +f.sellPrice, mrp: +i.mrp || (+f.sellPrice),
        createdAt: f.createdAt || i.createdAt, updatedAt: todayStr(),
      };
      if (diff > 0) updated = addBatch(updated, diff, "", todayStr());
      else if (diff < 0) updated = removeStock(updated, -diff, todayStr());
      return updated;
    }));
    log("inventory", `Quick-edited ${Object.keys(drafts).length} item(s)`);
    setQuickEdit(false); setDrafts(null);
    notify("All changes saved");
  };

  const stop = (e) => e.stopPropagation();

  // ----- Add/Edit modal: multi-barcode entry (one ";"-separated field; first token = default) -----
  // A scanner ends each barcode with Enter; that must NOT save the form. Instead it appends a "; "
  // separator so the next scan lands after it — letting the cashier scan any number of barcodes
  // (10, 20, …) into the one field in a row. `code` + `barcodes[]` are parsed from it on save.
  const onBarcodeKey = (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const cur = e.target.value; // full scanned value straight from the DOM
    setForm((f) => ({ ...f, barcodeText: withBarcodeSep(cur) }));
  };

  // Editable cells (icon/name, barcodes, category, added date, buy, sell, margin, stock+unit) shared
  // by per-row Edit and Quick edit. `d` is the draft, `sf(key,val)` updates it, `actionCell` is
  // the trailing cell (Save/Cancel for one row, empty in quick mode). The barcode cell is a full
  // multi-barcode field: a scanner's Enter appends "; " so several can be scanned into one row.
  const renderEditRow = (d, sf, actionCell) => (
    <tr>
      <td onClick={stop}>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <input className="input" style={{ padding: "6px 4px", width: 38, textAlign: "center" }} value={d.icon} placeholder={iconFor(d.category)} onChange={(e) => sf("icon", e.target.value)} aria-label="Icon" />
          <input className="input" style={{ padding: "6px 8px", minWidth: 96, flex: 1 }} value={d.name} onChange={(e) => sf("name", e.target.value)} aria-label="Name" />
        </div>
      </td>
      <td onClick={stop}>
        <input
          className="input" style={{ padding: "6px 8px", width: 150 }}
          value={d.barcodeText || ""} placeholder="scan barcode(s)"
          onChange={(e) => sf("barcodeText", e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); sf("barcodeText", withBarcodeSep(e.target.value)); } }}
          aria-label="Barcodes, separated by semicolons; first is the default"
          title="Scan or type; Enter adds a “;” so you can scan several. The first is the default." />
      </td>
      <td onClick={stop}>
        <select className="input" style={{ padding: "6px 4px" }} value={d.category} onChange={(e) => { const c = e.target.value; sf("category", c); if (isAutoIcon(d.icon, d.category)) sf("icon", iconFor(c)); }} aria-label="Category">
          {cats.map((c) => <option key={c}>{c}</option>)}
          {d.category && !cats.includes(d.category) && <option key={d.category}>{d.category}</option>}
        </select>
      </td>
      <td onClick={stop}><input className="input" style={{ padding: "6px 4px" }} type="date" max={todayStr()} value={d.createdAt} onChange={(e) => sf("createdAt", e.target.value)} aria-label="Added date" /></td>
      <td onClick={stop}><input className="input" style={{ padding: "6px 8px", width: 76, textAlign: "right" }} type="number" min="0" step="0.01" value={d.buyPrice} onChange={(e) => sf("buyPrice", e.target.value)} aria-label="Buy price" /></td>
      <td onClick={stop}><input className="input" style={{ padding: "6px 8px", width: 76, textAlign: "right" }} type="number" min="0" step="0.01" value={d.sellPrice} onChange={(e) => sf("sellPrice", e.target.value)} aria-label="Sell price" /></td>
      <td style={{ textAlign: "right", color: "#1B5E43" }}>{+d.buyPrice > 0 ? Math.round(((+d.sellPrice - +d.buyPrice) / +d.buyPrice) * 100) + "%" : "—"}</td>
      <td onClick={stop}>
        <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
          <input className="input" style={{ padding: "6px 8px", width: 60, textAlign: "right" }} type="number" min="0" value={d.stock} onChange={(e) => sf("stock", e.target.value)} aria-label="Stock" />
          <select className="input" style={{ padding: "6px 4px" }} value={d.unit} onChange={(e) => sf("unit", e.target.value)} aria-label="Unit">
            {UNITS.map((u) => <option key={u}>{u}</option>)}
          </select>
        </div>
      </td>
      {actionCell}
    </tr>
  );

  return (
    <div>
      <Header title="Inventory" sub={items.length + " items · click a header to sort · a row to see batches · Edit (or Quick edit) to change fields inline"}>
        {quickEdit ? (
          <>
            <button className="btn primary" onClick={saveAllQuick}>✓ Save all</button>{" "}
            <button className="btn ghost" onClick={exitQuick}>Cancel</button>
          </>
        ) : (
          <>
            {onAddCategory && <><button className="btn ghost" onClick={() => onAddCategory()} title="Create a new category you can assign to items">＋ New category</button>{" "}</>}
            <button className="btn ghost" onClick={enterQuick} disabled={items.length === 0} title="Edit every row's fields directly, then save once">✎ Quick edit</button>{" "}
            <button className="btn primary" onClick={() => setForm({ ...blankItem, barcodeText: "" })}>+ Add item</button>
          </>
        )}
      </Header>

      <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
        <input className="input" placeholder="Find an item…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
        <select className="input" value={cat} onChange={(e) => setCat(e.target.value)} style={{ width: 220 }}>
          <option>All</option>
          {cats.map((c) => <option key={c}>{c}</option>)}
        </select>
      </div>

      <section style={S.panel}>
        <table className="tbl">
          <thead>
            <tr>
              {sortTh("name", "Item")}
              <th style={{ textAlign: "left", whiteSpace: "nowrap" }}>Barcode</th>
              {sortTh("category", "Category")}
              {sortTh("createdAt", "Added")}
              {sortTh("buyPrice", "Buy", "right")}
              {sortTh("sellPrice", "Sell", "right")}
              {sortTh("margin", "Margin", "right")}
              {sortTh("stock", "Stock", "right")}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((i) => {
              const dte = daysToExpiry(i);
              const isOpen = open === i.id;
              return (
                <Fragment key={i.id}>
                  {quickEdit && drafts[i.id] ? (
                    renderEditRow(drafts[i.id], (k, v) => setDraft(i.id, k, v), <td />)
                  ) : rowEdit?.id === i.id ? (
                    renderEditRow(rowEdit, (k, v) => setRowEdit((e) => ({ ...e, [k]: v })), (
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }} onClick={stop}>
                        <button className="btn small primary" aria-label="Save item" onClick={saveRowEdit}>✓</button>{" "}
                        <button className="btn small ghost" aria-label="Cancel edit" onClick={() => setRowEdit(null)}>✕</button>
                      </td>
                    ))
                  ) : (
                  <tr style={{ cursor: "pointer" }} onClick={() => setOpen(isOpen ? null : i.id)}>
                    <td style={{ fontWeight: 600 }}>
                      <span style={{ marginRight: 6 }}>{i.icon || "📦"}</span>{i.name}
                      <span style={{ color: "#AAB", marginLeft: 6 }}>{isOpen ? "▾" : "▸"}</span>
                    </td>
                    <td style={{ color: "#677", fontSize: 12.5, whiteSpace: "nowrap" }}>
                      {(() => {
                        const bcs = itemBarcodes(i);
                        if (!bcs.length) return <span style={{ color: "#B7C2BA" }}>—</span>;
                        return <span title={bcs.join(", ")}>{bcs[0]}{bcs.length > 1 ? <span style={{ color: "#1B5E43", fontWeight: 700 }}> +{bcs.length - 1}</span> : null}</span>;
                      })()}
                    </td>
                    <td style={{ color: "#677" }}>{i.category}</td>
                    <td style={{ color: "#789", whiteSpace: "nowrap", fontSize: 12.5 }}>{i.createdAt || "—"}{i.updatedAt && i.updatedAt !== i.createdAt ? <span title={"edited " + i.updatedAt}> ✎</span> : null}</td>
                    <td style={{ textAlign: "right" }}>{INR(i.buyPrice)}</td>
                    <td style={{ textAlign: "right", fontWeight: 700 }}>{INR(i.sellPrice)}</td>
                    <td style={{ textAlign: "right", color: "#1B5E43" }}>{i.buyPrice ? Math.round(((i.sellPrice - i.buyPrice) / i.buyPrice) * 100) + "%" : "—"}</td>
                    <td style={{ textAlign: "right", fontWeight: 700, color: i.stock <= i.lowAt ? "#C44536" : "#223" }}>
                      {i.stock} {i.unit}{i.stock <= i.lowAt && " ⚠"}
                      {dte != null && dte <= 30 && <div style={{ fontSize: 10.5, fontWeight: 600, color: dte < 0 ? "#C44536" : "#B0762A" }}>{dte < 0 ? "expired" : "exp in " + dte + "d"}</div>}
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button className="btn small" onClick={(e) => { stop(e); setRestock({ id: i.id, name: i.name, qty: "", expiry: "" }); }}>Restock</button>{" "}
                      <button className="btn small ghost" onClick={(e) => { stop(e); startRowEdit(i); }}>Edit</button>{" "}
                      <button className="btn small ghost" title="More fields (MRP, barcodes, low-stock alert, dated stock)" aria-label={"More fields for " + i.name} onClick={(e) => { stop(e); setForm({ ...i, mrp: i.mrp ?? "", icon: i.icon || "", barcodeText: itemBarcodes(i).join("; "), expiry: "" }); }}>⚙</button>{" "}
                      <button className="btn small danger" aria-label={"Delete " + i.name} onClick={(e) => { stop(e); del(i); }}>✕</button>
                    </td>
                  </tr>
                  )}
                  {!quickEdit && isOpen && (
                    <tr>
                      <td colSpan={9} style={{ background: "#F7FAF7" }}>
                        {batchEdit?.id === i.id ? (
                          <div onClick={stop}>
                            <table className="tbl" style={{ margin: 0 }}>
                              <thead><tr><th style={{ width: 110 }}>Batch qty</th><th style={{ width: 170 }}>Expiry</th><th style={{ width: 170 }}>Date added</th><th style={{ width: 30 }}></th></tr></thead>
                              <tbody>
                                {batchEdit.rows.map((b) => (
                                  <tr key={b.id}>
                                    <td><input className="input" style={{ padding: "6px 8px", width: 80 }} type="number" min="0" value={b.qty} onChange={(e) => setBatchField(b.id, "qty", e.target.value)} aria-label="Batch quantity" /></td>
                                    <td><input className="input" style={{ padding: "6px 8px" }} type="date" value={b.expiry} onChange={(e) => setBatchField(b.id, "expiry", e.target.value)} aria-label="Batch expiry" /></td>
                                    <td><input className="input" style={{ padding: "6px 8px" }} type="date" max={todayStr()} value={b.addedOn} onChange={(e) => setBatchField(b.id, "addedOn", e.target.value)} aria-label="Date added" /></td>
                                    <td><button className="btn small danger" aria-label="Remove batch" onClick={() => removeBatchRow(b.id)}>✕</button></td>
                                  </tr>
                                ))}
                                {batchEdit.rows.length === 0 && <tr><td colSpan={4}><Empty text="No batches — add one below." /></td></tr>}
                              </tbody>
                            </table>
                            <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
                              <button className="btn small ghost" onClick={addBatchRow}>+ Add batch</button>
                              <button className="btn small primary" onClick={saveBatchEdit}>✓ Save batches</button>
                              <button className="btn small ghost" onClick={() => setBatchEdit(null)}>Cancel</button>
                              <span style={{ fontSize: 11.5, color: "#8A9C90", marginLeft: "auto" }}>New stock total: <b>{batchEditSum} {i.unit}</b></span>
                            </div>
                          </div>
                        ) : (
                          <>
                            {i.batches && i.batches.length ? (
                              <table className="tbl" style={{ margin: 0 }}>
                                <thead><tr><th style={{ width: 120 }}>Batch qty</th><th style={{ width: 160 }}>Expiry</th><th>Date added</th></tr></thead>
                                <tbody>
                                  {[...i.batches].sort(batchSort).map((b) => {
                                    const bd = b.expiry ? Math.round((new Date(b.expiry + "T00:00") - new Date(todayStr() + "T00:00")) / 86400000) : null;
                                    const col = bd == null ? "#677" : bd < 0 ? "#C44536" : bd <= 30 ? "#B0762A" : "#677";
                                    return (
                                      <tr key={b.id}>
                                        <td style={{ fontWeight: 700 }}>{b.qty} {i.unit}</td>
                                        <td style={{ color: col, fontWeight: bd != null && bd <= 30 ? 700 : 400 }}>{b.expiry || "— no expiry —"}{bd != null && bd <= 30 ? (bd < 0 ? " (expired)" : ` (${bd}d left)`) : ""}</td>
                                        <td style={{ color: "#677" }}>{b.addedOn}</td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            ) : (
                              <div style={{ padding: "8px 4px", color: "#8A9", fontSize: 13 }}>No batch / expiry detail yet.</div>
                            )}
                            <div style={{ marginTop: 8 }} onClick={stop}>
                              <button className="btn small ghost" onClick={() => startBatchEdit(i)}>✎ Edit batches</button>
                            </div>
                          </>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {filtered.length === 0 && <tr><td colSpan={9}><Empty text="No items found." /></td></tr>}
          </tbody>
        </table>
      </section>

      {form && (
        <Modal title={form.id ? "Edit item" : "Add new item"} onClose={() => setForm(null)}>
          <Field label="Item name"><input className="input" autoFocus value={form.name} onChange={(e) => {
            const name = e.target.value;
            setForm((f) => {
              // For a NEW item, auto-pick the category from the name until the user picks one
              // manually; carry the icon along if it's still auto.
              if (f.id || f.categoryTouched) return { ...f, name };
              const g = guessCategory(name, items);
              if (!g || g === f.category) return { ...f, name };
              return { ...f, name, category: g, icon: isAutoIcon(f.icon, f.category) ? iconFor(g) : f.icon };
            });
          }} placeholder="e.g. Amul Butter 100g" /></Field>
          <Field label="Barcodes (optional)">
            <textarea
              className="input"
              rows={2}
              value={form.barcodeText || ""}
              onChange={(e) => setForm({ ...form, barcodeText: e.target.value })}
              onKeyDown={onBarcodeKey}
              placeholder="Scan or type barcodes — press Enter after each. First one is the default."
              aria-label="Barcodes, separated by semicolons; the first is the default"
              style={{ resize: "vertical", minHeight: 62, lineHeight: 1.5, fontFamily: "inherit" }}
            />
            <div style={{ fontSize: 11.5, color: "#8A9C90", marginTop: 4 }}>
              Separate multiple barcodes with “<b>;</b>” — scanning auto-adds it. Add as many as you like; the first is the item's default.
            </div>
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Category">
              <div style={{ display: "flex", gap: 6 }}>
                <select className="input" style={{ flex: 1 }} value={form.category} onChange={(e) => { const c = e.target.value; setForm((f) => ({ ...f, category: c, categoryTouched: true, icon: isAutoIcon(f.icon, f.category) ? iconFor(c) : f.icon })); }}>
                  {cats.map((c) => <option key={c}>{c}</option>)}
                  {form.category && !cats.includes(form.category) && <option key={form.category}>{form.category}</option>}
                </select>
                {onAddCategory && (
                  <button type="button" className="btn ghost" style={{ padding: "0 10px", whiteSpace: "nowrap" }} title="Add a new category"
                    onClick={() => { const c = onAddCategory(); if (c) setForm((f) => ({ ...f, category: c, categoryTouched: true, icon: isAutoIcon(f.icon, f.category) ? iconFor(c) : f.icon })); }}>
                    ＋ New
                  </button>
                )}
              </div>
            </Field>
            <Field label="Unit">
              <select className="input" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })}>
                {UNITS.map((u) => <option key={u}>{u}</option>)}
              </select>
            </Field>
            <Field label="Icon (emoji)"><input className="input" value={form.icon} onChange={(e) => setForm({ ...form, icon: e.target.value })} placeholder={iconFor(form.category)} /></Field>
            <Field label="MRP (₹)"><input className="input" type="number" min="0" step="0.01" value={form.mrp} onChange={(e) => setForm({ ...form, mrp: e.target.value })} /></Field>
            <Field label="Buying price (₹)"><input className="input" type="number" min="0" step="0.01" value={form.buyPrice} onChange={(e) => setForm({ ...form, buyPrice: e.target.value })} /></Field>
            <Field label="Selling price (₹)"><input className="input" type="number" min="0" step="0.01" value={form.sellPrice} onChange={(e) => setForm({ ...form, sellPrice: e.target.value })} /></Field>
            <Field label={form.id ? "Stock quantity" : "Opening stock"}><input className="input" type="number" min="0" value={form.stock} onChange={(e) => setForm({ ...form, stock: e.target.value })} /></Field>
            <Field label={form.id ? "Expiry (for added stock)" : "Expiry (optional)"}><input className="input" type="date" value={form.expiry} onChange={(e) => setForm({ ...form, expiry: e.target.value })} /></Field>
            <Field label="Alert when stock below"><input className="input" type="number" min="0" value={form.lowAt} onChange={(e) => setForm({ ...form, lowAt: e.target.value })} /></Field>
          </div>
          {form.id && <div style={{ fontSize: 12, color: "#6B7E74", marginTop: 8 }}>Changing stock here adjusts batches automatically (increase adds a batch using the expiry above; decrease removes earliest-expiry stock first). For a specific dated batch, use <b>Restock</b>.</div>}
          <button className="btn primary big" style={{ width: "100%", marginTop: 14 }} onClick={save}>
            {form.id ? "Save changes" : "Add item"}
          </button>
        </Modal>
      )}

      {restock && (
        <Modal title={"Restock — " + restock.name} onClose={() => setRestock(null)}>
          <Field label="Quantity to add">
            <input className="input" type="number" min="0" autoFocus value={restock.qty} onChange={(e) => setRestock({ ...restock, qty: e.target.value })} />
          </Field>
          <Field label="Expiry date (optional)">
            <input className="input" type="date" value={restock.expiry} onChange={(e) => setRestock({ ...restock, expiry: e.target.value })} />
          </Field>
          <button className="btn primary big" style={{ width: "100%", marginTop: 12 }} onClick={doRestock}>Add stock</button>
        </Modal>
      )}
    </div>
  );
}

// ---------- Barcode Creator ----------
// Format a YYYY-MM-DD date as MM/YY for compact shelf labels.
const mmYY = (ds) => {
  if (!ds) return "";
  const [y, m] = ds.split("-");
  return m && y ? `${m}/${y.slice(2)}` : "";
};
const LABEL_SIZES = {
  "38x25": { w: 38, h: 25, label: "38 × 25 mm (small)" },
  "50x30": { w: 50, h: 30, label: "50 × 30 mm (medium)" },
  "65x38": { w: 65, h: 38, label: "65 × 38 mm (large)" },
};

// Generate a code valid for the chosen symbology.
function genCode(format) {
  if (format === "EAN13") {
    let base = "890"; // GS1 India prefix
    for (let i = 0; i < 9; i++) base += Math.floor(Math.random() * 10);
    const d = base.split("").map(Number);
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += d[i] * (i % 2 === 0 ? 1 : 3);
    return base + ((10 - (sum % 10)) % 10);
  }
  let s = "";
  for (let i = 0; i < 9; i++) s += Math.floor(Math.random() * 10);
  return "PSM" + s;
}

function barcodeDataUrl(value, format) {
  const canvas = document.createElement("canvas");
  JsBarcode(canvas, value, { format, width: 2, height: 60, fontSize: 16, margin: 6, displayValue: true });
  return canvas.toDataURL("image/png");
}

function BarcodeCreator({ items, setItems, store = STORE, notify, log }) {
  const [itemId, setItemId] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState(genCode("CODE128"));
  const [format, setFormat] = useState("CODE128");
  const [mrp, setMrp] = useState("");
  const [sell, setSell] = useState("");
  const [pkd, setPkd] = useState(todayStr());
  const [exp, setExp] = useState("");
  const [qty, setQty] = useState(12);
  const [size, setSize] = useState("38x25");
  const [cw, setCw] = useState(40);
  const [ch, setCh] = useState(28);
  const [err, setErr] = useState(null);
  const svgRef = useRef(null);

  // Resolve the chosen label size (preset or custom width/height in mm).
  const sz = size === "custom"
    ? (() => { const w = Math.max(15, +cw || 40), h = Math.max(10, +ch || 28); return { w, h, label: `${w} × ${h} mm` }; })()
    : LABEL_SIZES[size];

  // Live barcode preview (re-rendered whenever the code or symbology changes).
  useEffect(() => {
    if (!svgRef.current) return;
    if (!code.trim()) { svgRef.current.innerHTML = ""; setErr(null); return; }
    try {
      JsBarcode(svgRef.current, code.trim(), { format, width: 2, height: 50, fontSize: 14, margin: 4, displayValue: true });
      setErr(null);
    } catch {
      setErr("This value isn't valid for " + format + (format === "EAN13" ? " — EAN-13 needs 12–13 digits." : "."));
    }
  }, [code, format]);

  const pickItem = (id) => {
    setItemId(id);
    const it = items.find((i) => i.id === id);
    if (!it) return;
    setName(it.name);
    setMrp(it.mrp || it.sellPrice || "");
    setSell(it.sellPrice || "");
    setCode(it.code ? it.code : genCode(format));
  };

  const saveToItem = () => {
    if (!itemId) return notify("Pick an inventory item first to save its barcode");
    const val = code.trim();
    if (!val) return notify("Nothing to save");
    const target = items.find((i) => i.id === itemId);
    if (!target) return notify("That item no longer exists");
    // Must be unique across every other product so a scan resolves to exactly one item.
    const clash = findBarcodeClash([val], items, itemId);
    if (clash) return notify(`Barcode “${val}” already belongs to “${clash.item.name}”.`);
    if (itemBarcodes(target).some((b) => b.toLowerCase() === val.toLowerCase()))
      return notify(`“${target.name}” already has that barcode.`);
    // Empty product → this becomes the default; otherwise it's an additional barcode.
    setItems((list) => list.map((i) => {
      if (i.id !== itemId) return i;
      return (i.code || "").trim()
        ? { ...i, barcodes: [...(Array.isArray(i.barcodes) ? i.barcodes : []), val], updatedAt: todayStr() }
        : { ...i, code: val, updatedAt: todayStr() };
    }));
    log("inventory", `Added barcode for “${name}” → ${val}`);
    notify("Barcode saved to item — it can now be scanned at billing");
  };

  const printLabels = () => {
    if (!code.trim()) return notify("Enter or generate a barcode first");
    let url;
    try { url = barcodeDataUrl(code.trim(), format); }
    catch { return notify("Invalid barcode value for " + format); }
    const n = Math.max(1, Math.min(300, +qty || 1));
    const priceLine = [mrp ? "MRP ₹" + escapeHtml(String(mrp)) : "", sell ? "Sell ₹" + escapeHtml(String(sell)) : ""].filter(Boolean).join("&nbsp;&nbsp;");
    const dateLine = [pkd ? "PKD " + mmYY(pkd) : "", exp ? "EXP " + mmYY(exp) : ""].filter(Boolean).join("&nbsp;&nbsp;");
    const one = `<div class="lbl">
      <div class="store">${escapeHtml(store.name)}</div>
      <div class="pname">${escapeHtml(name || "")}</div>
      <img src="${url}" />
      ${priceLine ? `<div class="price">${priceLine}</div>` : ""}
      <div class="dates">${dateLine}</div>
    </div>`;
    printHtml(`
      <style>
        @page { margin: 6mm; }
        body { margin:0; font-family: Arial, Helvetica, sans-serif; }
        .sheet { display:flex; flex-wrap:wrap; gap:2mm; }
        .lbl { width:${sz.w}mm; height:${sz.h}mm; box-sizing:border-box; border:1px dashed #c8c8c8;
               padding:1mm 1.5mm; display:flex; flex-direction:column; align-items:center;
               justify-content:space-between; overflow:hidden; text-align:center; }
        .store { font-size:6pt; font-weight:bold; color:#10331F; line-height:1; }
        .pname { font-size:7.5pt; font-weight:bold; line-height:1.05; max-height:2.3em; overflow:hidden; }
        .lbl img { max-width:100%; height:auto; flex:0 0 auto; }
        .price { font-size:8pt; font-weight:bold; line-height:1; }
        .dates { font-size:5.5pt; color:#333; line-height:1; }
        @media print { .lbl { border-color:#e5e5e5; } }
      </style>
      <div class="sheet">${one.repeat(n)}</div>`, "Barcode labels");
    log("inventory", `Printed ${n} barcode label(s) for “${name || code.trim()}”`);
    notify(`Sent ${n} label(s) to the printer`);
  };

  const addExpiry = (days) => {
    const d = new Date((pkd || todayStr()) + "T00:00");
    d.setDate(d.getDate() + days);
    setExp(dateStr(d));
  };

  return (
    <div>
      <Header title="Barcode Creator" sub="Generate scannable barcode labels to paste on shelf items" />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <section style={S.panel}>
          <div style={S.panelHead}>Label details</div>

          <Field label="From inventory (optional)">
            <select className="input" value={itemId} onChange={(e) => pickItem(e.target.value)}>
              <option value="">— manual entry —</option>
              {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          </Field>

          <Field label="Product name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Amul Butter 100g" /></Field>

          <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, alignItems: "end" }}>
            <Field label="Barcode value"><input className="input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Scan, type, or generate" /></Field>
            <button className="btn" style={{ marginBottom: 10 }} onClick={() => setCode(genCode(format))}>Generate</button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Symbology">
              <select className="input" value={format} onChange={(e) => setFormat(e.target.value)}>
                <option value="CODE128">Code 128 (any text)</option>
                <option value="EAN13">EAN-13 (13 digits)</option>
              </select>
            </Field>
            <Field label="MRP (₹)"><input className="input" type="number" min="0" step="0.01" value={mrp} onChange={(e) => setMrp(e.target.value)} /></Field>
            <Field label="Selling price (₹)"><input className="input" type="number" min="0" step="0.01" value={sell} onChange={(e) => setSell(e.target.value)} /></Field>
            <Field label="Packaged date"><input className="input" type="date" max={todayStr()} value={pkd} onChange={(e) => setPkd(e.target.value)} /></Field>
            <Field label="Expiry date"><input className="input" type="date" value={exp} onChange={(e) => setExp(e.target.value)} /></Field>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: -2, marginBottom: 12 }}>
            <span style={{ fontSize: 11.5, color: "#6B7E74", alignSelf: "center" }}>Expiry quick-set:</span>
            {[["1w", 7], ["1m", 30], ["3m", 90], ["6m", 180], ["1y", 365]].map(([lbl, d]) => (
              <button key={lbl} className="btn small ghost" onClick={() => addExpiry(d)}>+{lbl}</button>
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Label size">
              <select className="input" value={size} onChange={(e) => setSize(e.target.value)}>
                {Object.entries(LABEL_SIZES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                <option value="custom">Custom…</option>
              </select>
            </Field>
            <Field label="How many labels"><input className="input" type="number" min="1" max="300" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
          </div>
          {size === "custom" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Field label="Width (mm)"><input className="input" type="number" min="15" max="200" value={cw} onChange={(e) => setCw(e.target.value)} /></Field>
              <Field label="Height (mm)"><input className="input" type="number" min="10" max="200" value={ch} onChange={(e) => setCh(e.target.value)} /></Field>
            </div>
          )}

          {err && <div style={{ color: "#C44536", fontSize: 13, marginTop: 4 }}>{err}</div>}
          {itemId && <button className="btn ghost" style={{ width: "100%", marginTop: 8 }} onClick={saveToItem}>Save this barcode to the inventory item</button>}
        </section>

        <section style={S.panel}>
          <div style={S.panelHead}>Label preview</div>
          <div style={{ display: "grid", placeItems: "center", padding: "10px 0 16px" }}>
            <div style={{
              width: 230, minHeight: 130, border: "1px dashed #cfcfcf", borderRadius: 6, padding: "8px 10px",
              display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "space-between", textAlign: "center", background: "#fff",
            }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: "#10331F" }}>{store.name}</div>
              <div style={{ fontSize: 12.5, fontWeight: 700, lineHeight: 1.1 }}>{name || <span style={{ color: "#AAB" }}>Product name</span>}</div>
              <svg ref={svgRef} style={{ maxWidth: "100%" }} />
              {(mrp || sell) ? (
                <div style={{ fontSize: 12, fontWeight: 800 }}>
                  {mrp ? "MRP ₹" + mrp : ""}{mrp && sell ? " · " : ""}{sell ? "Sell ₹" + sell : ""}
                </div>
              ) : null}
              <div style={{ fontSize: 9, color: "#445" }}>{pkd ? "PKD " + mmYY(pkd) : ""}{exp ? "  EXP " + mmYY(exp) : ""}</div>
            </div>
          </div>
          <button className="btn primary big" style={{ width: "100%" }} disabled={!code.trim() || !!err} onClick={printLabels}>
            🖨 Print {Math.max(1, Math.min(300, +qty || 1))} label(s) · {sz.label.split(" (")[0]}
          </button>
          <div style={{ fontSize: 11.5, color: "#8A9C90", marginTop: 10, lineHeight: 1.5 }}>
            Labels print as a tiled sheet at true millimetre size with dashed cut guides — set your printer to 100% / “Actual size” (not “Fit”). Saving the barcode to an item lets the cashier scan it on the Billing screen.
          </div>
        </section>
      </div>
    </div>
  );
}

// ---------- Raw Data Record (file import / paste) ----------
const RAW_ACCEPT = ".txt,.csv,.tsv,.xls,.xlsx,.pdf,.json";
function RawData({ items, setItems, setSales, setExpenses, notify, log }) {
  const [mode, setMode] = useState("inventory"); // "inventory" | "sales" | "expenses"
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [raw, setRaw] = useState("");
  const [source, setSource] = useState("");
  const [saleDate, setSaleDate] = useState(todayStr());

  // Expense rows only need description / amount / date. The shared parser fills the amount
  // into whichever numeric slot it found (often `qty` for "name, amount, date"), and a date
  // token into `date`/`expiry` — so pick the first sensible value for each.
  const toExpenseRow = (r) => ({
    name: r.name || "",
    amount: r.amount || r.sellPrice || r.buyPrice || r.qty || "",
    date: r.date || r.expiry || "",
  });

  const loadRows = (parsed, srcLabel) => {
    if (!parsed || parsed.length === 0) {
      setErr("No rows found. Make sure the data has item names and numbers — or add rows manually below.");
      return;
    }
    setErr(null);
    setRows(mode === "expenses" ? parsed.map(toExpenseRow) : parsed);
    setSource(srcLabel);
    notify(`${parsed.length} row(s) loaded — review, edit, then submit`);
  };

  const onFile = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setBusy(true); setErr(null);
    try {
      loadRows(await parseFile(f), f.name);
    } catch (ex) {
      console.error(ex);
      setErr("Could not read that file. Supported types: txt, csv, tsv, xls, xlsx, pdf, json.");
    }
    setBusy(false);
  };

  const processPaste = () => {
    if (!raw.trim()) return setErr("Paste some data into the box first.");
    try {
      loadRows(parseRawText(raw), "pasted text");
    } catch (ex) {
      console.error(ex);
      setErr("Could not parse that text.");
    }
  };

  const addRow = () => setRows([...(rows || []), mode === "expenses"
    ? { name: "", amount: "", date: todayStr() }
    : { name: "", qty: 1, unit: "pc", buyPrice: "", sellPrice: "", amount: "", expiry: "" }]);
  const edit = (i, k, v) => setRows(rows.map((r, x) => (x === i ? { ...r, [k]: v } : r)));
  const drop = (i) => setRows(rows.filter((_, x) => x !== i));
  const reset = () => { setRows(null); setRaw(""); setSource(""); setErr(null); };
  // Switching what we're importing clears any previewed rows (their shape differs per mode).
  const changeMode = (m) => { if (m === mode) return; setMode(m); setRows(null); setErr(null); };

  // Collapse duplicate rows (same name) into one entry so quantities sum instead
  // of one row clobbering another. Keyed by normName so it matches existing items the
  // same way the rest of the app does (trim + lowercase + collapse inner spaces).
  const aggregateRows = () => {
    const agg = new Map();
    rows.forEach((r) => {
      const key = normName(r.name);
      if (!key) return;
      const buy = +r.buyPrice || 0, sell = +r.sellPrice || 0, qty = +r.qty || 0;
      // Fall back to qty × unit price when no explicit line amount was given.
      const amount = +r.amount || (sell ? sell * qty : 0);
      const prev = agg.get(key);
      if (prev) {
        prev.qty += qty; prev.amount += amount;
        if (buy) prev.buy = buy;
        if (sell) prev.sell = sell;
      } else {
        agg.set(key, { name: r.name.trim(), unit: r.unit, qty, amount, buy, sell });
      }
    });
    return agg;
  };

  // Like aggregateRows, but for inventory it keeps each distinct expiry as its own
  // batch (so the same item imported with two expiry dates becomes two batches), while
  // still summing rows that share both name and expiry. Keyed by normName to match the app.
  const aggregateInventory = () => {
    const agg = new Map(); // normName -> { name, unit, buy, sell, batches: Map(expiry -> qty) }
    rows.forEach((r) => {
      const key = normName(r.name);
      if (!key) return;
      const buy = +r.buyPrice || 0, sell = +r.sellPrice || 0, qty = +r.qty || 0;
      const expiry = r.expiry || "";
      let e = agg.get(key);
      if (!e) { e = { name: r.name.trim(), unit: r.unit, buy, sell, batches: new Map() }; agg.set(key, e); }
      if (buy) e.buy = buy;
      if (sell) e.sell = sell;
      if (r.unit) e.unit = r.unit;
      e.batches.set(expiry, (e.batches.get(expiry) || 0) + qty);
    });
    return agg;
  };

  const commitInventory = () => {
    const counts = aggregateInventory();
    const names = new Set(items.map((i) => normName(i.name)));
    let added = 0, updated = 0;
    counts.forEach((_, key) => (names.has(key) ? updated++ : added++));
    // Functional updater (rebuilds the aggregate per call so it stays correct even if a live
    // cloud snapshot changed `items` since the import was previewed). Always NEW objects.
    setItems((list) => {
      const agg = aggregateInventory();
      const next = list.map((i) => {
        const e = agg.get(normName(i.name));
        if (!e) return i;
        agg.delete(normName(i.name));
        let updatedItem = { ...i, buyPrice: e.buy || i.buyPrice, sellPrice: e.sell || i.sellPrice };
        e.batches.forEach((qty, expiry) => { updatedItem = addBatch(updatedItem, qty, expiry, todayStr()); });
        return updatedItem;
      });
      agg.forEach((e) => {
        const sell = e.sell || (e.buy ? Math.round(e.buy * 1.15) : 0);
        const batches = [];
        let stock = 0;
        e.batches.forEach((qty, expiry) => {
          if (qty > 0) { batches.push({ id: uid(), qty, expiry: expiry || "", addedOn: todayStr() }); stock += qty; }
        });
        next.push({
          id: uid(), name: e.name, code: "", category: "Other", unit: e.unit, icon: iconFor("Other"),
          buyPrice: e.buy, sellPrice: sell, mrp: sell, stock, lowAt: 5, batches, createdAt: todayStr(),
        });
      });
      return next;
    });
    log("import", `Imported to inventory (${source || "manual"}): ${added} new, ${updated} restocked`);
    reset();
    notify(`Inventory updated — ${added} new, ${updated} restocked`);
  };

  const commitSales = () => {
    const agg = aggregateRows();
    let profit = 0, total = 0;
    const lines = [...agg.values()].map((a) => {
      total += a.amount;
      const ex = items.find((i) => normName(i.name) === normName(a.name));
      if (ex) profit += a.amount - ex.buyPrice * a.qty;
      return { name: a.name, qty: a.qty, unit: ex?.unit || "pc", buyPrice: ex?.buyPrice ?? 0, price: a.qty ? money(a.amount / a.qty) : a.amount, amount: money(a.amount) };
    });
    total = money(total); profit = money(profit);
    const now = new Date();
    setSales((s) => [...s, {
      id: uid(), date: saleDate || todayStr(),
      time: now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) + " (imported)",
      lines, total, profit,
    }]);
    setItems((its) => its.map((i) => {
      const a = agg.get(normName(i.name));
      return a ? removeStock(i, a.qty, todayStr()) : i;
    }));
    log("import", `Imported sale ${INR(total)} · ${lines.length} line(s) (${source || "manual"})`);
    reset();
    notify("Sale recorded — " + INR(total));
  };

  // Bulk-add expenses (description + amount + date). Each valid row becomes one expense
  // entry, exactly like Add Expense, so it flows into Finance totals and the expense charts.
  const commitExpenses = () => {
    const valid = (rows || []).filter((r) => (r.name || "").trim() && +r.amount > 0);
    if (!valid.length) return notify("Each expense needs a description and an amount greater than 0.");
    const newRows = valid.map((r) => ({ id: uid(), date: r.date || todayStr(), desc: r.name.trim(), amount: money(+r.amount) }));
    const sum = money(newRows.reduce((a, e) => a + e.amount, 0));
    setExpenses((list) => [...list, ...newRows]);
    log("import", `Imported ${newRows.length} expense(s) (${source || "manual"}) · ${INR(sum)}`);
    reset();
    notify(`${newRows.length} expense(s) added — ${INR(sum)}`);
  };

  return (
    <div>
      <Header title="Data Import" sub="Import a file or paste data — then review, edit, and submit">
        {rows && <button className="btn ghost small" onClick={reset}>Start over</button>}
      </Header>

      <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <button className={"btn " + (mode === "inventory" ? "primary" : "")} onClick={() => changeMode("inventory")}>
          ➕ Add to inventory
        </button>
        <button className={"btn " + (mode === "sales" ? "primary" : "")} onClick={() => changeMode("sales")}>
          🧾 Record a sale
        </button>
        <button className={"btn " + (mode === "expenses" ? "primary" : "")} onClick={() => changeMode("expenses")}>
          💸 Add expenses
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 16 }}>
        <section style={S.panel}>
          <div style={S.panelHead}>1 · Provide data</div>
          <label className="btn primary" style={{ display: "block", textAlign: "center", padding: "14px", cursor: "pointer", opacity: busy ? 0.6 : 1 }}>
            {busy ? "Reading file…" : "📂 Choose a file"}
            <input type="file" accept={RAW_ACCEPT} onChange={onFile} disabled={busy} style={{ display: "none" }} />
          </label>
          <div style={{ fontSize: 11.5, color: "#8A9C90", margin: "8px 0 14px", textAlign: "center" }}>
            txt · csv · tsv · xls · xlsx · pdf · json
          </div>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#465", marginBottom: 6 }}>…or paste data</div>
          <textarea
            className="input"
            rows={6}
            placeholder={mode === "inventory"
              ? "name, qty, buy, sell, expiry\nParle-G, 24, 8, 10, 2026-12-31\nLay's, 40, 16, 20, 31/12/2026"
              : mode === "expenses"
                ? "expense, amount, date\nElectricity bill, 1800, 2026-06-01\nShop rent, 15000, 01/06/2026"
                : "name, qty, amount\nParle-G, 5, 50\nLay's, 3, 60"}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            style={{ resize: "vertical", fontFamily: "monospace", fontSize: 12.5 }}
          />
          <button className="btn" style={{ width: "100%", marginTop: 8 }} onClick={processPaste}>Process pasted data</button>
          {err && <div style={{ color: "#C44536", fontSize: 13, marginTop: 10 }}>{err}</div>}
          <div style={{ fontSize: 11.5, color: "#8A9C90", marginTop: 12, lineHeight: 1.5 }}>
            {mode === "expenses"
              ? "Columns are auto-detected from headers (expense / description, amount, date). No headers? The text is the description, the number is the amount, and a date-looking value (e.g. 2026-06-01 or 01/06/2026) is the expense date. Blank dates default to today."
              : "Columns are auto-detected from headers (name / qty / buy / sell / amount / expiry). No headers? The name is read first, then numbers fill in as qty, buy, sell, amount — so 1 number is qty, 2 are qty + price, 3 are qty + buy + sell. A date-looking column (e.g. 2026-12-31 or 31/12/2026) is treated as the batch expiry."}
          </div>
        </section>

        <section style={S.panel}>
          <div style={S.panelHead}>
            2 · Review &amp; edit{source ? <span style={{ fontWeight: 500, textTransform: "none", letterSpacing: 0, color: "#8A9C90", marginLeft: 8 }}>from {source}</span> : null}
            <button className="btn small ghost" style={{ marginLeft: "auto" }} onClick={addRow}>+ Add row</button>
          </div>
          {!rows ? (
            <Empty text={busy ? "Reading…" : "Imported rows appear here. You can also build a list by hand with “+ Add row”."} />
          ) : (
            <>
              {mode === "sales" && (
                <label style={{ fontSize: 12, color: "#6B7E74", display: "block", marginBottom: 10 }}>
                  Sale date <input type="date" className="input" style={{ width: "auto", marginLeft: 6 }} value={saleDate} max={todayStr()} onChange={(e) => setSaleDate(e.target.value || todayStr())} />
                </label>
              )}
              {mode === "expenses" ? (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Description</th><th style={{ width: 110 }}>Amount ₹</th><th style={{ width: 150 }}>Date</th><th style={{ width: 30 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i}>
                        <td><input className="input" style={{ padding: "6px 8px" }} value={r.name} placeholder="e.g. Electricity bill" onChange={(e) => edit(i, "name", e.target.value)} /></td>
                        <td><input className="input" style={{ padding: "6px 8px" }} type="number" min="0" step="0.01" value={r.amount} onChange={(e) => edit(i, "amount", e.target.value)} /></td>
                        <td><input className="input" style={{ padding: "6px 8px" }} type="date" max={todayStr()} value={r.date || ""} onChange={(e) => edit(i, "date", e.target.value)} /></td>
                        <td><button className="btn small danger" aria-label="Remove row" onClick={() => drop(i)}>✕</button></td>
                      </tr>
                    ))}
                    {rows.length === 0 && <tr><td colSpan={4}><Empty text="No rows yet — click “+ Add row”." /></td></tr>}
                  </tbody>
                </table>
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Item</th><th style={{ width: 58 }}>Qty</th>
                      {mode === "inventory"
                        ? (<><th style={{ width: 72 }}>Unit</th><th style={{ width: 78 }}>Buy ₹</th><th style={{ width: 78 }}>Sell ₹</th><th style={{ width: 140 }}>Expiry</th></>)
                        : (<th style={{ width: 96 }}>Amount ₹</th>)}
                      <th style={{ width: 30 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i}>
                        <td><input className="input" style={{ padding: "6px 8px" }} value={r.name} onChange={(e) => edit(i, "name", e.target.value)} /></td>
                        <td><input className="input" style={{ padding: "6px 8px" }} type="number" min="0" value={r.qty} onChange={(e) => edit(i, "qty", +e.target.value)} /></td>
                        {mode === "inventory" ? (
                          <>
                            <td>
                              <select className="input" style={{ padding: "6px 4px" }} value={r.unit} onChange={(e) => edit(i, "unit", e.target.value)}>
                                {UNITS.map((u) => <option key={u}>{u}</option>)}
                              </select>
                            </td>
                            <td><input className="input" style={{ padding: "6px 8px" }} type="number" min="0" step="0.01" value={r.buyPrice} onChange={(e) => edit(i, "buyPrice", e.target.value)} /></td>
                            <td><input className="input" style={{ padding: "6px 8px" }} type="number" min="0" step="0.01" value={r.sellPrice} onChange={(e) => edit(i, "sellPrice", e.target.value)} /></td>
                            <td><input className="input" style={{ padding: "6px 8px" }} type="date" value={r.expiry || ""} onChange={(e) => edit(i, "expiry", e.target.value)} /></td>
                          </>
                        ) : (
                          <td><input className="input" style={{ padding: "6px 8px" }} type="number" min="0" step="0.01" value={r.amount} onChange={(e) => edit(i, "amount", e.target.value)} /></td>
                        )}
                        <td><button className="btn small danger" aria-label="Remove row" onClick={() => drop(i)}>✕</button></td>
                      </tr>
                    ))}
                    {rows.length === 0 && <tr><td colSpan={mode === "inventory" ? 7 : 4}><Empty text="No rows yet — click “+ Add row”." /></td></tr>}
                  </tbody>
                </table>
              )}
              <div style={{ fontSize: 12, color: "#6B7E74", margin: "10px 0" }}>
                {mode === "inventory"
                  ? "Existing names get restocked; new names create items (blank sell = buy + 15%). Each row's expiry becomes its own dated batch; leave blank for no expiry."
                  : mode === "expenses"
                    ? "Each row is added as a separate expense and shows up in Finance totals and the expense charts. Rows with no description or an amount of 0 are skipped; a blank date defaults to today."
                    : "Matched item names reduce stock automatically; unmatched lines still record as revenue."}
              </div>
              <button className="btn primary big" style={{ width: "100%" }} disabled={rows.length === 0} onClick={mode === "inventory" ? commitInventory : mode === "expenses" ? commitExpenses : commitSales}>
                {mode === "inventory" ? `Add ${rows.length} item(s) to inventory` : mode === "expenses" ? `Add ${rows.length} expense(s)` : `Record sale · ${rows.length} line(s)`}
              </button>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

// ---------- Sales history ----------
const PAY_COLORS = { UPI: "#2A6FB0", Cash: "#1B5E43", Udhari: "#C44536" };

function SalesHistory({ sales, items, staff, setSales, setItems, store = STORE, notify, log, role }) {
  const [open, setOpen] = useState(null);
  const [openDates, setOpenDates] = useState(() => new Set()); // expanded past dates (today is always open)
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [q, setQ] = useState(""); // free-text search across bills
  const [editing, setEditing] = useState(null); // { id, date, payment, lines:[...], orig:[...] }
  // "Add item on the go" fields for the Edit-bill modal: catalogue search + quick-catalogue row.
  const [addQ, setAddQ] = useState("");
  const [newName, setNewName] = useState("");
  const [newCode, setNewCode] = useState("");
  const [newPrice, setNewPrice] = useState("");
  const toggleDate = (d) => setOpenDates((s) => { const n = new Set(s); n.has(d) ? n.delete(d) : n.add(d); return n; });

  // Search matches a bill when EVERY space-separated term is found somewhere in it —
  // item names, customer, mobile, payment, date/time, bill id, or any amount/quantity.
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const searching = terms.length > 0;
  const matchSale = (s) => {
    if (!searching) return true;
    const hay = [
      s.date, s.time, s.payment, s.customer, s.mobile, s.id, s.total, s.profit, s.paid,
      ...(s.lines || []).flatMap((l) => [l.name, l.qty, l.amount, l.price]),
    ].filter((v) => v != null).join(" ").toLowerCase();
    return terms.every((t) => hay.includes(t));
  };

  const visible = sales.filter((s) => (!from || s.date >= from) && (!to || s.date <= to) && matchSale(s));
  const byDate = useMemo(() => {
    const m = {};
    [...visible].reverse().forEach((s) => { (m[s.date] = m[s.date] || []).push(s); });
    return Object.entries(m).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [visible]);
  const rangeTotal = money(visible.reduce((a, s) => a + s.total, 0));

  // Adjust stock by per-item-name deltas (positive = sell more → remove; negative = add back).
  const applyDeltas = (deltas) => {
    setItems((its) => its.map((i) => {
      const d = deltas[i.name.toLowerCase()];
      if (!d) return i;
      return d > 0 ? removeStock(i, d, todayStr()) : addBatch(i, -d, "", todayStr());
    }));
  };

  const deleteSale = (s) => {
    // Belt and braces: the nav never offers this view's delete to a worker, and the database
    // rules reject the write anyway — but the guard belongs next to the action too.
    if (!can(role, "sales.delete")) return notify("⚠ Only the owner can delete a bill.");
    if (!confirm(`Delete this ${INR(s.total)} bill from ${s.date}? Stock will be added back.`)) return;
    const deltas = {};
    // Misc / custom lines have no inventory item, and SERVICE lines have no stock at all, so
    // neither has anything to restore. Without the service guard a service that happens to
    // share a name with a product would silently inflate that product's stock on every delete.
    s.lines.forEach((l) => {
      if (l.misc || isServiceLine(l)) return;
      deltas[l.name.toLowerCase()] = (deltas[l.name.toLowerCase()] || 0) - l.qty;
    });
    applyDeltas(deltas);
    setSales((all) => all.filter((x) => x.id !== s.id));
    // The customer's visit/spend stats reverse themselves: the shell reconciles them from the
    // bills, so removing the bill is the whole of the reversal. See reconcileCustomers.
    log("sale", `Deleted bill ${INR(s.total)} (${s.date}) — stock restored`);
    notify("Bill deleted, stock restored");
  };

  const openEdit = (s) => setEditing({
    id: s.id, date: s.date, payment: s.payment || "UPI", paid: s.paid != null ? String(s.paid) : "", paidMode: s.paidMode || "Cash",
    discount: s.discount != null ? String(s.discount) : "", // editable ₹ discount (a % discount is edited as its ₹ value)
    lines: s.lines.map((l) => ({ ...l })), orig: s.lines.map((l) => ({ ...l })),
  });
  const editLine = (idx, qty) => setEditing((e) => ({ ...e, lines: e.lines.map((l, i) => (i === idx ? { ...l, qty: Math.max(0, qty || 0) } : l)) }));
  const removeLine = (idx) => setEditing((e) => ({ ...e, lines: e.lines.filter((_, i) => i !== idx) }));

  // ----- Add items to a bill while editing it -----
  // Matches Billing's picker + Misc row so the two flows behave identically. Nothing here changes
  // stock directly for existing items — saveEdit reconciles stock by name (orig vs new lines), so a
  // line added here simply depletes that item's stock by its qty when the edit is saved.
  const OPENING_STOCK = 20;     // opening stock for a quick-catalogued item (same as Billing)
  const BUY_PRICE_RATIO = 0.8;  // default cost = 80% of sell price (≈20% margin)
  const resetAddItem = () => { setAddQ(""); setNewName(""); setNewCode(""); setNewPrice(""); };
  const closeEdit = () => { setEditing(null); resetAddItem(); };

  // Catalogue items matching the add-search box (name / barcode / an exact price).
  const addMatches = useMemo(() => {
    const s = addQ.trim().toLowerCase();
    if (!editing || !s) return [];
    const isNum = /^\d+(\.\d+)?$/.test(s);
    const num = isNum ? +s : null;
    return items.filter((i) =>
      i.name.toLowerCase().includes(s) ||
      itemBarcodes(i).some((b) => b.toLowerCase().includes(s)) ||
      (isNum && (+i.sellPrice === num || +i.mrp === num))
    ).slice(0, 8);
  }, [addQ, items, editing]);

  // Add an existing catalogue item to the bill — bump the existing (non-misc) line of the same name
  // if present, else append a fresh line. Prices are coerced to numbers because cloud/imported data
  // can store them as strings (which would corrupt the amount/subtotal math).
  const addExistingLine = (item) => {
    setEditing((e) => {
      if (!e) return e;
      const key = normName(item.name);
      const at = e.lines.findIndex((l) => !l.misc && normName(l.name) === key);
      const price = +item.sellPrice || 0, buy = +item.buyPrice || 0;
      const lines = at >= 0
        ? e.lines.map((l, j) => (j === at ? { ...l, qty: (+l.qty || 0) + 1 } : l))
        : [...e.lines, { name: item.name, qty: 1, unit: item.unit || "pc", price, buyPrice: buy, amount: money(price) }];
      return { ...e, lines };
    });
    setAddQ("");
  };

  // Quick-catalogue a brand-new item and put it on the bill (mirrors Billing's Misc row): registers a
  // real inventory item (opening stock 20, cost 80% of sell, auto category) so the catalogue grows,
  // then adds a bill line whose qty is deducted from that stock on save. If the name/barcode already
  // belongs to a catalogued item, that item is added instead — no duplicate is created.
  const addNewItem = () => {
    if (!editing) return;
    const price = +newPrice;
    if (!(price > 0)) return notify("Enter a price for the item.");
    const name = newName.trim();
    if (!name) return notify("Enter a name for the item.");
    const codes = parseBarcodeText(newCode); // optional; cleaned + de-duped, first token = primary
    const existing = (codes.length ? findItemByBarcode(items, codes[0]) : null)
      || items.find((i) => normName(i.name) === normName(name));
    if (existing) { addExistingLine(existing); resetAddItem(); return; }
    const bcClash = findBarcodeClash(codes, items);
    if (bcClash) return notify(`Barcode “${bcClash.code}” already belongs to “${bcClash.item.name}”.`);
    const category = guessCategory(name, items) || "Other";
    const sell = money(price);
    const batches = [{ id: uid(), qty: OPENING_STOCK, expiry: "", addedOn: todayStr() }];
    const newItem = {
      name, code: codes[0] || "", barcodes: codes.slice(1), category, unit: "pc",
      icon: iconFor(category), buyPrice: money(sell * BUY_PRICE_RATIO), sellPrice: sell, mrp: sell,
      lowAt: 5, id: uid(), stock: OPENING_STOCK, batches, createdAt: todayStr(),
    };
    setItems((list) => [...list, newItem]);
    setEditing((e) => (e ? { ...e, lines: [...e.lines, { name, qty: 1, unit: "pc", price: sell, buyPrice: newItem.buyPrice, amount: sell }] } : e));
    log("inventory", `Added item “${name}” · ${OPENING_STOCK} pc @ ${INR(sell)} (cost ${INR(newItem.buyPrice)}) · ${category} (from bill edit${codes[0] ? `, barcode ${codes[0]}` : ""})`);
    notify(`Added “${name}” to inventory (${category}, stock ${OPENING_STOCK}) & this bill`);
    resetAddItem();
  };

  const editSubtotal = editing ? money(editing.lines.reduce((a, l) => a + l.price * l.qty, 0)) : 0;
  const editDiscount = editing ? Math.min(editSubtotal, Math.max(0, money(+editing.discount || 0))) : 0;
  const editTotal = money(editSubtotal - editDiscount);

  const saveEdit = () => {
    const newLines = editing.lines.filter((l) => l.qty > 0).map((l) => ({ ...l, amount: money(l.price * l.qty) }));
    if (newLines.length === 0) return notify("A bill needs at least one line — use Delete instead");
    const gross = money(newLines.reduce((a, l) => a + l.amount, 0));
    // Re-clamp any existing discount to the new subtotal, then net it off total and profit.
    const discountAmt = Math.min(gross, Math.max(0, money(+editing.discount || 0)));
    const total = money(gross - discountAmt);
    // Prefer the cost snapshotted on the line at sale time; fall back to the current item
    // cost only for legacy bills saved before lines carried buyPrice.
    const buyOf = (l) => (l.buyPrice != null ? +l.buyPrice : (items.find((i) => i.name.toLowerCase() === l.name.toLowerCase())?.buyPrice || 0));
    const profit = money(newLines.reduce((a, l) => a + (l.price - buyOf(l)) * l.qty, 0) - discountAmt);
    const oldQ = {}, newQ = {};
    // Misc / custom lines aren't inventory-backed, and service lines have no stock at all, so
    // neither drives stock reconciliation. Both sides must filter identically — filtering one
    // and not the other would book a phantom delta for every service on the bill.
    const stockBacked = (l) => !l.misc && !isServiceLine(l);
    editing.orig.forEach((l) => { if (!stockBacked(l)) return; const k = l.name.toLowerCase(); oldQ[k] = (oldQ[k] || 0) + l.qty; });
    newLines.forEach((l) => { if (!stockBacked(l)) return; const k = l.name.toLowerCase(); newQ[k] = (newQ[k] || 0) + l.qty; });
    const deltas = {};
    [...new Set([...Object.keys(oldQ), ...Object.keys(newQ)])].forEach((k) => { const d = (newQ[k] || 0) - (oldQ[k] || 0); if (d) deltas[k] = d; });
    applyDeltas(deltas);
    const paid = editing.payment === "Udhari" ? Math.min(total, Math.max(0, money(+editing.paid || 0))) : undefined;
    setSales((all) => all.map((x) => {
      if (x.id !== editing.id) return x;
      const next = { ...x, date: editing.date || x.date, payment: editing.payment, lines: newLines, total, profit };
      // A % discount, once edited, is stored as its plain ₹ value — drop the stale percent tag.
      if (discountAmt > 0) { next.subtotal = gross; next.discount = discountAmt; delete next.discountPct; }
      else { delete next.subtotal; delete next.discount; delete next.discountPct; }
      if (editing.payment === "Udhari") {
        next.paid = paid;
        if (paid > 0) next.paidMode = editing.paidMode; else delete next.paidMode;
      } else { delete next.paid; delete next.paidMode; }
      return next;
    }));
    log("sale", `Edited bill → ${INR(total)} · ${newLines.length} line(s) · ${editing.payment}`);
    setEditing(null);
    resetAddItem();
    notify("Bill updated");
  };

  // ----- Split a bill across multiple dates -----
  // Replaces one bill with several smaller bills whose amounts (and, in the same
  // proportion, profit + line amounts) add up to exactly the original. It is purely a
  // re-dating of money already recorded, so stock is NOT touched. Because the dashboard
  // and finance views aggregate from the sales list by date/total/profit/lines, the split
  // parts flow through everywhere and the cumulative stays equal to the original bill.
  const [splitting, setSplitting] = useState(null);
  // { id, time, payment, customer, total, profit, lines, parts:[{date, amount}] }

  const addDays = (ds, n) => { const d = new Date(ds + "T00:00"); d.setDate(d.getDate() + n); return dateStr(d); };
  // Spread an amount equally across n parts as 2-dp money; the last part absorbs the remainder.
  const equalShares = (amount, n) => {
    const each = money(amount / n);
    return Array.from({ length: n }, (_, i) => (i === n - 1 ? money(amount - each * (n - 1)) : each));
  };

  const openSplit = (s) => setSplitting({
    id: s.id, time: s.time, payment: s.payment || "UPI", customer: s.customer || "", mobile: s.mobile || "", paid: s.paid || 0, paidMode: s.paidMode || "Cash",
    total: s.total, profit: s.profit, lines: s.lines,
    parts: equalShares(s.total, 2).map((amount, i) => ({ date: addDays(s.date, -i), amount })),
    rangeFrom: addDays(s.date, -1), rangeTo: s.date,
  });
  // Every calendar day in [from, to] inclusive.
  const datesInRange = (from, to) => {
    if (!from || !to || from > to) return [];
    const out = [];
    for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
    return out;
  };
  const setRangeFrom = (v) => setSplitting((sp) => ({ ...sp, rangeFrom: v }));
  const setRangeTo = (v) => setSplitting((sp) => ({ ...sp, rangeTo: v }));
  // Fill one part per day across the range, divided equally (still editable afterwards).
  const applyRange = () => {
    if (!splitting) return;
    const dates = datesInRange(splitting.rangeFrom, splitting.rangeTo);
    if (!dates.length) return notify("Pick a valid range — From must be on or before To.");
    if (dates.length > 90) return notify("Range too large — keep it within 90 days.");
    const shares = equalShares(splitting.total, dates.length);
    setSplitting((sp) => ({ ...sp, parts: dates.map((date, i) => ({ date, amount: shares[i] })) }));
  };
  const divideEqually = () => setSplitting((sp) => {
    const shares = equalShares(sp.total, sp.parts.length);
    return { ...sp, parts: sp.parts.map((p, i) => ({ ...p, amount: shares[i] })) };
  });
  const addPart = () => setSplitting((sp) => {
    const lastDate = sp.parts[sp.parts.length - 1]?.date || todayStr();
    const parts = [...sp.parts, { date: addDays(lastDate, -1), amount: 0 }];
    const shares = equalShares(sp.total, parts.length);
    return { ...sp, parts: parts.map((p, i) => ({ ...p, amount: shares[i] })) };
  });
  const removePart = (idx) => setSplitting((sp) => {
    if (sp.parts.length <= 2) return sp;
    const parts = sp.parts.filter((_, i) => i !== idx);
    const shares = equalShares(sp.total, parts.length);
    return { ...sp, parts: parts.map((p, i) => ({ ...p, amount: shares[i] })) };
  });
  const setPartDate = (idx, date) => setSplitting((sp) => ({ ...sp, parts: sp.parts.map((p, i) => (i === idx ? { ...p, date } : p)) }));
  const setPartAmount = (idx, amount) => setSplitting((sp) => ({ ...sp, parts: sp.parts.map((p, i) => (i === idx ? { ...p, amount } : p)) }));
  // Put whatever is left over (total − all earlier parts) onto the last part, so the
  // amounts add up to the original in one click after editing the others.
  const balanceSplit = () => setSplitting((sp) => {
    const exceptLast = money(sp.parts.slice(0, -1).reduce((a, p) => a + (+p.amount || 0), 0));
    return { ...sp, parts: sp.parts.map((p, i) => (i === sp.parts.length - 1 ? { ...p, amount: money(sp.total - exceptLast) } : p)) };
  });

  const splitSum = splitting ? money(splitting.parts.reduce((a, p) => a + (+p.amount || 0), 0)) : 0;
  const splitDiff = splitting ? money(splitting.total - splitSum) : 0;
  // Valid when every part has a date and a positive amount, and the amounts add up to the
  // original to the paisa. A sub-paisa float residual is tolerated and snapped exactly on save.
  const splitValid = !!splitting
    && splitting.parts.length >= 2
    && splitting.parts.every((p) => p.date && (+p.amount || 0) > 0)
    && Math.abs(splitDiff) < 0.005;

  const saveSplit = () => {
    if (!splitValid) return;
    const { id, time, payment, customer, mobile, paid, paidMode, total, profit, lines } = splitting;
    // Snap the last part to absorb any sub-paisa residual so the parts sum to EXACTLY total.
    const exceptLast = money(splitting.parts.slice(0, -1).reduce((a, p) => a + (+p.amount || 0), 0));
    const parts = splitting.parts.map((p, i, arr) =>
      ({ ...p, amount: i === arr.length - 1 ? money(total - exceptLast) : money(+p.amount || 0) }));
    let profAcc = 0, paidAcc = 0;
    const newSales = parts.map((p, idx) => {
      const f = (+p.amount) / total;
      const isLast = idx === parts.length - 1;
      const prof = isLast ? money(profit - profAcc) : money(profit * f);
      profAcc = money(profAcc + prof);
      // Distribute any Udhari part-payment proportionally too (remainder on the last part).
      const partPaid = isLast ? money((+paid || 0) - paidAcc) : money((+paid || 0) * f);
      paidAcc = money(paidAcc + partPaid);
      // Scale each line by the same proportion; nudge the last line so the lines sum to
      // this part's amount exactly (keeps the bill detail and top-items totals consistent).
      let amtAcc = 0;
      const sl = lines.map((l) => {
        const amount = money((+l.amount || 0) * f);
        amtAcc = money(amtAcc + amount);
        return { ...l, qty: Math.round((+l.qty || 0) * f * 1000) / 1000, amount };
      });
      if (sl.length) { const d = money((+p.amount) - amtAcc); if (d) sl[sl.length - 1] = { ...sl[sl.length - 1], amount: money(sl[sl.length - 1].amount + d) }; }
      return {
        id: uid(), date: p.date,
        time: `${time || ""} (split ${idx + 1}/${parts.length})`.trim(),
        lines: sl, total: money(+p.amount), profit: prof,
        payment, ...(customer ? { customer } : {}), ...(mobile ? { mobile } : {}),
        ...(payment === "Udhari" ? { paid: partPaid } : {}),
        ...(payment === "Udhari" && partPaid > 0 ? { paidMode } : {}),
        splitOf: id,
      };
    });
    setSales((all) => all.flatMap((x) => (x.id === id ? newSales : [x])));
    log("sale", `Split bill ${INR(total)} into ${parts.length} part(s) across ${new Set(parts.map((p) => p.date)).size} date(s)`);
    setSplitting(null);
    notify(`Bill split into ${parts.length} parts`);
  };

  return (
    <div>
      <Header title="Sales History" sub={`${visible.length} of ${sales.length} bills · ${INR(rangeTotal)}`} />

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
        <input
          className="input"
          style={{ flex: 1, minWidth: 0 }}
          placeholder="🔍 Search bills — item, customer, mobile, amount, payment…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {q && <button className="btn ghost small" onClick={() => setQ("")}>Clear search</button>}
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <label style={{ fontSize: 12, color: "#6B7E74" }}>From <input type="date" className="input" style={{ width: "auto", marginLeft: 4 }} value={from} max={to || todayStr()} onChange={(e) => setFrom(e.target.value)} /></label>
        <label style={{ fontSize: 12, color: "#6B7E74" }}>To <input type="date" className="input" style={{ width: "auto", marginLeft: 4 }} value={to} max={todayStr()} onChange={(e) => setTo(e.target.value)} /></label>
        {(from || to) && <button className="btn ghost small" onClick={() => { setFrom(""); setTo(""); }}>Clear range</button>}
      </div>

      {sales.length === 0 && <section style={S.panel}><Empty text="No sales yet. Bills will appear here after you complete a sale." /></section>}
      {sales.length > 0 && visible.length === 0 && <section style={S.panel}><Empty text={searching ? `No bills match “${q.trim()}”${from || to ? " in this date range" : ""}.` : "No bills in this date range."} /></section>}
      {byDate.map(([date, list]) => {
        const isToday = date === todayStr();
        // Today is always open; every other date collapses (closed by default) so the list scans
        // quickly. While searching, open every matching date so the results are all visible.
        const expanded = isToday || searching || openDates.has(date);
        return (
        <section key={date} style={{ ...S.panel, marginBottom: 14 }}>
          <div
            style={{ ...S.panelHead, ...(isToday ? {} : { cursor: "pointer" }) }}
            onClick={isToday ? undefined : () => toggleDate(date)}
            {...(isToday ? {} : { role: "button", "aria-expanded": expanded })}
          >
            {!isToday && <span style={{ color: "#8A9C90", marginRight: 6 }}>{expanded ? "▾" : "▸"}</span>}
            {new Date(date + "T00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}
            {isToday && <span style={{ fontWeight: 600, color: "#1B5E43", marginLeft: 8 }}>· Today</span>}
            <span style={{ fontWeight: 500, color: "#8A9C90", marginLeft: 8 }}>· {list.length} bill{list.length > 1 ? "s" : ""}</span>
            <span style={{ marginLeft: "auto", fontWeight: 800 }}>
              {INR(list.reduce((a, s) => a + s.total, 0))}
              <span style={{ color: "#1B5E43", fontWeight: 700, fontSize: 12.5, marginLeft: 6 }}>(+{INR(money(list.reduce((a, s) => a + (s.profit || 0), 0)))})</span>
            </span>
          </div>
          {expanded && list.map((s) => (
            <div key={s.id}>
              <div style={{ ...S.row, cursor: "pointer" }} onClick={() => setOpen(open === s.id ? null : s.id)}>
                <span>
                  {s.time} · {s.lines.length} item{s.lines.length > 1 ? "s" : ""}
                  {searching && <span style={{ marginLeft: 6, fontSize: 11, color: "#8A9C90" }}>{new Date(s.date + "T00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</span>}
                  {s.payment && <span style={{ marginLeft: 8, fontSize: 10.5, fontWeight: 800, color: PAY_COLORS[s.payment] || "#789", border: `1px solid ${PAY_COLORS[s.payment] || "#bbb"}`, borderRadius: 6, padding: "0 6px" }}>{s.payment}{s.customer ? " · " + s.customer : ""}{s.mobile ? " · " + s.mobile : ""}</span>}
                </span>
                <span><b>{INR(s.total)}</b> <span style={{ color: "#1B5E43", fontSize: 12 }}>(+{INR(s.profit)})</span>
                  {s.payment === "Udhari" && (s.total - (s.paid || 0)) > 0 && <span style={{ color: "#C44536", fontSize: 11.5, fontWeight: 700, marginLeft: 6 }}>{INR(money(s.total - (s.paid || 0)))} due</span>}
                  {" "}{open === s.id ? "▾" : "▸"}</span>
              </div>
              {(open === s.id || searching) && (
                <div style={{ background: "#F4F7F4", borderRadius: 8, padding: "8px 12px", margin: "0 0 8px" }}>
                  {s.lines.map((l, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "3px 0" }}>
                      <span>
                        {l.name} × {l.qty}
                        {/* Who did the work — the first question asked of any past service bill. */}
                        {isServiceLine(l) && l.staffId ? <span style={{ color: "#8A9C90" }}> · {staffName(staff, l.staffId)}</span> : null}
                      </span>
                      <span>{INR(l.amount)}</span>
                    </div>
                  ))}
                  {s.discount > 0 && (
                    <div style={{ borderTop: "1px dashed #D8E0D8", marginTop: 4, paddingTop: 4 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "2px 0", color: "#6B7E74" }}>
                        <span>Subtotal</span><span>{INR(s.subtotal != null ? s.subtotal : money(s.total + s.discount))}</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "2px 0", color: "#C44536", fontWeight: 600 }}>
                        <span>Discount{s.discountPct ? ` (${s.discountPct}%)` : ""}</span><span>−{INR(s.discount)}</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "2px 0", fontWeight: 800 }}>
                        <span>Total</span><span>{INR(s.total)}</span>
                      </div>
                    </div>
                  )}
                  {/* A biller reaches this view to REPRINT a receipt — that's why sales.view is
                      theirs. Changing or erasing a bill that's already been rung up is an owner
                      decision, and the database rules enforce the delete half of that too. */}
                  <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                    <button className="btn small" onClick={() => printReceipt(s, store, staff)}>🖨 Print</button>
                    {can(role, "sales.edit") && <button className="btn small ghost" onClick={() => openEdit(s)}>✎ Edit bill</button>}
                    {can(role, "sales.edit") && <button className="btn small ghost" onClick={() => openSplit(s)}>✂ Split</button>}
                    {can(role, "sales.delete") && <button className="btn small danger" onClick={() => deleteSale(s)}>🗑 Delete</button>}
                  </div>
                </div>
              )}
            </div>
          ))}
        </section>
        );
      })}

      {editing && (
        <Modal title="Edit bill" onClose={closeEdit}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Date"><input type="date" className="input" max={todayStr()} value={editing.date} onChange={(e) => setEditing({ ...editing, date: e.target.value })} /></Field>
            <Field label="Payment">
              <select className="input" value={editing.payment} onChange={(e) => setEditing({ ...editing, payment: e.target.value })}>
                {["UPI", "Cash", "Udhari"].map((p) => <option key={p}>{p}</option>)}
              </select>
            </Field>
          </div>
          <table className="tbl">
            <thead><tr><th>Item</th><th style={{ width: 70 }}>Qty</th><th style={{ textAlign: "right" }}>Amount</th><th style={{ width: 30 }}></th></tr></thead>
            <tbody>
              {editing.lines.map((l, idx) => (
                <tr key={idx}>
                  <td>{l.name}<div style={{ fontSize: 11, color: "#9AA" }}>{INR(l.price)}/{l.unit}</div></td>
                  <td><input className="input" style={{ padding: "6px 8px" }} type="number" min="0" value={l.qty} onChange={(e) => editLine(idx, +e.target.value)} /></td>
                  <td style={{ textAlign: "right", fontWeight: 700 }}>{INR(money(l.price * l.qty))}</td>
                  <td><button className="btn small danger" aria-label="Remove line" onClick={() => removeLine(idx)}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Add items on the go — tap a catalogue match, or quick-catalogue a brand-new item. */}
          <div style={{ marginTop: 4, marginBottom: 6, padding: "8px 10px", background: "#F4F7F4", borderRadius: 8 }}>
            <div style={{ fontSize: 11.5, fontWeight: 700, color: "#465", marginBottom: 6 }}>Add item to this bill</div>
            <input
              className="input"
              placeholder="Search catalogue — name / barcode / price…"
              value={addQ}
              onChange={(e) => setAddQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && addMatches.length > 0) { addExistingLine(addMatches[0]); } }}
              aria-label="Search catalogue to add an item"
            />
            {addMatches.length > 0 && (
              <div style={{ marginTop: 6, maxHeight: 176, overflowY: "auto", border: "1px solid #E3EAE3", borderRadius: 8, background: "#fff" }}>
                {addMatches.map((i) => {
                  const inStock = (+i.stock || 0) > 0;
                  return (
                    <div key={i.id} role="button" onClick={() => addExistingLine(i)}
                      style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "6px 10px", cursor: "pointer", borderBottom: "1px solid #F0F3F0" }}>
                      <span style={{ fontSize: 13 }}><span style={{ marginRight: 5 }}>{i.icon || "📦"}</span>{i.name}</span>
                      <span style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                        <span style={{ color: "#1B5E43", fontWeight: 700 }}>{INR(i.sellPrice)}</span>
                        <span style={{ marginLeft: 8, color: inStock ? "#789" : "#C44536", fontWeight: inStock ? 400 : 600 }}>{inStock ? `${+i.stock || 0} left` : "Out of stock"}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            {addQ.trim() && addMatches.length === 0 && (
              <div style={{ fontSize: 11.5, color: "#8A9C90", marginTop: 6 }}>No catalogue match — add it as a new item below.</div>
            )}
            {/* Quick-catalogue a new item (mirrors Billing's Misc row): creates a real inventory item. */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginTop: 8 }}>
              <span style={{ fontSize: 11.5, fontWeight: 700, color: "#465", whiteSpace: "nowrap" }}>🧾 New</span>
              <input className="input" style={{ flex: 1, minWidth: 90 }} placeholder="Name" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addNewItem(); }} aria-label="New item name" />
              <input className="input" style={{ flex: 1, minWidth: 100 }} placeholder="Barcode (optional)" value={newCode} onChange={(e) => setNewCode(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addNewItem(); }} aria-label="New item barcode (optional)" title="Barcode (optional) — scan or type so this item scans at billing next time" />
              <input className="input" style={{ width: 86 }} type="number" min="0" step="0.01" placeholder="₹ sell" value={newPrice} onChange={(e) => setNewPrice(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addNewItem(); }} aria-label="New item sell price" />
              <button className="btn" onClick={addNewItem}>+ Add</button>
            </div>
            <div style={{ fontSize: 11, color: "#8A9C90", marginTop: 6 }}>New items are catalogued (opening stock {OPENING_STOCK}); the quantity on this bill is deducted from stock when you save.</div>
          </div>

          <Field label="Additional discount (₹)">
            <input className="input" type="number" min="0" step="0.01" max={editSubtotal} placeholder="0" value={editing.discount} onChange={(e) => setEditing({ ...editing, discount: e.target.value })} />
          </Field>
          {editDiscount > 0 && (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, color: "#6B7E74" }}><span>Subtotal</span><span>{INR(editSubtotal)}</span></div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, color: "#C44536", fontWeight: 600 }}><span>Discount</span><span>−{INR(editDiscount)}</span></div>
            </>
          )}
          <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 800, marginTop: 10 }}><span>New total</span><span>{INR(editTotal)}</span></div>
          {editing.payment === "Udhari" && (
            <div style={{ marginTop: 8 }}>
              <Field label="Amount paid (mark repayments here)">
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input className="input" style={{ flex: 1 }} type="number" min="0" step="0.01" max={editTotal} value={editing.paid} onChange={(e) => setEditing({ ...editing, paid: e.target.value })} />
                  <button className="btn small ghost" onClick={() => setEditing({ ...editing, paid: String(editTotal) })}>Mark fully paid</button>
                </div>
              </Field>
              {+editing.paid > 0 && (
                <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: -4, marginBottom: 4 }}>
                  <span style={{ fontSize: 11.5, color: "#6B7E74", fontWeight: 600 }}>Paid via</span>
                  {["UPI", "Cash"].map((m) => (
                    <button key={m} className={"btn small " + (editing.paidMode === m ? "primary" : "ghost")} onClick={() => setEditing({ ...editing, paidMode: m })}>{m}</button>
                  ))}
                </div>
              )}
              <div style={{ fontSize: 12, textAlign: "right", color: "#C44536", fontWeight: 600 }}>Outstanding: {INR(Math.max(0, money(editTotal - (+editing.paid || 0))))}</div>
            </div>
          )}
          <div style={{ fontSize: 11.5, color: "#6B7E74", marginTop: 4 }}>Stock adjusts automatically for any quantity change.</div>
          <button className="btn primary big" style={{ width: "100%", marginTop: 12 }} onClick={saveEdit}>Save changes</button>
        </Modal>
      )}

      {splitting && (
        <Modal title="Split bill across dates" onClose={() => setSplitting(null)}>
          <div style={{ fontSize: 12.5, color: "#6B7E74", marginBottom: 10, lineHeight: 1.5 }}>
            Original total <b>{INR(splitting.total)}</b>. Give each part a date and an amount — by default it's divided equally, but you can enter your own amounts. The parts must add up to exactly the original total. Profit and items are split in the same proportion, so the dashboard and finance graphs stay accurate. (Stock isn't affected.)
          </div>
          <div style={{ background: "#F4F7F4", borderRadius: 8, padding: "8px 12px", marginBottom: 10 }}>
            <div style={{ fontSize: 11.5, fontWeight: 700, color: "#465", marginBottom: 6 }}>Split over a date range</div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <label style={{ fontSize: 12, color: "#6B7E74" }}>From <input type="date" className="input" style={{ width: "auto", marginLeft: 4 }} max={splitting.rangeTo || todayStr()} value={splitting.rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} /></label>
              <label style={{ fontSize: 12, color: "#6B7E74" }}>To <input type="date" className="input" style={{ width: "auto", marginLeft: 4 }} max={todayStr()} value={splitting.rangeTo} onChange={(e) => setRangeTo(e.target.value)} /></label>
              <button className="btn small" onClick={applyRange}>Fill range</button>
            </div>
            <div style={{ fontSize: 11, color: "#8A9C90", marginTop: 6 }}>Creates one part per day in the range, divided equally — then edit any amount below.</div>
          </div>
          <table className="tbl">
            <thead><tr><th>Date</th><th style={{ textAlign: "right" }}>Amount ₹</th><th style={{ width: 30 }}></th></tr></thead>
            <tbody>
              {splitting.parts.map((p, idx) => (
                <tr key={idx}>
                  <td><input type="date" className="input" style={{ padding: "6px 8px" }} max={todayStr()} value={p.date} onChange={(e) => setPartDate(idx, e.target.value)} /></td>
                  <td><input type="number" min="0" step="0.01" className="input" style={{ padding: "6px 8px", textAlign: "right" }} value={p.amount} onChange={(e) => setPartAmount(idx, +e.target.value)} /></td>
                  <td><button className="btn small danger" disabled={splitting.parts.length <= 2} aria-label="Remove part" onClick={() => removePart(idx)}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <button className="btn small ghost" onClick={addPart}>+ Add date</button>
            <button className="btn small ghost" onClick={divideEqually}>Divide equally</button>
            <button className="btn small ghost" onClick={balanceSplit} disabled={Math.abs(splitDiff) < 0.005}>Balance last row</button>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 800, marginTop: 12 }}>
            <span>Split total</span>
            <span style={{ color: Math.abs(splitDiff) < 0.005 ? "#1B5E43" : "#C44536" }}>{INR(splitSum)} / {INR(splitting.total)}</span>
          </div>
          {Math.abs(splitDiff) >= 0.005 && (
            <div style={{ fontSize: 12, color: "#C44536", marginTop: 4 }}>
              Amounts must add up to {INR(splitting.total)} — {splitDiff > 0 ? `${INR(splitDiff)} short` : `${INR(-splitDiff)} over`}. Use “Balance last row” to put the rest on the last date.
            </div>
          )}
          <button className="btn primary big" style={{ width: "100%", marginTop: 12 }} disabled={!splitValid} onClick={saveSplit}>
            Save split · {splitting.parts.length} part(s)
          </button>
        </Modal>
      )}
    </div>
  );
}

// ---------- Alerts ----------
function Alerts({ items, goInventory, cats = CATEGORIES }) {
  const [view, setView] = useState("low"); // low | out | expiring | expired
  const [cat, setCat] = useState("All");
  const byCat = (i) => cat === "All" || i.category === cat;

  const low = items.filter((i) => byCat(i) && i.stock <= i.lowAt).sort((a, b) => a.stock - b.stock);
  const out = low.filter((i) => i.stock <= 0);

  const expRows = [];
  items.filter(byCat).forEach((i) => (i.batches || []).forEach((b) => {
    if (!b.expiry) return;
    const d = Math.round((new Date(b.expiry + "T00:00") - new Date(todayStr() + "T00:00")) / 86400000);
    expRows.push({ item: i, b, d });
  }));
  const expiring = expRows.filter((r) => r.d >= 0 && r.d <= 30).sort((a, b) => a.d - b.d);
  const expired = expRows.filter((r) => r.d < 0).sort((a, b) => a.d - b.d);

  const tabs = [["low", "Low stock", low.length], ["out", "Out of stock", out.length], ["expiring", "Expiring ≤30d", expiring.length], ["expired", "Expired", expired.length]];
  const isStockView = view === "low" || view === "out";
  const stockList = view === "out" ? out : low;
  const expList = view === "expired" ? expired : expiring;

  return (
    <div>
      <Header title="Alerts" sub="Items running low (lowest stock first) and batches nearing or past expiry">
        <button className="btn ghost small" onClick={goInventory}>Go to inventory</button>
      </Header>

      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        {tabs.map(([k, lbl, n]) => (
          <button key={k} className={"btn small " + (view === k ? "primary" : "")} onClick={() => setView(k)}>
            {lbl} <b>({n})</b>
          </button>
        ))}
        <select className="input" style={{ width: "auto", marginLeft: "auto" }} value={cat} onChange={(e) => setCat(e.target.value)}>
          <option>All</option>
          {cats.map((c) => <option key={c}>{c}</option>)}
        </select>
      </div>

      <section style={S.panel}>
        {isStockView ? (
          stockList.length === 0 ? (
            <Empty text="Nothing here — stock looks healthy." />
          ) : (
            <table className="tbl">
              <thead><tr><th>Item</th><th>Category</th><th style={{ textAlign: "right" }}>Stock</th><th style={{ textAlign: "right" }}>Alert below</th></tr></thead>
              <tbody>
                {stockList.map((i) => (
                  <tr key={i.id}>
                    <td style={{ fontWeight: 600 }}><span style={{ marginRight: 6 }}>{i.icon || "📦"}</span>{i.name}</td>
                    <td style={{ color: "#677" }}>{i.category}</td>
                    <td style={{ textAlign: "right", fontWeight: 800, color: i.stock <= 0 ? "#C44536" : "#B0762A" }}>{i.stock} {i.unit}</td>
                    <td style={{ textAlign: "right", color: "#789" }}>{i.lowAt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : (
          expList.length === 0 ? (
            <Empty text="No batches in this window." />
          ) : (
            <table className="tbl">
              <thead><tr><th>Item</th><th>Category</th><th style={{ textAlign: "right" }}>Batch qty</th><th>Expiry</th><th style={{ textAlign: "right" }}>Status</th></tr></thead>
              <tbody>
                {expList.map((r, idx) => (
                  <tr key={idx}>
                    <td style={{ fontWeight: 600 }}><span style={{ marginRight: 6 }}>{r.item.icon || "📦"}</span>{r.item.name}</td>
                    <td style={{ color: "#677" }}>{r.item.category}</td>
                    <td style={{ textAlign: "right", fontWeight: 700 }}>{r.b.qty} {r.item.unit}</td>
                    <td>{r.b.expiry}</td>
                    <td style={{ textAlign: "right", fontWeight: 700, color: r.d < 0 ? "#C44536" : "#B0762A" }}>{r.d < 0 ? `${-r.d}d ago` : `in ${r.d}d`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
      </section>
    </div>
  );
}

// ---------- Activity Log ----------
const LOG_COLORS = { sale: "#1B5E43", inventory: "#2A6FB0", expense: "#C44536", import: "#7A5AB0", backup: "#7A6A1E", bill: "#0E7C86" };

function Logs({ logs, setLogs, notify }) {
  const [date, setDate] = useState(""); // "" = all dates
  const [type, setType] = useState("all");

  const filtered = logs.filter((l) => (!date || l.date === date) && (type === "all" || l.type === type));

  const clear = () => {
    if (confirm("Clear the entire activity log? This cannot be undone (it does not affect sales or stock).")) {
      setLogs([]);
      notify("Activity log cleared");
    }
  };

  return (
    <div>
      <Header title="Activity Log" sub={logs.length + " events recorded — every change is logged here"}>
        {logs.length > 0 && <button className="btn ghost small" onClick={clear}>Clear log</button>}
      </Header>

      <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <label style={{ fontSize: 12, color: "#6B7E74" }}>Day <input type="date" className="input" style={{ width: "auto", marginLeft: 4 }} value={date} max={todayStr()} onChange={(e) => setDate(e.target.value)} /></label>
        <select className="input" style={{ width: 180 }} value={type} onChange={(e) => setType(e.target.value)}>
          <option value="all">All activity</option>
          {LOG_TYPES.map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
        </select>
        {(date || type !== "all") && <button className="btn ghost small" onClick={() => { setDate(""); setType("all"); }}>Show all</button>}
      </div>

      <section style={S.panel}>
        {filtered.length === 0 ? (
          <Empty text={logs.length === 0 ? "No activity yet. Actions you take in the app will appear here." : "No activity matches this filter."} />
        ) : (
          <table className="tbl">
            <thead><tr><th style={{ width: 168 }}>When</th><th style={{ width: 96 }}>Type</th><th>Activity</th></tr></thead>
            <tbody>
              {filtered.map((l) => (
                <tr key={l.id}>
                  <td style={{ whiteSpace: "nowrap", color: "#677" }}>{l.date} <span style={{ color: "#9AA" }}>{l.time}</span></td>
                  <td><span style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", color: LOG_COLORS[l.type] || "#555" }}>{l.type}</span></td>
                  <td>{l.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

// ---------- App Change Log ----------
// Data comes from git history at build time (scripts/vite-changelog-plugin.js) — CI/deploy noise is
// filtered out there, so nothing here is hand-maintained. The fallback URL only matters if the build
// had no git remote; entries are simply empty in that case and the section shows an empty state.
const REPO_URL = CHANGELOG_DATA.repoUrl || "https://github.com/s123dive-web/grocery-store-manager";
const CHANGELOG = CHANGELOG_DATA.entries || [];

function Changelog() {
  // Group entries by date so the list reads as dated releases, newest first.
  const groups = [];
  CHANGELOG.forEach(([date, summary, commit]) => {
    let g = groups.find((x) => x.date === date);
    if (!g) { g = { date, items: [] }; groups.push(g); }
    g.items.push({ summary, commit });
  });
  const fmt = (d) => new Date(d + "T00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

  return (
    <div>
      <Header title="App Change Log" sub={`What’s new — newest first · ${CHANGELOG.length} updates`}>
        <a className="btn ghost small" href={`${REPO_URL}/commits/main`} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>Full history on GitHub ↗</a>
      </Header>

      <section style={S.panel}>
        {groups.length === 0 ? (
          <Empty text="No change log available — this build was made without git history.">
            <a className="btn ghost small" href={`${REPO_URL}/commits/main`} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>Browse commits on GitHub ↗</a>
          </Empty>
        ) : groups.map((g) => (
          <div key={g.date} style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".06em", color: "#7A8C81", margin: "2px 0 8px" }}>{fmt(g.date)}</div>
            {g.items.map((it) => (
              <div key={it.commit} style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "8px 2px", borderBottom: "1px dashed #E5ECE6" }}>
                <span style={{ color: "#1B5E43" }}>•</span>
                <span style={{ flex: 1, fontSize: 13.5 }}>{it.summary}</span>
                <a href={`${REPO_URL}/commit/${it.commit}`} target="_blank" rel="noreferrer"
                   title="View this change on GitHub"
                   style={{ fontSize: 11.5, fontWeight: 700, fontFamily: "monospace", color: "#2A6FB0", textDecoration: "none", whiteSpace: "nowrap" }}>{it.commit} ↗</a>
              </div>
            ))}
          </div>
        ))}
      </section>
    </div>
  );
}

// ---------- Finance analytics helpers ----------
const PIE_COLORS = ["#1B5E43", "#E8A33D", "#2A6FB0", "#C44536", "#7A5AB0", "#3DA17A", "#B0762A", "#8A9C90"];
const inrTick = (v) => "₹" + (Math.abs(v) >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + "k" : v);
// Value labels sitting on top of vertical bars (compact ₹). Zeros are hidden so
// sparse charts stay uncluttered.
const barLabel = { position: "top", formatter: (v) => (v ? inrTick(v) : ""), fontSize: 9.5, fill: "#465" };

// Resolve a period preset (+ optional custom range) to { from, to, label }.
// `earliest` (a YYYY-MM-DD) is only consulted for the "allTime" preset — the caller
// passes the oldest record date so "All time" spans exactly the real data.
function periodRange(preset, cfrom, cto, earliest) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const som = (yy, mm) => dateStr(new Date(yy, mm, 1));
  const eom = (yy, mm) => dateStr(new Date(yy, mm + 1, 0));
  switch (preset) {
    case "lastMonth": { const d = new Date(y, m - 1, 1); return { from: som(d.getFullYear(), d.getMonth()), to: eom(d.getFullYear(), d.getMonth()), label: d.toLocaleDateString("en-IN", { month: "long", year: "numeric" }) }; }
    case "thisYear": return { from: dateStr(new Date(y, 0, 1)), to: dateStr(now), label: "Year " + y };
    case "last7": { const d = new Date(); d.setDate(d.getDate() - 6); return { from: dateStr(d), to: dateStr(now), label: "Last 7 days" }; }
    case "last14": { const d = new Date(); d.setDate(d.getDate() - 13); return { from: dateStr(d), to: dateStr(now), label: "Last 14 days" }; }
    case "last30": { const d = new Date(); d.setDate(d.getDate() - 29); return { from: dateStr(d), to: dateStr(now), label: "Last 30 days" }; }
    case "last45": { const d = new Date(); d.setDate(d.getDate() - 44); return { from: dateStr(d), to: dateStr(now), label: "Last 45 days" }; }
    // Month-based windows: new Date(y, m-N, day) rolls the year correctly and clamps overflow days.
    case "last2m": { const d = new Date(y, m - 2, now.getDate()); return { from: dateStr(d), to: dateStr(now), label: "Last 2 months" }; }
    case "lastQuarter": { const d = new Date(y, m - 3, now.getDate()); return { from: dateStr(d), to: dateStr(now), label: "Last 3 months" }; }
    case "last6m": { const d = new Date(y, m - 6, now.getDate()); return { from: dateStr(d), to: dateStr(now), label: "Last 6 months" }; }
    // All data on record: from the oldest entry — i.e. when the shop's books begin —
    // up to today. The label surfaces that start date so it's clear where "all time" begins.
    case "allTime": {
      const start = earliest || dateStr(new Date(y - 5, 0, 1));
      const since = earliest ? new Date(earliest + "T00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : null;
      return { from: start, to: dateStr(now), label: since ? `All time · since ${since}` : "All time" };
    }
    case "custom": return { from: cfrom || dateStr(now), to: cto || dateStr(now), label: `${cfrom || "…"} → ${cto || "…"}` };
    default: return { from: som(y, m), to: dateStr(now), label: now.toLocaleDateString("en-IN", { month: "long", year: "numeric" }) };
  }
}

// Build a daily (or monthly, for long ranges) revenue/profit/expense series.
function buildSeries(sales, expenses, from, to) {
  const start = new Date(from + "T00:00"), end = new Date(to + "T00:00");
  if (isNaN(start) || isNaN(end) || end < start) return [];
  const monthly = (end - start) / 86400000 > 62;
  const keyOf = (ds) => (monthly ? ds.slice(0, 7) : ds);
  const labelOf = (k) => (monthly
    ? new Date(k + "-01T00:00").toLocaleDateString("en-IN", { month: "short", year: "2-digit" })
    : new Date(k + "T00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" }));
  const buckets = new Map();
  if (monthly) { let d = new Date(start.getFullYear(), start.getMonth(), 1); while (d <= end) { const k = dateStr(d).slice(0, 7); buckets.set(k, { key: k, label: labelOf(k), revenue: 0, profit: 0, expenses: 0, cash: 0, upi: 0 }); d = new Date(d.getFullYear(), d.getMonth() + 1, 1); } }
  else { const d = new Date(start); while (d <= end) { const k = dateStr(d); buckets.set(k, { key: k, label: labelOf(k), revenue: 0, profit: 0, expenses: 0, cash: 0, upi: 0 }); d.setDate(d.getDate() + 1); } }
  sales.forEach((s) => { const b = buckets.get(keyOf(s.date)); if (b) { b.revenue += s.total; b.profit += s.profit; if (s.payment === "Cash") b.cash += s.total; else if (s.payment === "UPI") b.upi += s.total; } });
  expenses.forEach((e) => { const b = buckets.get(keyOf(e.date)); if (b) b.expenses += e.amount; });
  return [...buckets.values()].map((b) => ({ ...b, revenue: money(b.revenue), profit: money(b.profit), expenses: money(b.expenses), cash: money(b.cash), upi: money(b.upi) }));
}

// Day-wise revenue/profit buckets across [from, to] inclusive. One bucket per calendar
// day; days with no sales show as zero. Used by the Dashboard "period" charts.
function buildDaily(sales, from, to) {
  const start = new Date(from + "T00:00"), end = new Date(to + "T00:00");
  if (isNaN(start) || isNaN(end) || end < start) return [];
  const buckets = new Map();
  const d = new Date(start);
  while (d <= end) {
    const k = dateStr(d);
    buckets.set(k, { key: k, label: new Date(k + "T00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" }), revenue: 0, profit: 0 });
    d.setDate(d.getDate() + 1);
  }
  sales.forEach((s) => { const b = buckets.get(s.date); if (b) { b.revenue += s.total || 0; b.profit += s.profit || 0; } });
  return [...buckets.values()].map((b) => ({ ...b, revenue: money(b.revenue), profit: money(b.profit) }));
}

// Monday that begins the week containing d.
const weekStartOf = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); const wd = (x.getDay() + 6) % 7; x.setDate(x.getDate() - wd); return x; };

// Week-wise revenue/profit buckets across [from, to] inclusive. One bucket per calendar
// week (Mon–Sun); weeks with no sales show as zero. Labels mark the week-start date.
function buildWeekly(sales, from, to) {
  const start = new Date(from + "T00:00"), end = new Date(to + "T00:00");
  if (isNaN(start) || isNaN(end) || end < start) return [];
  const buckets = new Map();
  const d = weekStartOf(start);
  while (d <= end) {
    const k = dateStr(d);
    buckets.set(k, { key: k, label: new Date(k + "T00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" }), revenue: 0, profit: 0 });
    d.setDate(d.getDate() + 7);
  }
  sales.forEach((s) => { if (!s.date) return; const b = buckets.get(dateStr(weekStartOf(new Date(s.date + "T00:00")))); if (b) { b.revenue += s.total || 0; b.profit += s.profit || 0; } });
  return [...buckets.values()].map((b) => ({ ...b, revenue: money(b.revenue), profit: money(b.profit) }));
}

// Period options for the Dashboard "over time" charts. Each computes the from-date
// relative to today; the range end is always today.
const DASH_PERIODS = [
  ["7d", "Last 7 days", (d) => d.setDate(d.getDate() - 6)],
  ["14d", "Last 14 days", (d) => d.setDate(d.getDate() - 13)],
  ["1m", "Last 1 month", (d) => d.setMonth(d.getMonth() - 1)],
  ["2m", "Last 2 months", (d) => d.setMonth(d.getMonth() - 2)],
  ["quarter", "Last quarter", (d) => d.setMonth(d.getMonth() - 3)],
  ["6m", "Last 6 months", (d) => d.setMonth(d.getMonth() - 6)],
  ["1y", "Last year", (d) => d.setFullYear(d.getFullYear() - 1)],
  ["custom", "Custom date period", null],
];

const ChartCard = ({ title, children, height = 240 }) => (
  <section style={S.panel}>
    <div style={S.panelHead}>{title}</div>
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>
    </div>
  </section>
);

// Revenue split by how the bill was paid. Total includes everything (Udhari/credit too);
// Cash and UPI are the by-mode buckets. Shared by the Dashboard and Finance bar charts.
const PAYMIX_COLORS = ["#10331F", "#1B5E43", "#2A6FB0"]; // Total · Cash · UPI
const payMix = (sales) => {
  let total = 0, cash = 0, upi = 0;
  sales.forEach((s) => {
    const v = s.total || 0;
    total += v;
    if (s.payment === "Cash") cash += v;
    else if (s.payment === "UPI") upi += v;
  });
  return [
    { name: "Total", value: money(total) },
    { name: "Cash", value: money(cash) },
    { name: "UPI", value: money(upi) },
  ];
};
// Returns a BarChart ELEMENT (not a component) so it can be the direct child of ChartCard's
// ResponsiveContainer, which clones its child to inject width/height.
const renderPayMix = (sales) => {
  const data = payMix(sales);
  return (
    <BarChart data={data} margin={{ top: 16, right: 8, left: -8, bottom: 0 }}>
      <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
      <XAxis dataKey="name" tick={{ fontSize: 12, fill: "#678" }} />
      <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
      <Tooltip formatter={(v) => INR(v)} />
      <Bar dataKey="value" name="Amount" radius={[3, 3, 0, 0]} label={barLabel}>
        {data.map((d, i) => <Cell key={d.name} fill={PAYMIX_COLORS[i]} />)}
      </Bar>
    </BarChart>
  );
};
// Trend lines for Total / Cash / UPI over a buildSeries() result. Returns a LineChart element
// so it can be ChartCard's direct child (ResponsiveContainer clones it for sizing).
const renderPayTrend = (series) => (
  <LineChart data={series} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
    <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
    <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#678" }} interval="preserveStartEnd" minTickGap={20} />
    <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
    <Tooltip formatter={(v) => INR(v)} />
    <Legend wrapperStyle={{ fontSize: 12 }} />
    <Line type="monotone" dataKey="revenue" name="Total" stroke="#10331F" strokeWidth={2} dot={false} />
    <Line type="monotone" dataKey="cash" name="Cash" stroke="#1B5E43" strokeWidth={2} dot={false} />
    <Line type="monotone" dataKey="upi" name="UPI" stroke="#2A6FB0" strokeWidth={2} dot={false} />
  </LineChart>
);

// ---------- Finance (analytics) ----------
// Period presets for the analytics views. Finance and Stats each offer their own
// windows; the keys are resolved to concrete date ranges by periodRange().
const FINANCE_PERIODS = [["thisMonth", "This month"], ["lastMonth", "Last month"], ["last7", "Last 7 days"], ["last14", "Last 14 days"], ["last30", "Last 30 days"], ["last45", "Last 45 days"], ["last2m", "Last 2 months"], ["lastQuarter", "Last quarter"], ["thisYear", "This year"], ["custom", "Custom"]];
// Stats spans short windows through the full history. "All time" is anchored to
// fixed business milestones rather than the oldest data row: trading (sales) began
// May 2026, but capital / setup spending started earlier, in Jan 2026 — so the
// expense charts reach back further than the sales charts under "All time".
const TRADING_START = "2026-05-01"; // sales history begins — "All time" floor for revenue/profit charts
const CAPEX_START = "2026-01-01";   // capital/setup spending begins — "All time" floor for expense charts
const STATS_PERIODS = [["last7", "Last 7 days"], ["last30", "Last 30 days"], ["thisMonth", "This month"], ["lastMonth", "Last month"], ["lastQuarter", "Last 3 months"], ["last6m", "Last 6 months"], ["thisYear", "This year"], ["allTime", "All time"], ["custom", "Custom"]];

function Finance({ sales, expenses }) {
  const [preset, setPreset] = useState("thisMonth");
  const [cfrom, setCfrom] = useState("");
  const [cto, setCto] = useState("");
  const { from, to, label } = periodRange(preset, cfrom, cto);

  const pSales = useMemo(() => sales.filter((s) => s.date >= from && s.date <= to), [sales, from, to]);
  const pExp = useMemo(() => expenses.filter((e) => e.date >= from && e.date <= to), [expenses, from, to]);
  const revenue = money(pSales.reduce((a, s) => a + s.total, 0));
  const grossProfit = money(pSales.reduce((a, s) => a + s.profit, 0));
  const expTotal = money(pExp.reduce((a, e) => a + e.amount, 0));

  const series = useMemo(() => buildSeries(pSales, pExp, from, to), [pSales, pExp, from, to]);
  const expBreakdown = useMemo(() => {
    const m = {};
    pExp.forEach((e) => { m[e.desc] = (m[e.desc] || 0) + e.amount; });
    return Object.entries(m).map(([name, value]) => ({ name, value: money(value) })).sort((a, b) => b.value - a.value).slice(0, 8);
  }, [pExp]);
  const topItems = useMemo(() => {
    const m = {};
    pSales.forEach((s) => (s.lines || []).forEach((l) => { m[l.name] = (m[l.name] || 0) + l.amount; }));
    return Object.entries(m).map(([name, value]) => ({ name, value: money(value) })).sort((a, b) => b.value - a.value).slice(0, 7);
  }, [pSales]);

  return (
    <div>
      <Header title="Finance" sub={label}>
        <select className="input" style={{ width: "auto" }} value={preset} onChange={(e) => setPreset(e.target.value)}>
          {FINANCE_PERIODS.map(([k, lbl]) => <option key={k} value={k}>{lbl}</option>)}
        </select>
      </Header>

      {preset === "custom" && (
        <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
          <label style={{ fontSize: 12, color: "#6B7E74" }}>From <input type="date" className="input" style={{ width: "auto", marginLeft: 4 }} value={cfrom} max={cto || todayStr()} onChange={(e) => setCfrom(e.target.value)} /></label>
          <label style={{ fontSize: 12, color: "#6B7E74" }}>To <input type="date" className="input" style={{ width: "auto", marginLeft: 4 }} value={cto} max={todayStr()} onChange={(e) => setCto(e.target.value)} /></label>
        </div>
      )}

      <div style={S.cards}>
        <Card label="Revenue" value={INR(revenue)} sub={pSales.length + " bills"} />
        <Card label="Gross profit" value={INR(grossProfit)} sub="sales − item cost" />
        <Card label="Expenses" value={INR(expTotal)} sub={pExp.length + " entries"} />
        <Card label="Net profit" value={INR(money(grossProfit - expTotal))} sub="gross − expenses" accent />
      </div>

      <div style={{ marginTop: 16 }}>
        <ChartCard title="Total vs Cash vs UPI" height={220}>
          {renderPayMix(pSales)}
        </ChartCard>
      </div>

      <div style={{ marginTop: 16 }}>
        <ChartCard title="Total vs Cash vs UPI — trend" height={240}>
          {renderPayTrend(series)}
        </ChartCard>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginTop: 16 }}>
        {[
          { key: "revenue", title: "Revenue", color: "#1B5E43" },
          { key: "profit", title: "Profit", color: "#E8A33D" },
          { key: "expenses", title: "Expenses", color: "#C44536" },
        ].map((c) => (
          <ChartCard key={c.key} title={c.title} height={220}>
            <BarChart data={series} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#678" }} interval="preserveStartEnd" minTickGap={20} />
              <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
              <Tooltip formatter={(v) => INR(v)} />
              <Bar dataKey={c.key} name={c.title} fill={c.color} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ChartCard>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 16, marginTop: 16 }}>
        <ChartCard title="Revenue & profit over time">
          <AreaChart data={series} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
            <defs>
              <linearGradient id="gRev" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#1B5E43" stopOpacity={0.35} /><stop offset="100%" stopColor="#1B5E43" stopOpacity={0.03} /></linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#678" }} interval="preserveStartEnd" minTickGap={20} />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Area type="monotone" dataKey="revenue" name="Revenue" stroke="#1B5E43" strokeWidth={2} fill="url(#gRev)" />
            <Area type="monotone" dataKey="profit" name="Profit" stroke="#E8A33D" strokeWidth={2} fill="none" />
          </AreaChart>
        </ChartCard>

        <ChartCard title="Expense breakdown">
          {expBreakdown.length === 0 ? (
            <div style={{ display: "grid", placeItems: "center", height: "100%" }}><Empty text="No expenses in this period." /></div>
          ) : (
            <PieChart>
              <Pie data={expBreakdown} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={84} label={(e) => { const n = String(e.name || ""); return n.length > 10 ? n.slice(0, 10) + "…" : n; }} labelLine={false} fontSize={10}>
                {expBreakdown.map((e, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
              </Pie>
              <Tooltip formatter={(v) => INR(v)} />
            </PieChart>
          )}
        </ChartCard>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
        <ChartCard title="Revenue vs expenses">
          <BarChart data={series} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#678" }} interval="preserveStartEnd" minTickGap={20} />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="revenue" name="Revenue" fill="#1B5E43" radius={[3, 3, 0, 0]} />
            <Bar dataKey="expenses" name="Expenses" fill="#C44536" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ChartCard>

        <ChartCard title="Top items by revenue">
          {topItems.length === 0 ? (
            <div style={{ display: "grid", placeItems: "center", height: "100%" }}><Empty text="No sales in this period." /></div>
          ) : (
            <BarChart data={topItems} layout="vertical" margin={{ top: 4, right: 12, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 10.5, fill: "#465" }} width={110} />
              <Tooltip formatter={(v) => INR(v)} />
              <Bar dataKey="value" name="Revenue" fill="#2A6FB0" radius={[0, 3, 3, 0]} />
            </BarChart>
          )}
        </ChartCard>
      </div>
    </div>
  );
}

// ---------- Stats (insights / analytics) ----------
// All the number-crunching lives in ./lib/stats.js (pure + unit-tested). This
// component only wires those transforms to a mobile-first, date-range-driven
// dashboard. Every inline `grid-template-columns` collapses to a single column
// under 820px via the CSS at the bottom of this file, so the phone view stacks
// automatically.
const sectionHead = { fontSize: 13, fontWeight: 800, color: "#10331F", letterSpacing: ".02em", margin: "24px 0 8px" };
// (payment-method colours reuse the shared PAY_COLORS defined near Sales History)
// Bar value labels (compact ₹ / plain qty) that skip zeros to keep charts clean.
// `compactLabel` sits on top of vertical bars; the `…Right` variants end horizontal bars.
const compactLabel = { position: "top", formatter: (v) => (v ? inrCompact(v) : ""), fontSize: 9.5, fill: "#465" };
const compactLabelRight = { position: "right", formatter: (v) => (v ? inrCompact(v) : ""), fontSize: 9.5, fill: "#465" };
const qtyLabelRight = { position: "right", formatter: (v) => (v ? v : ""), fontSize: 9.5, fill: "#465" };
// Exact full-₹ value printed on top of bars / line points (zeros hidden). Two
// tints so a bar and its overlaid line stay distinguishable in the combo chart.
const exactLabel = { position: "top", formatter: (v) => (v ? formatINR(v) : ""), fontSize: 9, fill: "#14432E" };
const exactLabelGold = { position: "top", formatter: (v) => (v ? formatINR(v) : ""), fontSize: 9, fill: "#9A6410" };

// Green ramp for the heatmap: pale mint (quiet) → deep brand green (busiest).
const heatColor = (v, max) => {
  if (!v || !max) return "#F4F7F4";
  const t = Math.sqrt(Math.min(1, v / max)); // sqrt lifts the low end so small sales still register
  const lerp = (a, b) => Math.round(a + (b - a) * t);
  return `rgb(${lerp(224, 16)},${lerp(240, 51)},${lerp(230, 31)})`;
};

// One weekday × hour heatmap of revenue. Custom CSS grid (not Recharts) so it
// stays tiny and scrolls horizontally on a phone instead of squashing.
function Heatmap({ data }) {
  if (!data || data.placed === 0 || data.minHour == null) {
    return <Empty text="No clock-timed bills in this period to map." />;
  }
  const hours = [];
  for (let h = data.minHour; h <= data.maxHour; h++) hours.push(h);
  const cell = { width: 30, minWidth: 30, height: 26, borderRadius: 4 };
  return (
    <div style={{ overflowX: "auto", paddingBottom: 4 }}>
      <div style={{ display: "inline-block", minWidth: "100%" }}>
        <div style={{ display: "flex", gap: 3, marginLeft: 38, marginBottom: 3 }}>
          {hours.map((h) => (
            <div key={h} style={{ ...cell, height: "auto", textAlign: "center", fontSize: 9.5, color: "#8A9C90", fontWeight: 600 }}>{hourLabel(h)}</div>
          ))}
        </div>
        {DOW_ORDER.map((d) => (
          <div key={d} style={{ display: "flex", gap: 3, marginBottom: 3, alignItems: "center" }}>
            <div style={{ width: 35, minWidth: 35, fontSize: 11, color: "#465", fontWeight: 700 }}>{DOW[d]}</div>
            {hours.map((h) => {
              const v = data.grid[d][h];
              return (
                <div key={h} title={`${DOW[d]} ${hourLabel(h).replace("a", " AM").replace("p", " PM")} · ${formatINR(v)}`}
                  style={{ ...cell, background: heatColor(v, data.max), border: "1px solid #EDF2ED", cursor: "default" }} />
              );
            })}
          </div>
        ))}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, marginLeft: 38, fontSize: 10.5, color: "#8A9C90" }}>
          <span>Quieter</span>
          <div style={{ display: "flex", gap: 2 }}>
            {[0.05, 0.25, 0.5, 0.75, 1].map((t) => <div key={t} style={{ width: 16, height: 10, borderRadius: 2, background: heatColor(t, 1) }} />)}
          </div>
          <span>Busier — colour = revenue taken</span>
        </div>
      </div>
    </div>
  );
}

// Treemap tile: category rectangle labelled with its stock value. Recharts feeds
// x/y/width/height/index plus the datum fields (name, cost, retail, size).
function TreemapTile(props) {
  const { x, y, width, height, name, size, index } = props;
  if (!(width > 0) || !(height > 0)) return null;
  const fill = PIE_COLORS[(index ?? 0) % PIE_COLORS.length];
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} style={{ fill, stroke: "#fff", strokeWidth: 2 }} />
      {width > 54 && height > 22 && <text x={x + 7} y={y + 16} fill="#fff" fontSize={11} fontWeight={700}>{name}</text>}
      {width > 54 && height > 38 && <text x={x + 7} y={y + 31} fill="rgba(255,255,255,.85)" fontSize={10}>{inrCompact(size)}</text>}
    </g>
  );
}

// Turn a breakEvenEstimate() result into the big number + caption for its KPI card.
function breakEvenCard(be, est) {
  switch (est.status) {
    case "reached": return { value: "Recovered ✓", sub: `took ${est.days} day(s) · ${be.recovered}% of capital` };
    case "projected": return { value: "~" + est.daysLeft + " days", sub: `${be.recovered}% recovered · ${formatINR(est.perDay)}/day` };
    case "stalled": return { value: "—", sub: "no profit trend yet" };
    case "no-capex": return { value: "—", sub: "no setup cost logged" };
    default: return { value: "—", sub: "need more sales data" };
  }
}

function Stats({ sales, expenses, items }) {
  const [preset, setPreset] = useState("allTime"); // default to the full history
  const [cfrom, setCfrom] = useState("");
  const [cto, setCto] = useState("");
  const [metric, setMetric] = useState("revenue");      // top-items sort: revenue | qty | profit
  const [includeMisc, setIncludeMisc] = useState(false); // keep Misc/SwadSutra/Sold rows in item charts?
  const [treeMetric, setTreeMetric] = useState("cost");  // treemap sizing: cost | retail
  // "All time" for the sales charts is pinned to when trading began (TRADING_START).
  const { from, to, label } = periodRange(preset, cfrom, cto, TRADING_START);
  // Expenses (capital / setup cost) started before trading, so their "All time"
  // reaches back to CAPEX_START; every other preset shares the sales window.
  const expFrom = preset === "allTime" ? CAPEX_START : from;

  // Period slice drives most charts; a few (inventory, break-even, Udhari-now) are
  // "as of now" snapshots and deliberately read the full data — noted on each card.
  const pSales = useMemo(() => sales.filter((s) => s.date >= from && s.date <= to), [sales, from, to]);
  const pExp = useMemo(() => expenses.filter((e) => e.date >= expFrom && e.date <= to), [expenses, expFrom, to]);
  const sum = useMemo(() => summarize(pSales), [pSales]);
  const expMonthly = useMemo(() => expenseByMonth(pExp, expFrom, to), [pExp, expFrom, to]);
  const expBreak = useMemo(() => expenseBreakdown(pExp, { limit: 10 }), [pExp]);
  const expSum = useMemo(() => expenseTotal(pExp), [pExp]);

  const daily = useMemo(() => dailyRevenueSeries(pSales, from, to), [pSales, from, to]);
  const monthly = useMemo(() => monthlyRevenueProfit(pSales, from, to), [pSales, from, to]);
  const heat = useMemo(() => salesHeatmap(pSales), [pSales]);
  const topProducts = useMemo(() => topItemsBy(pSales, { metric, limit: 15, includeConsolidated: includeMisc }), [pSales, metric, includeMisc]);
  const pay = useMemo(() => paymentBreakdown(pSales), [pSales]);
  const udhariSeries = useMemo(() => udhariOutstandingSeries(sales, from, to), [sales, from, to]);
  const udhariNow = useMemo(() => money(sales.filter((s) => s.payment === "Udhari").reduce((a, s) => a + Math.max(0, (s.total || 0) - (s.paid || 0)), 0)), [sales]);
  const inv = useMemo(() => inventoryValue(items), [items]);
  const invCats = useMemo(() => inventoryByCategory(items), [items]);
  const dead = useMemo(() => deadStock(items, pSales), [items, pSales]);
  const be = useMemo(() => breakEvenSeries(sales, expenses), [sales, expenses]);       // all-time
  const est = useMemo(() => breakEvenEstimate(be), [be]);
  const beCard = breakEvenCard(be, est);

  const treeData = useMemo(() => invCats.map((c) => ({ ...c, size: treeMetric === "retail" ? c.retail : c.cost })).filter((c) => c.size > 0), [invCats, treeMetric]);
  const metricLabel = { revenue: "Revenue", qty: "Quantity", profit: "Profit" };

  return (
    <div>
      <Header title="Stats" sub={label}>
        <select className="input" style={{ width: "auto" }} value={preset} onChange={(e) => setPreset(e.target.value)}>
          {STATS_PERIODS.map(([k, lbl]) => <option key={k} value={k}>{lbl}</option>)}
        </select>
      </Header>

      {preset === "custom" && (
        <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
          <label style={{ fontSize: 12, color: "#6B7E74" }}>From <input type="date" className="input" style={{ width: "auto", marginLeft: 4 }} value={cfrom} max={cto || todayStr()} onChange={(e) => setCfrom(e.target.value)} /></label>
          <label style={{ fontSize: 12, color: "#6B7E74" }}>To <input type="date" className="input" style={{ width: "auto", marginLeft: 4 }} value={cto} max={todayStr()} onChange={(e) => setCto(e.target.value)} /></label>
        </div>
      )}

      {/* ---- KPI row (first four follow the date range; last four are "as of now") ---- */}
      <div style={S.cards}>
        <Card label="Revenue" value={formatINR(sum.revenue)} sub={sum.bills + " bills"} />
        <Card label="Trading profit" value={formatINR(sum.profit)} sub={`${sum.margin}% margin`} accent />
        <Card label="Margin" value={sum.margin + "%"} sub="profit ÷ revenue" />
        <Card label="Avg ticket" value={formatINR(sum.avgTicket)} sub="per bill" />
        <Card label="Udhari outstanding" value={formatINR(udhariNow)} sub="unpaid credit · now" />
        <Card label="Inventory at cost" value={formatINR(inv.cost)} sub={`${inv.count} items · now`} />
        <Card label="Out of stock" value={inv.outOfStock} sub="items at zero · now" />
        <Card label="Break-even" value={beCard.value} sub={beCard.sub} />
      </div>

      {pSales.length === 0 ? (
        <section style={{ ...S.panel, marginTop: 16 }}><Empty text="No sales in this period — pick a wider range to see the charts." /></section>
      ) : (
        <>
          <div style={sectionHead}>Revenue over time</div>
          <ChartCard title="Daily revenue & 7-day average" height={260}>
            <LineChart data={daily} margin={{ top: 12, right: 10, left: -6, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
              <XAxis dataKey="label" tick={{ fontSize: 10.5, fill: "#678" }} interval="preserveStartEnd" minTickGap={26} />
              <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrCompact} width={48} />
              <Tooltip formatter={(v, n) => [formatINR(v), n]} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="revenue" name="Daily revenue" stroke="#9BC0AC" strokeWidth={1.5} dot={false} label={exactLabel} />
              <Line type="monotone" dataKey="ma7" name="7-day average" stroke="#1B5E43" strokeWidth={2.5} dot={false} />
            </LineChart>
          </ChartCard>

          <div style={{ marginTop: 16 }}>
            <ChartCard title="Monthly revenue & profit" height={250}>
              <ComposedChart data={monthly} margin={{ top: 16, right: 10, left: -6, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#678" }} />
                <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrCompact} width={48} />
                <Tooltip formatter={(v, n) => [formatINR(v), n]} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="revenue" name="Revenue" fill="#1B5E43" radius={[3, 3, 0, 0]} maxBarSize={54} label={exactLabel} />
                <Line type="monotone" dataKey="profit" name="Profit" stroke="#E8A33D" strokeWidth={2.5} dot={{ r: 2.5, fill: "#E8A33D" }} label={exactLabelGold} />
              </ComposedChart>
            </ChartCard>
          </div>

          <div style={sectionHead}>When customers shop</div>
          <section style={S.panel}>
            <div style={S.panelHead}>Sales heatmap — weekday × time of day</div>
            <Heatmap data={heat} />
          </section>

          <div style={sectionHead}>Products & payment</div>
          <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 16 }}>
            <section style={S.panel}>
              <div style={{ ...S.panelHead, flexWrap: "wrap", gap: 6 }}>
                Top 15 items
                <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  {["revenue", "qty", "profit"].map((m) => (
                    <button key={m} className={"btn small " + (metric === m ? "primary" : "ghost")} onClick={() => setMetric(m)}>{metricLabel[m]}</button>
                  ))}
                </div>
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "#6B7E74", marginBottom: 8, cursor: "pointer" }}>
                <input type="checkbox" checked={includeMisc} onChange={(e) => setIncludeMisc(e.target.checked)} />
                Include Misc / consolidated rows (they distort real top-sellers)
              </label>
              {topProducts.length === 0 ? (
                <Empty text="No individual items sold in this period." />
              ) : (
                <div style={{ width: "100%", height: Math.max(220, topProducts.length * 26 + 24) }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={topProducts} layout="vertical" margin={{ top: 4, right: 54, left: 8, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" horizontal={false} />
                      <XAxis type="number" tick={{ fontSize: 10.5, fill: "#678" }} tickFormatter={metric === "qty" ? undefined : inrCompact} />
                      <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: "#465" }} width={116} interval={0} />
                      <Tooltip formatter={(v) => (metric === "qty" ? v : formatINR(v))} />
                      <Bar dataKey={metric} name={metricLabel[metric]} fill="#3DA17A" radius={[0, 3, 3, 0]} label={metric === "qty" ? qtyLabelRight : compactLabelRight} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </section>

            <section style={S.panel}>
              <div style={S.panelHead}>How customers pay</div>
              {pay.rows.length === 0 ? (
                <Empty text="No sales to split." />
              ) : (
                <>
                  <div style={{ position: "relative", width: "100%", height: 190 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={pay.rows} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={52} outerRadius={80} paddingAngle={2} stroke="none">
                          {pay.rows.map((r) => <Cell key={r.name} fill={PAY_COLORS[r.name] || "#8A9C90"} />)}
                        </Pie>
                        <Tooltip formatter={(v, n) => [formatINR(v), n]} />
                      </PieChart>
                    </ResponsiveContainer>
                    {/* Center total — a positioned overlay renders reliably across Recharts versions. */}
                    <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", pointerEvents: "none" }}>
                      <div style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 11, color: "#8A9C90" }}>Total</div>
                        <div style={{ fontSize: 15, fontWeight: 800, color: "#10331F" }}>{inrCompact(pay.total)}</div>
                      </div>
                    </div>
                  </div>
                  <div>
                    {pay.rows.map((r) => (
                      <div key={r.name} style={S.row}>
                        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ width: 10, height: 10, borderRadius: 3, background: PAY_COLORS[r.name] || "#8A9C90" }} />{r.name}
                        </span>
                        <b>{formatINR(r.value)} <span style={{ color: "#8A9C90", fontWeight: 500 }}>· {r.pct}%</span></b>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </section>
          </div>

          <div style={sectionHead}>Credit & recovery</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <ChartCard title="Udhari outstanding over time">
              <AreaChart data={udhariSeries} margin={{ top: 8, right: 10, left: -6, bottom: 0 }}>
                <defs>
                  <linearGradient id="gUdhari" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#E8A33D" stopOpacity={0.4} /><stop offset="100%" stopColor="#E8A33D" stopOpacity={0.04} /></linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
                <XAxis dataKey="label" tick={{ fontSize: 10.5, fill: "#678" }} interval="preserveStartEnd" minTickGap={26} />
                <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrCompact} width={48} />
                <Tooltip formatter={(v) => [formatINR(v), "Outstanding"]} />
                <Area type="monotone" dataKey="outstanding" name="Outstanding" stroke="#B0762A" strokeWidth={2} fill="url(#gUdhari)" />
              </AreaChart>
            </ChartCard>

            <ChartCard title="Break-even — profit vs capital (all-time)">
              {be.series.length === 0 ? (
                <div style={{ display: "grid", placeItems: "center", height: "100%" }}><Empty text="No sales yet to track break-even." /></div>
              ) : (
                <ComposedChart data={be.series} margin={{ top: 16, right: 12, left: -6, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gBreak" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#1B5E43" stopOpacity={0.35} /><stop offset="100%" stopColor="#1B5E43" stopOpacity={0.03} /></linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
                  <XAxis dataKey="label" tick={{ fontSize: 10.5, fill: "#678" }} interval="preserveStartEnd" minTickGap={26} />
                  <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrCompact} width={48} />
                  <Tooltip formatter={(v) => [formatINR(v), "Cumulative profit"]} />
                  <Area type="monotone" dataKey="cumProfit" name="Cumulative profit" stroke="#1B5E43" strokeWidth={2} fill="url(#gBreak)" />
                  {be.capex > 0 && <ReferenceLine y={be.capex} stroke="#C44536" strokeDasharray="5 4" label={{ value: `Capital ${inrCompact(be.capex)}`, position: "insideTopRight", fontSize: 10, fill: "#C44536" }} />}
                </ComposedChart>
              )}
            </ChartCard>
          </div>
          <div style={{ fontSize: 12, color: "#6B7E74", marginTop: 8 }}>
            <b>Capital / Setup Cost</b> (one-time): {formatINR(be.capex)} — this is investment, never subtracted from trading profit.
            {est.status === "reached" && <> You’ve recovered it (took {est.days} day(s)).</>}
            {est.status === "projected" && <> At about {formatINR(est.perDay)}/day of profit, roughly {est.daysLeft} day(s) to go.</>}
          </div>

          <div style={sectionHead}>
            Capital / setup spending
            {preset === "allTime" && <span style={{ fontWeight: 500, color: "#8A9C90" }}> · since {new Date(CAPEX_START + "T00:00").toLocaleDateString("en-IN", { month: "short", year: "numeric" })}</span>}
          </div>
          {pExp.length === 0 ? (
            <section style={S.panel}><Empty text="No capital / setup spending recorded in this period." /></section>
          ) : (
            <>
              <div style={{ fontSize: 12.5, color: "#3A5547", marginBottom: 8 }}>
                One-time setup / capital of <b>{formatINR(expSum)}</b> across {pExp.length} {pExp.length === 1 ? "entry" : "entries"} — investment, not an operating cost, so it never reduces trading profit.
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 16 }}>
                <ChartCard title="Capital deployed by month">
                  <BarChart data={expMonthly} margin={{ top: 16, right: 10, left: -6, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#678" }} />
                    <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrCompact} width={48} />
                    <Tooltip formatter={(v) => [formatINR(v), "Spent"]} />
                    <Bar dataKey="amount" name="Spent" fill="#C44536" radius={[3, 3, 0, 0]} maxBarSize={56} label={compactLabel} />
                  </BarChart>
                </ChartCard>
                <section style={S.panel}>
                  <div style={S.panelHead}>Where it went</div>
                  <div style={{ width: "100%", height: Math.max(200, expBreak.rows.length * 26 + 24) }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={expBreak.rows} layout="vertical" margin={{ top: 4, right: 54, left: 8, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" horizontal={false} />
                        <XAxis type="number" tick={{ fontSize: 10.5, fill: "#678" }} tickFormatter={inrCompact} />
                        <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: "#465" }} width={112} interval={0} />
                        <Tooltip formatter={(v) => formatINR(v)} />
                        <Bar dataKey="value" name="Spent" fill="#B0762A" radius={[0, 3, 3, 0]} label={compactLabelRight} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </section>
              </div>
            </>
          )}

          <div style={sectionHead}>Inventory</div>
          <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16 }}>
            <section style={S.panel}>
              <div style={{ ...S.panelHead, flexWrap: "wrap", gap: 6 }}>
                Stock value by category
                <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  <button className={"btn small " + (treeMetric === "cost" ? "primary" : "ghost")} onClick={() => setTreeMetric("cost")}>At cost {inrCompact(inv.cost)}</button>
                  <button className={"btn small " + (treeMetric === "retail" ? "primary" : "ghost")} onClick={() => setTreeMetric("retail")}>At retail {inrCompact(inv.retail)}</button>
                </div>
              </div>
              {treeData.length === 0 ? (
                <Empty text="No stock on hand to value." />
              ) : (
                <div style={{ width: "100%", height: 280 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <Treemap data={treeData} dataKey="size" nameKey="name" stroke="#fff" isAnimationActive={false} content={<TreemapTile />} />
                  </ResponsiveContainer>
                </div>
              )}
            </section>
            <section style={S.panel}>
              <div style={S.panelHead}>Slow movers — in stock, no sales this period <span style={{ fontWeight: 500, textTransform: "none", letterSpacing: 0, color: "#8A9C90", marginLeft: 8 }}>{dead.length}</span></div>
              {dead.length === 0 ? (
                <Empty text="Everything in stock sold at least once. 👍" />
              ) : (
                <>
                  {dead.slice(0, 10).map((i) => (
                    <div key={i.name} style={S.row}><span>{i.name} <span style={{ color: "#9AA", fontSize: 11 }}>· {i.stock} {i.unit}</span></span><b>{formatINR(i.value)}</b></div>
                  ))}
                  {dead.length > 10 && <div style={{ fontSize: 11.5, color: "#8A9C90", marginTop: 6 }}>+ {dead.length - 10} more…</div>}
                </>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

// ---------- Udhari / Credit (outstanding by customer) ----------
// Standalone top-level view. Outstanding is tracked across ALL time — a debt isn't
// period-bound — so this reads the full sales list rather than a date-filtered slice.
const billOut = (s) => Math.max(0, money((s.total || 0) - (s.paid || 0)));
// Minutes since midnight from a stored time like "02:15 pm" / "10:05 am (back-dated)"; -1 if unknown.
const timeToMin = (t) => {
  const m = String(t || "").match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (!m) return -1;
  let h = +m[1]; const ap = (m[3] || "").toLowerCase();
  if (ap) { h = h % 12; if (ap === "pm") h += 12; }
  return h * 60 + (+m[2]);
};
// Newest-first comparator for {date,time} records: date descending, then time descending.
const byDateTimeDesc = (a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : timeToMin(b.time) - timeToMin(a.time));

function Udhari({ sales, setSales, notify, log }) {
  const [openCust, setOpenCust] = useState(() => new Set()); // expanded customer names
  const [openBills, setOpenBills] = useState(() => new Set()); // expanded bills (showing order details)
  const [paying, setPaying] = useState(null); // the sale (bill) a repayment is being recorded against
  const [payAmt, setPayAmt] = useState("");
  const [payMode, setPayMode] = useState("Cash");

  const udhari = useMemo(() => {
    const u = sales.filter((s) => s.payment === "Udhari");
    const byCust = {};
    u.forEach((s) => {
      const out = billOut(s);
      const name = (s.customer || "").trim() || "(no name)";
      const c = byCust[name] || (byCust[name] = { name, mobile: "", outstanding: 0, total: 0, bills: 0, billList: [] });
      c.outstanding += out; c.total += (s.total || 0); c.bills += 1;
      c.billList.push(s);
      if (s.mobile) c.mobile = s.mobile;
    });
    const customers = Object.values(byCust).map((c) => ({
      ...c, outstanding: money(c.outstanding), total: money(c.total),
      // Newest bills first (date then time descending).
      billList: [...c.billList].sort(byDateTimeDesc),
    })).sort((a, b) => b.outstanding - a.outstanding);
    return { customers, count: u.length, totalOutstanding: money(u.reduce((a, s) => a + billOut(s), 0)), withDue: customers.filter((c) => c.outstanding > 0) };
  }, [sales]);

  // A chronological ledger of every udhari event: credit given (bill date) and each repayment
  // (from the payments ledger; legacy/uncaptured paid amounts reconcile to the bill date).
  const history = useMemo(() => {
    const events = [];
    sales.filter((s) => s.payment === "Udhari").forEach((s) => {
      const who = (s.customer || "").trim() || "(no name)";
      events.push({ id: s.id + "-c", date: s.date, time: s.time || "", kind: "credit", who, amount: money(s.total || 0) });
      const ledger = Array.isArray(s.payments) ? s.payments : [];
      let ledgerSum = 0;
      ledger.forEach((p, i) => {
        const amt = money(p.amount || 0);
        ledgerSum += amt;
        events.push({ id: `${s.id}-p${p.id || i}`, date: p.date || s.date, time: p.time || "", kind: "paid", who, amount: amt, mode: p.mode || "—" });
      });
      const rem = money((s.paid || 0) - ledgerSum);
      if (rem > 0.005) events.push({ id: s.id + "-p0", date: s.date, time: s.time || "", kind: "paid", who, amount: rem, mode: s.paidMode || "—", atStart: true });
    });
    // Strictly newest-first: date descending, then time descending. On an exact tie the
    // repayment (the later action) sorts above the credit.
    events.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      const tm = timeToMin(b.time) - timeToMin(a.time);
      if (tm) return tm;
      return a.kind === b.kind ? 0 : a.kind === "paid" ? -1 : 1;
    });
    const totalCredit = money(events.filter((e) => e.kind === "credit").reduce((a, e) => a + e.amount, 0));
    const totalPaid = money(events.filter((e) => e.kind === "paid").reduce((a, e) => a + e.amount, 0));
    return { events, totalCredit, totalPaid };
  }, [sales]);

  const toggle = (name) => setOpenCust((s) => { const n = new Set(s); n.has(name) ? n.delete(name) : n.add(name); return n; });
  const toggleBill = (id) => setOpenBills((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // A repayment targets EITHER one bill ({type:"bill", id}) or a customer's whole balance
  // ({type:"customer", name}). Customer payments are split across their due bills.
  const openPay = (sale) => { setPaying({ type: "bill", id: sale.id }); setPayAmt(String(billOut(sale))); setPayMode(sale.paidMode || "Cash"); };
  // Pay against a customer's WHOLE outstanding — the lump sum is applied to their due bills
  // oldest-first (FIFO), so it settles the longest-standing debts before the newer ones.
  const openPayCustomer = (c) => { setPaying({ type: "customer", name: c.name }); setPayAmt(String(c.outstanding)); setPayMode("Cash"); };

  // Split a lump sum across bills (already oldest-first), returning [{bill, amount}] per bill touched.
  const allocateFIFO = (bills, amount) => {
    let remaining = money(amount);
    const parts = [];
    for (const b of bills) {
      if (remaining <= 0.005) break;
      const a = Math.min(billOut(b), remaining);
      if (a > 0.005) { parts.push({ bill: b, amount: money(a) }); remaining = money(remaining - a); }
    }
    return parts;
  };

  // Figures for whatever is being paid, read live from `sales` so the modal stays correct
  // even if the underlying records changed (e.g. edited elsewhere while it's open).
  const payingBill = paying?.type === "bill" ? sales.find((s) => s.id === paying.id) : null;
  // The customer's still-due bills, oldest-first for FIFO allocation.
  const payingCustBills = paying?.type === "customer"
    ? sales.filter((s) => s.payment === "Udhari" && ((((s.customer || "").trim() || "(no name)") === paying.name)) && billOut(s) > 0).sort((a, b) => byDateTimeDesc(b, a))
    : null;
  const payOut = paying?.type === "bill"
    ? (payingBill ? billOut(payingBill) : 0)
    : (paying?.type === "customer" ? money((payingCustBills || []).reduce((a, s) => a + billOut(s), 0)) : 0);
  const payWho = paying?.type === "bill" ? ((payingBill?.customer || "").trim() || "(no name)") : (paying?.name || "");
  const payAmtNum = Math.min(payOut, Math.max(0, money(+payAmt || 0)));
  const payRemaining = money(payOut - payAmtNum);
  // How a customer lump sum lands across their bills — preview and save use the same split.
  const payAlloc = paying?.type === "customer" ? allocateFIFO(payingCustBills || [], payAmtNum) : null;
  const payClears = payAlloc ? payAlloc.filter((p) => p.amount >= billOut(p.bill) - 0.005).length : 0;
  // Something concrete to pay against (a live bill, or a customer with ≥1 due bill).
  const payShow = !!paying && !!(payingBill || (payingCustBills && payingCustBills.length));

  const savePayment = () => {
    if (!paying) return setPaying(null);
    if (payAmtNum <= 0) return notify("Enter an amount greater than ₹0");
    const nowTime = new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
    if (paying.type === "bill") {
      if (!payingBill) return setPaying(null);
      const newPaid = money((payingBill.paid || 0) + payAmtNum);
      const rem = money((payingBill.total || 0) - newPaid);
      // Single setSales → Sales History, dashboard and cloud sync all pick up the new paid/outstanding.
      // Also append a dated entry to the payments ledger so the History panel can show when it was paid.
      setSales((all) => all.map((x) => {
        if (x.id !== payingBill.id) return x;
        const payments = [...(x.payments || []), { id: uid(), date: todayStr(), time: nowTime, amount: payAmtNum, mode: payMode }];
        return { ...x, paid: newPaid, paidMode: payMode, payments };
      }));
      log("sale", `Udhari repayment ${INR(payAmtNum)} (${payMode}) from ${payWho}${rem > 0 ? ` — ${INR(rem)} still due` : " — bill cleared"}`);
      notify(`Recorded ${INR(payAmtNum)} (${payMode})${rem > 0 ? ` · ${INR(rem)} still due` : " · bill cleared 🎉"}`);
    } else {
      // Customer-level: apply the lump sum across their due bills oldest-first, stamping a dated
      // ledger entry on each bill it touches. One setSales updates every affected bill at once.
      const alloc = payAlloc || [];
      if (!alloc.length) return setPaying(null);
      const byId = {};
      alloc.forEach((p) => { byId[p.bill.id] = p.amount; });
      setSales((all) => all.map((x) => {
        const amt = byId[x.id];
        if (amt == null) return x;
        const payments = [...(x.payments || []), { id: uid(), date: todayStr(), time: nowTime, amount: amt, mode: payMode }];
        return { ...x, paid: money((x.paid || 0) + amt), paidMode: payMode, payments };
      }));
      const rem = money(payOut - payAmtNum);
      const nb = alloc.length;
      log("sale", `Udhari repayment ${INR(payAmtNum)} (${payMode}) from ${payWho} across ${nb} bill${nb === 1 ? "" : "s"}${rem > 0 ? ` — ${INR(rem)} still due` : " — all cleared"}`);
      notify(`Recorded ${INR(payAmtNum)} (${payMode}) across ${nb} bill${nb === 1 ? "" : "s"}${rem > 0 ? ` · ${INR(rem)} still due` : " · all cleared 🎉"}`);
    }
    setPaying(null);
  };

  return (
    <div>
      <Header title="Udhari / Credit" sub="Outstanding credit by customer, across all time." />
      <div style={S.cards}>
        <Card label="Outstanding credit" value={INR(udhari.totalOutstanding)} sub={udhari.withDue.length + " customer(s) owe"} accent />
        <Card label="Udhari bills" value={udhari.count} sub="total credit bills" />
        <Card label="Top debtor" value={udhari.withDue[0] ? udhari.withDue[0].name : "—"} sub={udhari.withDue[0] ? INR(udhari.withDue[0].outstanding) : "—"} />
      </div>
      <section style={{ ...S.panel, marginBottom: 4 }}>
        <div style={S.panelHead}>Who owes you <span style={{ fontWeight: 500, textTransform: "none", letterSpacing: 0, color: "#8A9C90", marginLeft: 8 }}>{udhari.withDue.length}</span></div>
        {udhari.withDue.length === 0 ? (
          <Empty text="No outstanding credit — all udhari settled. 🎉" />
        ) : (
          <table className="tbl">
            <thead><tr><th style={{ width: 18 }}></th><th>Customer</th><th>Mobile</th><th style={{ textAlign: "right" }}>Bills</th><th style={{ textAlign: "right" }}>Outstanding</th><th></th></tr></thead>
            <tbody>
              {udhari.withDue.map((c) => {
                const isOpen = openCust.has(c.name);
                const dueBills = c.billList.filter((b) => billOut(b) > 0);
                // One bill → pay it directly; several → pay the whole balance in one go (split
                // oldest-first). Either way the row itself still expands to pay a single bill.
                const payRow = () => (dueBills.length === 1 ? openPay(dueBills[0]) : openPayCustomer(c));
                return (
                  <Fragment key={c.name}>
                    <tr onClick={() => toggle(c.name)} style={{ cursor: "pointer" }}>
                      <td style={{ color: "#8A9C90" }}>{isOpen ? "▾" : "▸"}</td>
                      <td style={{ fontWeight: 600 }}>{c.name}</td>
                      <td style={{ color: "#677" }}>{c.mobile || "—"}</td>
                      <td style={{ textAlign: "right" }}>{c.bills}</td>
                      <td style={{ textAlign: "right", fontWeight: 700, color: "#C44536" }}>{INR(c.outstanding)}</td>
                      <td style={{ textAlign: "right" }}>
                        <button className="btn small primary" onClick={(e) => { e.stopPropagation(); payRow(); }}>
                          {dueBills.length === 1 ? "Pay" : "Pay total"}
                        </button>
                      </td>
                    </tr>
                    {isOpen && dueBills.map((b) => {
                      const billOpen = openBills.has(b.id);
                      const nLines = (b.lines || []).length;
                      return (
                        <Fragment key={b.id}>
                          <tr onClick={() => toggleBill(b.id)} style={{ background: "#FAFBF8", cursor: "pointer" }}>
                            <td></td>
                            <td colSpan={3} style={{ fontSize: 12.5, color: "#566" }}>
                              <span style={{ color: "#8A9C90", marginRight: 4 }}>{billOpen ? "▾" : "▸"}</span>
                              {b.date}{b.time ? " · " + b.time : ""} · {nLines} item{nLines === 1 ? "" : "s"} · bill {INR(b.total)}{(b.paid || 0) > 0 ? ` · paid ${INR(b.paid)}${b.paidMode ? " (" + b.paidMode + ")" : ""}` : ""}
                            </td>
                            <td style={{ textAlign: "right", fontWeight: 700, color: "#C44536" }}>{INR(billOut(b))}</td>
                            <td style={{ textAlign: "right" }}>
                              <button className="btn small" onClick={(e) => { e.stopPropagation(); openPay(b); }}>Pay</button>
                            </td>
                          </tr>
                          {billOpen && (
                            <tr style={{ background: "#FAFBF8" }}>
                              <td></td>
                              <td colSpan={5} style={{ paddingTop: 0 }}>
                                <div style={{ background: "#fff", border: "1px solid #EEF3EE", borderRadius: 8, padding: "8px 12px" }}>
                                  {nLines === 0 ? (
                                    <div style={{ fontSize: 12.5, color: "#8A9C90" }}>No line items on this bill.</div>
                                  ) : (b.lines).map((l, i) => (
                                    <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "3px 0" }}>
                                      <span>{l.name} × {l.qty}</span><span>{INR(l.amount)}</span>
                                    </div>
                                  ))}
                                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, fontWeight: 700, borderTop: "1px dashed #DDE8DE", marginTop: 4, paddingTop: 4 }}>
                                    <span>Total</span><span>{INR(b.total)}</span>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
        <div style={{ fontSize: 11.5, color: "#8A9C90", marginTop: 8 }}>“Pay total” settles a customer's whole balance in one go (oldest bills first). Or tap a customer to expand and pay a single bill — full or part, Cash / UPI. Sales History updates automatically.</div>
      </section>

      <section style={{ ...S.panel, marginTop: 16 }}>
        <div style={S.panelHead}>
          History
          <span style={{ fontWeight: 500, textTransform: "none", letterSpacing: 0, color: "#8A9C90", marginLeft: 8 }}>{history.events.length} event{history.events.length === 1 ? "" : "s"}</span>
          <span style={{ marginLeft: "auto", fontWeight: 500, fontSize: 12, color: "#8A9C90", textTransform: "none", letterSpacing: 0 }}>
            Credit given <b style={{ color: "#C44536" }}>{INR(history.totalCredit)}</b> · Repaid <b style={{ color: "#1B5E43" }}>{INR(history.totalPaid)}</b>
          </span>
        </div>
        {history.events.length === 0 ? (
          <Empty text="No udhari/credit activity yet." />
        ) : (
          <table className="tbl">
            <thead><tr><th>Date &amp; time</th><th>Customer</th><th>Type</th><th style={{ textAlign: "right" }}>Amount</th><th>Mode</th></tr></thead>
            <tbody>
              {history.events.slice(0, 150).map((e) => (
                <tr key={e.id}>
                  <td style={{ whiteSpace: "nowrap", color: "#677" }}>{e.date}{e.time ? <span style={{ color: "#9AA" }}> {e.time}</span> : null}</td>
                  <td style={{ fontWeight: 600 }}>{e.who}</td>
                  <td>
                    {e.kind === "credit"
                      ? <span style={{ fontSize: 10.5, fontWeight: 800, color: "#C44536", border: "1px solid #C44536", borderRadius: 6, padding: "1px 6px" }}>CREDIT</span>
                      : <span style={{ fontSize: 10.5, fontWeight: 800, color: "#1B5E43", border: "1px solid #1B5E43", borderRadius: 6, padding: "1px 6px" }}>PAID</span>}
                  </td>
                  <td style={{ textAlign: "right", fontWeight: 700, color: e.kind === "credit" ? "#C44536" : "#1B5E43" }}>{e.kind === "credit" ? INR(e.amount) : "− " + INR(e.amount)}</td>
                  <td style={{ color: "#677", fontSize: 12 }}>{e.kind === "paid" ? (e.mode || "—") + (e.atStart ? " · at billing" : "") : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {history.events.length > 150 && <div style={{ fontSize: 11.5, color: "#8A9C90", marginTop: 8 }}>Showing the most recent 150 of {history.events.length} events.</div>}
      </section>

      {payShow && (
        // Close only when the press STARTS on the backdrop itself. Using onClick here would
        // also fire when a drag/tap that began inside the input releases over the backdrop,
        // closing the modal mid-payment.
        <div style={S.overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) setPaying(null); }}>
          <div style={S.modal}>
            <h2 style={{ fontSize: 17, margin: "0 0 4px" }}>{paying.type === "customer" ? "Pay total" : "Pay"}</h2>
            <div style={{ fontSize: 13, color: "#566", marginBottom: 14 }}>
              {paying.type === "customer" ? (
                <>
                  <b>{payWho}</b> · {payingCustBills.length} unpaid bill{payingCustBills.length === 1 ? "" : "s"} · <span style={{ color: "#C44536", fontWeight: 600 }}>outstanding {INR(payOut)}</span>
                </>
              ) : (
                <>
                  <b>{payWho}</b> · {payingBill.date} · bill {INR(payingBill.total)}
                  {(payingBill.paid || 0) > 0 ? ` · already paid ${INR(payingBill.paid)}` : ""} · <span style={{ color: "#C44536", fontWeight: 600 }}>outstanding {INR(payOut)}</span>
                </>
              )}
            </div>
            <Field label="Amount received">
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input className="input" style={{ flex: 1 }} type="number" min="0" step="0.01" max={payOut} value={payAmt} onChange={(e) => setPayAmt(e.target.value)} autoFocus aria-label="Amount received" />
                <button className="btn small ghost" onClick={() => setPayAmt(String(payOut))}>Full</button>
              </div>
            </Field>
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 12 }}>
              <span style={{ fontSize: 12, color: "#6B7E74", fontWeight: 600 }}>Paid via</span>
              {["Cash", "UPI"].map((m) => (
                <button key={m} className={"btn small " + (payMode === m ? "primary" : "ghost")} onClick={() => setPayMode(m)}>{m}</button>
              ))}
            </div>
            <div style={{ fontSize: 13, textAlign: "right", marginBottom: paying.type === "customer" && payAmtNum > 0 ? 4 : 14, fontWeight: 600 }}>
              Paying {INR(payAmtNum)} ({payMode})
              {payRemaining > 0
                ? <span style={{ color: "#C44536" }}> · remaining {INR(payRemaining)}</span>
                : <span style={{ color: "#1B5E43" }}> · {paying.type === "customer" ? "clears all bills 🎉" : "clears this bill 🎉"}</span>}
            </div>
            {paying.type === "customer" && payAmtNum > 0 && (
              <div style={{ fontSize: 11.5, color: "#8A9C90", textAlign: "right", marginBottom: 14 }}>
                Applied oldest bills first{payClears > 0 ? ` · clears ${payClears} bill${payClears === 1 ? "" : "s"}` : ""}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn ghost" onClick={() => setPaying(null)}>Cancel</button>
              <button className="btn primary" onClick={savePayment} disabled={payAmtNum <= 0}>Pay</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Vendor Bills (purchase bills with proof, isolated from other data) ----------
const BILL_CATEGORIES = ["Stock purchase", "Rent", "Utilities", "Salary", "Transport", "Maintenance", "Packaging", "Taxes/Fees", "Other"];
const BILL_STATUS = ["unpaid", "partial", "paid"];
const STATUS_COLORS = { paid: "#1B5E43", partial: "#B0762A", unpaid: "#C44536" };
const isImageType = (t, name) => /^image\//i.test(t || "") || /\.(jpe?g|png|webp|gif|bmp|heic)$/i.test(name || "");
const outstandingOf = (b) => (b.status === "paid" ? 0 : b.status === "partial" ? Math.max(0, (+b.amount || 0) - (+b.paidAmount || 0)) : (+b.amount || 0));

function VendorBills({ bills, setBills, setDailyBills, online, notify, log }) {
  const blank = { vendor: "", date: todayStr(), amount: "", category: BILL_CATEGORIES[0], status: "unpaid", paidAmount: "", dueDate: "" };
  const [form, setForm] = useState(blank);
  const [editId, setEditId] = useState(null);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const fileRef = useRef(null);
  // filters
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [vq, setVq] = useState("");
  const [statusF, setStatusF] = useState("all");
  const [catF, setCatF] = useState("All");

  const resetForm = () => { setForm(blank); setEditId(null); setFile(null); if (fileRef.current) fileRef.current.value = ""; };

  const onFile = (e) => {
    const f = e.target.files?.[0] || null;
    if (f && f.size > MAX_PROOF_BYTES) { notify("Proof file is too large (max 10 MB)."); e.target.value = ""; return; }
    setFile(f);
  };

  const save = async () => {
    if (busy) return;
    if (!form.vendor.trim()) return notify("Vendor name is required.");
    if (!(+form.amount > 0)) return notify("Enter a bill amount greater than 0.");
    setBusy(true); setErr("");
    try {
      const id = editId || uid();
      let proof = null;
      if (file) proof = await uploadBillProof(id, file); // throws → caught below
      const base = {
        vendor: form.vendor.trim(), date: form.date || todayStr(), amount: money(+form.amount),
        category: form.category, status: form.status,
        paidAmount: form.status === "partial" ? money(+form.paidAmount || 0) : form.status === "paid" ? money(+form.amount) : 0,
        dueDate: form.status === "paid" ? "" : (form.dueDate || ""),
      };
      if (editId) {
        setBills((list) => list.map((b) => (b.id === editId ? { ...b, ...base, ...(proof || {}), updatedAt: todayStr() } : b)));
        log("bill", `Edited vendor bill — ${base.vendor} · ${INR(base.amount)}`);
        notify("Bill updated");
      } else {
        setBills((list) => [...list, { id, ...base, ...(proof || {}), createdAt: todayStr() }]);
        log("bill", `Added vendor bill — ${base.vendor} · ${INR(base.amount)}` + (proof ? " (with proof)" : ""));
        notify("Bill saved");
      }
      resetForm();
    } catch (e) {
      console.error("bill save failed", e);
      const code = e?.code || e?.message || "unknown";
      setErr(`Upload failed (${code}). The bill was NOT saved. ` + (
        code.includes("unauthorized") || code.includes("unauthenticated") ? "Firebase Storage rules are blocking it — publish the rule from the Storage → Rules page."
          : code.includes("object-not-found") || code.includes("bucket") || code.includes("unknown") ? "Firebase Storage isn't set up for this project — open Storage in the console and click ‘Get started’ to create the bucket."
            : code.includes("retry-limit") || code.includes("network") ? "Network/CORS problem — check the connection and retry."
              : "Open the browser console for details."
      ));
      notify("⚠ Proof upload failed — see the message in the form.");
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (b) => {
    // Legacy guard: the grocery core had a separate Daily-Need Bills section that mirrored into
    // this slice, and those records must not be edited from here. Salon Manager doesn't ship
    // that section, so this only ever fires for data carried in from a grocery-era backup.
    if (b.source === "daily-need") {
      notify("This bill was synced from Daily-Need Bills and can't be edited here.");
      return;
    }
    setEditId(b.id);
    setForm({ vendor: b.vendor || "", date: b.date || todayStr(), amount: String(b.amount ?? ""), category: b.category || BILL_CATEGORIES[0], status: b.status || "unpaid", paidAmount: String(b.paidAmount ?? ""), dueDate: b.dueDate || "" });
    setFile(null); if (fileRef.current) fileRef.current.value = "";
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const del = async (b) => {
    const synced = b.source === "daily-need";
    const msg = synced
      ? `Delete “${b.vendor}” (${INR(b.amount)})? This also removes it from Daily-Need Bills.`
      : `Delete bill from “${b.vendor}” (${INR(b.amount)})? Its proof file will also be removed.`;
    if (!confirm(msg)) return;
    await deleteBillProof(b.filePath);
    setBills((list) => list.filter((x) => x.id !== b.id));
    // Delete-from-either-side: drop the matching daily record too (linked by shared id).
    if (synced) setDailyBills?.((list) => list.filter((x) => x.id !== b.id));
    if (editId === b.id) resetForm();
    log("bill", `Deleted ${synced ? "daily-need" : "vendor"} bill — ${b.vendor} · ${INR(b.amount)}`);
    notify("Bill deleted");
  };

  const filtered = useMemo(() => bills.filter((b) =>
    (!from || b.date >= from) && (!to || b.date <= to) &&
    (!vq.trim() || (b.vendor || "").toLowerCase().includes(vq.trim().toLowerCase())) &&
    (statusF === "all" || (b.status || "unpaid") === statusF) &&
    (catF === "All" || b.category === catF)
  ), [bills, from, to, vq, statusF, catF]);
  const sorted = useMemo(() => [...filtered].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)), [filtered]);

  const totalSpend = money(filtered.reduce((a, b) => a + (+b.amount || 0), 0));
  const outstanding = money(filtered.reduce((a, b) => a + outstandingOf(b), 0));

  const monthly = useMemo(() => {
    const m = {};
    filtered.forEach((b) => { const k = (b.date || "").slice(0, 7); if (k) m[k] = (m[k] || 0) + (+b.amount || 0); });
    return Object.entries(m).sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => ({ label: new Date(k + "-01T00:00").toLocaleDateString("en-IN", { month: "short", year: "2-digit" }), amount: money(v) }));
  }, [filtered]);
  const topVendors = useMemo(() => {
    const m = {};
    filtered.forEach((b) => { const v = b.vendor || "—"; m[v] = (m[v] || 0) + (+b.amount || 0); });
    return Object.entries(m).map(([name, value]) => ({ name, value: money(value) })).sort((a, b) => b.value - a.value).slice(0, 8);
  }, [filtered]);
  const byCategory = useMemo(() => {
    const m = {};
    filtered.forEach((b) => { const c = b.category || "Other"; m[c] = (m[c] || 0) + (+b.amount || 0); });
    return Object.entries(m).map(([name, value]) => ({ name, value: money(value) })).sort((a, b) => b.value - a.value);
  }, [filtered]);
  const topVendorName = topVendors[0]?.name;

  const setMonth = (mv) => { if (!mv) { setFrom(""); setTo(""); return; } setFrom(mv + "-01"); const d = new Date(+mv.slice(0, 4), +mv.slice(5, 7), 0); setTo(dateStr(d)); };
  const fmtDate = (d) => (d ? new Date(d + "T00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—");

  return (
    <div>
      <Header title="Vendor Bills" sub="Record purchase bills with proof — separate from sales, inventory & finance">
        {!online && <span style={{ fontSize: 11.5, color: "#C9803A" }}>Offline — proof upload needs internet</span>}
      </Header>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", gap: 16, alignItems: "start" }}>
        {/* add / edit form */}
        <section style={S.panel}>
          <div style={S.panelHead}>{editId ? "Edit bill" : "New bill"}</div>
          <Field label="Vendor name"><input className="input" value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} placeholder="e.g. Sharma Wholesale" /></Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Bill date"><input className="input" type="date" max={todayStr()} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
            <Field label="Amount (₹)"><input className="input" type="number" min="0" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field>
            <Field label="Category">
              <select className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                {BILL_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="Payment status">
              <select className="input" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                {BILL_STATUS.map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
              </select>
            </Field>
            {form.status === "partial" && <Field label="Paid so far (₹)"><input className="input" type="number" min="0" step="0.01" value={form.paidAmount} onChange={(e) => setForm({ ...form, paidAmount: e.target.value })} /></Field>}
            {form.status !== "paid" && <Field label="Due date (optional)"><input className="input" type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} /></Field>}
          </div>
          <Field label={editId ? "Replace proof (optional)" : "Bill proof (optional)"}>
            <input ref={fileRef} className="input" type="file" accept={PROOF_ACCEPT} onChange={onFile} />
          </Field>
          {editId && !file && (() => { const cur = bills.find((b) => b.id === editId); return cur?.fileURL ? <div style={{ fontSize: 11.5, color: "#6B7E74", marginTop: -6, marginBottom: 6 }}>Current proof: <a href={cur.fileURL} target="_blank" rel="noopener noreferrer">{cur.fileName || "view"}</a> — choose a file to replace it.</div> : null; })()}
          <div style={{ fontSize: 11, color: "#8A9C90", marginBottom: 10 }}>JPG/PNG/PDF/DOC/XLS… up to 10 MB. Stored securely in the cloud.</div>
          {err && (
            <div style={{ fontSize: 12, color: "#C44536", background: "#FBEDEB", border: "1px solid #E2B6B0", borderRadius: 8, padding: "8px 10px", marginBottom: 10, lineHeight: 1.5 }}>
              {err}
              {file && <div style={{ marginTop: 6 }}><button className="btn small ghost" disabled={busy} onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = ""; setErr(""); notify("Proof removed — you can save the bill without it for now."); }}>Save without proof instead</button></div>}
            </div>
          )}
          <button className="btn primary big" style={{ width: "100%" }} disabled={busy} onClick={save}>{busy ? "Saving…" : editId ? "Save changes" : "Save bill"}</button>
          {editId && <button className="btn ghost" style={{ width: "100%", marginTop: 8 }} disabled={busy} onClick={resetForm}>Cancel edit</button>}
        </section>

        {/* list + filters */}
        <section style={S.panel}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
            <label style={{ fontSize: 12, color: "#6B7E74" }}>From <input type="date" className="input" style={{ width: "auto", marginLeft: 4 }} value={from} max={to || todayStr()} onChange={(e) => setFrom(e.target.value)} /></label>
            <label style={{ fontSize: 12, color: "#6B7E74" }}>To <input type="date" className="input" style={{ width: "auto", marginLeft: 4 }} value={to} max={todayStr()} onChange={(e) => setTo(e.target.value)} /></label>
            <label style={{ fontSize: 12, color: "#6B7E74" }}>Month <input type="month" className="input" style={{ width: "auto", marginLeft: 4 }} max={todayStr().slice(0, 7)} onChange={(e) => setMonth(e.target.value)} /></label>
            <select className="input" style={{ width: "auto" }} value={statusF} onChange={(e) => setStatusF(e.target.value)}>
              <option value="all">All status</option>
              {BILL_STATUS.map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
            </select>
            <select className="input" style={{ width: "auto" }} value={catF} onChange={(e) => setCatF(e.target.value)}>
              <option>All</option>
              {BILL_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
            </select>
            <input className="input" style={{ flex: 1, minWidth: 120 }} placeholder="Search vendor…" value={vq} onChange={(e) => setVq(e.target.value)} />
            {(from || to || vq || statusF !== "all" || catF !== "All") && <button className="btn ghost small" onClick={() => { setFrom(""); setTo(""); setVq(""); setStatusF("all"); setCatF("All"); }}>Clear</button>}
          </div>

          <div style={S.cards}>
            <Card label="Total spend" value={INR(totalSpend)} sub={filtered.length + " bills"} />
            <Card label="Outstanding" value={INR(outstanding)} sub="unpaid + partial" accent />
            <Card label="Top vendor" value={topVendorName || "—"} sub={topVendors[0] ? INR(topVendors[0].value) : "—"} />
          </div>

          {sorted.length === 0 ? (
            <Empty text={bills.length === 0 ? "No bills yet. Add your first vendor bill on the left." : "No bills match these filters."} />
          ) : (
            <table className="tbl" style={{ marginTop: 12 }}>
              <thead><tr><th style={{ width: 96 }}>Date</th><th>Vendor</th><th>Category</th><th style={{ textAlign: "right" }}>Amount</th><th>Status</th><th>Proof</th><th style={{ width: 78 }}></th></tr></thead>
              <tbody>
                {sorted.map((b) => {
                  const out = outstandingOf(b);
                  return (
                    <tr key={b.id}>
                      <td style={{ whiteSpace: "nowrap", color: "#677" }}>{fmtDate(b.date)}</td>
                      <td style={{ fontWeight: 600 }}>
                        {b.vendor}
                        {b.source === "daily-need" && <span title="Synced from Daily-Need Bills" style={{ marginLeft: 6, fontSize: 9.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".03em", color: "#0E7C86", border: "1px solid #9FD3D8", background: "#EAF7F8", borderRadius: 6, padding: "0 5px", whiteSpace: "nowrap" }}>🧺 Daily-Need</span>}
                      </td>
                      <td style={{ color: "#677", fontSize: 12.5 }}>{b.category || "—"}</td>
                      <td style={{ textAlign: "right", fontWeight: 700 }}>{INR(b.amount)}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <span style={{ fontSize: 10.5, fontWeight: 800, textTransform: "uppercase", color: STATUS_COLORS[b.status] || "#789", border: `1px solid ${STATUS_COLORS[b.status] || "#bbb"}`, borderRadius: 6, padding: "0 6px" }}>{b.status || "unpaid"}</span>
                        {out > 0 && <div style={{ fontSize: 10.5, color: "#C44536" }}>{INR(out)} due{b.dueDate ? " · " + fmtDate(b.dueDate) : ""}</div>}
                      </td>
                      <td>
                        {b.fileURL ? (
                          isImageType(b.fileType, b.fileName)
                            ? <a href={b.fileURL} target="_blank" rel="noopener noreferrer" title={b.fileName}><img src={b.fileURL} alt="proof" style={{ width: 36, height: 36, objectFit: "cover", borderRadius: 6, border: "1px solid #E2EAE3" }} /></a>
                            : <a href={b.fileURL} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12 }}>📎 Open</a>
                        ) : <span style={{ color: "#AAB", fontSize: 12 }}>—</span>}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <button className="btn small ghost" aria-label={"Edit " + b.vendor} onClick={() => startEdit(b)}>✎</button>{" "}
                        <button className="btn small danger" aria-label={"Delete " + b.vendor} onClick={() => del(b)}>🗑</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {filtered.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginTop: 16 }}>
          <ChartCard title="Spend by month">
            <BarChart data={monthly} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#678" }} interval="preserveStartEnd" minTickGap={16} />
              <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
              <Tooltip formatter={(v) => INR(v)} />
              <Bar dataKey="amount" name="Spend" fill="#0E7C86" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ChartCard>
          <ChartCard title="Top vendors by spend">
            <BarChart data={topVendors} layout="vertical" margin={{ top: 4, right: 12, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 10.5, fill: "#465" }} width={110} />
              <Tooltip formatter={(v) => INR(v)} />
              <Bar dataKey="value" name="Spend" fill="#2A6FB0" radius={[0, 3, 3, 0]} />
            </BarChart>
          </ChartCard>
          <ChartCard title="Spend by category">
            <BarChart data={byCategory} layout="vertical" margin={{ top: 4, right: 12, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 10.5, fill: "#465" }} width={96} />
              <Tooltip formatter={(v) => INR(v)} />
              <Bar dataKey="value" name="Spend" fill="#3DA17A" radius={[0, 3, 3, 0]} />
            </BarChart>
          </ChartCard>
        </div>
      )}
    </div>
  );
}

// ---------- Add Expense (own page) ----------
function Expenses({ expenses, setExpenses, notify, log }) {
  const [exp, setExp] = useState({ desc: "", amount: "", date: todayStr() });
  const [month, setMonth] = useState(todayStr().slice(0, 7));
  const [showAll, setShowAll] = useState(false);
  const [editing, setEditing] = useState(null); // { id, desc, amount, date } being edited inline
  const listed = showAll ? expenses : expenses.filter((e) => e.date.startsWith(month));
  const sorted = [...listed].sort((a, b) => (a.date < b.date ? 1 : -1));
  const total = money(listed.reduce((a, e) => a + e.amount, 0));
  const monthLabel = new Date(month + "-01T00:00").toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  const addExp = () => {
    if (!exp.desc.trim() || !(+exp.amount > 0)) return notify("Enter a description and a positive amount");
    const date = exp.date || todayStr();
    const row = { id: uid(), date, desc: exp.desc.trim(), amount: +exp.amount };
    setExpenses((list) => [...list, row]);
    log("expense", `Expense ${INR(+exp.amount)} — ${exp.desc.trim()}` + (date !== todayStr() ? ` (dated ${date})` : ""));
    setExp({ desc: "", amount: "", date: todayStr() });
    notify("Expense recorded");
  };

  const del = (e) => {
    if (!confirm(`Delete expense “${e.desc}” (${INR(e.amount)})?`)) return;
    setExpenses((list) => list.filter((x) => x.id !== e.id));
    if (editing?.id === e.id) setEditing(null);
    log("expense", `Deleted expense ${INR(e.amount)} — ${e.desc}`);
    notify("Expense deleted");
  };

  const startEdit = (e) => setEditing({ id: e.id, desc: e.desc, amount: String(e.amount), date: e.date });
  const saveEdit = () => {
    if (!editing.desc.trim() || !(+editing.amount > 0)) return notify("Enter a description and a positive amount");
    const date = editing.date || todayStr();
    const amount = money(+editing.amount);
    setExpenses((list) => list.map((x) => (x.id === editing.id ? { ...x, desc: editing.desc.trim(), amount, date } : x)));
    log("expense", `Edited expense ${INR(amount)} — ${editing.desc.trim()}`);
    setEditing(null);
    notify("Expense updated");
  };

  return (
    <div>
      <Header title="Add Expense" sub="Record shop expenses — rent, electricity, supplies, salaries…">
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ fontSize: 12, color: showAll ? "#9AA" : "#6B7E74" }}>
            Month <input type="month" className="input" style={{ width: "auto", marginLeft: 4 }} value={month} max={todayStr().slice(0, 7)} disabled={showAll} onChange={(e) => setMonth(e.target.value || todayStr().slice(0, 7))} />
          </label>
          <button className={"btn small " + (showAll ? "primary" : "ghost")} onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Showing all" : "Show all"}
          </button>
        </div>
      </Header>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 16 }}>
        <section style={S.panel}>
          <div style={S.panelHead}>New expense</div>
          <Field label="Description"><input className="input" autoFocus value={exp.desc} onChange={(e) => setExp({ ...exp, desc: e.target.value })} placeholder="e.g. Electricity bill" /></Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Amount (₹)"><input className="input" type="number" min="0" step="0.01" value={exp.amount} onChange={(e) => setExp({ ...exp, amount: e.target.value })} /></Field>
            <Field label="Date"><input className="input" type="date" max={todayStr()} value={exp.date} onChange={(e) => setExp({ ...exp, date: e.target.value })} /></Field>
          </div>
          <button className="btn primary big" style={{ width: "100%", marginTop: 8 }} onClick={addExp}>Record expense</button>
        </section>

        <section style={S.panel}>
          <div style={S.panelHead}>
            {showAll ? "All expenses" : monthLabel}
            <span style={{ fontWeight: 500, textTransform: "none", letterSpacing: 0, color: "#8A9C90", marginLeft: 8 }}>{listed.length} {listed.length === 1 ? "entry" : "entries"}</span>
            <span style={{ marginLeft: "auto", fontWeight: 800 }}>{INR(total)}</span>
          </div>
          {sorted.length === 0 ? (
            <Empty text={showAll ? "No expenses recorded yet." : "No expenses recorded in " + monthLabel + "."} />
          ) : (
            <table className="tbl">
              <thead><tr><th style={{ width: 150 }}>Date</th><th>Description</th><th style={{ textAlign: "right", width: 100 }}>Amount</th><th style={{ width: 96 }}></th></tr></thead>
              <tbody>
                {sorted.map((e) => (editing?.id === e.id ? (
                  <tr key={e.id}>
                    <td><input className="input" style={{ padding: "6px 8px" }} type="date" max={todayStr()} value={editing.date} onChange={(ev) => setEditing({ ...editing, date: ev.target.value })} /></td>
                    <td><input className="input" style={{ padding: "6px 8px" }} value={editing.desc} onChange={(ev) => setEditing({ ...editing, desc: ev.target.value })} /></td>
                    <td><input className="input" style={{ padding: "6px 8px", textAlign: "right" }} type="number" min="0" step="0.01" value={editing.amount} onChange={(ev) => setEditing({ ...editing, amount: ev.target.value })} /></td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <button className="btn small primary" aria-label="Save" onClick={saveEdit}>✓</button>{" "}
                      <button className="btn small ghost" aria-label="Cancel" onClick={() => setEditing(null)}>✕</button>
                    </td>
                  </tr>
                ) : (
                  <tr key={e.id}>
                    <td style={{ color: "#677", whiteSpace: "nowrap" }}>{e.date}</td>
                    <td>{e.desc}</td>
                    <td style={{ textAlign: "right", fontWeight: 700 }}>{INR(e.amount)}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <button className="btn small ghost" aria-label={"Edit " + e.desc} onClick={() => startEdit(e)}>✎</button>{" "}
                      <button className="btn small danger" aria-label={"Delete " + e.desc} onClick={() => del(e)}>🗑</button>
                    </td>
                  </tr>
                )))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}

// ---------- Store Settings (configurable shop identity + branding) ----------
// The shop name, tagline, address, phone, logo, payment QR and counter-PC IP that used to be
// hard-coded now live in `config` (synced at shop/config across every device). This screen edits
// a local draft and commits it via setConfig on Save; effectiveStore() layers it over the
// built-in defaults everywhere the identity is shown (sidebar, login card, printed receipt).
function StoreConfig({ config, setConfig, notify, log, user, role }) {
  const toDraft = (c = {}) => ({
    name: c.name || "", tagline: c.tagline || "", address: c.address || "",
    phone: c.phone || "", pcIp: c.pcIp || "", logo: c.logo || "", paymentQr: c.paymentQr || "",
    upiId: c.upiId || "", upiName: c.upiName || "",
  });
  const [draft, setDraft] = useState(() => toDraft(config));
  const [busyKey, setBusyKey] = useState(""); // "logo" | "paymentQr" while an upload is processed
  const savedRef = useRef(JSON.stringify(toDraft(config))); // last-saved snapshot (drives the dirty flag)
  const dirty = JSON.stringify(draft) !== savedRef.current;

  // Adopt an incoming cloud config (edited on another device) — but never clobber unsaved local
  // edits: only reset the draft when it still matches the last snapshot we saved/loaded.
  useEffect(() => {
    setDraft((d) => (JSON.stringify(d) === savedRef.current ? toDraft(config) : d));
    savedRef.current = JSON.stringify(toDraft(config));
  }, [config]);

  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));

  const onImage = async (e, key, maxDim) => {
    const f = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file after a remove
    if (!f) return;
    setBusyKey(key);
    try {
      set(key, await imageFileToDataUrl(f, maxDim));
    } catch (err) {
      console.error("image read failed", err);
      notify("⚠ " + (err.message || "Couldn't read that image"));
    } finally {
      setBusyKey("");
    }
  };

  const save = () => {
    if (draft.pcIp.trim() && !isValidPcIp(draft.pcIp)) {
      return notify("⚠ Enter a valid IP like 192.168.1.50 (or 192.168.1.50:9100), or leave it blank");
    }
    if (draft.upiId.trim() && !isValidUpiId(draft.upiId)) {
      return notify("⚠ Enter a valid UPI ID like mysalon@okhdfcbank, or leave it blank");
    }
    // Spread the existing config first: shop/config is a shared singleton that holds more than
    // this form edits (loyaltyConfig lives here too). Rebuilding it from the draft alone would
    // silently wipe whatever this form doesn't know about.
    const next = {
      ...config,
      name: draft.name.trim(), tagline: draft.tagline.trim(), address: draft.address.trim(),
      phone: draft.phone.trim(), pcIp: draft.pcIp.trim(), logo: draft.logo || "", paymentQr: draft.paymentQr || "",
      upiId: draft.upiId.trim(), upiName: draft.upiName.trim(),
    };
    const snap = toDraft(next);
    savedRef.current = JSON.stringify(snap);
    setDraft(snap);
    setConfig(next);
    log?.("settings", "Updated salon settings");
    notify("✓ Salon settings saved");
  };

  const resetDefaults = () => {
    if (!confirm("Reset the salon's identity settings back to the app defaults? A custom logo and payment QR will be removed.")) return;
    const snap = toDraft({});
    savedRef.current = JSON.stringify(snap);
    setDraft(snap);
    // Blank only the identity fields this form owns; anything else in the singleton (loyalty
    // rules, and whatever a later version adds) is untouched. "Reset settings" must not quietly
    // reset the loyalty scheme the salon's customers have points under.
    setConfig((c) => ({ ...c, ...toDraft({}) }));
    log?.("settings", "Reset salon identity settings to defaults");
    notify("Salon settings reset to defaults");
  };

  const kb = (dataUrl) => (dataUrl ? Math.round(dataUrl.length / 1024) : 0);

  // A logo / QR uploader with live preview, size read-out, and a "use default" reset.
  const ImageField = ({ label, keyName, maxDim, fallback, hint }) => (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "#465", marginBottom: 6 }}>{label}</div>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <img
          src={draft[keyName] || fallback}
          alt={label}
          style={{ width: 64, height: 64, borderRadius: 10, objectFit: "contain", background: "#fff", border: "1px solid #E2EAE3", padding: 3, flexShrink: 0 }}
        />
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <label className="btn small ghost" style={{ cursor: "pointer" }}>
              {busyKey === keyName ? "Processing…" : draft[keyName] ? "Replace…" : "Upload…"}
              <input type="file" accept="image/*" onChange={(e) => onImage(e, keyName, maxDim)} style={{ display: "none" }} disabled={busyKey === keyName} />
            </label>
            {draft[keyName] && (
              <button className="btn small ghost" onClick={() => set(keyName, "")}>Use default</button>
            )}
          </div>
          <div style={{ fontSize: 11.5, color: "#8A9C90", marginTop: 5 }}>
            {draft[keyName] ? `Custom image · ~${kb(draft[keyName])} KB` : "Using the built-in default"}
            {hint ? <> · {hint}</> : null}
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div>
      <Header title="Salon Settings" sub="Salon name, address, logo and other details used across the app and on printed receipts.">
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {dirty && <span style={{ fontSize: 12, color: "#C9803A", fontWeight: 600 }}>Unsaved changes</span>}
          <button className="btn ghost" onClick={resetDefaults}>Reset to defaults</button>
          <button className="btn primary big" onClick={save} disabled={!dirty}>Save settings</button>
        </div>
      </Header>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, alignItems: "start" }}>
        <section style={S.panel}>
          <div style={S.panelHead}>Shop identity</div>
          <Field label="Shop name"><input className="input" value={draft.name} placeholder={STORE.name} onChange={(e) => set("name", e.target.value)} /></Field>
          <Field label="Tagline"><input className="input" value={draft.tagline} placeholder={STORE.tagline} onChange={(e) => set("tagline", e.target.value)} /></Field>
          <Field label="Address"><textarea className="input" rows={3} style={{ resize: "vertical" }} value={draft.address} placeholder={STORE.address} onChange={(e) => set("address", e.target.value)} /></Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Phone"><input className="input" type="tel" value={draft.phone} placeholder="e.g. +91 98765 43210" onChange={(e) => set("phone", e.target.value)} /></Field>
            <Field label="Shop PC IP address">
              <input className="input" value={draft.pcIp} placeholder="e.g. 192.168.1.50" onChange={(e) => set("pcIp", e.target.value)} />
            </Field>
          </div>
          <div style={{ fontSize: 11.5, color: "#8A9C90", marginTop: -2 }}>
            The counter PC's address on the shop's local network — used to reach a local print server / POS on that machine.
            Accepts a plain IPv4, optionally with a port (e.g. <code>192.168.1.50:9100</code>).
          </div>
        </section>

        <section style={S.panel}>
          <div style={S.panelHead}>Branding &amp; receipt</div>
          <ImageField label="Shop logo" keyName="logo" maxDim={240} fallback={LOGO_SRC} hint="shown in the sidebar, on the sign-in card and at the top of receipts" />

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="UPI ID (amount QR)">
              <input className="input" value={draft.upiId} placeholder="e.g. prakashmart@okhdfcbank" onChange={(e) => set("upiId", e.target.value)} />
            </Field>
            <Field label="Payee name (UPI)">
              <input className="input" value={draft.upiName} placeholder={draft.name.trim() || STORE.name} onChange={(e) => set("upiName", e.target.value)} />
            </Field>
          </div>
          <div style={{ fontSize: 11.5, color: "#8A9C90", margin: "-2px 0 14px", lineHeight: 1.5 }}>
            Set your UPI ID and the billing screen &amp; receipt show a QR that <b>already contains the bill amount</b> — the customer scans and pays without typing. Payee name is optional (defaults to the shop name). Leave the UPI ID blank to use the fixed image below instead.
          </div>

          <ImageField label="Payment QR image (fallback)" keyName="paymentQr" maxDim={480} fallback={PAYMENT_QR_SRC} hint="used on receipts only when no UPI ID is set" />
          <div style={{ fontSize: 11.5, color: "#8A9C90", marginTop: 4, lineHeight: 1.5 }}>
            Images are automatically resized and stored with your shop data, so they sync to every signed-in device. Leave a field on “default” to keep the bundled image.
          </div>
        </section>
      </div>

      <section style={{ ...S.panel, marginTop: 16 }}>
        <div style={S.panelHead}>Receipt preview</div>
        <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
          <img src={draft.logo || LOGO_SRC} alt="" style={{ width: 48, height: 48, borderRadius: 10, objectFit: "contain", background: "#fff", border: "1px solid #E2EAE3", padding: 3 }} />
          <div>
            <div style={{ fontWeight: 800, fontSize: 16 }}>{draft.name.trim() || STORE.name}</div>
            <div style={{ fontSize: 12.5, color: "#6B7E74", whiteSpace: "pre-line" }}>{draft.address.trim() || STORE.address}</div>
            {draft.phone.trim() && <div style={{ fontSize: 12.5, color: "#6B7E74" }}>☎ {draft.phone.trim()}</div>}
          </div>
        </div>
      </section>

      {can(role, "users.manage") && <Users user={user} notify={notify} log={log} />}
    </div>
  );
}

// ---------- Customer editor (shared) ----------
// Used by the Customers view and by the billing picker's quick-create, so a customer created
// mid-bill is the same shape as one created deliberately — one form, one validation path.
//
// Phone is the key (shop/customers/<phone>), so it is only editable when creating. Changing it
// later would mean re-keying the record and re-pointing every bill at the new key; the honest
// answer is to create a new customer.
function CustomerForm({ value, onChange, isNew, err }) {
  const set = (k, v) => onChange({ ...value, [k]: v });
  const year = todayStr().slice(0, 4);
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label="Phone">
          {isNew ? (
            <input className="input" type="tel" inputMode="numeric" autoFocus value={value.phone} onChange={(e) => set("phone", e.target.value)} />
          ) : (
            <input className="input" value={formatPhone(value.phone)} disabled title="Phone is the customer's key and can't be changed" />
          )}
        </Field>
        <Field label="Name"><input className="input" autoFocus={!isNew} value={value.name} onChange={(e) => set("name", e.target.value)} /></Field>
        <Field label="Gender">
          <select className="input" value={value.gender || ""} onChange={(e) => set("gender", e.target.value)}>
            <option value="">—</option>
            <option value="F">Female</option>
            <option value="M">Male</option>
            <option value="O">Other</option>
          </select>
        </Field>
        <div />
        <Field label="Birthday">
          <input
            className="input" type="date"
            value={fromDayMonth(value.dob, year)}
            onChange={(e) => set("dob", toDayMonth(e.target.value))}
          />
        </Field>
        <Field label="Anniversary">
          <input
            className="input" type="date"
            value={fromDayMonth(value.anniversary, year)}
            onChange={(e) => set("anniversary", toDayMonth(e.target.value))}
          />
        </Field>
      </div>
      <div style={{ fontSize: 11.5, color: "#8A9C90", marginTop: -4, marginBottom: 8 }}>
        Only the day and month are kept — the year isn't stored, and isn't needed to send a wish.
      </div>
      <Field label="Notes">
        <textarea className="input" rows={2} style={{ resize: "vertical" }} placeholder="e.g. prefers Priya · allergic to ammonia" value={value.notes || ""} onChange={(e) => set("notes", e.target.value)} />
      </Field>
      {err && <div style={{ color: "#B23B2E", fontSize: 12.5, marginTop: 8 }}>{err}</div>}
    </>
  );
}

// Validate a customer form. Phone is only checked on create — an existing record's key is
// already normalised and locked.
function validateCustomer(form, customers, isNew) {
  if (isNew) {
    if (!isValidPhone(form.phone)) return "Enter a valid 10-digit mobile number.";
    const key = normalizePhone(form.phone);
    if ((customers || []).some((c) => c.phone === key)) return "That number is already on the customer list.";
  }
  if (!String(form.name || "").trim()) return "Give the customer a name.";
  if (form.dob && !isValidDayMonth(form.dob)) return "That birthday isn't a real date.";
  if (form.anniversary && !isValidDayMonth(form.anniversary)) return "That anniversary isn't a real date.";
  return null;
}

// Build a saveable customer record from a form.
const makeCustomer = (form, { createdAt = "" } = {}) => {
  const phone = normalizePhone(form.phone);
  return {
    ...blankCustomer(phone, form.createdAt || createdAt),
    ...form,
    id: phone,
    phone,
    name: String(form.name || "").trim(),
    notes: String(form.notes || "").trim(),
  };
};

// ---------- Customers (owner only) ----------
// The customer database, and each customer's profile. A biller can look someone up to bill
// them (the picker) but cannot browse this list — see roles.js: customers.pick vs
// customers.browse. RTDB can't enforce that split, so it's a UI control; the README says so.
function Customers({ customers, sales, services, staff, setCustomers, notify, log }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("recent");
  const [editing, setEditing] = useState(null); // phone | "new"
  const [form, setForm] = useState(blankCustomer());
  const [err, setErr] = useState("");
  const [profile, setProfile] = useState(null); // phone whose profile is open

  const listed = useMemo(() => {
    const query = q.trim().toLowerCase();
    const digits = query.replace(/\D+/g, "");
    const rows = customers.filter((c) =>
      !query ||
      String(c.name || "").toLowerCase().includes(query) ||
      (digits && String(c.phone || "").includes(digits))
    );
    const cmp = {
      recent: (a, b) => String(b.lastVisitAt || "").localeCompare(String(a.lastVisitAt || "")),
      spend: (a, b) => (b.totalSpend || 0) - (a.totalSpend || 0),
      visits: (a, b) => (b.totalVisits || 0) - (a.totalVisits || 0),
      name: (a, b) => String(a.name || "").localeCompare(String(b.name || "")),
    }[sort];
    return [...rows].sort(cmp);
  }, [customers, q, sort]);

  const startNew = () => { setForm(blankCustomer("", todayStr())); setEditing("new"); setErr(""); };
  const startEdit = (c) => { setForm({ ...c }); setEditing(c.phone); setErr(""); };
  const close = () => { setEditing(null); setErr(""); };

  const save = () => {
    const isNew = editing === "new";
    const problem = validateCustomer(form, customers, isNew);
    if (problem) return setErr(problem);
    const rec = makeCustomer(form, { createdAt: todayStr() });
    setCustomers((list) => (isNew ? [...list, rec] : list.map((c) => (c.phone === editing ? { ...c, ...rec } : c))));
    log("settings", `${isNew ? "Added" : "Updated"} customer — ${rec.name} · ${formatPhone(rec.phone)}`);
    notify(`✓ ${rec.name} saved`);
    close();
  };

  // Deleting a customer does NOT touch their bills — the money stays on the books. It only
  // drops the profile, so the bills become walk-ins that still reference a phone nobody has a
  // record for. That's why this asks so explicitly.
  const remove = (c) => {
    const bills = billsForCustomer(sales, c.phone).length;
    const msg = bills
      ? `Delete ${c.name}'s profile? Their ${bills} bill(s) stay on the books and keep counting towards revenue — only the customer record, notes and occasion dates are removed.`
      : `Delete ${c.name}'s profile?`;
    if (!confirm(msg)) return;
    setCustomers((list) => list.filter((x) => x.phone !== c.phone));
    log("settings", `Deleted customer — ${c.name} · ${formatPhone(c.phone)}`);
    notify(`${c.name} removed`);
    if (profile === c.phone) setProfile(null);
  };

  const openProfile = customers.find((c) => c.phone === profile);

  return (
    <div>
      <Header title="Customers" sub={`${customers.length} on the books`}>
        <button className="btn primary big" onClick={startNew}>+ New customer</button>
      </Header>

      <section style={{ ...S.panel, marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <input className="input" style={{ flex: "1 1 220px" }} placeholder="Search by name or phone…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="input" style={{ width: "auto" }} value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="recent">Most recent visit</option>
            <option value="spend">Highest spend</option>
            <option value="visits">Most visits</option>
            <option value="name">Name (A–Z)</option>
          </select>
        </div>
      </section>

      {listed.length === 0 ? (
        <Empty text={customers.length ? "No customers match." : "No customers yet — they're created as you bill them."} />
      ) : (
        <section style={S.panel}>
          <div style={{ overflowX: "auto" }}>
            <table className="tbl" style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th>Name</th><th>Phone</th>
                  <th style={{ textAlign: "right" }}>Visits</th>
                  <th style={{ textAlign: "right" }}>Spend</th>
                  <th>Last visit</th><th />
                </tr>
              </thead>
              <tbody>
                {listed.map((c) => (
                  <tr key={c.phone}>
                    <td>
                      <button
                        onClick={() => setProfile(c.phone)}
                        style={{ background: "none", border: "none", padding: 0, font: "inherit", fontWeight: 600, color: "#1B5E43", cursor: "pointer", textAlign: "left" }}
                      >
                        {c.name || "(no name)"}
                      </button>
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>{formatPhone(c.phone)}</td>
                    <td style={{ textAlign: "right" }}>{c.totalVisits || 0}</td>
                    <td style={{ textAlign: "right", fontWeight: 600 }}>{INR(c.totalSpend || 0)}</td>
                    <td style={{ whiteSpace: "nowrap", color: c.lastVisitAt ? "#334" : "#A8B8AE" }}>{c.lastVisitAt || "never"}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button className="btn ghost" style={{ fontSize: 12 }} onClick={() => startEdit(c)}>Edit</button>{" "}
                      <button className="btn ghost" style={{ fontSize: 12, color: "#C44536" }} onClick={() => remove(c)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {editing && (
        <Modal title={editing === "new" ? "New customer" : "Edit customer"} onClose={close}>
          <CustomerForm value={form} onChange={setForm} isNew={editing === "new"} err={err} />
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 14 }}>
            <button className="btn" onClick={close}>Cancel</button>
            <button className="btn primary" onClick={save}>Save customer</button>
          </div>
        </Modal>
      )}

      {openProfile && (
        <CustomerProfile
          customer={openProfile} sales={sales} services={services} staff={staff}
          onClose={() => setProfile(null)} onEdit={() => { setProfile(null); startEdit(openProfile); }}
        />
      )}
    </div>
  );
}

// ---------- Customer profile ----------
// Phase 1 shows who they are and every bill they've had. Phase 3 adds the points ledger,
// packages and next-due services; Phase 4 adds their segment.
function CustomerProfile({ customer, sales, staff, onClose, onEdit }) {
  const bills = useMemo(() => billsForCustomer(sales, customer.phone).slice().reverse(), [sales, customer.phone]);
  const avg = customer.totalVisits ? money(customer.totalSpend / customer.totalVisits) : 0;

  return (
    <Modal title={customer.name || formatPhone(customer.phone)} onClose={onClose}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <Card label="Visits" value={customer.totalVisits || 0} />
        <Card label="Total spend" value={INR(customer.totalSpend || 0)} accent />
        <Card label="Average bill" value={INR(avg)} />
        <Card label="Last visit" value={customer.lastVisitAt || "never"} />
      </div>

      <div style={{ fontSize: 12.5, color: "#5E7468", lineHeight: 1.8, marginBottom: 12 }}>
        <div>☎ {formatPhone(customer.phone)}</div>
        {customer.dob && <div>🎂 Birthday · {customer.dob.replace("-", " / ")}</div>}
        {customer.anniversary && <div>💐 Anniversary · {customer.anniversary.replace("-", " / ")}</div>}
        {customer.notes && <div style={{ marginTop: 6, whiteSpace: "pre-line", color: "#334" }}>📝 {customer.notes}</div>}
      </div>

      <div style={{ ...S.panelHead, marginTop: 4 }}>Visit history</div>
      {bills.length === 0 ? (
        <Empty text="No bills yet." />
      ) : (
        <div style={{ maxHeight: 260, overflowY: "auto" }}>
          <table className="tbl" style={{ width: "100%" }}>
            <thead><tr><th>Date</th><th>What they had</th><th style={{ textAlign: "right" }}>Paid</th></tr></thead>
            <tbody>
              {bills.map((b) => (
                <tr key={b.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{b.date}</td>
                  <td style={{ fontSize: 12.5 }}>
                    {(b.lines || []).map((l, i) => (
                      <div key={i} style={{ color: isServiceLine(l) ? "#334" : "#6B7E74" }}>
                        {l.name}
                        {l.qty > 1 ? ` ×${l.qty}` : ""}
                        {isServiceLine(l) && l.staffId ? <span style={{ color: "#8A9C90" }}> · {staffName(staff, l.staffId)}</span> : null}
                      </div>
                    ))}
                  </td>
                  <td style={{ textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" }}>{INR(b.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 14 }}>
        <button className="btn" onClick={onClose}>Close</button>
        <button className="btn primary" onClick={onEdit}>Edit customer</button>
      </div>
    </Modal>
  );
}

// ---------- Services (owner only) ----------
// The salon's menu: what it sells, how long each thing takes, what it pays the person doing
// it, and how soon the customer is due back. Those last two are why this can't just be the
// Inventory screen with different labels — a service has no stock, but it does have a
// commission rate and a rebooking cycle that the Reminders queue reads.
function Services({ services, setServices, notify, log }) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("All");
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState(null); // service id | "new"
  const [form, setForm] = useState(blankService());
  const [err, setErr] = useState("");

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    return services.filter((s) =>
      (showInactive || s.active !== false) &&
      (cat === "All" || s.category === cat) &&
      (!query || String(s.name || "").toLowerCase().includes(query))
    );
  }, [services, q, cat, showInactive]);

  const grouped = useMemo(() => {
    const m = new Map();
    filtered.forEach((s) => {
      const k = s.category || "Other";
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(s);
    });
    return [...m.entries()];
  }, [filtered]);

  const startNew = () => { setForm(blankService(todayStr())); setEditing("new"); setErr(""); };
  const startEdit = (s) => { setForm({ ...s }); setEditing(s.id); setErr(""); };
  const close = () => { setEditing(null); setErr(""); };

  const save = () => {
    const problem = validateService(form);
    if (problem) return setErr(problem);
    const isNew = editing === "new";
    const rec = makeService(form, { id: isNew ? uid() : editing, createdAt: form.createdAt || todayStr() });
    setServices((list) => (isNew ? [...list, rec] : list.map((s) => (s.id === editing ? rec : s))));
    log("settings", `${isNew ? "Added" : "Updated"} service — ${rec.name} · ${INR(rec.price)}`);
    notify(`✓ ${rec.name} saved`);
    close();
  };

  // Deactivate rather than delete: a deleted service would orphan every past bill line and
  // commission report that references it. Deactivating takes it off the billing screen while
  // leaving history readable.
  const toggleActive = (s) => {
    const next = s.active === false;
    if (!next && !confirm(`Take “${s.name}” off the menu? Past bills keep it; it just stops appearing when billing.`)) return;
    setServices((list) => list.map((x) => (x.id === s.id ? { ...x, active: next } : x)));
    log("settings", `${next ? "Re-activated" : "Deactivated"} service — ${s.name}`);
    notify(next ? `${s.name} is back on the menu` : `${s.name} taken off the menu`);
  };

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div>
      <Header title="Services" sub={`${activeServices(services).length} on the menu · prices, durations, commission and rebooking cycles`}>
        <button className="btn primary big" onClick={startNew}>+ New service</button>
      </Header>

      <section style={{ ...S.panel, marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input className="input" style={{ flex: "1 1 200px" }} placeholder="Search services…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="input" style={{ width: "auto" }} value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="All">All categories</option>
            {SERVICE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <label style={{ fontSize: 12.5, color: "#6B7E74", display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            Show inactive
          </label>
        </div>
      </section>

      {grouped.length === 0 ? (
        <Empty text="No services match." />
      ) : grouped.map(([category, list]) => (
        <section key={category} style={{ ...S.panel, marginBottom: 14 }}>
          <div style={S.panelHead}>{serviceIconFor(category)} {category} <span style={{ fontWeight: 400, color: "#8A9C90" }}>· {list.length}</span></div>
          <div style={{ overflowX: "auto" }}>
            <table className="tbl" style={{ width: "100%" }}>
              <thead>
                <tr><th>Service</th><th style={{ textAlign: "right" }}>Price</th><th style={{ textAlign: "right" }}>Time</th><th style={{ textAlign: "right" }}>Commission</th><th style={{ textAlign: "right" }}>Rebook</th><th /></tr>
              </thead>
              <tbody>
                {list.map((s) => (
                  <tr key={s.id} style={s.active === false ? { opacity: 0.5 } : undefined}>
                    <td>
                      {s.name}
                      {s.active === false && <span style={{ fontSize: 11, color: "#C44536" }}> · off menu</span>}
                    </td>
                    <td style={{ textAlign: "right", fontWeight: 600 }}>{INR(s.price)}</td>
                    <td style={{ textAlign: "right" }}>{s.durationMin} min</td>
                    <td style={{ textAlign: "right" }}>{s.commissionPct}%</td>
                    <td style={{ textAlign: "right", color: s.rebookCycleDays ? "#334" : "#A8B8AE" }}>
                      {s.rebookCycleDays ? `${s.rebookCycleDays} d` : "—"}
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button className="btn ghost" style={{ fontSize: 12 }} onClick={() => startEdit(s)}>Edit</button>{" "}
                      <button className="btn ghost" style={{ fontSize: 12 }} onClick={() => toggleActive(s)}>
                        {s.active === false ? "Restore" : "Remove"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      {editing && (
        <Modal title={editing === "new" ? "New service" : "Edit service"} onClose={close}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div style={{ gridColumn: "1 / -1" }}>
              <Field label="Name"><input className="input" autoFocus value={form.name} onChange={(e) => set("name", e.target.value)} /></Field>
            </div>
            <Field label="Category">
              <select className="input" value={form.category} onChange={(e) => { set("category", e.target.value); set("icon", serviceIconFor(e.target.value)); }}>
                {SERVICE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="Price (₹)"><input className="input" inputMode="decimal" value={form.price} onChange={(e) => set("price", e.target.value)} /></Field>
            <Field label="Duration (minutes)">
              <input className="input" inputMode="numeric" step={5} type="number" value={form.durationMin} onChange={(e) => set("durationMin", e.target.value)} />
            </Field>
            <Field label="Commission %"><input className="input" inputMode="decimal" value={form.commissionPct} onChange={(e) => set("commissionPct", e.target.value)} /></Field>
            <div style={{ gridColumn: "1 / -1" }}>
              <Field label="Rebooking cycle (days)">
                <input className="input" inputMode="numeric" value={form.rebookCycleDays} onChange={(e) => set("rebookCycleDays", e.target.value)} />
              </Field>
              <div style={{ fontSize: 11.5, color: "#8A9C90", marginTop: -4 }}>
                How long until the customer is typically due again — this drives the Reminders queue.
                Use <b>0</b> for one-off work like bridal makeup, which should never prompt a reminder.
              </div>
            </div>
          </div>
          {err && <div style={{ color: "#B23B2E", fontSize: 12.5, marginTop: 10 }}>{err}</div>}
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 14 }}>
            <button className="btn" onClick={close}>Cancel</button>
            <button className="btn primary" onClick={save}>Save service</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------- Staff (owner only) ----------
// Who works here, what colour they are on the appointment grid, and what they earn by default.
// Phase 5 builds payout reports and performance charts on top of this.
function Staff({ staff, setStaff, notify, log }) {
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState(null); // staff id | "new"
  const [form, setForm] = useState(blankStaff());
  const [err, setErr] = useState("");

  const listed = useMemo(
    () => staff.filter((s) => showInactive || s.active !== false),
    [staff, showInactive]
  );

  const startNew = () => { setForm(blankStaff(staff, todayStr())); setEditing("new"); setErr(""); };
  const startEdit = (s) => { setForm({ ...s }); setEditing(s.id); setErr(""); };
  const close = () => { setEditing(null); setErr(""); };

  const save = () => {
    const problem = validateStaff(form);
    if (problem) return setErr(problem);
    const isNew = editing === "new";
    const rec = makeStaff(form, { id: isNew ? uid() : editing, createdAt: form.createdAt || todayStr() });
    setStaff((list) => (isNew ? [...list, rec] : list.map((s) => (s.id === editing ? rec : s))));
    log("settings", `${isNew ? "Added" : "Updated"} staff — ${rec.name}`);
    notify(`✓ ${rec.name} saved`);
    close();
  };

  // Deactivate, never delete: past bills and appointments carry a staffId, and deleting the
  // record would leave every one of them attributed to nobody.
  const toggleActive = (s) => {
    const next = s.active === false;
    if (!next && !confirm(`Mark ${s.name} as no longer working here? Their past bills and commission history stay intact.`)) return;
    setStaff((list) => list.map((x) => (x.id === s.id ? { ...x, active: next } : x)));
    log("settings", `${next ? "Re-activated" : "Deactivated"} staff — ${s.name}`);
    notify(next ? `${s.name} re-activated` : `${s.name} deactivated`);
  };

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div>
      <Header title="Staff" sub={`${activeStaff(staff).length} working · colours, roles and default commission`}>
        <button className="btn primary big" onClick={startNew}>+ Add staff</button>
      </Header>

      <section style={{ ...S.panel, marginBottom: 14 }}>
        <label style={{ fontSize: 12.5, color: "#6B7E74", display: "flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show people who no longer work here
        </label>
      </section>

      {listed.length === 0 ? (
        <Empty text="No staff yet.">
          <button className="btn primary" onClick={startNew}>Add the first stylist</button>
        </Empty>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 }}>
          {listed.map((s) => (
            <section key={s.id} style={{ ...S.panel, opacity: s.active === false ? 0.55 : 1, borderTop: `3px solid ${s.color}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ width: 34, height: 34, borderRadius: "50%", background: s.color, color: "#fff", display: "grid", placeItems: "center", fontWeight: 800, flexShrink: 0 }}>
                  {String(s.name || "?").trim().charAt(0).toUpperCase()}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 14.5 }}>{s.name}</div>
                  <div style={{ fontSize: 12, color: "#6B7E74" }}>{s.role || "—"}</div>
                </div>
              </div>
              <div style={{ fontSize: 12.5, color: "#5E7468", marginTop: 10, lineHeight: 1.7 }}>
                <div>Default commission · <b>{s.commissionPctDefault}%</b></div>
                {s.phone && <div>☎ {formatPhone(s.phone)}</div>}
                {s.active === false && <div style={{ color: "#C44536", fontWeight: 600 }}>No longer working here</div>}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button className="btn ghost" style={{ fontSize: 12 }} onClick={() => startEdit(s)}>Edit</button>
                <button className="btn ghost" style={{ fontSize: 12 }} onClick={() => toggleActive(s)}>
                  {s.active === false ? "Re-activate" : "Deactivate"}
                </button>
              </div>
            </section>
          ))}
        </div>
      )}

      {editing && (
        <Modal title={editing === "new" ? "Add staff" : "Edit staff"} onClose={close}>
          <Field label="Name"><input className="input" autoFocus value={form.name} onChange={(e) => set("name", e.target.value)} /></Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Role"><input className="input" placeholder="e.g. Hair Stylist" value={form.role} onChange={(e) => set("role", e.target.value)} /></Field>
            <Field label="Phone"><input className="input" type="tel" value={form.phone} onChange={(e) => set("phone", e.target.value)} /></Field>
          </div>
          <Field label="Default commission %">
            <input className="input" inputMode="decimal" value={form.commissionPctDefault} onChange={(e) => set("commissionPctDefault", e.target.value)} />
          </Field>
          <div style={{ fontSize: 11.5, color: "#8A9C90", marginTop: -6, marginBottom: 10 }}>
            Used when a service doesn't set its own commission rate.
          </div>
          <Field label="Colour on the appointment grid">
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {STAFF_COLORS.map((c) => (
                <button
                  key={c} type="button" onClick={() => set("color", c)}
                  aria-label={`Colour ${c}`}
                  style={{
                    width: 28, height: 28, borderRadius: "50%", background: c, cursor: "pointer",
                    border: String(form.color).toLowerCase() === c.toLowerCase() ? "3px solid #334" : "1px solid #DDE5DF",
                  }}
                />
              ))}
            </div>
          </Field>
          {err && <div style={{ color: "#B23B2E", fontSize: 12.5, marginTop: 10 }}>{err}</div>}
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 14 }}>
            <button className="btn" onClick={close}>Cancel</button>
            <button className="btn primary" onClick={save}>Save</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------- Settings → Users (owner only) ----------
// Day-to-day staff access is managed from here, not from the Firebase console.
//
// Adding a user has to create a real Firebase Auth account, and the client SDK signs newly
// created users straight in — which would boot the owner out of their own session mid-task. The
// standard workaround is a SECOND, throwaway app instance: create the account on that, sign it
// out, delete it. The owner's session lives on the primary app and is never touched. See
// secondaryApp() in src/lib/firebase.js.
//
// The role each user gets is written to shop/users/<uid>, which is exactly what
// database.rules.json reads back to authorise every request. This screen IS the access control.
function Users({ user, notify, log }) {
  const [users, setUsers] = useState(null); // null = still loading
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ email: "", name: "", pwd: "", role: "biller" });

  useEffect(() => subscribeUsers(
    (val) => { setUsers(val || {}); setErr(""); },
    (e) => { console.error("users read failed", e); setErr("Couldn't load the user list."); setUsers({}); }
  ), []);

  const rows = useMemo(
    () => Object.entries(users || {}).sort((a, b) =>
      // Owners first, then alphabetically — the list reads as a hierarchy.
      (a[1].role === "owner" ? 0 : 1) - (b[1].role === "owner" ? 0 : 1) ||
      String(a[1].email || "").localeCompare(String(b[1].email || ""))
    ),
    [users]
  );

  const addUser = async () => {
    const email = form.email.trim().toLowerCase();
    const name = form.name.trim();
    if (!email || !form.pwd) return setErr("Email and password are both required.");
    if (form.pwd.length < 6) return setErr("Firebase requires a password of at least 6 characters.");
    if (rows.some(([, u]) => String(u.email || "").toLowerCase() === email)) {
      return setErr("That email is already on the team.");
    }
    setBusy(true); setErr("");
    let secondary = null;
    try {
      // Create the account on a throwaway app so the owner's session survives.
      secondary = secondaryApp();
      const cred = await createUserWithEmailAndPassword(getAuth(secondary), email, form.pwd);
      await writeUser(cred.user.uid, {
        email, name, role: form.role, active: true, createdAt: todayStr(),
      });
      await signOut(getAuth(secondary));
      log?.("settings", `Added user ${email} (${ROLE_LABELS[form.role]})`);
      notify(`✓ ${email} can now sign in as ${ROLE_LABELS[form.role]}`);
      setForm({ email: "", name: "", pwd: "", role: "biller" });
      setAdding(false);
    } catch (e) {
      console.error("add user failed", e);
      setErr(
        e?.code === "auth/email-already-in-use"
          ? "That email already has an account. If they used to work here, ask them to sign in — you can then set their role."
          : e?.code === "auth/weak-password" ? "Password is too weak — use at least 6 characters."
            : e?.code === "auth/invalid-email" ? "That doesn't look like a valid email address."
              : authMessage(e?.code)
      );
    } finally {
      // Always tear the throwaway instance down, or a later add would collide on the app name.
      if (secondary) { try { await deleteApp(secondary); } catch { /* already gone */ } }
      setBusy(false);
    }
  };

  // Guarded by validateUserChange: the owner must not be able to demote or deactivate the last
  // active owner, because nobody would be left who can manage users and there is no way back
  // without a console visit.
  const applyChange = async (uid, next, label) => {
    const problem = validateUserChange(users, uid, next);
    if (problem) return notify("⚠ " + problem);
    try {
      await updateUser(uid, next);
      log?.("settings", `${label} — ${users[uid]?.email || uid}`);
      notify("✓ " + label);
    } catch (e) {
      console.error("user update failed", e);
      notify("⚠ Couldn't save that change.");
    }
  };

  const changeRole = (uid, role) => {
    const u = users[uid];
    if (!u || u.role === role) return;
    applyChange(uid, { role, active: u.active !== false }, `Role changed to ${ROLE_LABELS[role]}`);
  };

  const toggleActive = (uid) => {
    const u = users[uid];
    if (!u) return;
    const active = u.active === false;
    if (!active && !confirm(`Deactivate ${u.email}? They'll be signed out and won't be able to sign back in.`)) return;
    applyChange(uid, { role: u.role, active }, active ? "User re-activated" : "User deactivated");
  };

  return (
    <section style={{ ...S.panel, marginTop: 16 }}>
      <div style={{ ...S.panelHead, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>Users &amp; roles</span>
        {!adding && <button className="btn primary" onClick={() => { setAdding(true); setErr(""); }}>+ Add user</button>}
      </div>

      <div style={{ fontSize: 12, color: "#6B7E74", lineHeight: 1.6, marginBottom: 12 }}>
        {ROLES.map((r) => (
          <div key={r}>
            <b style={{ color: "#334" }}>{ROLE_LABELS[r]}</b> — {ROLE_DESCRIPTIONS[r]}
          </div>
        ))}
      </div>

      {adding && (
        <div style={{ border: "1px solid #E2EAE3", borderRadius: 10, padding: 12, marginBottom: 14, background: "#F8FBF9" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Email"><input className="input" type="email" autoComplete="off" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} /></Field>
            <Field label="Name (optional)"><input className="input" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></Field>
            <Field label="Temporary password">
              <input className="input" type="text" autoComplete="off" value={form.pwd} onChange={(e) => setForm((f) => ({ ...f, pwd: e.target.value }))} />
            </Field>
            <Field label="Role">
              <select className="input" value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}>
                {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
              </select>
            </Field>
          </div>
          <div style={{ fontSize: 11.5, color: "#8A9C90", marginBottom: 8 }}>
            Share the password with them and ask them to change it from the sign-in screen's “Forgot password” link.
          </div>
          {err && <div style={{ color: "#B23B2E", fontSize: 12.5, marginBottom: 8 }}>{err}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="btn" onClick={() => { setAdding(false); setErr(""); }} disabled={busy}>Cancel</button>
            <button className="btn primary" onClick={addUser} disabled={busy}>{busy ? "Creating…" : "Create user"}</button>
          </div>
        </div>
      )}

      {!adding && err && <div style={{ color: "#B23B2E", fontSize: 12.5, marginBottom: 8 }}>{err}</div>}

      {users === null ? (
        <div style={{ color: "#8A9C90", fontSize: 13 }}>Loading users…</div>
      ) : rows.length === 0 ? (
        <Empty text="No users yet." />
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="tbl" style={{ width: "100%" }}>
            <thead>
              <tr><th>Email</th><th>Name</th><th>Role</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {rows.map(([uid, u]) => {
                const isMe = uid === user?.uid;
                const inactive = u.active === false;
                return (
                  <tr key={uid} style={inactive ? { opacity: 0.55 } : undefined}>
                    <td>
                      {u.email}
                      {isMe && <span style={{ fontSize: 11, color: "#8A9C90" }}> (you)</span>}
                    </td>
                    <td>{u.name || <span style={{ color: "#A8B8AE" }}>—</span>}</td>
                    <td>
                      <select
                        className="input" style={{ padding: "4px 6px", fontSize: 12.5 }}
                        value={u.role} onChange={(e) => changeRole(uid, e.target.value)}
                      >
                        {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                      </select>
                    </td>
                    <td style={{ color: inactive ? "#C44536" : "#1B5E43", fontWeight: 600, fontSize: 12.5 }}>
                      {inactive ? "Deactivated" : "Active"}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button className="btn ghost" style={{ fontSize: 12 }} onClick={() => toggleActive(uid)}>
                        {inactive ? "Re-activate" : "Deactivate"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ fontSize: 11.5, color: "#8A9C90", marginTop: 10, lineHeight: 1.6 }}>
        Deactivating keeps the person's history intact and blocks them at the database, not just in
        the app. Removing an account entirely is a Firebase console job — deactivating is almost
        always what you want.
      </div>
    </section>
  );
}

// ---------- small components ----------
// ---------- Admin (password-gated bulk / destructive operations) ----------
// Every action requires: confirm → confirm again → re-enter the account password
// (verified against Firebase Auth). Only on a successful re-auth does the action run.
function Admin({ items, setItems, setSales, setExpenses, setLogs, user, notify, log }) {
  const [pending, setPending] = useState(null); // the chosen operation
  const [step, setStep] = useState(1); // 1 = first confirm, 2 = password
  const [pwd, setPwd] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const dupeExtras = useMemo(() => {
    const seen = new Set();
    let extra = 0;
    for (const i of items) { const k = normName(i.name); seen.has(k) ? extra++ : seen.add(k); }
    return extra;
  }, [items]);

  const zeroStockCount = useMemo(() => items.filter((i) => (+i.stock || 0) <= 0).length, [items]);
  const zeroPriceCount = useMemo(() => items.filter((i) => (+i.sellPrice || 0) <= 0).length, [items]);

  // Items now sitting in "Other" (or with no category) whose NAME confidently maps to a real
  // category. guessCategory is called without the items list so only the keyword map is used —
  // no fuzzy shared-token guessing — keeping bulk re-categorization high-precision. Anything the
  // keywords can't place stays in Other, so nothing is ever mis-filed.
  const isOtherCat = (i) => { const c = (i.category || "").trim().toLowerCase(); return c === "" || c === "other"; };
  const guessForOther = (i) => { const g = guessCategory(i.name); return g && g !== "Other" ? g : null; };
  const otherFixable = useMemo(() => items.filter((i) => isOtherCat(i) && guessForOther(i)).length, [items]);

  const ops = [
    { key: "zeroStock", label: "Zero all stock", group: "Inventory",
      desc: "Set stock to 0 and clear every batch for all items. Names and prices are kept.",
      apply: () => setItems((l) => l.map((i) => ({ ...i, stock: 0, batches: [], updatedAt: todayStr() }))),
      logMsg: "Reset all stock to 0", toast: "All stock set to 0" },
    { key: "zeroBuy", label: "Zero all buy prices", group: "Inventory",
      desc: "Set the buy (cost) price to 0 for every item.",
      apply: () => setItems((l) => l.map((i) => ({ ...i, buyPrice: 0, updatedAt: todayStr() }))),
      logMsg: "Reset all buy prices to 0", toast: "All buy prices set to 0" },
    { key: "zeroSell", label: "Zero all sell prices", group: "Inventory",
      desc: "Set the sell price and MRP to 0 for every item.",
      apply: () => setItems((l) => l.map((i) => ({ ...i, sellPrice: 0, mrp: 0, updatedAt: todayStr() }))),
      logMsg: "Reset all sell prices to 0", toast: "All sell prices set to 0" },
    { key: "zeroPrices", label: "Zero all prices (buy + sell)", group: "Inventory",
      desc: "Set buy price, sell price and MRP to 0 for every item.",
      apply: () => setItems((l) => l.map((i) => ({ ...i, buyPrice: 0, sellPrice: 0, mrp: 0, updatedAt: todayStr() }))),
      logMsg: "Reset all prices to 0", toast: "All prices set to 0" },
    { key: "dedupe", label: "Merge duplicate items" + (dupeExtras ? ` (${dupeExtras})` : ""), group: "Inventory",
      desc: "Combine items that share the same name into one entry — stock and batches are summed, nothing is lost.",
      disabled: dupeExtras === 0,
      apply: () => setItems((l) => {
        const g = new Map();
        for (const i of l) { const k = normName(i.name); if (!g.has(k)) g.set(k, []); g.get(k).push(i); }
        return [...g.values()].map((x) => (x.length === 1 ? x[0] : mergeItemGroup(x)));
      }),
      logMsg: "Merged duplicate items", toast: "Duplicates merged" },
    { key: "autoCat", label: "Auto-categorize “Other” items" + (otherFixable ? ` (${otherFixable})` : ""), group: "Inventory",
      desc: "Move items now in “Other” into the category their name matches (e.g. “Bisleri Water” → Cold Drinks & Water). Only confident name matches are moved; anything unclear stays in Other. Auto icons update; custom ones are kept.",
      disabled: otherFixable === 0,
      apply: () => setItems((l) => l.map((i) => {
        if (!isOtherCat(i)) return i;
        const g = guessForOther(i);
        if (!g) return i;
        return { ...i, category: g, icon: isAutoIcon(i.icon, i.category) ? iconFor(g) : i.icon, updatedAt: todayStr() };
      })),
      logMsg: `Auto-categorized ${otherFixable} item(s) from Other`, toast: `${otherFixable} item(s) re-categorized` },
    { key: "delZeroStock", label: "Delete 0-stock items" + (zeroStockCount ? ` (${zeroStockCount})` : ""), group: "Danger zone", danger: true,
      desc: "Permanently remove every item whose stock is 0. Items that still have stock are kept.",
      disabled: zeroStockCount === 0,
      apply: () => setItems((l) => l.filter((i) => (+i.stock || 0) > 0)),
      logMsg: "Deleted 0-stock items", toast: "0-stock items deleted" },
    { key: "delZeroPrice", label: "Delete 0-price items" + (zeroPriceCount ? ` (${zeroPriceCount})` : ""), group: "Danger zone", danger: true,
      desc: "Permanently remove every item whose sell price is 0. Items with a sell price are kept.",
      disabled: zeroPriceCount === 0,
      apply: () => setItems((l) => l.filter((i) => (+i.sellPrice || 0) > 0)),
      logMsg: "Deleted 0-price items", toast: "0-price items deleted" },
    { key: "delItems", label: "Delete ALL inventory items", group: "Danger zone", danger: true,
      desc: "Permanently remove every item from inventory. Sales history is kept.",
      apply: () => setItems([]), logMsg: "Deleted all inventory items", toast: "All items deleted" },
    { key: "clrSales", label: "Clear all sales history", group: "Danger zone", danger: true,
      desc: "Permanently delete every recorded sale. Inventory stock is NOT changed.",
      apply: () => setSales([]), logMsg: "Cleared all sales history", toast: "Sales history cleared" },
    { key: "clrExp", label: "Clear all expenses", group: "Danger zone", danger: true,
      desc: "Permanently delete every expense entry.",
      apply: () => setExpenses([]), logMsg: "Cleared all expenses", toast: "Expenses cleared" },
    { key: "clrLogs", label: "Clear activity log", group: "Danger zone",
      desc: "Delete all activity-log entries.",
      apply: () => setLogs([]), logMsg: "Cleared activity log", toast: "Activity log cleared" },
    { key: "factory", label: "Factory reset", group: "Danger zone", danger: true,
      desc: "Replace inventory with the fresh starter catalogue (all at 0 stock) and delete ALL sales, expenses and logs. Cannot be undone.",
      apply: () => {
        setItems(SEED_ITEMS.map((i) => ({ ...i, id: uid(), stock: 0, batches: [] })));
        setSales([]); setExpenses([]); setLogs([]);
      },
      logMsg: "Factory reset performed", toast: "Factory reset complete" },
  ];

  const groups = [...new Set(ops.map((o) => o.group))];
  const choose = (op) => { if (op.disabled) return; setPending(op); setStep(1); setPwd(""); setErr(""); };
  const close = () => { setPending(null); setStep(1); setPwd(""); setErr(""); setBusy(false); };

  const confirmRun = async () => {
    if (!pwd) return setErr("Enter your account password.");
    if (!user?.email) return setErr("No signed-in account to verify against.");
    setBusy(true); setErr("");
    try {
      const cred = EmailAuthProvider.credential(user.email, pwd);
      await reauthenticateWithCredential(auth.currentUser, cred);
    } catch (e) {
      setBusy(false);
      setErr(e?.code === "auth/too-many-requests"
        ? "Too many attempts — please wait a minute and retry."
        : "Incorrect password — operation cancelled.");
      return;
    }
    try { pending.apply(); log("admin", pending.logMsg); notify(pending.toast); }
    catch (e) { console.error("admin op failed", e); notify("⚠ Operation failed."); }
    close();
  };

  return (
    <div>
      <Header title="Admin" sub="Bulk & destructive operations · double-confirm + password required" />
      {groups.map((grp) => (
        <section key={grp} style={{ ...S.panel, marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", color: grp === "Danger zone" ? "#B23B2E" : "#6B7E74", marginBottom: 6 }}>{grp}</div>
          {ops.filter((o) => o.group === grp).map((op) => (
            <div key={op.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, padding: "10px 0", borderTop: "1px solid #EAF0EA" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, color: op.danger ? "#B23B2E" : "#10331F" }}>{op.label}</div>
                <div style={{ fontSize: 12.5, color: "#5E7468" }}>{op.desc}</div>
              </div>
              <button
                className="btn"
                disabled={op.disabled}
                onClick={() => choose(op)}
                style={{ flex: "0 0 auto", opacity: op.disabled ? 0.5 : 1, ...(op.danger ? { borderColor: "#E2B6B0", color: "#B23B2E" } : {}) }}
              >
                Run
              </button>
            </div>
          ))}
        </section>
      ))}

      {pending && (
        <Modal title={step === 1 ? "Confirm operation" : "Enter password to confirm"} onClose={close}>
          {step === 1 ? (
            <>
              <p style={{ marginTop: 0, fontWeight: 700, color: pending.danger ? "#B23B2E" : "#10331F" }}>{pending.label}</p>
              <p style={{ color: "#5E7468", fontSize: 13 }}>{pending.desc}</p>
              <p style={{ color: pending.danger ? "#B23B2E" : "#5E7468", fontSize: 13 }}>
                This applies to all signed-in devices and may not be reversible. Continue?
              </p>
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 14 }}>
                <button className="btn" onClick={close}>Cancel</button>
                <button className="btn primary" onClick={() => { setStep(2); setErr(""); }}>Yes, continue</button>
              </div>
            </>
          ) : (
            <>
              <p style={{ marginTop: 0, fontSize: 13, color: "#5E7468" }}>
                Final step. Enter the password for <b>{user?.email}</b> to run <b>{pending.label}</b>.
              </p>
              <input
                className="input" type="password" autoFocus placeholder="Account password"
                value={pwd} onChange={(e) => setPwd(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") confirmRun(); }}
                style={{ width: "100%", boxSizing: "border-box" }}
              />
              {err && <div style={{ color: "#B23B2E", fontSize: 12.5, marginTop: 8 }}>{err}</div>}
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 14 }}>
                <button className="btn" onClick={close} disabled={busy}>Cancel</button>
                <button className="btn primary" onClick={confirmRun} disabled={busy}>{busy ? "Verifying…" : "Confirm & run"}</button>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

const Header = ({ title, sub, children }) => (
  <div style={{ display: "flex", alignItems: "flex-end", marginBottom: 18, gap: 12 }}>
    <div>
      <h1 style={{ margin: 0, fontSize: 24, letterSpacing: "-0.03em" }}>{title}</h1>
      {sub && <div style={{ color: "#6B7E74", fontSize: 13, marginTop: 2 }}>{sub}</div>}
    </div>
    <div style={{ marginLeft: "auto" }}>{children}</div>
  </div>
);

const Card = ({ label, value, sub, accent }) => (
  <div style={{ ...S.card, ...(accent ? { background: "#1B5E43", color: "#fff" } : {}) }}>
    <div style={{ fontSize: 11.5, textTransform: "uppercase", letterSpacing: "0.07em", color: accent ? "#A8CDBA" : "#7A8C81" }}>{label}</div>
    <div style={{ fontSize: 24, fontWeight: 800, margin: "6px 0 2px", fontVariantNumeric: "tabular-nums" }}>{value}</div>
    <div style={{ fontSize: 12, color: accent ? "#C8E2D4" : "#8A9C90" }}>{sub}</div>
  </div>
);

const Field = ({ label, children }) => (
  <label style={{ display: "block", marginBottom: 10 }}>
    <div style={{ fontSize: 12, fontWeight: 600, color: "#465", marginBottom: 4 }}>{label}</div>
    {children}
  </label>
);

const Empty = ({ text, children }) => (
  <div style={{ padding: "22px 10px", textAlign: "center", color: "#8A9", fontSize: 13 }}>
    {text}
    {children && <div style={{ marginTop: 10 }}>{children}</div>}
  </div>
);

function Modal({ title, children, onClose }) {
  // Only close when the *press* started on the backdrop itself. Relying on the
  // click target alone closed the dialog whenever a drag (e.g. selecting digits
  // in a number field) began inside an input but released on the overlay.
  const downOnOverlay = useRef(false);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      style={S.overlay}
      onMouseDown={(e) => { downOnOverlay.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && downOnOverlay.current) onClose(); }}
      role="dialog" aria-modal="true" aria-label={title}
    >
      <div style={S.modal}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
          <h2 style={{ margin: 0, fontSize: 17 }}>{title}</h2>
          <button className="btn ghost small" style={{ marginLeft: "auto" }} aria-label="Close dialog" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------- styles ----------
const S = {
  app: { display: "flex", minHeight: "100vh", background: "#EFF3EE", fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif", color: "#1E2421" },
  nav: { width: 210, background: "#10331F", color: "#E6F0E9", display: "flex", flexDirection: "column", gap: 4, padding: "16px 10px", position: "sticky", top: 0, height: "100vh", boxSizing: "border-box" },
  logo: { display: "flex", gap: 10, alignItems: "center", padding: "4px 8px 18px" },
  logoMark: { width: 38, height: 38, borderRadius: 10, background: "#E8A33D", color: "#10331F", display: "grid", placeItems: "center", fontWeight: 800, fontSize: 17 },
  main: { flex: 1, padding: "26px 30px", maxWidth: 1280, margin: "0 auto", width: "100%", boxSizing: "border-box" },
  cards: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 },
  card: { background: "#fff", borderRadius: 14, padding: "16px 18px", border: "1px solid #E2EAE3" },
  panel: { background: "#fff", borderRadius: 14, padding: 16, border: "1px solid #E2EAE3" },
  panelHead: { fontWeight: 800, fontSize: 13.5, textTransform: "uppercase", letterSpacing: "0.05em", color: "#3A5547", display: "flex", alignItems: "center", marginBottom: 10 },
  row: { display: "flex", justifyContent: "space-between", padding: "8px 2px", borderBottom: "1px dashed #E5ECE6", fontSize: 13.5 },
  receipt: { background: "#FFFDF6", borderRadius: 4, padding: "18px 16px", border: "1px solid #E8E2CF", boxShadow: "0 2px 10px rgba(40,60,40,.07)", alignSelf: "start", backgroundImage: "repeating-linear-gradient(transparent, transparent 27px, rgba(180,170,140,.12) 28px)" },
  receiptHead: { textAlign: "center", fontWeight: 800, letterSpacing: "0.25em", fontSize: 12, color: "#6B6347", borderBottom: "2px dashed #D8D0B8", paddingBottom: 10, marginBottom: 8 },
  rcptLine: { display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderBottom: "1px dotted #E0D9C4" },
  rcptTotal: { display: "flex", justifyContent: "space-between", fontWeight: 800, fontSize: 18, paddingTop: 12, marginTop: 6, borderTop: "2px dashed #C9BF9F" },
  badge: { background: "#C44536", color: "#fff", fontSize: 10.5, fontWeight: 800, borderRadius: 9, padding: "1px 7px", marginLeft: 8 },
  toast: { position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "#10331F", color: "#fff", padding: "10px 20px", borderRadius: 10, fontSize: 13.5, boxShadow: "0 6px 20px rgba(0,0,0,.25)", zIndex: 60 },
  overlay: { position: "fixed", inset: 0, background: "rgba(15,30,20,.45)", display: "grid", placeItems: "center", zIndex: 50 },
  modal: { background: "#fff", borderRadius: 16, padding: 20, width: "min(480px, 92vw)", maxHeight: "86vh", overflow: "auto" },
};

const CSS = `
  .navbtn { display:flex; align-items:center; gap:6px; width:100%; text-align:left; background:none; border:none; color:#BCD2C4; padding:10px 12px; border-radius:9px; font-size:13.5px; font-weight:600; cursor:pointer; position:relative; }
  .navbtn:hover { background:#1A4A2E; color:#fff; }
  .navbtn.active { background:#1B5E43; color:#fff; }
  .navbtn.sub { padding-left:26px; font-size:13px; color:#A8C2B4; }
  .navbtn.sub::before { content:""; position:absolute; left:14px; top:9px; bottom:9px; width:2px; background:#2A5A3E; border-radius:2px; }
  .input { width:100%; box-sizing:border-box; padding:10px 12px; border:1.5px solid #D5E0D6; border-radius:9px; font-size:14px; background:#fff; outline:none; font-family:inherit; }
  .input:focus { border-color:#1B5E43; box-shadow:0 0 0 3px rgba(27,94,67,.12); }
  .btn { border:none; border-radius:9px; padding:9px 16px; font-size:13.5px; font-weight:700; cursor:pointer; background:#E4ECE5; color:#23402F; font-family:inherit; }
  .btn:hover { filter:brightness(.96); }
  .btn.primary { background:#1B5E43; color:#fff; }
  .btn.big { padding:13px 18px; font-size:15px; }
  .btn.ghost { background:transparent; border:1.5px solid #CFDCD1; }
  .btn.small { padding:5px 10px; font-size:12px; }
  .btn.danger { background:#FBEAE7; color:#C44536; }
  .pick { text-align:left; background:#F6FAF6; border:1.5px solid #DDE8DE; border-radius:11px; padding:10px 12px; cursor:pointer; font-family:inherit; }
  .pick:hover:not(:disabled) { border-color:#1B5E43; background:#fff; }
  .pick:disabled { opacity:.7; cursor:not-allowed; background:#F0F2F0; }
  .qty { width:26px; height:26px; border-radius:7px; border:1.5px solid #D0C7AB; background:#fff; font-size:15px; font-weight:700; cursor:pointer; line-height:1; }
  .tbl { width:100%; border-collapse:collapse; font-size:13.5px; }
  .tbl th { text-align:left; font-size:11.5px; text-transform:uppercase; letter-spacing:.05em; color:#7A8C81; padding:6px 8px; border-bottom:2px solid #E2EAE3; }
  .tbl td { padding:9px 8px; border-bottom:1px solid #EEF3EE; }
  .tbl tr:hover td { background:#F7FAF7; }
  @media (max-width: 820px) {
    .app { flex-direction:column !important; }
    .nav { width:auto !important; height:auto !important; position:static !important;
           flex-direction:row !important; flex-wrap:wrap !important; gap:4px !important; }
    .nav .navbtn { width:auto !important; }
    .main { padding:16px !important; max-width:none !important; }
    /* 16px inputs stop mobile browsers auto-zooming on focus */
    .input { font-size:16px; }
    /* inline grids are 2- or 4-column; collapse them all on small screens */
    [style*="grid-template-columns"] { grid-template-columns:1fr !important; }
    /* let wide tables scroll horizontally instead of overflowing the panel */
    .tbl { display:block; overflow-x:auto; white-space:nowrap; }
  }
`;
