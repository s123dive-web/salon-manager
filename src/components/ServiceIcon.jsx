// The drawing half of the service-icon system. The other half — which icon a service gets — is
// src/lib/serviceIcons.js, and it never touches React.
//
// Everything here is inline SVG on a 24-unit grid: no icon package, no image files, no network.
// The app has to start on a counter tablet with the Wi-Fi off, so an icon that needs fetching is
// not an icon, it is a blank square.
//
// House rules for the glyphs:
//   · 24×24 viewBox, stroke-only, 1.5 stroke weight, round caps and joins
//   · `stroke` is left to CSS. Icons never choose their own colour — that is the theme's job,
//     and it is what lets one stylesheet turn all 22 of them from flat ink into gilded glass.
//   · decorative: aria-hidden, focusable="false". The service NAME is the label, everywhere.
import { memo } from "react";
import { ICON_KEYS } from "../lib/serviceIcons.js";

// Which gradient family an icon belongs to in the glass theme. Grouped by the part of the salon
// the work belongs to, so a scan down the POS list reads as four colour families rather than 22
// unrelated ones. In the flat theme this only ever selects `currentColor`.
const ICON_TONE = {
  haircut: "warm", beard: "warm", hairColor: "warm", hairTreatment: "warm", hairStyle: "warm",
  facial: "rose", cleanup: "rose", waxing: "rose", threading: "rose", bleach: "rose",
  manicure: "plum", pedicure: "plum", nailArt: "plum", makeup: "plum", bridal: "plum", mehendi: "plum",
  massage: "teal", spa: "teal", bodyScrub: "teal", retailProduct: "teal", backbarProduct: "teal",
  defaultService: "warm",
};

// The glyphs. Kept as raw path data (not JSX) so the whole set reads as one table and a new icon
// is one line, not one component.
const GLYPHS = {
  // ── Hair ────────────────────────────────────────────────────────────────────────────────
  haircut: [                       // scissors
    { c: [6.2, 18, 2.6] }, { c: [17.8, 18, 2.6] },
    "M8.1 16.1 18.4 3.6", "M15.9 16.1 5.6 3.6",
  ],
  beard: [                         // safety razor
    "M12 21.2v-9.4",
    "M5.6 5.2h12.8a1.6 1.6 0 0 1 1.6 1.6v2.2a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 9V6.8a1.6 1.6 0 0 1 1.6-1.6Z",
    "M4 8h16", "M9.4 10.6v1.2M12 10.6v1.2M14.6 10.6v1.2",
  ],
  hairColor: [                     // tint bottle, half full
    "M10.2 3.2h3.6v2.6l2 2.6a4 4 0 0 1 .8 2.4v7.6a2.4 2.4 0 0 1-2.4 2.4H9.8a2.4 2.4 0 0 1-2.4-2.4v-7.6a4 4 0 0 1 .8-2.4l2-2.6Z",
    "M7.4 13h9.2",
    "M12 15.4c1 1.3 1.5 2.1 1.5 2.7a1.5 1.5 0 0 1-3 0c0-.6.5-1.4 1.5-2.7Z",
  ],
  hairTreatment: [                 // two conditioned strands + a shine
    "M9 21c-2.6-3.4-2.6-6.8 0-10.2 1.3-1.7 1.9-3.2 1.8-4.8",
    "M14.4 21c-2.6-3.4-2.6-6.8 0-10.2 1.3-1.7 1.9-3.2 1.8-4.8",
    "M5.4 3.6 6.1 5.9 8.4 6.6 6.1 7.3 5.4 9.6 4.7 7.3 2.4 6.6 4.7 5.9Z",
  ],
  hairStyle: [                     // blow dryer
    "M4.2 9a4.8 4.8 0 0 1 4.8-4.8h4.6a4.8 4.8 0 0 1 0 9.6H9A4.8 4.8 0 0 1 4.2 9Z",
    "M9.4 13.8 8.2 19.7a1.7 1.7 0 0 0 1.7 2h1.5",
    "M4.4 6.4 1.8 5.2M3.4 9H1M4.4 11.6 1.8 12.8",
  ],
  // ── Skin ────────────────────────────────────────────────────────────────────────────────
  facial: [                        // face + glow
    { c: [11, 12.6, 7.8] },
    "M8.4 10.8v1.2", "M13.6 10.8v1.2", "M8.2 15a4 4 0 0 0 5.6 0",
    "M19.6 2.6 20.2 4.3 21.9 4.9 20.2 5.5 19.6 7.2 19 5.5 17.3 4.9 19 4.3Z",
  ],
  cleanup: [                       // deep-cleanse droplets
    "M12 3.4c2.6 3 3.9 5.1 3.9 6.6a3.9 3.9 0 0 1-7.8 0c0-1.5 1.3-3.6 3.9-6.6Z",
    "M6.4 13.6c1.4 1.7 2.1 2.9 2.1 3.7a2.1 2.1 0 0 1-4.2 0c0-.8.7-2 2.1-3.7Z",
    "M17.6 13.6c1.4 1.7 2.1 2.9 2.1 3.7a2.1 2.1 0 0 1-4.2 0c0-.8.7-2 2.1-3.7Z",
  ],
  waxing: [                        // wax strip, lifted
    "M15.2 2.9a3.4 3.4 0 0 1 4.8 4.8L8.8 18.9a3.4 3.4 0 0 1-4.8-4.8Z",
    "M11.1 6.6 17.3 12.8", "M6.6 11.1 12.8 17.3",
  ],
  threading: [                     // thread spool
    "M8 3.6h8M8 15.6h8", "M9.6 3.6v12M14.4 3.6v12",
    "M9.6 6.6h4.8M9.6 9.6h4.8M9.6 12.6h4.8",
    "M14.4 15.6c.6 2.3 2.1 3.7 4.4 4.4",
  ],
  bleach: [                        // mixing bowl + brush
    "M3.2 12.4h12.4a6.2 6.2 0 0 1-12.4 0Z",
    "M14.8 12 20.6 4.4", "M17.1 6.4 19.9 8.6",
  ],
  // ── Nails ───────────────────────────────────────────────────────────────────────────────
  manicure: [                      // three fingers, nail beds marked
    "M4.6 21.2v-7.2a2.2 2.2 0 0 1 4.4 0v7.2",
    "M9.8 21.2v-9.2a2.2 2.2 0 0 1 4.4 0v9.2",
    "M15 21.2v-7.2a2.2 2.2 0 0 1 4.4 0v7.2",
    "M4.6 15.6h4.4M9.8 13.6h4.4M15 15.6h4.4",
  ],
  pedicure: [                      // foot + toes
    "M7.4 21c-1.9 0-3.2-1.4-3.2-3.4 0-2.8 1.5-4.2 1.5-7C5.7 8 7.2 6 9.6 6c2.3 0 3.6 1.8 3.6 4.6 0 3-1.4 4.4-1.4 6.8 0 2.2-1.3 3.6-3.2 3.6Z",
    { c: [15.6, 6.8, 1.15] }, { c: [17.6, 8.8, 1] }, { c: [18.8, 11.2, 0.9] }, { c: [19.4, 13.8, 0.8] },
  ],
  nailArt: [                       // painted nail + gems
    "M8.4 6.6h7.2v8.8a3.6 3.6 0 0 1-7.2 0Z",
    "M8.4 6.6a3.6 3.6 0 0 1 7.2 0", "M8.4 11.2h7.2",
    "M12 13 12.7 14.5 14.2 15.2 12.7 15.9 12 17.4 11.3 15.9 9.8 15.2 11.3 14.5Z",
    "M19.4 3.2 20 4.8 21.6 5.4 20 6 19.4 7.6 18.8 6 17.2 5.4 18.8 4.8Z",
  ],
  // ── Spa & body ──────────────────────────────────────────────────────────────────────────
  massage: [                       // shoulders, worked
    { c: [12, 6.4, 3] },
    "M5.6 19.8a6.4 6.4 0 0 1 12.8 0",
    "M2.6 14.6c1.2-1.3 2.7-1.3 3.9 0", "M17.5 14.6c1.2-1.3 2.7-1.3 3.9 0",
  ],
  spa: [                           // lotus on water
    "M12 4.2c2.1 2.4 2.1 6 0 8.4-2.1-2.4-2.1-6 0-8.4Z",
    "M12 12.6C9.4 14 6 13 4.4 10.4 7 9 10.4 10 12 12.6Z",
    "M12 12.6C14.6 14 18 13 19.6 10.4 17 9 13.6 10 12 12.6Z",
    "M4 17.6c1.6-1.3 3.2-1.3 4.8 0s3.2 1.3 4.8 0 3.2-1.3 4.8 0",
  ],
  bodyScrub: [                     // scrub jar + granules
    "M6 9.4h12v8.4a2.6 2.6 0 0 1-2.6 2.6H8.6A2.6 2.6 0 0 1 6 17.8Z",
    "M7.8 9.4V7a2 2 0 0 1 2-2h4.4a2 2 0 0 1 2 2v2.4",
    { c: [9.6, 13.4, 0.7] }, { c: [12.6, 12.4, 0.7] }, { c: [14.8, 15, 0.7] }, { c: [10.8, 16.6, 0.7] },
  ],
  // ── Makeup & occasion ───────────────────────────────────────────────────────────────────
  makeup: [                        // brush
    "M16 3.2a2.9 2.9 0 0 1 4.1 4.1l-2.3 2.3-4.1-4.1Z",
    "M13.7 5.5 17.8 9.6l-1.6 1.6-4.1-4.1Z",
    "M12.1 7.1 16.2 11.2 6.9 20.5a2.9 2.9 0 0 1-4.1-4.1Z",
  ],
  bridal: [                        // tiara
    "M3.6 18.4h16.8",
    "M3.6 18.4 6.2 8.8l4 4.6L12 5.6l1.8 7.8 4-4.6 2.6 9.6",
    { c: [12, 4.2, 1.1] }, { c: [6.2, 7.6, 0.9] }, { c: [17.8, 7.6, 0.9] },
  ],
  mehendi: [                       // henna-decorated palm
    "M6.6 21.2v-7.6a5.4 5.4 0 0 1 10.8 0v7.6",
    "M9.2 9.4V5.6M12 8.6V4.2M14.8 9.4V5.6", "M17.4 13.4 19.8 11",
    { c: [12, 15.8, 1.5] },
    "M12 12.8v1.2M12 17.6v1.2M8.9 15.8h1.2M13.9 15.8h1.2",
  ],
  // ── Stock ───────────────────────────────────────────────────────────────────────────────
  retailProduct: [                 // retail bottle, labelled
    "M10 2.8h4v2.4l1.7 2a3.4 3.4 0 0 1 .8 2.2v9.2a2.4 2.4 0 0 1-2.4 2.4H9.9a2.4 2.4 0 0 1-2.4-2.4V9.4a3.4 3.4 0 0 1 .8-2.2l1.7-2Z",
    "M7.5 11.8h9M7.5 15.4h5.4",
  ],
  backbarProduct: [                // backbar pump bottle
    "M6.6 9.6h10.8v9.4a2.4 2.4 0 0 1-2.4 2.4H9a2.4 2.4 0 0 1-2.4-2.4Z",
    "M11.8 9.6V5.2", "M11.8 5.2h3.8a1.8 1.8 0 0 1 1.8 1.8v1.4",
    "M8.8 13.6h6.8",
  ],
  defaultService: [                // sparkle
    "M12 3.2 13.9 9.3 20 11.2 13.9 13.1 12 19.2 10.1 13.1 4 11.2 10.1 9.3Z",
    "M18.6 16.4 19.1 17.9 20.6 18.4 19.1 18.9 18.6 20.4 18.1 18.9 16.6 18.4 18.1 17.9Z",
  ],
};

/** Every icon key the resolver can return must have something to draw. */
export const MISSING_GLYPHS = ICON_KEYS.filter((k) => !GLYPHS[k]);

/**
 * One service icon: bare inline SVG, no chip. Use this where the icon sits on top of something
 * that already has a background of its own — an appointment block, a coloured pill.
 *
 * Memoised: the POS picker draws one of these per service, and a keystroke in the search box or
 * a change in the cart must not re-run 80 SVG subtrees.
 */
export const ServiceIcon = memo(function ServiceIcon({ icon, size = 20, className = "" }) {
  const glyph = GLYPHS[icon] || GLYPHS.defaultService;
  const tone = ICON_TONE[icon] || "warm";
  return (
    <svg
      className={`svc-icon svc-icon--${tone}${className ? ` ${className}` : ""}`}
      width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth={1.5}
      strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      {glyph.map((part, i) =>
        typeof part === "string"
          ? <path key={i} d={part} />
          : <circle key={i} cx={part.c[0]} cy={part.c[1]} r={part.c[2]} />
      )}
    </svg>
  );
});

/**
 * A service icon in its chip — the form used in every list: POS picker, services table, visit
 * history, category headers.
 *
 * The chip's look is entirely the theme's business (see SERVICE_ICON_CSS): glass in `advanced`,
 * flat card in `basic`. Nothing here knows which is on.
 */
export const ServiceIconChip = memo(function ServiceIconChip({ icon, size = 28, iconSize }) {
  return (
    <span className="svc-chip" style={{ width: size, height: size, borderRadius: Math.round(size * 0.32) }}>
      <ServiceIcon icon={icon} size={iconSize || Math.round(size * 0.64)} />
    </span>
  );
});

/**
 * The gradient definitions, mounted ONCE at the app root — every icon in every list refers to
 * these four by url(#…), so 80 icons on the POS screen cost four gradients, not 320.
 *
 * Stop colours are CSS variables, so the gradients re-tint with the salon's colour theme without
 * this markup changing. Sized 0×0 rather than display:none, which would take the gradients out of
 * rendering in some browsers and leave every stroke black.
 *
 * Only mounted under the glass theme — the flat theme strokes in currentColor and never asks.
 */
export function ServiceIconDefs() {
  const stops = [
    ["si-grad-warm", "var(--accent)", "var(--accent-2)"],
    ["si-grad-rose", "var(--accent-2)", "var(--accent-plum)"],
    ["si-grad-teal", "var(--accent-teal)", "var(--accent)"],
    ["si-grad-plum", "var(--accent-plum)", "var(--accent-2)"],
  ];
  return (
    <svg
      width="0" height="0" aria-hidden="true" focusable="false"
      style={{ position: "absolute", width: 0, height: 0, overflow: "hidden" }}
    >
      <defs>
        {stops.map(([id, from, to]) => (
          // userSpaceOnUse over the 24-grid: the gradient runs the same way across every glyph,
          // instead of being squeezed into each individual path's bounding box.
          <linearGradient key={id} id={id} gradientUnits="userSpaceOnUse" x1="2" y1="2" x2="22" y2="22">
            <stop offset="0%" stopColor={from} />
            <stop offset="100%" stopColor={to} />
          </linearGradient>
        ))}
      </defs>
    </svg>
  );
}

/**
 * The two-theme skin for the icon system, appended to the app's stylesheet.
 *
 * `advanced` — the icon sits in a glass chip: a soft tinted fill, a hairline border and an inset
 * top highlight, with the stroke picking up one of four gradients.
 * `basic` — the same chip, flat: card background, one hairline, single-colour stroke, no
 * gradients requested at all.
 *
 * Deliberately NO backdrop-filter. These chips appear 80-at-a-time in scrolling lists, and the
 * blur budget is spent on surfaces that sit still.
 */
export const SERVICE_ICON_CSS = `
  /* Glass theme tokens. --accent/--accent-2 are the gold→rose pair the hair family strokes with;
     teal and plum carry the spa and nail families. */
  [data-theme="advanced"] {
    --accent:#C9962E; --accent-2:#DE6E92; --accent-teal:#2C9E97; --accent-plum:#8B5CF6;
    --glass-fill:linear-gradient(150deg, #ffffff 0%, var(--brand-soft) 100%);
    --glass-border:rgba(90,110,100,.20);
    --glass-shadow:0 1px 2px rgba(20,45,32,.10), inset 0 1px 0 rgba(255,255,255,.85);
  }
  [data-theme="basic"] {
    --glass-fill:#F6FAF6;
    --glass-border:#DDE8DE;
    --glass-shadow:none;
  }
  .svc-chip {
    position:relative; display:inline-grid; place-items:center; flex-shrink:0;
    background:var(--glass-fill, #F6FAF6);
    border:1px solid var(--glass-border, #DDE8DE);
    box-shadow:var(--glass-shadow, none);
    color:#40564A; overflow:hidden;
  }
  /* The inset top highlight that makes the chip read as glass rather than as a grey square. */
  [data-theme="advanced"] .svc-chip::before {
    content:""; position:absolute; left:0; right:0; top:0; height:48%;
    background:linear-gradient(rgba(255,255,255,.9), rgba(255,255,255,0));
    pointer-events:none;
  }
  .svc-icon { display:block; position:relative; }
  [data-theme="advanced"] .svc-icon--warm { stroke:url(#si-grad-warm); }
  [data-theme="advanced"] .svc-icon--rose { stroke:url(#si-grad-rose); }
  [data-theme="advanced"] .svc-icon--teal { stroke:url(#si-grad-teal); }
  [data-theme="advanced"] .svc-icon--plum { stroke:url(#si-grad-plum); }
  /* Last, so it beats the tone rules on source order: icons sitting on a saturated surface —
     an appointment block in the stylist's colour — take that surface's own text colour. A gold
     gradient on a purple block is unreadable at 14px. */
  .svc-on-color .svc-icon { stroke:currentColor; }
`;
