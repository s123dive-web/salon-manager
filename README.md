# Salon Manager — Appointments, Billing & CRM

A single-screen salon & spa management app: **appointments, billing, customers, loyalty,
stock and accounts**. A **React + Vite** front end backed by **Firebase** (Authentication,
Realtime Database, Storage), so data syncs live across every device that signs in — the
counter tablet, the owner's phone, the back-office laptop.

Salon Manager is an adaptation of a **production-validated grocery POS**
([grocery-store-manager](https://github.com/s123dive-web/grocery-store-manager)) that has been
in daily use in a real shop. The billing, inventory, sync, import, backup and analytics engines
are **ported, not rewritten** — they arrive with their test suites intact. The salon layer
(appointments, services, staff, loyalty, reminders, commissions) is built on top.

Nothing here is branded to a particular salon: the name, address, phone, logo and payment QR
are all **editable in Settings**, so the app is reusable by any salon.

## ⚠ Before it will run: connect a Firebase project

This repository ships with a **placeholder Firebase config**. Sign-in and sync are inactive
until you connect your own project — the sign-in screen says so plainly rather than failing
with a cryptic SDK error.

**Salon Manager needs its OWN Firebase project.** It stores data under the same
`shop/<slice>` paths as the grocery app, so pointing both at one project would have them
overwrite each other's live data.

1. [Firebase console](https://console.firebase.google.com/) → **Add project**.
2. **Authentication** → Sign-in method → enable **Email/Password**.
3. **Realtime Database** → Create database (pick your region).
4. **Storage** → Get started (needed for vendor-bill proof uploads).
5. **Project settings → General → Your apps → Web app** → copy the config values into
   [`src/lib/firebase.js`](src/lib/firebase.js), replacing every `PLACEHOLDER_*`.
6. Deploy the security rules (see [Roles & access control](#roles--access-control)).
7. Sign in. **The first account to sign in claims ownership** of the salon.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
```

Other scripts: `npm run build`, `npm run preview`, `npm run lint`, `npm run format`,
`npm test` (Vitest), `npm run test:watch`.

## Roles & access control

Salon Manager is **multi-user**. The owner manages staff accounts from inside the app
(**Settings → Users**) — no Firebase console visits for day-to-day user management.

| Can they… | Owner | Biller | Inventory |
|---|:--:|:--:|:--:|
| Billing (POS), print receipts | ✅ | ✅ | ✅ |
| Appointments — view, book, change status, block time | ✅ | ✅ | ✅ |
| Customer picker (search + quick-create) | ✅ | ✅ | ✅ |
| Dashboard — the shop's revenue, profit and margins | ✅ | — | — |
| Dashboard — today's diary + their own bills | ✅ | ✅ | ✅ |
| Browse the customer database, profiles, segments | ✅ | — | — |
| View a past bill (to reprint) | ✅ | ✅ | ✅ |
| Edit or delete a bill | ✅ | — | — |
| Back-date a bill | ✅ | — | — |
| Inventory — add / edit / restock | ✅ | — | ✅ |
| Alerts, Barcode Creator, Data Import | ✅ | — | ✅ |
| Finance, Stats | ✅ | — | — |
| Expenses, Vendor Bills, Udhari ledger | ✅ | — | — |
| Services, Staff, Packages, Loyalty config | ✅ | — | — |
| Redeem a customer's points / package at the till | ✅ | ✅ | ✅ |
| Staff commissions & payout reports | ✅ | — | — |
| Reminders / campaigns | ✅ | — | — |
| Settings, Users, Activity Log | ✅ | — | — |
| Backup / Restore | ✅ | — | — |

`inventory` is a strict superset of `biller` — a test enforces that, so the two can't drift.

**Enforced in two layers**, and both matter:

1. **UI** — [`src/lib/roles.js`](src/lib/roles.js) is the single source of truth for
   `can(role, action)`. Navigation renders by role, and **every gated view re-checks its own
   permission**: hiding a button is not a control, because the active tab is just state.
   Role is resolved from `shop/users/<uid>` *before* the app shell renders, so a worker never
   sees an owner-only view flash past on a slow connection.
2. **Server** — [`database.rules.json`](database.rules.json) re-derives the role from
   `shop/users/<uid>` and enforces it at the database. This is the real boundary.

The client also **never subscribes to a slice its role cannot read**, so a worker's session
doesn't spray permission-denied errors at the counter.

### Deploying the rules

```bash
# one-time: install the CLI and sign in
npm i -g firebase-tools && firebase login

# edit OWNER_EMAIL in storage.rules (see below), then:
firebase deploy --only database,storage
```

- [`database.rules.json`](database.rules.json) — role-based, per-slice. No email to edit:
  ownership is claimed by the first sign-in.
- [`storage.rules`](storage.rules) — vendor-bill proofs. **Still needs `OWNER_EMAIL` filled
  in**, because Storage rules *cannot read the Realtime Database* — there is no RTDB
  equivalent of `firestore.get()`, so the role lookup isn't expressible there. Proofs are
  owner-only anyway, so an email allowlist costs nothing in practice.
- [`firebase.json`](firebase.json) — points the CLI at both rule files.

> Until the rules are deployed, the database is only as safe as whatever rules are currently
> live in the console. Treat deploying them as part of setup, not an optional extra.

### Bootstrap: how the first owner is created

While `shop/users` is empty, the first authenticated user **self-registers as owner** — both
the app and the rules implement this. Once anyone is registered, the node locks down and only
an owner can add users. So: **create the owner's Firebase Auth account and sign in with it
first**, before adding anyone else.

The owner can't lock themselves out: demoting or deactivating the **last active owner** is
refused, because there would be nobody left who can manage users and no console-free way back.

### What the role system does and does not protect

Be clear-eyed about this. The Realtime Database enforces rules **per node**, and the POS
cannot function without reading `sales`, `customers`, `items` and `services`. So:

- ✅ **Genuinely protected, server-side.** Expenses, vendor bills, and the daily-bills slice
  are unreadable to workers. Settings, the service menu, prices, commission rates, package
  definitions and the user registry are **read-only** to workers. Deleting a bill is
  **owner-only**, enforced by a rule (`newData.exists()` separates an edit from a delete),
  not merely hidden. Restore requires a whole-tree write the rules deny to non-owners.
- ⚠ **A UI control, not a boundary.** Workers can read `sales` because the POS needs it, so a
  technically skilled worker could open the browser console and derive revenue totals from
  raw data. Likewise "create a customer but don't browse the customer list" is a UI
  restriction: RTDB cannot express field-level or query-shaped read limits, so `customers` is
  readable to anyone who can bill.

True isolation would need a backend API in front of the database (Cloud Functions or a
server), which is out of scope. The role system is an **operational control** over what staff
can do and see in normal use, **plus rule-enforced protection of the genuinely sensitive
slices** — money, settings, user management, and deletions.

## How data is stored

Data lives in the **Firebase Realtime Database** and syncs **live across every signed-in
device**. Each record is stored under its own keyed node — `shop/<slice>/<id>` — so concurrent
edits to different records from different devices merge instead of clobbering each other;
writes are field-level deltas, and incoming cloud snapshots are 3-way merged with any
un-pushed local edits. See [`src/lib/sync.js`](src/lib/sync.js) (covered by
[`src/lib/sync.test.js`](src/lib/sync.test.js)).

| Slice | Holds |
|---|---|
| `users/<uid>` | email, name, role, active — **the access-control registry** |
| `customers/<phone>` | keyed by phone; name, dob, anniversary, tags, denormalized visit/spend/points stats |
| `services/<id>` | name, category, duration, price, commission %, rebook cycle |
| `staff/<id>` | name, colour, role, default commission % |
| `appointments/<id>` | date, staff, start, duration, services, status, linked bill |
| `sales/<id>` | bills — with customer, per-line staff attribution, points, packages |
| `items/<id>` | retail **and** backbar stock, with batches/expiry |
| `packages`, `customerPackages` | package definitions and what each customer has left |
| `messageTemplates/<id>` | reminder templates (Hindi + English) |
| `expenses`, `vendorBills`, `logs` | accounts and the activity trail |
| `config` | salon identity + loyalty rules (a singleton, not a keyed slice) |

A `localStorage` cache (key `slm-cache-v1`) gives instant first paint and offline reads, and is
flushed on tab close/hide. **It only caches slices the signed-in role may read** — a counter
tablet is a shared device, and an owner's session must not leave the expense book on disk for
whoever signs in next. Vendor-bill **proof files** live in Firebase Storage
([`src/lib/bills.js`](src/lib/bills.js)); only metadata and a download URL go in the database.

> **Back up regularly** from the sidebar — **⬇ JSON** or **⬇ XLSX**, and **⬆ Restore** accepts
> either. ⚠ **Restore replaces all data and that change syncs to the cloud**, so it overwrites
> every signed-in device, not just this one. Export a fresh backup first. Owner only.

## First run & seed data

On first run — and **only** while a slice is still empty — the app seeds itself so it is usable
immediately, then never overwrites that data again. A salon that has edited its own prices will
not have them reset by a redeploy.

- **~80 services** across Hair / Skin / Nails / Spa / Makeup, men's and women's, at typical
  Pune mid-market prices, with durations and sensible rebooking cycles.
- **34 products**, split `retail` (resold over the counter) and `backbar` (consumed during a
  service). Everything starts at **0 stock** so the salon counts its real opening stock in.
- **2 sample stylists**, so the appointment grid has columns on day one.
- **10 reminder templates** — Hindi and English, for rebooking, birthdays, anniversaries,
  win-backs and expiring packages.
- **No customers.** That data is real or it is nothing.

All of it is editable in-app, and lives in [`src/lib/seed.js`](src/lib/seed.js) as pure,
tested data (no clock, no randomness).

## Architecture

- **`src/salon-manager.jsx`** — the app: shell, sync wiring, and every view.
- **`src/lib/*.js`** — pure, unit-tested logic. No React, no Firebase (except the thin
  `firebase.js` / `sync.js` / `bills.js` adapters).

| Module | What it does | Tests |
|---|---|---|
| [`sync.js`](src/lib/sync.js) | keyed-node storage, field-level deltas, 3-way merge, role-aware slice reads | ✅ |
| [`roles.js`](src/lib/roles.js) | the `can(role, action)` permission matrix | ✅ |
| [`seed.js`](src/lib/seed.js) | first-run service menu, stock, staff, templates | ✅ |
| [`customers.js`](src/lib/customers.js) | phone normalisation (the customer key) + drift-free visit/spend stats | ✅ |
| [`salon.js`](src/lib/salon.js) | service/staff validation, commission rate resolution, bill-line types | ✅ |
| [`appointments.js`](src/lib/appointments.js) | the overlap check, grid layout, booking validation | ✅ |
| [`loyalty.js`](src/lib/loyalty.js) | points maths, tiers, prepaid packages | ✅ |
| [`stats.js`](src/lib/stats.js) | revenue/profit series, heatmaps, break-even, salon analytics | ✅ |
| [`parse.js`](src/lib/parse.js) | tolerant import parser (txt/csv/tsv/xls/xlsx/pdf/json) | ✅ |
| [`backup.js`](src/lib/backup.js) | JSON/XLSX backup & restore | ✅ |
| [`barcodes.js`](src/lib/barcodes.js) | Code 128 / EAN-13 generation and matching | ✅ |
| [`dailyBills.js`](src/lib/dailyBills.js) | carried over from the grocery core; **not mounted** — see below | ✅ |
| [`bills.js`](src/lib/bills.js) | vendor-bill proof upload to Firebase Storage | — |
| [`firebase.js`](src/lib/firebase.js) | SDK init + the secondary app used to create users | — |

`dailyBills.js` and its suite are kept intact so a grocery-era backup still restores, and so
the section could be revived without rewriting its validated mappers — but Salon Manager does
not ship the Daily-Need Bills view. A salon's consumable purchases go through **Vendor Bills**.

Money is handled in **paise-rounded rupees** and dates in the **local timezone**, using the
helpers the grocery app already hardened — don't reintroduce bugs those fixed.

### Nothing that matters is a running total

Customer visit counts, total spend, loyalty points, tier and package sessions are all
**derived from the bills** and recomputed, never incremented.

This is the single most important invariant in the app. An incremented counter drifts the first
time a bill is deleted, edited on another device, or merged twice — and each of those drifts is
a real argument at the counter: a points balance nobody can adjudicate, a package session
either given away twice or refused to someone entitled to it. Deriving them means **the
delete-reversal is automatic — there is no reversal code to forget.**

The cost is one pass over an in-memory array; the reconcilers return the *same array reference*
when nothing changed, so they settle in one pass rather than writing to the cloud on every
render. `Admin → recompute` re-runs them all if data is ever imported from outside the app.

Two knowing simplifications, both in [`loyalty.js`](src/lib/loyalty.js):

- Points are earned on what the customer actually **pays** (after a points redemption), not on
  the pre-redemption total — otherwise points would earn points.
- A package covers **one session per bill line**. Adding a second of the same service to one
  bill bumps the quantity at the package's zero price rather than drawing a second session.

### The appointment diary

The day view is a hand-rolled CSS grid — one column per working stylist, 15-minute rows,
absolutely-positioned blocks. There is no calendar dependency; the grid *is* the layout.

Two decisions worth knowing about:

- **Time is `startMin`** — minutes since midnight, local — plus a duration, not a timestamp. A
  salon books "Tuesday at 3pm", not an instant on a global timeline, and minutes-since-midnight
  can't be shifted by a timezone or a DST boundary.
- **Overlap uses half-open intervals.** An appointment ending at 3:00 and one starting at 3:00
  do *not* clash — back-to-back is a normal busy day, and closed intervals would reject the most
  common booking pattern there is. Cancelled and no-show slots free the chair again; `blocked`
  time does not (that's the point of it).

Working hours come from **Settings** and bound the grid; a booking outside them is refused
rather than rendered off-screen.

## Deploying

Pushing to `main` builds and publishes to **GitHub Pages** via
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) (Node 24; runs `npm run build`
and `npm test` before publishing, and retries the Pages publish up to 3× to ride out transient
API failures). The Pages base path is set in [`vite.config.js`](vite.config.js) and must match
the repository name.
