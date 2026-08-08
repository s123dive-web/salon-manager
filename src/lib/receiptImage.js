// Turn a receipt's HTML into a JPEG the salon can send a customer on WhatsApp.
//
// ── Why an image and not a PDF ───────────────────────────────────────────────────────────
// WhatsApp renders an image inline in the chat; a PDF is a grey tile the customer has to tap
// and download. For a receipt — glanced at once, occasionally saved — inline wins. It is also
// what lets this file exist at all: a PDF writer would need EMBEDDED FONTS, because `₹`
// (U+20B9) is absent from the WinAnsi encoding of every built-in PDF font, and a Devanagari
// shop name (the receipt deliberately supports one) needs a whole Indic-shaping font on top.
// That is hundreds of KB that would have to ship in the bundle, since the app must work on a
// counter tablet with the Wi-Fi off. Rasterizing hands text shaping to the browser, which
// already has those fonts, and the salon's own thermal-receipt layout comes out unchanged.
//
// ── How the rasterizing works ────────────────────────────────────────────────────────────
// An SVG <foreignObject> holding XHTML, loaded into an <img>, drawn onto a <canvas>. No
// dependency: this is the browser rendering its own markup. Two consequences drive the code
// below, and both are load-bearing rather than incidental:
//
//   1. foreignObject content is parsed as XML, not HTML. `&nbsp;` is a fatal parse error
//      there (XML predefines only amp/lt/gt/quot/apos) and every void element must be
//      self-closed. toXhtml() below repairs both — see its own note.
//   2. An SVG loaded through <img> is rendered in a sandbox that fetches NOTHING external.
//      A remote <img src> inside it silently renders blank, and on some engines taints the
//      canvas so toBlob() throws a SecurityError. Callers must pass markup whose images are
//      all `data:` URLs — which is what receiptHtml(..., { forImage: true }) produces.
//
// Height is measured in a real (hidden) iframe first rather than guessed. A receipt is
// variable-length — three lines or thirty — and an SVG needs its height up front; an iframe
// is also the same isolated-document mechanism printing already uses, so the measured box is
// the printed box, with no app CSS bleeding in.

/** Widen a JPEG past the 272px that 72mm works out to, so phone screens get a crisp receipt. */
export const DEFAULT_SCALE = 3;

/** JPEG quality. Black-on-white text rings badly below ~0.9; above ~0.95 only adds bytes. */
export const DEFAULT_QUALITY = 0.92;

/** How long to wait for the offscreen document to lay out before giving up. */
const RENDER_TIMEOUT_MS = 10000;

/**
 * Repair an HTML fragment into the XHTML that <foreignObject> requires.
 *
 * Deliberately a small set of targeted fixes, not a general HTML→XML converter: the only
 * input is our own receipt markup, and a real parser here would be far more code than the
 * three things that actually differ. Each is pinned by a test.
 *
 * - `&nbsp;` → `&#160;`. The one entity the receipt uses that XML does not define. Left
 *   alone it doesn't degrade — it aborts the whole render.
 * - void elements get self-closed, so a hand-edited `<br>` or `<img ...>` can't break it.
 * - a stray `&` that isn't already an entity is escaped, so a shop called "Cut & Curl"
 *   survives even if it reaches here unescaped.
 */
export function toXhtml(html) {
  return String(html ?? "")
    // A bare & (not the start of a named/numeric entity) is invalid XML.
    .replace(/&(?!#\d+;|#x[0-9a-fA-F]+;|[a-zA-Z][a-zA-Z0-9]*;)/g, "&amp;")
    .replace(/&nbsp;/g, "&#160;")
    // Self-close void elements that were written HTML-style.
    .replace(/<(br|hr|img|input|meta|link|source|col)\b([^>]*?)\s*\/?>/gi, (m, tag, attrs) => `<${tag}${attrs} />`);
}

/**
 * Wrap XHTML in an SVG document of a fixed pixel size.
 *
 * The white <rect> is not decoration: JPEG has no alpha, so an unpainted background composites
 * as black and the receipt arrives as white-on-black. The canvas is filled white too — belt
 * and braces, since one of the two runs on every platform.
 */
export function svgWrapper(xhtml, width, height) {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="100%" height="100%" fill="#ffffff"/>` +
    // width/height on the foreignObject as well as the svg: Safari lays out a foreignObject
    // with no explicit size as zero-by-zero and silently draws nothing.
    `<foreignObject x="0" y="0" width="${w}" height="${h}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml">${xhtml}</div>` +
    `</foreignObject></svg>`
  );
}

/**
 * An SVG string as a data URL.
 *
 * encodeURIComponent, never btoa: a receipt carries `₹` and may carry Devanagari, and btoa
 * throws on any code point above U+00FF.
 */
export const svgDataUrl = (svg) => "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);

/** "Bill-4F2A9C-2026-08-08.jpg" — safe on every filesystem and readable in a WhatsApp chat. */
export function receiptFileName(sale) {
  // Each part is cleaned separately, so a punctuation-heavy id can't leave a run of dashes
  // (or a leading one) in the middle of the name.
  const clean = (v) => String(v ?? "").replace(/[^\w.-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const ref = clean(String(sale?.id || "").slice(-6).toUpperCase());
  return ["Bill", ref, clean(sale?.date)].filter(Boolean).join("-") + ".jpg";
}

/** Mount a hidden iframe holding `html`, hand it to `fn`, and always clean it up. */
async function inHiddenFrame(html, fn) {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  Object.assign(iframe.style, {
    position: "fixed", left: "-10000px", top: "0", width: "400px", height: "100px",
    border: "0", visibility: "hidden",
  });
  document.body.appendChild(iframe);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Receipt render timed out")), RENDER_TIMEOUT_MS);
      iframe.onload = () => { clearTimeout(timer); resolve(); };
      iframe.onerror = () => { clearTimeout(timer); reject(new Error("Receipt render failed")); };
      // srcdoc fires one load event after content AND images, matching printHtml().
      iframe.srcdoc = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">${html}</body></html>`;
    });
    const doc = iframe.contentDocument;
    // Fonts must be resolved before measuring: Courier New arriving late reflows every line
    // and the measured height would be for the fallback face. Raced against a timer because
    // fonts.ready is not guaranteed to settle in a hidden frame on every engine, and an
    // unbounded await here is indistinguishable from a frozen button.
    if (doc?.fonts?.ready) {
      try {
        await Promise.race([doc.fonts.ready, new Promise((r) => setTimeout(r, 2000))]);
      } catch { /* measuring against the fallback face beats not sending the bill */ }
    }
    return await fn(doc);
  } finally {
    try { document.body.removeChild(iframe); } catch { /* already gone */ }
  }
}

/** Load a data URL into an <img> and wait for it to be decodable. */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => reject(new Error("Receipt image timed out")), RENDER_TIMEOUT_MS);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    // The usual cause is markup that isn't well-formed XML — the SVG fails to parse and the
    // <img> reports a plain error with no detail, so say what to look at.
    img.onerror = () => { clearTimeout(timer); reject(new Error("Receipt image failed to render (malformed markup?)")); };
    img.src = src;
  });
}

/**
 * Render receipt HTML to a JPEG Blob.
 *
 * `html` must be the output of receiptHtml(..., { forImage: true }) — see the note at the top
 * of this file about external images.
 */
export async function renderReceiptJpeg(html, { scale = DEFAULT_SCALE, quality = DEFAULT_QUALITY } = {}) {
  const { width, height } = await inHiddenFrame(html, (doc) => {
    // .rcpt is the paper box; fall back to the body if the class ever moves.
    const node = doc.querySelector(".rcpt") || doc.body;
    const rect = node.getBoundingClientRect();
    return { width: rect.width || node.scrollWidth, height: rect.height || node.scrollHeight };
  });
  if (!(width > 0) || !(height > 0)) throw new Error("Receipt measured as empty");

  const img = await loadImage(svgDataUrl(svgWrapper(toXhtml(html), width, height)));

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  return await new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Receipt image could not be encoded"))),
      "image/jpeg",
      quality,
    );
  });
}

/** The same JPEG as a File, which is what the Web Share API needs. */
export async function renderReceiptFile(html, sale, opts) {
  const blob = await renderReceiptJpeg(html, opts);
  return new File([blob], receiptFileName(sale), { type: "image/jpeg" });
}

/**
 * Can this device hand a file to another app (the WhatsApp share sheet)?
 *
 * Feature-detected per FILE rather than once at startup: canShare({files}) is the only honest
 * test — Chrome on Windows 10 advertises navigator.share but rejects file payloads, and
 * calling share() there throws after the user has already tapped.
 */
export function canShareFile(file) {
  try {
    return typeof navigator !== "undefined" && !!navigator.canShare && !!navigator.share && navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

/**
 * The same question, asked before a receipt exists — so the button can be hidden rather than
 * offered and then failing. Probes with a stand-in JPEG of the same type, which is what
 * canShare() actually inspects.
 */
export function canShareImages() {
  try {
    if (typeof File === "undefined") return false;
    return canShareFile(new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], "bill.jpg", { type: "image/jpeg" }));
  } catch {
    return false;
  }
}
