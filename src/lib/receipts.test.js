// The pure half of sending a bill on WhatsApp: the message, the deep link, the storage path.
//
// The upload itself (uploadReceiptImage / deleteReceiptImage) is a thin Firebase Storage
// adapter and is deliberately not tested here — it has no logic of its own, and standing up
// the Storage emulator to assert that uploadBytes was called would test the SDK, not this app.
// What IS worth pinning is everything a customer actually sees, plus the path rule that keeps
// their phone number out of a public URL.
import { describe, it, expect } from "vitest";
import { receiptMessage, receiptPath, receiptWaLink, uploadErrorMessage } from "./receipts.js";

const STORE = { name: "Glow Salon" };
const SALE = {
  id: "sale-1723101abc4f2a9c",
  date: "2026-08-08",
  total: 1250,
  customer: "Asha Patil",
  customerPhone: "9876543210",
};

describe("receiptMessage", () => {
  it("greets by first name and states the shop, ref and total", () => {
    const msg = receiptMessage(SALE, STORE, "https://example.test/bill.jpg");
    // First name only — "Hi Asha" reads like a person, "Hi Asha Patil" reads like a bank.
    expect(msg).toContain("Hi Asha!");
    expect(msg).not.toContain("Patil");
    expect(msg).toContain("Glow Salon");
    expect(msg).toContain("#4F2A9C"); // last 6 of the id, uppercased — matches the printed ref
    expect(msg).toContain("Rs.1250");
    expect(msg).toContain("https://example.test/bill.jpg");
  });

  it("writes Rs. rather than ₹", () => {
    // The message is URL-encoded into a deep link and read inside WhatsApp, where the rupee
    // glyph still renders wrong on a fair number of older Android fonts.
    expect(receiptMessage(SALE, STORE, "")).not.toContain("₹");
  });

  it("drops a trailing .00 but keeps real paise", () => {
    expect(receiptMessage({ ...SALE, total: 1250 }, STORE)).toContain("Rs.1250");
    expect(receiptMessage({ ...SALE, total: 1250.5 }, STORE)).toContain("Rs.1250.50");
  });

  it("omits the URL line entirely when there is no URL", () => {
    // The share flow attaches the image itself; a dangling blank line would ship with it.
    const msg = receiptMessage(SALE, STORE);
    expect(msg.split("\n").every((l) => l.trim() !== "")).toBe(true);
  });

  it("stays sensible for a walk-in with no name and no shop name", () => {
    const msg = receiptMessage({ id: "x", total: 300 }, {});
    expect(msg).toContain("Hi!");
    expect(msg).toContain("Rs.300");
    expect(msg).not.toContain("undefined");
    expect(msg).not.toContain("NaN");
  });
});

describe("receiptWaLink", () => {
  it("addresses the customer's phone with the 91 prefix and encodes the message", () => {
    const link = receiptWaLink(SALE, STORE, "https://example.test/b.jpg");
    expect(link.startsWith("https://wa.me/919876543210?text=")).toBe(true);
    expect(decodeURIComponent(link.split("?text=")[1])).toBe(
      receiptMessage(SALE, STORE, "https://example.test/b.jpg"),
    );
  });

  it("falls back to the bill's own mobile field when no customer is linked", () => {
    const link = receiptWaLink({ ...SALE, customerPhone: "", mobile: "98765 43210" }, STORE, "");
    expect(link.startsWith("https://wa.me/919876543210")).toBe(true);
  });
});

describe("receiptPath", () => {
  it("keys on the sale id and never the phone number", () => {
    // The object is world-readable (see storage.rules): a guessable or identifying path would
    // turn "unlisted" into "enumerable".
    const path = receiptPath(SALE.id, "Bill-4F2A9C-2026-08-08.jpg");
    expect(path).toBe("shop/receipts/sale-1723101abc4f2a9c/Bill-4F2A9C-2026-08-08.jpg");
    expect(path).not.toContain("9876543210");
  });

  it("strips path traversal out of both segments", () => {
    // Both halves are attacker-adjacent: the id comes off a synced record, the filename is
    // built from it. Taking the basename removes traversal by construction — a sanitizer that
    // only replaced the slashes would leave ".." intact in a path handed to Storage.
    const path = receiptPath("../../etc", "../../../secret key.jpg");
    expect(path).toBe("shop/receipts/etc/secret_key.jpg");
    expect(path).not.toContain("..");
  });

  it("survives a windows-style path and an empty segment", () => {
    expect(receiptPath("..\\..\\admin", "..\\x.jpg")).toBe("shop/receipts/admin/x.jpg");
    expect(receiptPath("", "")).toBe("shop/receipts/unknown/bill.jpg");
    expect(receiptPath("...", "...")).toBe("shop/receipts/unknown/bill.jpg");
  });

  it("is deterministic, so re-sending replaces rather than litters", () => {
    expect(receiptPath("s1", "a.jpg")).toBe(receiptPath("s1", "a.jpg"));
  });
});

describe("uploadErrorMessage", () => {
  it("names the fix for a project with no Storage bucket", () => {
    // The state a fresh Firebase project is actually in. The SDK calls this "an unknown error";
    // the owner needs to be told to enable Storage.
    const msg = uploadErrorMessage({ code: "storage/unknown" });
    expect(msg).toContain("Cloud Storage isn't set up");
    expect(msg).toContain("firebase deploy --only storage");
  });

  it("names the fix for undeployed rules", () => {
    expect(uploadErrorMessage({ code: "storage/unauthorized" })).toContain("firebase deploy --only storage");
  });

  it("points a timeout at the flow that needs no upload at all", () => {
    expect(uploadErrorMessage({ code: "storage/timeout" })).toContain("Share bill");
  });

  it("falls back to the raw message, then to something non-empty", () => {
    expect(uploadErrorMessage({ message: "boom" })).toBe("boom");
    expect(uploadErrorMessage(undefined)).toBe("Upload failed");
    expect(uploadErrorMessage({})).toBe("Upload failed");
  });
});
