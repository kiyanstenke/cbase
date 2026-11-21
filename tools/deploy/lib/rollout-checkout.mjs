// The rollout lock in node — the second half of the lock in the root script `deploy`.
//
// The shell file can be bypassed (`node tools/deploy/deploy.mjs server`), so the same rule is checked here before any rollout work:
// a rollout command runs only from a rollout checkout. A rollout checkout has
//   (a) deploy.local.json in the repo root (gitignored: host, root and port of the installation), and
//   (b) the marker file `.cbase-rollout-checkout` in the repo root (gitignored, never tracked) whose content is exactly the
//       real path of the checkout.
// The marker is positive and bound to the path on purpose: a clone carries every TRACKED file of the dev tree, so a tracked
// "I am the dev tree" marker would be in the rollout checkout too; an untracked, path-bound marker is carried over by neither a
// clone nor a copy of the folder, and a stray deploy.local.json in the dev tree alone never unlocks it.
// Guard: tools/deploy/rollout-lock.test.mjs (shell and node rule against the same trees, with counter-proofs).
import fs from "node:fs";
import path from "node:path";

export const ROLLOUT_MARKER = ".cbase-rollout-checkout";
/** The words of the root script that need a rollout checkout (the shell file lists the same ones; the test compares). */
export const ROLLOUT_WORDS = ["server", "web", "client", "rollback", "all", "init"];

/** Reads the file system: is `repo` a rollout checkout? → `{ ok, reason }`. */
export function rolloutCheckoutVerdict(repo) {
  const real = fs.realpathSync(repo);
  if (!fs.existsSync(path.join(real, "deploy.local.json"))) return { ok: false, reason: "deploy.local.json is missing in the repo root" };
  const marker = path.join(real, ROLLOUT_MARKER);
  if (!fs.existsSync(marker)) return { ok: false, reason: `${ROLLOUT_MARKER} is missing (this looks like the dev tree)` };
  const content = fs.readFileSync(marker, "utf8").replace(/\n+$/, "");
  if (content !== real) return { ok: false, reason: `${ROLLOUT_MARKER} names another checkout (${content || "empty"}), not ${real}` };
  return { ok: true, reason: "" };
}

/** Pure: does the parsed command line (parseArgs) roll out or change anything on the host? mobile-only runs and reads do not. */
export function isRolloutRun(o) {
  if (o.command === "init" || o.command === "rollback") return true;
  if (o.command) return false;
  return o.targets.some((t) => t === "web" || t === "server" || t === "client");
}

/** Throws unless `repo` is a rollout checkout. */
export function assertRolloutCheckout(repo) {
  const v = rolloutCheckoutVerdict(repo);
  if (!v.ok) throw new Error(`Rollout refused: ${v.reason}. Rollout commands run only from a rollout checkout (deploy.local.json plus ${ROLLOUT_MARKER} holding the real path of the checkout) — never from the dev tree.`);
}
