// Barcode helpers shared by Inventory (uniqueness, editing) and Billing (scan lookup).
//
// A product carries a primary barcode in `code` (its default) plus any number of additional
// barcodes in `barcodes[]`. Everything here treats that pair as one logical set so a scanned
// value resolves to exactly one product and duplicates are caught wherever a barcode is saved.

// The full barcode set of a product — primary first — trimmed and de-duped case-insensitively.
export function itemBarcodes(item) {
  if (!item) return [];
  const out = [];
  const seen = new Set();
  const push = (v) => {
    const t = String(v ?? "").trim();
    if (!t) return;
    const k = t.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(t);
  };
  push(item.code);
  (Array.isArray(item.barcodes) ? item.barcodes : []).forEach(push);
  return out;
}

// In-store variable-weight / price-embedded barcodes carry a changing price or weight in their
// trailing digits. Per the EAN standard these are the "restricted distribution" numbers that
// start with "2", so ONLY those get their last 3 digits ignored (returning the identifying
// prefix). Every standard product barcode (890…, etc.) is returned unchanged and must match
// exactly — stripping its digits would wrongly collide different products from the same maker.
export function barcodeMatchKey(code) {
  const t = String(code ?? "").trim().toLowerCase();
  return (t.length > 10 && t.startsWith("2")) ? t.slice(0, -3) : t;
}

// The item matching a scanned barcode, or null. An EXACT (case-insensitive) match always wins —
// a normal fixed barcode resolves to its own product. Only a variable-weight "2"-prefix code that
// has no exact match falls back to a prefix match (last 3 digits ignored) so scales still scan;
// standard barcodes never fall back, so they can't collide with a same-prefix product.
export function findItemByBarcode(items, scanned) {
  const raw = String(scanned ?? "").trim().toLowerCase();
  if (!raw) return null;
  const exact = (items || []).find((i) => itemBarcodes(i).some((b) => b.toLowerCase() === raw));
  if (exact) return exact;
  const key = barcodeMatchKey(raw);
  if (key === raw) return null; // not a variable-weight code → exact only, no prefix fallback
  return (items || []).find((i) => itemBarcodes(i).some((b) => barcodeMatchKey(b) === key)) || null;
}

// First entry in `codes` that already belongs to a DIFFERENT product → { code, item }, else null.
// `exceptId` is the item being saved, so its own barcodes never count as a clash against itself.
export function findBarcodeClash(codes, items, exceptId) {
  const owner = new Map(); // normalized barcode → owning item
  for (const it of items || []) {
    if (it.id === exceptId) continue;
    for (const b of itemBarcodes(it)) {
      const k = b.toLowerCase();
      if (!owner.has(k)) owner.set(k, it);
    }
  }
  for (const c of codes) {
    const t = String(c ?? "").trim();
    if (!t) continue;
    const hit = owner.get(t.toLowerCase());
    if (hit) return { code: t, item: hit };
  }
  return null;
}

// Trim + de-dupe (case-insensitive) a raw list of typed/scanned barcodes, preserving order and
// the original casing of the first occurrence. Used when saving a product's barcode list.
export function cleanBarcodeList(raw) {
  const out = [];
  const seen = new Set();
  for (const c of raw || []) {
    const t = String(c ?? "").trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

// Parse a barcode-entry field into a clean list: split on ";", commas or whitespace (so a scanner
// burst, pasted list, or typed values all work), trim and de-dupe. The first token is the primary.
export function parseBarcodeText(text) {
  return cleanBarcodeList(String(text ?? "").split(/[;,\s]+/));
}

// Append a "; " separator to a barcode-entry field after a scan completes, so the next scan lands
// after it — unless the field is empty or already ends in a separator. Used on the scanner's Enter.
export function withBarcodeSep(val) {
  const s = String(val ?? "");
  if (!s.trim()) return s;
  return /[;\s]$/.test(s) ? s : s + "; ";
}

// A query that reads like a scanned barcode rather than a typed search term: no spaces, at least
// 6 characters, and containing a digit (product-name searches almost never are). Lets billing tell
// a genuine "barcode not found" scan apart from an ordinary manual search that matched nothing.
export function looksLikeBarcode(s) {
  const t = String(s ?? "").trim();
  return /^[A-Za-z0-9\-_.]{6,}$/.test(t) && /\d/.test(t);
}
