import { execFileSync } from "node:child_process";

// Builds the App Change Log straight from `git log` at build (and dev-server) time, and exposes it to
// the app as the virtual module `virtual:changelog`. Nothing to hand-edit: ship a commit with a clear
// subject line and it shows up. Requires full history at build time — CI must checkout with
// fetch-depth: 0 (a shallow clone only sees the tip commit).

// Subjects we never surface to a shopkeeper: CI plumbing, deploy re-triggers, lockfile churn, and the
// other conventional-commit chore types. Anything else is treated as a real, user-facing change.
const NOISE_PREFIX = /^(ci|chore|build|test|docs|style)(\([^)]*\))?:\s/i;
const NOISE_BODY = /re-trigger|deploy-pages|regenerate.*lockfile|fetch-depth|build on node/i;

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

// Normalize any origin remote (git@host:owner/repo.git or https://host/owner/repo.git) to a
// browseable https base so we can build /commit/<sha> and /commits/<branch> links.
function repoUrl() {
  try {
    return git(["remote", "get-url", "origin"])
      .replace(/^git@([^:]+):/, "https://$1/")
      .replace(/\.git$/, "");
  } catch {
    return "";
  }
}

// Read up to `max` real changes, newest first, as [date, summary, shortSha]. Uses control chars as
// field/record separators so commit subjects can contain any punctuation safely.
function entries(max = 80) {
  let raw;
  try {
    raw = git([
      "log", "--no-merges", `--max-count=${max * 3}`,
      "--date=short", "--pretty=format:%h\x1f%ad\x1f%s\x1e",
    ]);
  } catch {
    return []; // no git / no history (e.g. a shallow or export build) — fall back to an empty log
  }
  const out = [];
  for (const record of raw.split("\x1e")) {
    const line = record.trim();
    if (!line) continue;
    const [sha, date, subject] = line.split("\x1f");
    if (!sha || !date || !subject) continue;
    if (NOISE_PREFIX.test(subject) || NOISE_BODY.test(subject)) continue;
    out.push([date, subject, sha]);
    if (out.length >= max) break;
  }
  return out;
}

export default function changelogPlugin() {
  const VIRTUAL = "virtual:changelog";
  const RESOLVED = "\0" + VIRTUAL;
  return {
    name: "vite-plugin-changelog",
    resolveId(id) {
      return id === VIRTUAL ? RESOLVED : null;
    },
    load(id) {
      if (id !== RESOLVED) return null;
      const data = { repoUrl: repoUrl(), entries: entries() };
      return `export default ${JSON.stringify(data)};`;
    },
  };
}
