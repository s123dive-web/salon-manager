// Sending a customer their bill on WhatsApp.
//
// ── The constraint everything here is shaped by ──────────────────────────────────────────
// A wa.me deep link carries a phone number and TEXT. It cannot carry a file. That is not a
// gap to work around with a library — it is the documented surface — so "send the bill" splits
// into two genuinely different deliveries, and the app offers both:
//
//   LINK  — upload the JPEG, put its URL in the message, open the customer's chat with the
//           text pre-filled. The recipient is pre-selected, so the right person gets it; the
//           customer taps a link to see the bill. Needs the network.
//   SHARE — hand the JPEG to the OS share sheet (navigator.share) and let the user pick
//           WhatsApp. The bill lands in the chat as a real inline image, and it works with no
//           connection because WhatsApp queues it. The user must pick the contact themselves.
//
// Neither automates the send: a human presses send in WhatsApp, exactly as with the reminder
// queue (see reminders.js). No WhatsApp Business API, no unofficial libraries.
//
// ── Why the uploaded file is world-readable, and why that is acceptable ──────────────────
// The customer opening the link is not signed in — they cannot be — so shop/receipts/** is
// public-read in storage.rules. What protects a receipt is that its URL is unguessable:
// Firebase mints a random download token per object, and the path is keyed on the SALE ID.
// The phone number is deliberately NOT in the path. Anyone with the link sees one bill; nobody
// can enumerate or guess a second. Uploading is still restricted to signed-in staff.
//
// This module stays PURE — everything a customer reads, with no Firebase in it — so it tests in
// milliseconds with no emulator. The upload that puts the file somewhere is the thin adapter
// next door in receiptStorage.js.
import { waLink } from "./reminders.js";

/**
 * One path segment, with no way out of it.
 *
 * Takes the BASENAME first and only then sanitizes: a filename keeps its dot (it needs the
 * .jpg), and merely replacing the slashes in "../../x" would leave the ".." sitting in a path
 * that gets handed straight to Firebase Storage. Dropping everything up to the last slash
 * removes traversal by construction rather than by blocklist.
 */
const safeSegment = (v, fallback) => {
  const s = String(v ?? "")
    .replace(/\\/g, "/")
    .split("/").pop()
    .replace(/[^\w.-]+/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^[._-]+/, "");
  return s || fallback;
};

/** Where a sent receipt lives. Sale id only — never the customer's phone (see header). */
export const receiptPath = (saleId, fileName) =>
  `shop/receipts/${safeSegment(saleId, "unknown")}/${safeSegment(fileName, "bill.jpg")}`;

/**
 * The message that arrives with the bill.
 *
 * Kept short on purpose: it sits under a link preview in the chat, and a salon sending a
 * paragraph reads like a marketing blast rather than a receipt. `url` is optional — the share
 * flow attaches the image itself and needs no link.
 */
export function receiptMessage(sale, store = {}, url = "") {
  const shop = String(store.name || "").trim();
  const name = String(sale?.customer || "").trim().split(/\s+/)[0];
  const amount = Number(sale?.total) || 0;
  // "Rs." not "₹": the message is URL-encoded into a deep link and read inside WhatsApp,
  // where a rupee glyph still renders wrong on a fair number of older Android keyboards/fonts.
  const total = "Rs." + amount.toFixed(2).replace(/\.00$/, "");
  const ref = String(sale?.id || "").slice(-6).toUpperCase();

  const lines = [
    `${name ? `Hi ${name}! ` : "Hi! "}Here's your bill${shop ? ` from ${shop}` : ""}${ref ? ` (#${ref})` : ""} — ${total}.`,
  ];
  if (url) lines.push(url);
  lines.push("Thank you, see you again!");
  return lines.join("\n");
}

/**
 * The wa.me link that opens this customer's chat with the message ready to send.
 *
 * Reuses waLink() from the reminder queue rather than rebuilding the 91-prefix rule — there
 * is one right answer for "how does this shop address an Indian mobile" and it is tested there.
 */
export const receiptWaLink = (sale, store, url) =>
  waLink(sale?.customerPhone || sale?.mobile || "", receiptMessage(sale, store, url));

/** Cache header for an uploaded receipt: a bill never changes once rung up. */
export const RECEIPT_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * Turn a Firebase Storage error into something a salon owner can act on.
 *
 * Every one of these is a SETUP problem with a specific fix, and the raw SDK message ("Firebase
 * Storage: An unknown error occurred") names none of them. The two that actually happen on a
 * fresh project are a bucket that was never created and rules that were never deployed —
 * neither is a bug in the app, and both are invisible unless the message says so.
 */
export function uploadErrorMessage(err) {
  switch (err?.code) {
    case "storage/unauthorized":
      return "Storage rules reject this upload — deploy them with: firebase deploy --only storage";
    case "storage/unauthenticated":
      return "Signed out — sign in again and retry";
    case "storage/retry-limit-exceeded":
    case "storage/timeout":
      return "Upload timed out — check the connection, or use Share bill instead";
    case "storage/quota-exceeded":
      return "Storage quota is full";
    case "storage/canceled":
      return "Upload cancelled";
    // A bucket that does not exist surfaces as an opaque unknown/404, not a named code.
    case "storage/unknown":
    case "storage/object-not-found":
    case "storage/bucket-not-found":
    case "storage/project-not-found":
      return "Cloud Storage isn't set up for this Firebase project — enable Storage in the Firebase console, then: firebase deploy --only storage";
    default:
      return err?.message || "Upload failed";
  }
}
