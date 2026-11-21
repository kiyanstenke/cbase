// The main branch of a repo: `origin/HEAD`, else `main`, then `master`, otherwise none. The view computes `toMain`, the
// branch points and the main line against it; without it every row's `toMain` is `null`, and the UI says "no main branch
// detected".
//
// ONE order, TWO implementations: the pure choice `selectMainBranch` (from the refs read) and the shell piece `MAIN_SH`
// with which the read script (read.js) determines the main branch IN the container — it needs it in the same `sh -c` for
// `rev-list --not <main>`. Both derive from `CANDIDATES`; the guard server/backend/test/git-view-read.test.js runs the
// script on real repos (origin/HEAD, only main, only master, none) and holds its choice against the pure one.
//
// Which ref is compared: for `origin/HEAD` its target; for `main`/`master` the remote ref `refs/remotes/origin/<b>` if it
// exists, else the local `refs/heads/<b>`. The remote ref first because cbase fetches but never pulls: a local `main`
// stands still after a merge on GitLab, and every merged branch would otherwise look open. The ref itself is the main
// line at the top (`line`), never a row of the group "remote only" (groups.js).
//
// selectMainBranch({ originHead, refs })  → { name, source, ref } | null
//   originHead  the target of the symref `refs/remotes/origin/HEAD` (`refs/remotes/origin/<b>`) or null
//   refs        the existing ref names (set or list, full: `refs/heads/…`, `refs/remotes/…`)
//   source      "origin/HEAD" | "main" | "master" (contract.js MAIN_BRANCH_SOURCES)

import { MAIN_BRANCH_SOURCES } from "./contract.js";

const ORIGIN_HEAD = "refs/remotes/origin/HEAD";
const REMOTE_PREFIX = "refs/remotes/origin/";

/** The fallback names after origin/HEAD, in their order; per name the remote ref first, then the local one. */
export const CANDIDATES = Object.freeze(MAIN_BRANCH_SOURCES.filter((q) => q !== "origin/HEAD")
  .map((name) => Object.freeze({ name, refs: Object.freeze([`${REMOTE_PREFIX}${name}`, `refs/heads/${name}`]) })));

export function selectMainBranch({ originHead = null, refs } = {}) {
  const existing = refs instanceof Set ? refs : new Set(refs || []);
  const target = String(originHead || "");
  if (target.startsWith(REMOTE_PREFIX) && target !== ORIGIN_HEAD && existing.has(target)) {
    return { name: target.slice(REMOTE_PREFIX.length), source: "origin/HEAD", ref: target };
  }
  for (const k of CANDIDATES) {
    const ref = k.refs.find((r) => existing.has(r));
    if (ref) return { name: k.name, source: k.name, ref };
  }
  return null;
}

// The shell piece (POSIX, runs under dash): sets `h` (ref) and `hq` (source) — both empty without a main branch. A ref
// counts only if it points to a commit (`^{commit}`), just as `refs` above only knows existing refs.
const check = (ref, source) => `if [ -z "$h" ] && git rev-parse -q --verify '${ref}^{commit}' >/dev/null 2>&1; then h='${ref}'; hq='${source}'; fi`;
export const MAIN_SH = [
  "h=''; hq=''",
  `oh=$(git symbolic-ref -q ${ORIGIN_HEAD} 2>/dev/null) || oh=''`,
  `case "$oh" in ${REMOTE_PREFIX}?*) if [ "$oh" != ${ORIGIN_HEAD} ] && git rev-parse -q --verify "$oh^{commit}" >/dev/null 2>&1; then h=$oh; hq='origin/HEAD'; fi;; esac`,
  ...CANDIDATES.flatMap((k) => k.refs.map((r) => check(r, k.name))),
].join("\n");
