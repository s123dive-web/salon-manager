/**
 * Shared harness for the Realtime Database security-rules suite.
 *
 * These specs run the REAL database.rules.json inside the Firebase emulator, so they test
 * the actual server-side boundary rather than src/lib/roles.js (which is the UI mirror of
 * the same matrix and is covered separately by roles.test.js).
 *
 * Run them with `npm run test:rules` — the emulator must be up, and `firebase
 * emulators:exec` handles that. Never point this at a real project: every spec wipes the
 * whole database between assertions.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, afterAll } from "vitest";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const RULES_FILE = path.join(REPO_ROOT, "database.rules.json");

/** Throwaway id. Must match the --project passed to `firebase emulators:exec`. */
export const PROJECT_ID = "salon-manager-rules-test";

/** Stable uids so assertions can name an actor without threading strings around. */
export const UID = {
  owner: "uid-owner",
  owner2: "uid-owner-two",
  biller: "uid-biller",
  inventory: "uid-inventory",
  stranger: "uid-stranger",
};

/**
 * The default staff roster: exactly one active owner, one biller, one inventory user.
 * "Exactly one owner" matters — the last-active-owner spec in bootstrap.test.js depends
 * on there being no second owner to fall back to.
 */
export const USERS = {
  [UID.owner]: {
    email: "owner@salon.test",
    name: "Owner",
    role: "owner",
    active: true,
    createdAt: "2026-01-01T09:00:00.000Z",
  },
  [UID.biller]: {
    email: "biller@salon.test",
    name: "Biller",
    role: "biller",
    active: true,
    createdAt: "2026-01-01T09:00:00.000Z",
  },
  [UID.inventory]: {
    email: "stock@salon.test",
    name: "Stock",
    role: "inventory",
    active: true,
    createdAt: "2026-01-01T09:00:00.000Z",
  },
};

let env = null;

/** Where the emulator is. `emulators:exec` exports this; the fallback matches firebase.json. */
function emulatorAddress() {
  const fromEnv = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
  if (fromEnv) {
    const [host, port] = fromEnv.split(":");
    return { host, port: Number(port) };
  }
  return { host: "127.0.0.1", port: 9000 };
}

export async function initRulesEnv() {
  if (env) return env;
  const { host, port } = emulatorAddress();
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    database: {
      rules: fs.readFileSync(RULES_FILE, "utf8"),
      host,
      port,
    },
  });
  return env;
}

function rulesEnv() {
  if (!env) throw new Error("rules env not initialised — use useRulesHarness()");
  return env;
}

// ---- actors -------------------------------------------------------------------------
// Each returns a Database handle bound to a signed-in (or signed-out) identity. The rules
// re-derive the role from shop/users/<uid>, so the uid is what actually decides access —
// these helpers just make the intent readable at the call site.

export const asOwner = (uid = UID.owner) => rulesEnv().authenticatedContext(uid).database();
export const asBiller = (uid = UID.biller) => rulesEnv().authenticatedContext(uid).database();
export const asInventory = (uid = UID.inventory) =>
  rulesEnv().authenticatedContext(uid).database();
export const asUser = (uid) => rulesEnv().authenticatedContext(uid).database();
export const asUnauth = () => rulesEnv().unauthenticatedContext().database();

// ---- seeding ------------------------------------------------------------------------
// withSecurityRulesDisabled is the only way to set up state the actor under test is not
// allowed to create. Seeding through the rules would make the fixture itself a silent
// assertion, and a rule change would show up as a confusing setup failure.

/** Write the staff roster. Pass a subset to model a different shop. */
export async function seedUsers(users = USERS) {
  await rulesEnv().withSecurityRulesDisabled(async (ctx) => {
    await ctx.database().ref("shop/users").set(users);
  });
}

/** Write arbitrary fixture data at `path`, bypassing the rules. */
export async function seed(path, value) {
  await rulesEnv().withSecurityRulesDisabled(async (ctx) => {
    await ctx.database().ref(path).set(value);
  });
}

/** Read back through the rules-disabled context, to check what a write actually did. */
export async function readAsAdmin(path) {
  let snapshot;
  await rulesEnv().withSecurityRulesDisabled(async (ctx) => {
    snapshot = await ctx.database().ref(path).get();
  });
  return snapshot.val();
}

/**
 * Registers the emulator lifecycle for a spec file.
 *
 * @param {{ seed?: boolean }} options - `seed: false` leaves shop/users EMPTY after each
 *   clear, which is the precondition for the bootstrap specs.
 */
export function useRulesHarness({ seed: seedRoster = true } = {}) {
  beforeAll(async () => {
    await initRulesEnv();
  });

  beforeEach(async () => {
    await rulesEnv().clearDatabase();
    if (seedRoster) await seedUsers();
  });

  afterAll(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });
}
