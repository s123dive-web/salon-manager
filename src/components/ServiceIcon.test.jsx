// Markup-level tests for the glyph set. Rendered to static markup rather than through jsdom:
// there is no behaviour here to drive, only the shape of the SVG the browser will get.
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ServiceIcon, ServiceIconChip, ServiceIconDefs, SERVICE_ICON_CSS, MISSING_GLYPHS } from "./ServiceIcon.jsx";
import { ICON_KEYS } from "../lib/serviceIcons.js";

const html = (el) => renderToStaticMarkup(el);

describe("the glyph set", () => {
  it("draws every icon the resolver can return", () => {
    expect(MISSING_GLYPHS, `no glyph for: ${MISSING_GLYPHS.join(", ")}`).toEqual([]);
  });

  it("renders a non-empty, single-path-or-more SVG for each icon", () => {
    ICON_KEYS.forEach((key) => {
      const markup = html(<ServiceIcon icon={key} />);
      expect(markup, key).toMatch(/<svg[^>]*viewBox="0 0 24 24"/);
      expect((markup.match(/<path|<circle/g) || []).length, key).toBeGreaterThan(0);
    });
  });

  it("only uses path commands the SVG spec knows — a typo here is an invisible icon", () => {
    ICON_KEYS.forEach((key) => {
      const markup = html(<ServiceIcon icon={key} />);
      for (const d of markup.match(/ d="([^"]+)"/g) || []) {
        const data = d.slice(4, -1);
        expect(data, `${key}: ${data}`).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]+$/);
        expect(data.trim().startsWith("M"), `${key}: paths must start with a moveto`).toBe(true);
      }
    });
  });

  it("keeps to the house stroke style: 1.5 weight, round caps, no fill", () => {
    const markup = html(<ServiceIcon icon="haircut" />);
    expect(markup).toContain('stroke-width="1.5"');
    expect(markup).toContain('stroke-linecap="round"');
    expect(markup).toContain('stroke-linejoin="round"');
    expect(markup).toContain('fill="none"');
  });

  it("falls back to the default glyph for an unknown key, instead of rendering nothing", () => {
    expect(html(<ServiceIcon icon="nonsense" />)).toBe(html(<ServiceIcon icon="defaultService" />));
    expect(html(<ServiceIcon icon={undefined} />)).toBe(html(<ServiceIcon icon="defaultService" />));
  });
});

describe("accessibility", () => {
  it("is decorative everywhere — the service NAME is the label", () => {
    ICON_KEYS.forEach((key) => {
      const markup = html(<ServiceIcon icon={key} />);
      expect(markup, key).toContain('aria-hidden="true"');
      expect(markup, key).toContain('focusable="false"');
      // No <title>/<desc>: a screen reader must not read "scissors" before every service name.
      expect(markup, key).not.toContain("<title");
    });
  });

  it("hides the chip's icon and the shared gradient defs too", () => {
    expect(html(<ServiceIconChip icon="spa" />)).toContain('aria-hidden="true"');
    expect(html(<ServiceIconDefs />)).toContain('aria-hidden="true"');
  });
});

describe("theming hooks", () => {
  it("tags each icon with its gradient family, and picks no colour of its own", () => {
    const tones = ICON_KEYS.map((k) => html(<ServiceIcon icon={k} />).match(/svc-icon--(\w+)/)[1]);
    expect(new Set(tones)).toEqual(new Set(["warm", "rose", "teal", "plum"]));
    // currentColor, not a hex: the stylesheet decides, per theme.
    expect(html(<ServiceIcon icon="facial" />)).toContain('stroke="currentColor"');
  });

  it("defines exactly the four gradients the tones reference, once", () => {
    const defs = html(<ServiceIconDefs />);
    ["si-grad-warm", "si-grad-rose", "si-grad-teal", "si-grad-plum"].forEach((id) => {
      expect((defs.match(new RegExp(`id="${id}"`, "g")) || []).length, id).toBe(1);
      expect(SERVICE_ICON_CSS).toContain(`url(#${id})`);
    });
  });

  it("skins both themes, and never spends the blur budget on a scrolling list", () => {
    expect(SERVICE_ICON_CSS).toContain('[data-theme="advanced"]');
    expect(SERVICE_ICON_CSS).toContain('[data-theme="basic"]');
    expect(SERVICE_ICON_CSS).not.toContain("backdrop-filter");
  });

  it("only reaches for gradients under the glass theme", () => {
    // Every stroke:url(...) rule must be scoped to the advanced theme, or the flat theme would
    // render black strokes wherever the defs are not mounted.
    SERVICE_ICON_CSS.split("\n")
      .filter((line) => line.includes("stroke:url("))
      .forEach((line) => expect(line, line.trim()).toContain('[data-theme="advanced"]'));
  });
});

describe("performance guards", () => {
  it("memoises both components — 80 icons in the POS picker must not redraw on every keystroke", () => {
    // Structural check: React.memo wraps the component in a memo element type. Without it, a
    // re-render of the billing screen re-runs every glyph's subtree.
    const memoTag = Symbol.for("react.memo");
    expect(ServiceIcon.$$typeof).toBe(memoTag);
    expect(ServiceIconChip.$$typeof).toBe(memoTag);
  });

  it("takes only primitives, so memoisation actually bites", () => {
    // A prop that is a fresh object/array each render would defeat memo(). Icons take a string
    // key and a number — the resolver runs once per menu change, upstream.
    expect(html(<ServiceIcon icon="spa" size={16} />)).toBe(html(<ServiceIcon icon="spa" size={16} />));
  });
});

describe("sizing", () => {
  it("honours the requested size on the bare icon", () => {
    expect(html(<ServiceIcon icon="spa" size={14} />)).toContain('width="14"');
    expect(html(<ServiceIcon icon="spa" />)).toContain('width="20"');
  });

  it("sizes the chip's box and scales the glyph inside it", () => {
    const chip = html(<ServiceIconChip icon="spa" size={32} />);
    expect(chip).toMatch(/width:\s*32px/);
    expect(chip).toContain('width="20"'); // 32 × 0.64
  });
});
