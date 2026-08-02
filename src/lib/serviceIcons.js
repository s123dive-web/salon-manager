// Which icon a service gets — resolved from its NAME, at render time.
//
// The rule this module exists to enforce: an icon is never baked into the data. Seed services,
// services typed in by the owner, and services restored from a three-year-old backup all go
// through the same resolver, so improving the keyword table improves every screen at once and
// no migration is ever needed. Nothing here writes anything.
//
// Pure module by design — no React, no DOM, no clock, no randomness. The drawing lives in
// src/components/ServiceIcon.jsx; this file only ever returns a key from ICON_KEYS.
//
// The salon speaks Hinglish. "Champi", "katori wax", "mehendi" and "malish" are what actually
// gets typed into the service name field in a Pune salon, so they are first-class keywords
// rather than an afterthought.

/** Every icon the app can draw. A resolver result is always one of these. */
export const ICON_KEYS = [
  "haircut", "beard", "hairColor", "hairTreatment", "hairStyle",
  "facial", "cleanup", "waxing", "threading", "bleach",
  "manicure", "pedicure", "nailArt",
  "massage", "spa", "bodyScrub",
  "makeup", "bridal", "mehendi",
  "retailProduct", "backbarProduct", "defaultService",
];

const KEY_SET = new Set(ICON_KEYS);

/**
 * Is this value one of our icon keys?
 *
 * Load-bearing beyond its size: `service.icon` is an OLD field that used to hold an emoji
 * (see seed.js), and still does for every service the app has ever seeded. Only a value that
 * is a real icon key counts as an owner's deliberate override — an emoji falls through to the
 * keyword table, and the receipt printer keeps using the emoji it has always used.
 */
export const isIconKey = (value) => typeof value === "string" && KEY_SET.has(value);

/** Human labels for the per-service override picker in Settings → Services. */
export const ICON_LABELS = {
  haircut: "Haircut", beard: "Beard / shave", hairColor: "Hair colour",
  hairTreatment: "Hair treatment", hairStyle: "Styling / blow dry",
  facial: "Facial", cleanup: "Clean-up", waxing: "Waxing", threading: "Threading",
  bleach: "Bleach / de-tan",
  manicure: "Manicure", pedicure: "Pedicure", nailArt: "Nail art / extensions",
  massage: "Massage", spa: "Spa", bodyScrub: "Body scrub / polish",
  makeup: "Makeup", bridal: "Bridal / occasion", mehendi: "Mehendi",
  retailProduct: "Retail product", backbarProduct: "Backbar product",
  defaultService: "Default",
};

/**
 * Last resort before `defaultService`: the service's category. Deliberately coarse — a Hair
 * service whose name told us nothing is still more usefully a pair of scissors than a star.
 */
export const CATEGORY_FALLBACK = {
  Hair: "haircut",
  Skin: "facial",
  Nails: "manicure",
  Spa: "spa",
  Makeup: "makeup",
  Other: "defaultService",
};

/**
 * A name, flattened for matching: lower-cased, every run of punctuation/whitespace (including
 * the em-dashes the seed menu is full of) collapsed to a single space, and wrapped in spaces so
 * a keyword can be tested at a word boundary.
 *
 *   "Haircut Women — Layer / Step Cut"  →  " haircut women layer step cut "
 */
export const normalizeName = (value) =>
  ` ${String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

/**
 * The keyword table, IN PRIORITY ORDER — the first rule with a hit wins. Order is the whole
 * design here, because salon service names overlap constantly. The constraints that fix this
 * ordering (each one is pinned by a test in serviceIcons.test.js):
 *
 *   • nails before hair      — "Nail Cut & File" must not be a haircut
 *   • beard before haircut   — "Beard Trim & Shape" is a beard, not a trim
 *   • beard before colour    — "Beard Colour" is a beard, not a hair colour
 *   • haircut before styling — "Advanced Style Cut" is a cut, not a blow-dry
 *   • styling before hair-treatment — "Hair Wash & Blow Dry" is styling; the wash is incidental
 *   • hair-treatment before spa      — "Hair Spa" is a hair treatment, not a body spa
 *   • massage/scrub before spa       — "Body Massage — Aroma" is a massage; "Body Polishing" a scrub
 *   • threading/wax/bleach before facial — "Threading — Full Face", "Face Wax", "Bleach — Face"
 *
 * Keywords match at a word START, so a stem covers its family: "wax" → waxing/waxes, "colour"
 * → colours. Multi-word keywords are matched as a phrase ("hair spa", "de tan").
 */
export const KEYWORD_RULES = [
  // Stock, not service. Only reachable from an inventory item's name; items normally resolve
  // through `stockType` below, long before this table is consulted.
  { icon: "backbarProduct", keywords: ["backbar", "back bar"] },
  { icon: "retailProduct", keywords: ["retail"] },

  // Occasion work first: "Bridal Makeup" is bridal, not makeup.
  { icon: "mehendi", keywords: ["mehendi", "mehandi", "mehndi", "henna", "heena"] },
  { icon: "bridal", keywords: ["bridal", "bride", "dulhan", "wedding", "saree", "sari", "drap"] },
  { icon: "makeup", keywords: ["makeup", "make up", "lipstick", "kajal", "contour", "eyeliner"] },

  // Nails before everything hair-shaped: "Nail Cut & File" contains "cut".
  { icon: "nailArt", keywords: ["nail art", "nail extension", "nail polish", "gel polish", "acrylic nail", "overlay"] },
  { icon: "pedicure", keywords: ["pedicure", "pedi", "foot spa"] },
  { icon: "manicure", keywords: ["manicure", "mani", "cuticle", "nail cut", "nail file", "nail"] },

  // Skin, specific → general. Each of these would otherwise be swallowed by "facial".
  { icon: "threading", keywords: ["threading", "thread", "eyebrow", "upper lip", "forehead"] },
  { icon: "waxing", keywords: ["wax", "rica", "katori", "chocolate wax", "strip"] },
  { icon: "bleach", keywords: ["bleach", "de tan", "detan", "d tan", "tan removal"] },
  { icon: "cleanup", keywords: ["clean up", "cleanup", "cleansing", "deep clean"] },
  { icon: "facial", keywords: ["facial", "face pack", "hydra", "anti ageing", "anti aging", "peel", "glow", "face"] },

  // Body work before "spa", which is the vaguest word on any salon menu.
  { icon: "massage", keywords: ["massage", "champi", "malish", "maalish", "reflexology", "abhyanga", "shoulder", "acupressure"] },
  { icon: "bodyScrub", keywords: ["scrub", "polishing", "body polish", "exfoliat", "ubtan", "loofah"] },

  // Hair. Beard first (a beard trim is not a haircut), then cut, then style, then colour, then
  // treatment — and only then the catch-all "spa".
  { icon: "beard", keywords: ["beard", "shave", "moustache", "mustache", "stubble", "razor", "daadhi", "dadhi"] },
  { icon: "haircut", keywords: ["haircut", "hair cut", "trim", "cut", "layer", "fringe", "bang"] },
  { icon: "hairStyle", keywords: ["blow dry", "blowdry", "ironing", "iron", "straighten", "tong", "curl", "updo", "styling", "style", "bun", "braid", "chignon", "hair set"] },
  { icon: "hairColor", keywords: ["colour", "color", "highlight", "balayage", "ombre", "root touch", "toner", "streak", "global", "dye", "mehroon", "burgundy"] },
  { icon: "hairTreatment", keywords: ["hair spa", "head spa", "treatment", "keratin", "botox", "smoothening", "smoothing", "rebonding", "dandruff", "hair fall", "hairfall", "hair wash", "shampoo", "conditioning", "hair mask", "scalp", "protein", "olaplex", "nanoplastia", "serum"] },
  { icon: "spa", keywords: ["spa", "steam", "sauna", "aroma", "jacuzzi", "wellness", "therapy"] },
];

/**
 * The icon for a service (or an inventory item), in four steps:
 *
 *   1. an explicit `service.icon` the owner picked in Settings → Services
 *   2. `stockType`, for inventory items — retail bottle vs backbar pump
 *   3. the keyword table above, matched against the name
 *   4. the category, and finally `defaultService`
 *
 * Total and deterministic: same input, same key, always. Never throws — a null, a number or a
 * half-typed form row all resolve to `defaultService`.
 */
export function resolveIcon(service) {
  if (!service || typeof service !== "object") return "defaultService";

  // 1. The owner's deliberate override wins over anything we could infer. An emoji in this
  //    field is legacy seed data, not an override — isIconKey() is what tells them apart.
  if (isIconKey(service.icon)) return service.icon;

  // 2. Inventory items: what the bottle is FOR beats what is in it.
  const stockType = String(service.stockType || "").trim().toLowerCase();
  if (stockType === "backbar") return "backbarProduct";
  if (stockType === "retail") return "retailProduct";

  // 3. The name.
  const hay = normalizeName(service.name);
  if (hay.trim()) {
    for (const rule of KEYWORD_RULES) {
      if (rule.keywords.some((kw) => hay.includes(` ${kw}`))) return rule.icon;
    }
  }

  // 4. The category — matched case-insensitively, because a restored backup may carry "hair".
  const category = String(service.category || "").trim().toLowerCase();
  for (const key of Object.keys(CATEGORY_FALLBACK)) {
    if (key.toLowerCase() === category) return CATEGORY_FALLBACK[key];
  }
  return "defaultService";
}

/** Convenience for callers that hold a name and a category but no service record. */
export const resolveIconFor = (name, category = "") => resolveIcon({ name, category });
