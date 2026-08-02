import { defineConfig } from "vitest/config";

// Separate config for the security-rules suite.
//
// It is NOT part of `npm test`: these specs talk to the Firebase emulator over the
// network, so they need `firebase emulators:exec` around them (see `npm run test:rules`).
// vite.config.js excludes tests/rules/** from the default run for the same reason.
//
// The emulator is ONE shared, stateful process. Every spec clears the whole database in
// beforeEach, so two spec files running concurrently would delete each other's seed data
// mid-assertion. Both switches below are needed to prevent that: fileParallelism keeps the
// spec FILES from overlapping, maxWorkers keeps them in a single worker.
// (Vitest 4 removed `poolOptions.forks.singleFork` — these are its top-level replacement.)
export default defineConfig({
  test: {
    include: ["tests/rules/**/*.test.js"],
    environment: "node",
    fileParallelism: false,
    maxWorkers: 1,
    // First connection to a cold emulator is slow; the assertions themselves are fast.
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
