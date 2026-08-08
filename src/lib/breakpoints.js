// Breakpoints — the single source for every width at which the app changes shape.
//
// Pure data and string builders: no React, no DOM. The CSS block in salon-manager.jsx, the
// useMediaQuery hook and the responsive tests all read these same numbers, so a breakpoint
// can be moved in one place instead of drifting between three hand-typed copies.
//
// The five bands are chosen from what the salon actually runs on, not from a framework's
// defaults:
//
//   phone    ≤ 599   a phone held in one hand at the counter. No room for a rail at all —
//                    navigation moves to a bottom tab bar within thumb reach.
//   tablet   600–1023 an iPad/Android tab, either orientation, and a small laptop window.
//                    A 210px rail would eat a third of a 768px portrait screen, so the rail
//                    collapses to icons and the two-pane splits stack.
//   laptop   1024–1439 the original desktop layout, unchanged.
//   desktop  1440–1919 same layout, content allowed to grow to CONTENT_MAX.
//   wide     ≥ 1920  same again; the calendar and wide tables may run past CONTENT_MAX.
//
// Note the bands are keyed on the LOWER bound of the next band up (600, 1024, …) because
// that is how `min-width` queries read; MAX_* holds the matching `max-width` value, which is
// always one pixel less. Deriving one from the other keeps a phone at exactly 600px CSS
// pixels out of both the phone and the tablet rule's overlap.

/** Lower bound (inclusive) of each band, in CSS pixels. */
export const BREAKPOINTS = {
  tablet: 600,
  laptop: 1024,
  desktop: 1440,
  wide: 1920,
};

/** Upper bound (inclusive) of the band below each breakpoint — for `max-width` queries. */
export const MAX = {
  phone: BREAKPOINTS.tablet - 1, // 599
  tablet: BREAKPOINTS.laptop - 1, // 1023
  laptop: BREAKPOINTS.desktop - 1, // 1439
  desktop: BREAKPOINTS.wide - 1, // 1919
};

/**
 * Media-query strings, named for what they mean to the app rather than for their width.
 * `compact` is the important one: it covers phone AND tablet, i.e. every width where the
 * full 210px sidebar does not earn its space.
 */
export const MQ = {
  phone: `(max-width: ${MAX.phone}px)`,
  tabletUp: `(min-width: ${BREAKPOINTS.tablet}px)`,
  tablet: `(min-width: ${BREAKPOINTS.tablet}px) and (max-width: ${MAX.tablet}px)`,
  compact: `(max-width: ${MAX.tablet}px)`, // phone + tablet: no full rail
  laptopUp: `(min-width: ${BREAKPOINTS.laptop}px)`,
  desktopUp: `(min-width: ${BREAKPOINTS.desktop}px)`,
  wideUp: `(min-width: ${BREAKPOINTS.wide}px)`,
  // Input capability, which is NOT the same question as width: a 1024px tablet is a wide
  // screen driven by a fingertip, and a 900px laptop window is a narrow one driven by a
  // mouse. Touch sizing hangs off `coarse`; hover styling hangs off `hover`.
  coarse: `(pointer: coarse)`,
  hover: `(hover: hover)`,
};

/** Widest the main content column is allowed to get. Was 1280; see the layout notes. */
export const CONTENT_MAX = 1600;

/** Minimum tap target on a coarse pointer — 44px is the iOS HIG floor and clears Android's 48dp
 *  once the 8px gap between targets is counted. Applied only under MQ.coarse, so a mouse-driven
 *  desktop keeps its original density. */
export const TOUCH_TARGET = 44;

/** Sidebar widths: the full rail, and the icon-only rail used across the tablet band. */
export const RAIL_WIDTH = 210;
export const RAIL_WIDTH_ICONS = 64;

/**
 * Which band a viewport width falls in.
 * @param {number} width viewport width in CSS pixels
 * @returns {"phone"|"tablet"|"laptop"|"desktop"|"wide"}
 */
export function deviceClass(width) {
  if (!(width >= 0)) return "laptop"; // NaN/undefined/negative: assume the original layout
  if (width < BREAKPOINTS.tablet) return "phone";
  if (width < BREAKPOINTS.laptop) return "tablet";
  if (width < BREAKPOINTS.desktop) return "laptop";
  if (width < BREAKPOINTS.wide) return "desktop";
  return "wide";
}

/** True where the full 210px sidebar is replaced (phone tab bar, or tablet icon rail). */
export const isCompact = (width) => deviceClass(width) === "phone" || deviceClass(width) === "tablet";
