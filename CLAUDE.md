# CLAUDE.md

Salon Manager — React + Vite SPA on Firebase Realtime Database. See the
[README](README.md) for the product-level picture; this file covers what's easy to get
wrong when working in the repo.

## Commands

| Command | What it runs |
|---|---|
| `npm run dev` | Vite dev server on 5173 |
| `npm test` | the pure-lib + jsdom suites (`src/**`). No emulator, no Java. This is what CI runs. |
| `npm run test:rules` | the security-rules suite (`tests/rules/**`) against the Firebase emulator |
| `npm run build` | production build (Pages base path `/salon-manager/`) |
| `npm run lint` / `npm run format` | ESLint / Prettier |

`npm test` and `npm run test:rules` are **separate on purpose** — see below.

## Security-rules tests

[`database.rules.json`](database.rules.json) is the real access boundary; `src/lib/roles.js`
is only the UI mirror of it. The rules are exercised by:

- [`tests/rules/setup.js`](tests/rules/setup.js) — harness: emulator wiring, the
  `asOwner()` / `asBiller()` / `asInventory()` / `asUnauth()` actors, `withSecurityRulesDisabled`
  seeding, and `useRulesHarness()` (clear + reseed per test, cleanup at the end).
- [`tests/rules/rbac.test.js`](tests/rules/rbac.test.js) — the role matrix.
- [`tests/rules/bootstrap.test.js`](tests/rules/bootstrap.test.js) — first-owner
  self-registration, lockdown once claimed, unauthenticated access, last-owner lockout.

Config lives in [`vitest.rules.config.js`](vitest.rules.config.js), not `vite.config.js`.

**Java 11+ must be on `PATH`** — the RTDB emulator is a JAR. Without it the command stops at
`Could not spawn 'java -version'`.

### Emulator ports

Declared in [`firebase.json`](firebase.json). Change them there; the harness reads the
address `emulators:exec` exports and only falls back to these literals.

| Emulator | Port |
|---|---|
| Realtime Database | 9000 |
| Authentication | 9099 |
| Emulator UI | 4000 |
| Emulator hub (CLI-assigned) | 4400 |

The test project id is `salon-manager-rules-test` and must match the `--project` flag in the
`test:rules` script — `singleProjectMode` is on, so a mismatch warns and reads the wrong
namespace. It is a throwaway id; never point these tests at a real project, because every
spec wipes the database in `beforeEach`.

### Two constraints that will bite

1. **`tests/rules/**` is excluded from `npm test`** (in `vite.config.js`). The pure-lib
   suites must stay runnable with no emulator and no Java — CI only runs `npm test`, and
   including the rules suite there would break the Pages deploy on any machine without a JVM.

2. **The rules suite must stay single-threaded.** The emulator is one shared, stateful
   process and every spec clears the whole database, so parallel spec files delete each
   other's fixtures mid-assertion. `vitest.rules.config.js` sets `fileParallelism: false` and
   `maxWorkers: 1`; both are required. (Vitest 4 removed `poolOptions.forks.singleFork` —
   these top-level options replace it. A stale `poolOptions` block is silently ignored, so
   the suite would still pass while running in parallel.)

Failures from breaking either look like flaky rules, not like a config problem — which is
what makes them expensive.

### Known rule-vs-README divergences

Both are asserted as-is by the suite, so it documents real behaviour. Don't "fix" the tests
to match the README:

- **A biller can edit an existing bill.** `shop/sales/$id` is gated on
  `newData.exists() || role === 'owner'`, so that clause gates **deletes only**. The delete
  half is rule-enforced; the edit half is UI-only.
- **The rules let the last active owner demote/deactivate/delete themselves.** The app
  refuses this; the rules cannot express it (RTDB has no way to count siblings matching a
  predicate). Closing it server-side needs a maintained counter node or a Cloud Function.

## Sending a bill on WhatsApp

One receipt layout, two deliveries. `receiptHtml()` in `salon-manager.jsx` is the **single
source** of receipt markup; `printReceipt()` sends it to paper and `SendBillActions` rasterizes
it to a JPEG. Anything added to one is in the other for free — that is the whole point of the
split, so don't inline receipt markup into a caller.

| Where | What |
|---|---|
| [`src/lib/receiptImage.js`](src/lib/receiptImage.js) | HTML → JPEG. SVG `<foreignObject>` → `<img>` → canvas. No dependency. |
| [`src/lib/receipts.js`](src/lib/receipts.js) | pure: the message, the `wa.me` link, the storage path |
| [`src/lib/receiptStorage.js`](src/lib/receiptStorage.js) | thin Storage adapter (upload/delete) |

**It's a JPEG, not a PDF, and that's load-bearing.** Every built-in PDF font encodes WinAnsi,
which has no `₹` (U+20B9) — and a Devanagari shop name needs Indic shaping on top. A PDF would
mean bundling font subsets, and the app has to work with the Wi-Fi off. Rasterizing hands text
shaping to the browser, which already has those fonts.

**Two rules the rasterizer cannot bend:**

1. **`<foreignObject>` content is parsed as XML, not HTML.** `&nbsp;` is a *fatal parse error*
   there and every void element must be self-closed. `toXhtml()` repairs both. A receipt that
   renders blank is almost always this.
2. **An SVG loaded through `<img>` fetches nothing external.** A remote `<img src>` inside it
   renders blank and taints the canvas, so `toBlob()` throws. This is why
   `receiptHtml(..., { forImage: true })` drops the two bundled `/public` assets — every image
   in the rasterized markup must be a `data:` URL.

Styling therefore hangs off **`.rcpt`, never `body`** — a foreignObject has no `body` element
for a `body {}` rule to land on, and a receipt styled through `body` rasterizes unpadded.

**Delivery is still a human pressing send**, exactly as in the reminder queue — no WhatsApp
Business API. A `wa.me` link cannot carry a file, which is why there are two buttons: *WhatsApp
bill* uploads the JPEG and sends its URL to the right customer's chat, and *Share bill* hands
the file to `navigator.share` (real inline image, works offline, but the user picks the chat).
The share button is hidden where `canShare({files})` is false — most desktops.

**A send failure is a modal, not a toast** (`SendFailedModal`, the same red hard-stop as a blocked
offline write). The salon otherwise walks away believing the customer has their bill, and the
message carries the fix — usually a shell command — which a toast that fades in three seconds is
the wrong place for. The upload is capped at 20s and, on failure, probes the bucket so "Storage
was never enabled" doesn't present as a generic timeout.

`shop/receipts/**` is **public-read** in [`storage.rules`](storage.rules): the customer opening
the link is not signed in and never will be. What protects a receipt is an unguessable URL —
Firebase's random download token, on a path keyed by **sale id, never the phone number**.
Nothing writes the uploaded URL back onto the sale; re-sending re-uploads to the same
deterministic path, for the same reason nothing in this app keeps a running total.

## Service icons

Split in two, on purpose:

| Where | What |
|---|---|
| [`src/lib/serviceIcons.js`](src/lib/serviceIcons.js) | the registry — `ICON_KEYS`, `KEYWORD_RULES`, `CATEGORY_FALLBACK`, `resolveIcon()`. Pure; no React. |
| [`src/components/ServiceIcon.jsx`](src/components/ServiceIcon.jsx) | the drawing — `<ServiceIcon>`, `<ServiceIconChip>`, `<ServiceIconDefs>`, `SERVICE_ICON_CSS`. Inline SVG only: no icon package, no image files, nothing fetched. |

**Resolve at render; never bake into the data.** An icon is worked out from the service's
*name* every time it is drawn. Nothing writes an icon on save, and `seed.js` must never gain an
icon-key field — that is what lets the keyword table be improved later and have every screen,
including a three-year-old restored backup, pick it up with no migration.

The one exception is the owner's override: **`service.icon`**, set in Settings → Services →
Edit, and an ordinary synced field (no special case in `mergeRemote`). `resolveIcon` honours it
first, but **only when it is a real icon key** — that same field has always held a decorative
*emoji* on seeded services (`"💇"`), and receipts still print that emoji. `isIconKey()` tells
the two apart; `serviceEmoji()` in `src/lib/salon.js` keeps bill lines on the emoji side.

Rule ORDER in `KEYWORD_RULES` is the whole design — "Hair Spa" is a hair treatment, not a spa;
"Nail Cut & File" is not a haircut; "Beard Colour" is not a hair colour. Every one of those is
pinned by a test, so reordering the table tells you immediately what it broke.

Mount points: POS picker (chip per service, 32px per category heading), appointment blocks
(14px, first service, only on blocks of ≥2 slots), Settings → Services, customer visit history.
**Not the thermal receipt** — print markup stays emoji and text. Icons are decorative
everywhere: `aria-hidden`, never a label; the service NAME is the accessible label.

### Theming

Two independent axes, both synced (shop-wide, owner-set in Settings) and both applied on the
`.app` root:

- **Colour** — `config.theme`, one of six palettes in `THEMES`, spread **inline** as CSS variables
  via `themeVars(store.theme)`.
- **Appearance** — `config.iconStyle` → `data-theme="advanced" | "basic"`. This is the **whole-app
  skin**, not just the icons: `advanced` is a dark glass-morphism theme (lit gradient backdrop,
  frosted panels, gilded service chips); `basic` is the original bright, flat look. (The config key
  is still `iconStyle` for backward-compat with saved settings; the UI calls it "Appearance".)

**The two layer, they don't fight.** `themeVars` sets `--brand`/`--ink`/`--nav-*`/`--app-bg`/
`--focus-ring` **inline**, and inline always beats a stylesheet rule — so the Advanced block can
**never** override those, and deliberately doesn't. Advanced defines only its *own* tokens
(`--bg-base`, `--glass-*`, `--accent`, `--surface`, `--text-*`, …) in the `[data-theme="advanced"]`
block in `salon-manager.jsx`. Result: the chosen colour palette still tints the accents showing
through the dark glass.

**Pixel-identical Basic is by construction.** Every themeable surface reads a token with its
*original* value as the fallback — `var(--surface, #fff)`, `var(--input-border, #D5E0D6)`, etc. In
`basic` those tokens are undefined, so every `var()` resolves to the original light value. Adding a
new advanced surface = tokenize the hardcoded value here with its original as the fallback, then
give the token a dark value in the `[data-theme="advanced"]` block. Never define these tokens at
`:root` (that would change Basic).

**Glass tokens are owned by the app, consumed by the icons.** `SERVICE_ICON_CSS`
(`components/ServiceIcon.jsx`) loads *after* the app CSS, so it must not redefine
`--accent`/`--glass-*` — it just consumes them (and keeps its own flat values under
`[data-theme="basic"]`). The four gradient defs are still mounted once, only under `advanced`.

**Blur budget.** `backdrop-filter` lives on exactly two still surfaces — the sidebar (`.nav`) and
the modal scrim (`S.overlay`). **Never** on cards, panels or chips: those appear in scrolling lists
and only *tint* (via `--surface`/`--glass-fill`). `@supports not (backdrop-filter)` falls the
sidebar back to an opaque panel. `icons.integration.test.jsx` pins that `SERVICE_ICON_CSS` contains
no `backdrop-filter`.

**Print & offline.** Receipts print from a separate `about:blank` iframe with its own black-on-white
stylesheet — the theme cannot reach them; a defensive `@media print` block also flattens the app
window if it's printed directly. The Advanced display face (`--font-display`) is a **serif system
stack** (`Cormorant Garamond → Georgia → serif`), never a web font — the app must run on a counter
tablet with the Wi-Fi off, so nothing is fetched.

## Conventions

- `src/lib/*.js` is pure logic — no React, no Firebase (except the thin `firebase.js` /
  `sync.js` / `bills.js` adapters). Keep it that way; it's why those suites are fast.
- `src/components/` is the only UI outside `salon-manager.jsx`, and exists for things with
  their own stylesheet (the icon set). Screens stay in the big file.
- Money is paise-rounded rupees; dates are local-timezone.
- **Nothing that matters is a running total.** Visit counts, spend, loyalty points, tier and
  package sessions are derived from the bills and recomputed, never incremented. The README
  explains why at length — this is the app's central invariant.
- jsdom specs opt in per-file with a `// @vitest-environment jsdom` docblock; the default
  environment is node.
