import { describe, it, expect } from "vitest";
import { BREAKPOINTS, MAX, MQ, deviceClass, isCompact, CONTENT_MAX, TOUCH_TARGET } from "./breakpoints.js";

describe("breakpoints", () => {
  it("puts each real device in the band its layout was designed for", () => {
    // The left column is what the salon actually holds; if one of these moves band, the
    // shell it gets changes, so they are pinned rather than left to the numbers.
    const cases = [
      [320, "phone"], // iPhone SE (1st gen)
      [360, "phone"], // the common Android width
      [390, "phone"], // iPhone 14/15/16
      [414, "phone"], // iPhone Plus / Max
      [599, "phone"], // last pixel before the rail returns
      [600, "tablet"],
      [768, "tablet"], // iPad portrait
      [820, "tablet"], // iPad Air portrait — the OLD single breakpoint sat here
      [1023, "tablet"],
      [1024, "laptop"], // iPad landscape
      [1366, "laptop"], // the most common laptop width
      [1439, "laptop"],
      [1440, "desktop"],
      [1920, "wide"],
      [2560, "wide"], // 27" QHD
      [3440, "wide"], // ultrawide
    ];
    for (const [width, band] of cases) expect([width, deviceClass(width)]).toEqual([width, band]);
  });

  it("treats an unknown width as the original desktop layout rather than as a phone", () => {
    // A missing/NaN width must never silently hand a desktop the phone shell.
    expect(deviceClass(undefined)).toBe("laptop");
    expect(deviceClass(NaN)).toBe("laptop");
    expect(deviceClass(-1)).toBe("laptop");
  });

  it("calls exactly the phone and tablet bands compact", () => {
    expect(isCompact(599)).toBe(true);
    expect(isCompact(1023)).toBe(true);
    expect(isCompact(1024)).toBe(false);
    expect(isCompact(1920)).toBe(false);
  });

  it("leaves no gap or overlap between a max-width band and the min-width above it", () => {
    // An off-by-one here shows up as a width where two shells render at once, or neither.
    expect(MAX.phone).toBe(BREAKPOINTS.tablet - 1);
    expect(MAX.tablet).toBe(BREAKPOINTS.laptop - 1);
    expect(MAX.laptop).toBe(BREAKPOINTS.desktop - 1);
    expect(MAX.desktop).toBe(BREAKPOINTS.wide - 1);
  });

  it("builds media queries off the same numbers", () => {
    expect(MQ.phone).toBe("(max-width: 599px)");
    expect(MQ.compact).toBe("(max-width: 1023px)");
    expect(MQ.laptopUp).toBe("(min-width: 1024px)");
    // Input capability is a separate axis from width and must not be width-based.
    expect(MQ.coarse).toBe("(pointer: coarse)");
    expect(MQ.hover).toBe("(hover: hover)");
  });

  it("keeps the touch target at the iOS floor and the content cap above the old 1280", () => {
    expect(TOUCH_TARGET).toBeGreaterThanOrEqual(44);
    expect(CONTENT_MAX).toBeGreaterThan(1280);
  });
});
