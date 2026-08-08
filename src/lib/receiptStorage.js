// Firebase Storage adapter for customer receipt images — the thin half of src/lib/receipts.js.
//
// Everything with a decision in it (the message, the deep link, the path rule and why the phone
// number is kept out of it) lives in receipts.js, which is pure and unit-tested. This file is
// only the two calls that need the SDK, kept apart so the lib suites don't have to load
// Firebase to test a sentence of Hindi-English.
import { ref as sRef, uploadBytesResumable, getDownloadURL, deleteObject } from "firebase/storage";
import { storage } from "./firebase.js";
import { receiptPath, RECEIPT_CACHE_CONTROL } from "./receipts.js";

// uploadErrorMessage lives in receipts.js with the rest of the pure logic — re-exported here so
// a caller dealing with uploads has one import.
export { uploadErrorMessage } from "./receipts.js";

/**
 * How long a receipt upload gets before we give up on it.
 *
 * The SDK's own default is TEN MINUTES of exponential-backoff retries, which is a reasonable
 * default for a big file on a bad connection and a terrible one here: a receipt is ~60 KB and
 * the salon is standing at the till with the customer waiting. Worse, the retry is silent, so
 * a misconfigured project (no bucket provisioned → 404 on every attempt) presents as a button
 * that says "Preparing…" for ten minutes and then fails. Fail in twenty seconds and say why.
 */
export const UPLOAD_TIMEOUT_MS = 20000;

/**
 * Does the configured Storage bucket actually exist?
 *
 * Only ever called once an upload has already failed, and it exists because the SDK hides the
 * most likely cause: a project with Storage never enabled 404s on every attempt, but the SDK
 * treats that as retryable and eventually reports a plain timeout. "Check your connection" then
 * sends the owner chasing a network problem that isn't there. One unauthenticated GET tells the
 * two apart — 404 is a missing bucket, 403 is a bucket that exists and is (correctly) refusing
 * to list itself to an anonymous caller.
 */
async function bucketMissing() {
  const bucket = storage?.app?.options?.storageBucket;
  if (!bucket || typeof fetch !== "function") return false;
  try {
    const res = await fetch(`https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket)}/o?maxResults=1`);
    return res.status === 404;
  } catch {
    return false; // offline, blocked, anything else — don't claim a diagnosis we don't have
  }
}

/**
 * Upload a receipt JPEG and return its public download URL.
 *
 * Overwrites on re-send: the path is deterministic per sale, so sending the same bill twice
 * replaces the object instead of littering storage with copies of an identical receipt.
 *
 * Resumable rather than a one-shot uploadBytes purely so the task can be CANCELLED on timeout
 * — an abandoned one-shot upload keeps retrying in the background long after the user gave up.
 * `onProgress` is optional and reports 0..1.
 */
export async function uploadReceiptImage(saleId, file, onProgress) {
  const path = receiptPath(saleId, file?.name || "bill.jpg");
  const task = uploadBytesResumable(sRef(storage, path), file, {
    contentType: "image/jpeg",
    cacheControl: RECEIPT_CACHE_CONTROL,
  });

  let timer;
  // Cancelling the task makes it emit its own storage/canceled error. That is OUR cancel, and
  // reporting "Upload cancelled" would bury the reason we cancelled — so once the timer has
  // fired, the task's error is ignored and the refined error below is the one that lands.
  let timedOut = false;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(async () => {
        timedOut = true;
        try { task.cancel(); } catch { /* already settled */ }
        const e = new Error("Upload timed out");
        // Refine the diagnosis before giving up — see bucketMissing().
        e.code = (await bucketMissing()) ? "storage/bucket-not-found" : "storage/timeout";
        reject(e);
      }, UPLOAD_TIMEOUT_MS);
      task.on(
        "state_changed",
        (snap) => onProgress?.(snap.totalBytes ? snap.bytesTransferred / snap.totalBytes : 0),
        (err) => { if (!timedOut) reject(err); },
        resolve,
      );
    });
  } finally {
    clearTimeout(timer);
  }

  return { receiptURL: await getDownloadURL(task.snapshot.ref), receiptPath: path };
}

/** Best-effort delete, so removing a bill is never blocked by a missing/again-deleted file. */
export async function deleteReceiptImage(path) {
  if (!path) return;
  try { await deleteObject(sRef(storage, path)); }
  catch (e) { if (e?.code !== "storage/object-not-found") console.error("receipt delete failed", e); }
}
