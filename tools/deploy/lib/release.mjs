// Releases on the server: `releases/<id>/` plus the symlink `current`.
//
// There were once FOUR candidates for "the backend source", only one of which matched the running container — a build from the
// wrong one would have silently reverted three files. That is why `current` now points at the single live tree, and every
// deploy puts a new, complete release next to it (rollback = repoint the symlink).
//
// THE ACTIVATION HISTORY. `./deploy rollback server` without `--to` used to take the NEWEST release that is not `current` —
// but `releases/` also holds releases that were never active: `./deploy web` creates one without repointing `current`
// (targets/web.mjs), and a server deploy that fails before `pointCurrent` (image or project box check) leaves its release and
// the rejected candidate behind. A rollback would have gone "forward" onto the web release, built an image without a check and
// pointed `:latest` at it. So `pointCurrent` keeps the file `activations` next to `current`: one release per line that
// `current` REALLY carried, the most recent last — a stack. A deploy pushes the new release on top; whoever goes back to the
// release below (the rollback without `--to`, or `--to` exactly on it) pops the top activation; any other `--to` pushes. So a
// second rollback goes further back, not forward again. Only what matches the running state is true: if the top line is not
// the release `current` pointed at before the repoint (manual operation, an old version, a write error), only that `current`
// counts from the history (it WAS active). Without a known predecessor `rollback server` does not roll back, it names `--to`
// (fail closed: unknown is not "the newest"). The pure computation is `nextHistory` / `predecessor`, guarded
// by the maintainer's private suite.
import { config } from "../config.mjs";
import { isDryRun } from "../../check/lib/sh.mjs";
import { sshAct, sshProbe } from "./ssh.mjs";
import * as log from "../../check/lib/log.mjs";

const root = () => config.remote.root;

export const HISTORY_FILE = "activations";
// This many activations are kept — a rollback needs the top ones, the rest is a log.
export const HISTORY_MAX = 50;
// pruneReleases never removes this many of the most recent activations (current and the two before it).
export const HISTORY_PROTECTED = 3;
const RELEASE_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

export async function currentRelease() {
  const r = await sshProbe(`readlink ${root()}/current 2>/dev/null || true`);
  return r.stdout.trim().replace(/^releases\//, "") || null;
}

export async function listReleases() {
  const r = await sshProbe(`ls -1 ${root()}/releases 2>/dev/null || true`);
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean).sort();
}

/** Pure: the content of `activations` → stack (oldest first). Empty ⇒ []; a line that is not a release identifier ⇒ null
 *  (unknown — the file is not the one pointCurrent writes). */
export function historyFrom(text) {
  const rows = String(text ?? "").split("\n").map((z) => z.trim()).filter(Boolean);
  return rows.every((z) => RELEASE_RE.test(z)) ? rows : null;
}

/** Pure: the stack after `current` is repointed from `prior` to `target` (see header). */
export function nextHistory(stack, { prior = null, target }) {
  if (!target || !RELEASE_RE.test(target)) throw new TypeError(`nextHistory: not a release identifier: ${target}`);
  let s = Array.isArray(stack) ? stack.filter((r) => RELEASE_RE.test(r)) : [];
  // Only what matches the running state: broken ⇒ just the previous current (it was active), no current ⇒ nothing.
  if (!prior) s = [];
  else if (s.at(-1) !== prior) s = [prior];
  if (target === prior) return s;
  if (s.length >= 2 && s.at(-2) === target) return s.slice(0, -1); // back to the predecessor: the activation is dropped
  return [...s, target].slice(-HISTORY_MAX);
}

/** Pure: the release that was active before `cur` — `{ release }` or `{ reason }` (unknown, never guessed). */
export function predecessor(stack, cur) {
  if (!cur) return { reason: "current points to no release" };
  if (stack === null) return { reason: `${HISTORY_FILE} is not readable` };
  if (!Array.isArray(stack) || !stack.length) return { reason: `no activation history (${HISTORY_FILE} is missing or empty — it is created by the first server deploy that records it)` };
  if (stack.at(-1) !== cur) return { reason: `the history ends at ${stack.at(-1)}, current points to ${cur} — repointed by hand?` };
  if (stack.length < 2) return { reason: `no activation is recorded before ${cur}` };
  return { release: stack.at(-2) };
}

/** Pure: which releases pruneReleases removes — the oldest beyond `keep`, never current and never the most recent
 *  activations (else a run of web releases would remove the predecessor and `rollback server` could not find it). */
export function releasesToRemove({ all, cur, stack, keep }) {
  const shielded = new Set([cur, ...(Array.isArray(stack) ? stack.slice(-HISTORY_PROTECTED) : [])].filter(Boolean));
  const dropable = (all || []).filter((r) => !shielded.has(r));
  return dropable.slice(0, Math.max(0, dropable.length - (keep - 1)));
}

// This many unprotected candidate tags are kept per image (the most recent by name) — rejected ones included: a server deploy
// whose image or project box check fails leaves its candidate behind for inspection.
export const CANDIDATES_KEEP = 2;

/** Pure: which candidate tags (`<image>:cand-<release>`) pruneCandidates removes. Protected are the candidate of `keep` (the
 *  release just activated) and those of the most recent activations — the SAME rule as releasesToRemove. Keeping only the two
 *  most recently named tags would count rejected candidates too: after two failed deploys between two activations the
 *  predecessor's candidate would be gone, and `rollback server` would rebuild it from the release tree and swap without an
 *  image check. Of the rest, the `keepCount` most recent stay. If the history is unknown (`null`), nothing is removed —
 *  which candidates a rollback needs is then unknown, and unknown is not free. A tag without `:cand-` is never removed. */
export function candidatesToRemove({ tags, keep, stack, keepCount = CANDIDATES_KEEP }) {
  if (stack === null) return [];
  const releaseOf = (t) => {
    const i = String(t).lastIndexOf(":cand-");
    return i < 0 ? "" : String(t).slice(i + ":cand-".length);
  };
  const shielded = new Set([keep, ...(Array.isArray(stack) ? stack.slice(-HISTORY_PROTECTED) : [])].filter(Boolean));
  const other = [...new Set(tags || [])].filter((t) => releaseOf(t) && !shielded.has(releaseOf(t))).sort();
  return other.slice(0, Math.max(0, other.length - keepCount));
}

export async function historyRead() {
  const r = await sshProbe(`cat ${root()}/${HISTORY_FILE} 2>/dev/null || true`, { check: false });
  if (r.code !== 0) return null;
  return historyFrom(r.stdout);
}

// Derive a new release from the current one — idempotent, so the web and server targets can fill the same release in one run.
export async function ensureRelease(id) {
  const exists = await sshProbe(`test -d ${root()}/releases/${id} && echo yes || echo no`);
  if (exists.stdout.trim() === "yes") return;
  const hasCurrent = await sshProbe(`test -d ${root()}/current && echo yes || echo no`);
  if (hasCurrent.stdout.trim() === "yes") {
    await sshAct(`cp -a ${root()}/current/ ${root()}/releases/${id}/`);
  } else {
    await sshAct(`mkdir -p ${root()}/releases/${id}/backend ${root()}/releases/${id}/gateway ${root()}/releases/${id}/web-out`);
  }
  log.info(`Release ${id} created`);
}

// Repoint `current` and record the activation (see header) — in ONE ssh call, the history after the symlink. Writing it is
// best effort with a message: a deploy does not abort because the log is not writable — the next read sees the gap (the top
// line is not current) and `rollback server` then demands `--to`.
export async function pointCurrent(id) {
  if (!RELEASE_RE.test(String(id))) throw new TypeError(`pointCurrent: not a release identifier: ${id}`);
  const prior = await currentRelease();
  const fresh = nextHistory(await historyRead(), { prior, target: id });
  const file = `${root()}/${HISTORY_FILE}`;
  const r = await sshAct(
    `ln -sfn releases/${id} ${root()}/current\n` +
      `{ printf '%s\\n' ${fresh.map((x) => `'${x}'`).join(" ")} > ${file}.new && mv -f ${file}.new ${file}; } || echo HISTORY-NOT-WRITTEN >&2`,
  );
  if (isDryRun()) return;
  if (/HISTORY-NOT-WRITTEN/.test(r.stderr || "")) log.warn(`Activation history (${file}) not written — \`rollback server\` demands \`--to\` until the next deploy.`);
  const now = await currentRelease();
  if (now !== id) throw new Error(`current points to ${now}, expected ${id}`);
  log.ok(`current → releases/${id}`);
}

export async function pruneReleases(keep = config.remote.keepReleases) {
  const all = await listReleases();
  const cur = await currentRelease();
  const drop = releasesToRemove({ all, cur, stack: await historyRead(), keep });
  if (!drop.length) return;
  log.detail(`pruning old releases: ${drop.join(", ")}`);
  for (const d of drop) await sshAct(`rm -rf ${root()}/releases/${d}`);
}
