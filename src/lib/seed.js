// First-run seed data for Salon Manager.
//
// Seeding follows the same discipline as the grocery core's catalogue: it is written ONCE,
// when the slice is empty, and never overwrites anything that already exists. A salon that has
// edited its menu must never have its prices reset by a redeploy.
//
// Everything here is a starting point, not a fixture: prices are typical Pune mid-market rates
// and every field is editable in-app. No customers are seeded — that data is real or it is
// nothing.
//
// The builders take `uid` and `today` as arguments rather than importing them, so this module
// stays pure and testable (no clock, no randomness of its own).

// ── Services ────────────────────────────────────────────────────────────────────────────
export const SERVICE_CATEGORIES = ["Hair", "Skin", "Nails", "Spa", "Makeup", "Other"];

export const SERVICE_CATEGORY_ICONS = {
  Hair: "💇",
  Skin: "🧖",
  Nails: "💅",
  Spa: "🌿",
  Makeup: "💄",
  Other: "✨",
};

export const serviceIconFor = (category) => SERVICE_CATEGORY_ICONS[category] || "✨";

// [name, category, durationMin, price, commissionPct, rebookCycleDays]
//
// rebookCycleDays drives the Reminders queue: it is how long after this service the customer
// is typically due again. 0 = never prompt (one-off / occasion work like bridal makeup).
// Commission tracks skill: chemical and spa work pays more than a trim.
const SERVICES = [
  // ---- Hair · Women -------------------------------------------------------------------
  ["Haircut Women — Trim", "Hair", 30, 400, 10, 45],
  ["Haircut Women — Layer / Step Cut", "Hair", 45, 700, 10, 45],
  ["Haircut Women — Advanced Style Cut", "Hair", 60, 1200, 12, 45],
  ["Fringe / Bang Trim", "Hair", 15, 200, 8, 30],
  ["Hair Wash — Women", "Hair", 20, 300, 8, 21],
  ["Hair Wash & Blow Dry", "Hair", 30, 500, 10, 21],
  ["Blow Dry — Long Hair", "Hair", 40, 700, 10, 21],
  ["Ironing / Straightening (temporary)", "Hair", 45, 800, 10, 21],
  ["Tonging / Curls", "Hair", 45, 900, 10, 21],
  ["Head Massage (30 min)", "Hair", 30, 600, 12, 30],
  ["Hair Spa — Basic", "Hair", 60, 1200, 12, 30],
  ["Hair Spa — Advanced", "Hair", 75, 1800, 12, 30],
  ["Dandruff Treatment", "Hair", 60, 1500, 12, 30],
  ["Hair Fall Treatment", "Hair", 60, 2000, 12, 30],
  ["Root Touch-up (ammonia-free)", "Hair", 45, 1200, 12, 30],
  ["Global Hair Colour — Women", "Hair", 120, 3000, 12, 60],
  ["Highlights — Partial", "Hair", 120, 2500, 12, 90],
  ["Highlights — Full", "Hair", 180, 4500, 12, 90],
  ["Balayage / Ombre", "Hair", 210, 5500, 15, 120],
  ["Keratin Treatment", "Hair", 180, 5500, 15, 120],
  ["Hair Botox Treatment", "Hair", 180, 6000, 15, 120],
  ["Smoothening", "Hair", 180, 5000, 15, 150],
  ["Rebonding", "Hair", 210, 6500, 15, 180],

  // ---- Hair · Men ---------------------------------------------------------------------
  ["Haircut Men", "Hair", 30, 250, 10, 21],
  ["Haircut Men — Style Cut", "Hair", 40, 400, 10, 21],
  ["Kids Haircut (under 10)", "Hair", 30, 250, 10, 30],
  ["Head Shave", "Hair", 20, 200, 8, 21],
  ["Beard Trim & Shape", "Hair", 20, 200, 8, 14],
  ["Clean Shave", "Hair", 20, 150, 8, 14],
  ["Beard Colour", "Hair", 30, 400, 10, 30],
  ["Hair Colour Men — Global", "Hair", 45, 800, 12, 30],
  ["Hair Wash — Men", "Hair", 15, 150, 8, 21],
  ["Hair Spa — Men", "Hair", 45, 800, 12, 30],

  // ---- Skin ---------------------------------------------------------------------------
  ["Threading — Eyebrow", "Skin", 10, 50, 8, 14],
  ["Threading — Upper Lip", "Skin", 5, 30, 8, 14],
  ["Threading — Forehead", "Skin", 5, 30, 8, 14],
  ["Threading — Full Face", "Skin", 25, 250, 8, 21],
  ["Face Wax", "Skin", 20, 300, 10, 21],
  ["Underarms Wax", "Skin", 10, 150, 10, 21],
  ["Full Arms Wax", "Skin", 30, 400, 10, 28],
  ["Full Legs Wax", "Skin", 40, 600, 10, 28],
  ["Rica Wax — Full Arms", "Skin", 30, 600, 10, 28],
  ["Rica Wax — Full Legs", "Skin", 45, 900, 10, 28],
  ["Full Body Wax", "Skin", 90, 2500, 12, 30],
  ["Bleach — Face", "Skin", 25, 500, 10, 21],
  ["De-Tan Pack — Face", "Skin", 30, 700, 10, 21],
  ["Clean-up — Basic", "Skin", 30, 600, 10, 21],
  ["Clean-up — Fruit", "Skin", 40, 800, 10, 21],
  ["Facial — Fruit", "Skin", 60, 1200, 12, 30],
  ["Facial — Gold", "Skin", 75, 1800, 12, 30],
  ["Facial — Diamond", "Skin", 75, 2200, 12, 30],
  ["Facial — Hydra", "Skin", 90, 2800, 12, 30],
  ["Facial — Anti-Ageing", "Skin", 90, 3000, 12, 30],
  ["Men Clean-up", "Skin", 30, 600, 10, 21],
  ["Men Facial — Basic", "Skin", 45, 900, 12, 30],
  ["Men De-Tan", "Skin", 30, 700, 10, 21],

  // ---- Nails --------------------------------------------------------------------------
  ["Nail Cut & File", "Nails", 20, 200, 8, 21],
  ["Nail Polish Application", "Nails", 20, 200, 8, 14],
  ["Manicure — Basic", "Nails", 40, 500, 10, 21],
  ["Manicure — Spa", "Nails", 60, 900, 12, 21],
  ["Pedicure — Basic", "Nails", 45, 700, 10, 21],
  ["Pedicure — Spa", "Nails", 60, 1200, 12, 21],
  ["Gel Polish", "Nails", 60, 1200, 12, 21],
  ["Nail Extensions (full set)", "Nails", 120, 2500, 15, 21],
  ["Nail Extension Refill", "Nails", 90, 1500, 12, 21],
  ["Nail Art (per nail)", "Nails", 15, 150, 12, 0],

  // ---- Spa ----------------------------------------------------------------------------
  ["Head, Neck & Shoulder Massage", "Spa", 30, 800, 15, 21],
  ["Back Massage (30 min)", "Spa", 30, 1000, 15, 21],
  ["Foot Reflexology", "Spa", 45, 1200, 15, 21],
  ["Body Massage — Swedish (60 min)", "Spa", 60, 2000, 15, 30],
  ["Body Massage — Deep Tissue (60 min)", "Spa", 60, 2500, 15, 30],
  ["Body Massage — Aroma (90 min)", "Spa", 90, 3000, 15, 30],
  ["Body Polishing", "Spa", 90, 3500, 15, 60],

  // ---- Makeup — occasion work, so no rebook cycle --------------------------------------
  ["Saree Draping", "Makeup", 30, 800, 12, 0],
  ["Hair Styling — Updo", "Makeup", 60, 1500, 12, 0],
  ["Party Makeup", "Makeup", 60, 2500, 15, 0],
  ["Makeup Trial", "Makeup", 90, 3000, 15, 0],
  ["Engagement Makeup", "Makeup", 90, 6000, 15, 0],
  ["Reception Makeup", "Makeup", 120, 8000, 15, 0],
  ["Bridal Makeup — HD", "Makeup", 150, 15000, 15, 0],
];

export const buildServices = ({ uid, today = "" }) =>
  SERVICES.map(([name, category, durationMin, price, commissionPct, rebookCycleDays]) => ({
    id: uid(),
    name,
    category,
    durationMin,
    price,
    commissionPct,
    rebookCycleDays,
    active: true,
    icon: serviceIconFor(category),
    createdAt: today,
  }));

// ── Products (the `items` slice) ─────────────────────────────────────────────────────────
// Salon stock splits in two:
//   retail  — sold over the counter to the customer, profit tracked as usual.
//   backbar — consumed while performing a service; never rung up on its own, but it still
//             has to be counted, reordered and valued. `stockType` is the only new field.
export const PRODUCT_CATEGORIES = [
  "Hair Care", "Skin Care", "Nail Care", "Colour & Chemicals",
  "Waxing & Threading", "Spa & Massage", "Consumables", "Tools & Styling", "Other",
];

export const PRODUCT_CATEGORY_ICONS = {
  "Hair Care": "🧴",
  "Skin Care": "🧖",
  "Nail Care": "💅",
  "Colour & Chemicals": "🎨",
  "Waxing & Threading": "🪒",
  "Spa & Massage": "🌿",
  Consumables: "🧻",
  "Tools & Styling": "✂️",
  Other: "📦",
};

export const STOCK_TYPES = ["retail", "backbar"];

// [name, category, unit, buyPrice, sellPrice, lowAt, stockType]
const PRODUCTS = [
  // ---- Retail: hair -------------------------------------------------------------------
  ["Professional Shampoo 300ml", "Hair Care", "pc", 620, 780, 3, "retail"],
  ["Professional Conditioner 300ml", "Hair Care", "pc", 640, 800, 3, "retail"],
  ["Anti-Dandruff Shampoo 200ml", "Hair Care", "pc", 350, 450, 3, "retail"],
  ["Hair Serum 100ml", "Hair Care", "pc", 180, 240, 4, "retail"],
  ["Argan Hair Oil 100ml", "Hair Care", "pc", 700, 900, 2, "retail"],
  ["Hair Mask 200g", "Hair Care", "pc", 600, 780, 2, "retail"],
  ["Heat Protectant Spray 150ml", "Hair Care", "pc", 450, 580, 2, "retail"],
  ["Hair Styling Wax 100g", "Tools & Styling", "pc", 260, 350, 3, "retail"],
  ["Hair Spray 200ml", "Tools & Styling", "pc", 300, 400, 3, "retail"],

  // ---- Retail: skin -------------------------------------------------------------------
  ["Sunscreen SPF 50 — 50ml", "Skin Care", "pc", 380, 480, 4, "retail"],
  ["Charcoal Face Wash 100ml", "Skin Care", "pc", 220, 290, 4, "retail"],
  ["Vitamin C Serum 30ml", "Skin Care", "pc", 700, 900, 3, "retail"],
  ["Moisturiser 100ml", "Skin Care", "pc", 300, 400, 3, "retail"],
  ["Under-Eye Cream 15ml", "Skin Care", "pc", 500, 650, 2, "retail"],

  // ---- Retail: nails ------------------------------------------------------------------
  ["Nail Polish — assorted", "Nail Care", "pc", 90, 150, 6, "retail"],
  ["Nail Polish Remover 100ml", "Nail Care", "pc", 60, 100, 4, "retail"],
  ["Cuticle Oil 15ml", "Nail Care", "pc", 150, 220, 3, "retail"],

  // ---- Backbar: colour & chemicals -----------------------------------------------------
  ["Hair Colour Tube 50g", "Colour & Chemicals", "pc", 320, 400, 6, "backbar"],
  ["Developer 9% — 1L", "Colour & Chemicals", "L", 260, 330, 3, "backbar"],
  ["Bleach Powder 500g", "Colour & Chemicals", "packet", 400, 520, 2, "backbar"],
  ["Bleach Cream 250g", "Colour & Chemicals", "pc", 250, 320, 3, "backbar"],
  ["Keratin Solution 500ml", "Colour & Chemicals", "ml", 3500, 4200, 1, "backbar"],
  ["Smoothening Cream 500g", "Colour & Chemicals", "pc", 1200, 1500, 2, "backbar"],

  // ---- Backbar: hair -------------------------------------------------------------------
  ["Backbar Shampoo 5L", "Hair Care", "L", 1400, 1800, 2, "backbar"],
  ["Backbar Conditioner 5L", "Hair Care", "L", 1500, 1900, 2, "backbar"],
  ["Hair Spa Cream 1kg", "Hair Care", "kg", 900, 1150, 2, "backbar"],

  // ---- Backbar: waxing & threading ------------------------------------------------------
  ["Rica Wax Tin 800ml", "Waxing & Threading", "pc", 600, 750, 4, "backbar"],
  ["Waxing Strips (100)", "Waxing & Threading", "packet", 150, 200, 5, "backbar"],
  ["Threading Thread Spool", "Waxing & Threading", "pc", 40, 60, 10, "backbar"],

  // ---- Backbar: spa & consumables --------------------------------------------------------
  ["Massage Oil 1L", "Spa & Massage", "L", 500, 650, 2, "backbar"],
  ["Facial Kit — single use", "Skin Care", "pc", 180, 250, 10, "backbar"],
  ["Cotton Roll 500g", "Consumables", "packet", 120, 160, 5, "backbar"],
  ["Disposable Towels (50)", "Consumables", "packet", 200, 260, 4, "backbar"],
  ["Disposable Gloves (100)", "Consumables", "box", 250, 320, 3, "backbar"],
];

// Mirrors the grocery catalogue builder: every item starts at 0 stock with no batches, so the
// shop counts its real opening stock in rather than inheriting a fictional one.
export const buildProducts = ({ uid, today = "", iconFor }) =>
  PRODUCTS.map(([name, category, unit, buyPrice, sellPrice, lowAt, stockType]) => ({
    id: uid(),
    name,
    category,
    unit,
    buyPrice,
    sellPrice,
    mrp: sellPrice,
    stock: 0,
    lowAt,
    stockType,
    batches: [],
    icon: iconFor ? iconFor(category) : PRODUCT_CATEGORY_ICONS[category] || "📦",
    createdAt: today,
  }));

// ── Staff ────────────────────────────────────────────────────────────────────────────────
// Two sample stylists so the appointment grid has columns on day one. Rename or deactivate
// them from Staff; they carry no history.
const STAFF = [
  ["Priya Sharma", "Hair Stylist", "#7C3AED", 10],
  ["Rahul Kadam", "Barber", "#0EA5E9", 10],
];

export const buildStaff = ({ uid, today = "" }) =>
  STAFF.map(([name, role, color, commissionPctDefault]) => ({
    id: uid(),
    name,
    role,
    color,
    phone: "",
    commissionPctDefault,
    active: true,
    createdAt: today,
  }));

// ── Message templates ─────────────────────────────────────────────────────────────────────
// Filled in and opened as a WhatsApp deep link from the Reminders view. Placeholders:
//   {name}     the customer's first name
//   {service}  the service that is due / was last taken
//   {days}     days since the last visit, or days until expiry — depends on the template
//   {shopName} the salon's name from Settings
//
// Hindi templates are romanised on purpose: it is what actually gets typed in a Pune salon,
// and it renders on every phone regardless of Devanagari font support.
const TEMPLATES = [
  ["Rebooking reminder — English", "rebook",
    "Hi {name}! It's been {days} days since your {service} at {shopName}. Ready for your next appointment? Reply with a day that suits you and we'll book you in. 💇"],
  ["Rebooking reminder — Hindi", "rebook",
    "Namaste {name}! Aapke {service} ko {days} din ho gaye hain. {shopName} mein aapka next appointment book kar dein? Bas apna time bata dijiye. 💇"],

  ["Birthday — English", "birthday",
    "Happy Birthday, {name}! 🎂 Everyone at {shopName} wishes you a wonderful year ahead. Drop in this month and enjoy a little birthday treat on us."],
  ["Birthday — Hindi", "birthday",
    "Janmadin ki hardik shubhkamnaye, {name}! 🎂 {shopName} ki poori team ki taraf se. Is mahine aaiye — aapke liye ek chhota sa birthday gift ready hai."],

  ["Anniversary — English", "anniversary",
    "Happy Anniversary, {name}! 💐 Wishing you both a lovely day from all of us at {shopName}. Planning something special? Let us get you ready for it."],
  ["Anniversary — Hindi", "anniversary",
    "Aapko Anniversary ki dher saari shubhkamnaye, {name}! 💐 {shopName} ki taraf se. Koi khaas plan hai? Taiyaar hone ke liye humein yaad kijiye."],

  ["Win-back (dormant) — English", "dormant",
    "Hi {name}, we've missed you at {shopName} — it's been {days} days! We'd love to see you again. Reply here and we'll find you a slot that works."],
  ["Win-back (dormant) — Hindi", "dormant",
    "Hello {name}, {shopName} mein aapko dekhe {days} din ho gaye! Aapki kami mehsoos hoti hai. Reply kijiye, hum aapke liye achha slot nikal denge."],

  ["Package expiring — English", "package",
    "Hi {name}, a heads-up from {shopName}: your package still has sessions left and expires in {days} days. Book in before then so nothing goes to waste!"],
  ["Package expiring — Hindi", "package",
    "{name} ji, {shopName} se ek reminder: aapke package mein sessions abhi bache hain aur wo {days} din mein expire ho raha hai. Jaldi book kar lijiye!"],
];

export const buildTemplates = ({ uid, today = "" }) =>
  TEMPLATES.map(([name, kind, body]) => ({
    id: uid(),
    name,
    kind,
    body,
    active: true,
    createdAt: today,
  }));

// ── Loyalty defaults ──────────────────────────────────────────────────────────────────────
// Lives inside the shop/config singleton (not its own slice), because it is one small object
// the owner edits in Settings. Deliberately modest: 1 point per ₹100, 1 point = ₹1, so a
// ₹2,000 facial earns ₹20 back — a nudge, not a discount scheme that eats the margin.
export const DEFAULT_LOYALTY_CONFIG = {
  enabled: true,
  earnRate: 1, // points per ₹100 spent
  redeemValue: 1, // ₹ per point
  minRedeemPoints: 50, // don't let 3 points clutter the till
  maxRedeemPctOfBill: 20, // cap a redemption at 20% of the bill
  tiers: {
    // 12-month rolling spend thresholds, in ₹.
    silver: 10000,
    gold: 25000,
    platinum: 50000,
  },
};
