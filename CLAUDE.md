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

### Feature access (the owner's per-role switches)

Settings → Users & roles → **Feature access** lets the owner turn individual features on and off
for the `biller` and `inventory` roles. The choices live at `config.permissions` (a sparse map of
*what changed from the default*) and arrive as `can()`'s **third argument**.

**`GRANTABLE` in `roles.js` is derived from `database.rules.json`, not from taste.** The rules
hard-code `role === 'owner'` on the sensitive nodes, so a switch for anything outside that
envelope would open a screen whose every read comes back permission-denied — a toggle that looks
like it worked and fails at the counter. `can()` **intersects overrides with the envelope**, so
even a hand-edited `permissions` blob can't grant past the rules, and the owner is answered
before overrides are read at all. Adding a switch = check the rule in `database.rules.json`
first, then add the action to `GRANTABLE[role]`.

Three things that will bite:

1. **`can(role, action)` with no third argument silently ignores the owner's switches.** Inside
   `StoreManager` use `allow(action)`; elsewhere the component is handed `perms` next to `role`
   and calls `can(role, action, perms)`. A stray two-arg call is how a hidden tab ends up with a
   reachable view behind it — `permissions.integration.test.jsx` mounts the real app and checks
   the nav and the view guard *agree*.
2. **`sync.js` `readableSlices(role)` deliberately takes no overrides.** It only gates the money
   slices, and no money action is grantable — a test pins that. Put a money action in `GRANTABLE`
   and the subscription list quietly stops matching the permission matrix.
3. **A grantable action must not need an owner-only WRITE.** This is why `reminders.use`
   (sending) and `reminders.templates` (editing the templates, which writes an owner-only node)
   are separate actions, and why `SEEDERS.messageTemplates` gates on the latter.

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

## Responsive layout

Five bands, all defined once in [`src/lib/breakpoints.js`](src/lib/breakpoints.js) and interpolated
into the CSS block — **no width is typed twice**. `deviceClass()` is pure and pinned by
[`breakpoints.test.js`](src/lib/breakpoints.test.js) against the widths the salon actually holds.

| Band | Width | Shell |
|---|---|---|
| phone | ≤ 599 | sidebar hidden; bottom tab bar (4 tabs + More sheet) |
| tablet | 600–1023 | sidebar collapsed to a 64px icon rail, `☰` expands it *over* the page |
| laptop | 1024–1439 | the original layout, untouched |
| desktop / wide | ≥ 1440 | same, content to `CONTENT_MAX` (1600, was 1280) |

Pointer type is a **separate axis** from width: touch sizing hangs off `(pointer: coarse)`, hover
styling off `(hover: hover)`. A 1024px tablet is a wide screen driven by a fingertip; a 900px laptop
window is a narrow one driven by a mouse. Keying touch sizing on width is what used to make an iPad
zoom on every input.

### Four things that will bite

1. **A media query loses to an inline style.** Most layout in `salon-manager.jsx` is inline
   (`S.nav`, `S.main`, `S.app`, the ~54 inline grids), and a normal stylesheet declaration cannot
   beat one. Every responsive rule that restyles an inline-styled element therefore carries
   `!important` — that is the *only* thing it is used for here, never to win a fight inside the CSS
   block. Miss it and the change silently does nothing: the 210px rail just stays put on a phone.

2. **Responsive grids are opt-in by class.** `.g2` / `.g3` / `.g-split` / `.cards`. The previous
   version of this block collapsed *every* element with an inline `grid-template-columns` via
   `[style*="grid-template-columns"]`, which also matched the appointments calendar
   (`56px repeat(N, minmax(140px,1fr))`) and stacked its time gutter on top of its stylist columns
   on every phone. The calendar, the barcode keypad and the `auto-fill` grids deliberately carry no
   class. Adding a new two-pane layout = add the class; don't widen a selector.

3. **Anything pinned over scrolling content must be OPAQUE.** The blur budget above allows
   `backdrop-filter` on the sidebar and the modal scrim only — so the tab bar, top bar and More
   sheet can't have it, and Advanced's `--nav-bg` (72%) / `--modal-bg` (88%) let the page read
   straight through them. They use `--bar-bg` / `--sheet-bg` instead, which are solid; the pinned
   first column of a scrolling table uses `--tbl-sticky-bg` for the same reason.

4. **`background:` is banned where `backgroundImage` is also set.** Use `backgroundColor`. A
   shorthand whose value contains `var()` is stored as one *pending-substitution* value covering
   every longhand it owns, so setting `backgroundImage` immediately after (React writes style keys
   in order) discards the rest and **background-color comes out empty**. This is real Chrome CSSOM
   behaviour, not a jsdom quirk. It is why Advanced's dark ground never painted — its light text sat
   on the white page — and it is pinned by `responsive.integration.test.jsx`.

`100vh` → always paired with a `100dvh` line after it (`.app`, `.nav`, `.modal`). On iOS `vh` is the
viewport at its *tallest*, so a 100vh rail is taller than the screen whenever Safari's toolbar is
expanded. `index.html` opts into `viewport-fit=cover`, so everything pinned to an edge pays it back
with `env(safe-area-inset-*)` padding.

### Verifying it

`responsive.integration.test.jsx` mounts the **real** app with `window.matchMedia` stubbed per
width, asserts which shell each band gets, and pins the CSS contract. jsdom lays nothing out, so it
proves the rules are present and say what they were written to say — never that a layout *looks*
right. That part is a browser.

**Headless Chrome will lie to you about phones.** It clamps its window to ~500 CSS px, so
`--window-size=390` renders at 500 and merely *crops* the screenshot — which reads as "the content
overflows" when it does not. Load the page in an `<iframe width="390">` instead: a frame gets
exactly the viewport it is given and its media queries evaluate against it. Check
`document.documentElement.scrollWidth === clientWidth` inside the frame; that inequality is the
horizontal-overflow bug that actually ruins a phone.

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
