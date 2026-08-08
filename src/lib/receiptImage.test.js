// @vitest-environment jsdom
//
// The pure half of rasterizing a receipt.
//
// jsdom is needed for one reason: DOMParser. The point of most of these tests is "would a real
// XML parser accept what we hand the browser", and asserting that against a regex instead of a
// parser would miss exactly the cases that break in production.
//
// renderReceiptJpeg() itself is not tested here: it needs a real layout engine and a real
// canvas encoder, and jsdom has neither (getBoundingClientRect returns zeroes, toBlob does not
// exist). Asserting against a stubbed canvas would only prove the stub was called. What IS
// tested is the string handling that decides whether the browser can parse the document at
// all — which is where this actually breaks, because <foreignObject> is XML and the receipt is
// written as HTML.
import { describe, it, expect } from "vitest";
import { toXhtml, svgWrapper, svgDataUrl, receiptFileName } from "./receiptImage.js";

describe("toXhtml", () => {
  it("converts &nbsp; to a numeric entity", () => {
    // The single most likely cause of a blank receipt: XML predefines only amp/lt/gt/quot/apos,
    // so a literal &nbsp; (which the receipt's meta line uses) aborts the whole parse.
    expect(toXhtml("Bill #4F2A9C &nbsp; 2026-08-08")).toBe("Bill #4F2A9C &#160; 2026-08-08");
  });

  it("self-closes void elements", () => {
    expect(toXhtml('<img class="logo" src="data:,x">')).toBe('<img class="logo" src="data:,x" />');
    expect(toXhtml("<br>")).toBe("<br />");
    // Already self-closed markup must survive untouched rather than gaining a second slash.
    expect(toXhtml('<img src="data:,x" />')).toBe('<img src="data:,x" />');
  });

  it("escapes a bare ampersand but leaves real entities alone", () => {
    expect(toXhtml("Cut & Curl")).toBe("Cut &amp; Curl");
    expect(toXhtml("Cut &amp; Curl")).toBe("Cut &amp; Curl");
    expect(toXhtml("&#39;")).toBe("&#39;");
    expect(toXhtml("&#x27;")).toBe("&#x27;");
  });

  it("leaves the characters that made us rasterize in the first place", () => {
    // ₹ and Devanagari are exactly why this is an image and not a PDF — they must pass through
    // as literal UTF-8, not get entity-mangled.
    expect(toXhtml("₹1,250 — ग्लो सैलून")).toBe("₹1,250 — ग्लो सैलून");
  });

  it("produces markup an XML parser accepts", () => {
    // The real assertion behind all of the above: does the browser's XML parser take it?
    const receipt = '<div class="rcpt"><img src="data:,x"><span>Cut & Curl</span>&nbsp;₹500</div>';
    const doc = new DOMParser().parseFromString(
      `<root>${toXhtml(receipt)}</root>`,
      "application/xml",
    );
    expect(doc.querySelector("parsererror")).toBe(null);
    expect(doc.documentElement.textContent).toContain("Cut & Curl");
    expect(doc.documentElement.textContent).toContain("₹500");
  });
});

describe("svgWrapper", () => {
  it("sizes both the svg and the foreignObject", () => {
    // Safari lays out an unsized foreignObject as zero-by-zero and draws nothing.
    const svg = svgWrapper("<div>x</div>", 272, 480);
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg" width="272" height="480"');
    expect(svg).toContain('<foreignObject x="0" y="0" width="272" height="480">');
    expect(svg).toContain('xmlns="http://www.w3.org/1999/xhtml"');
  });

  it("paints a white background", () => {
    // JPEG has no alpha: an unpainted background composites to black and the customer gets a
    // white-on-black receipt.
    expect(svgWrapper("<div/>", 10, 10)).toContain('fill="#ffffff"');
  });

  it("rounds fractional measurements up and never emits a zero dimension", () => {
    expect(svgWrapper("<div/>", 271.2, 479.6)).toContain('width="272" height="480"');
    expect(svgWrapper("<div/>", 0, 0)).toContain('width="1" height="1"');
  });

  it("is itself well-formed XML", () => {
    const doc = new DOMParser().parseFromString(svgWrapper(toXhtml("<div>₹9 &nbsp;</div>"), 10, 20), "image/svg+xml");
    expect(doc.querySelector("parsererror")).toBe(null);
  });
});

describe("svgDataUrl", () => {
  it("percent-encodes rather than base64-encodes", () => {
    // btoa throws on any code point above U+00FF, and a receipt always carries ₹.
    const url = svgDataUrl('<svg>₹</svg>');
    expect(url.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(url.slice("data:image/svg+xml;charset=utf-8,".length))).toBe("<svg>₹</svg>");
  });

  it("encodes the # that would otherwise truncate the data URL", () => {
    // An unencoded '#' (every hex colour in the receipt CSS) turns the rest into a fragment.
    expect(svgDataUrl("<svg fill='#000'/>")).not.toContain("#");
  });
});

describe("receiptFileName", () => {
  it("names the file after the bill ref and date", () => {
    expect(receiptFileName({ id: "sale-1723101abc4f2a9c", date: "2026-08-08" }))
      .toBe("Bill-4F2A9C-2026-08-08.jpg");
  });

  it("stays a legal filename whatever the sale looks like", () => {
    expect(receiptFileName({})).toBe("Bill.jpg");
    expect(receiptFileName({ id: "a/b\\c:d", date: "" })).toBe("Bill-B-C-D.jpg");
    expect(receiptFileName({ id: "s1", date: "2026-08-08" })).toBe("Bill-S1-2026-08-08.jpg");
  });
});
