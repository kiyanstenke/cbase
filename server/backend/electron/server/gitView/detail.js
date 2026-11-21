// The detail of a branch and the diff of a file.
//
//   GET /api/projects/:pid/gitView/branch?repo=&instance=&name=   (route: routes.js)
//     → 200 { row, commits, files, mr, origin, clipped, failed }  (DETAIL_FIELDS)
//       row       the row of the branch as GET …/gitView delivers it (overview.js rowFor: THE SAME cached readings, without
//                 search and cap, user and chats fresh), looked up by `name` AND `instance` — null if it does not exist
//                 there (a branch unchanged in the copy has no copy row of its own) or the reading failed
//       commits   the commits the branch is ahead of the main branch, newest first, at most DETAIL_COMMITS_MAX:
//                 `[{ sha, t, author, subject }]` (`t` ms); null without a detected main branch (not "none")
//       files     `git diff --numstat <main>...<branch>`: `[{ file, plus, minus, binary }]` (binary: plus/minus null), at
//                 most FILES_MAX; null without a main branch or without a common base
//       mr        merge-request.js mergeRequestFor (GitLab directly, with the account of the remote's host): `{ state: "no-gitlab" | "no-access" | "none" | "error" }` or
//                 `{ iid, title, target, pipeline, url }`; "no-gitlab" also without a remote with a readable project path
//                 (git.js remoteLocation)
//       origin    `{ source: "cbase", user, state }` for a cbase branch with a row (user.js) · else
//                 `{ source: "reflog", from, at }` from the oldest reflog line "branch: Created from <from>" · else
//                 `{ source: "unknown" }`
//       clipped   null or `{ commits: {shown, total} | null, files: {shown, total} | null }` — the cap says that it is one.
//                 The file list carries a cap too, hence per part.
//       failed    null or `{ commits: text | null, files: text | null }`: a part whose git failed (`rev-list --count`/`log`
//                 or `diff --numstat` with exit ≠ 0) is `null` AND listed here with its reason — so "failed" can be told
//                 from "no main branch" (`null` without an entry here).
//     If the script itself fails (deadline, output cap, exit ≠ 0, a section missing), the route never answers 404
//     BRANCH_UNKNOWN and never half a response: 504 READ_TIME (`reason: "time"`) or 409 READ_FAILED (`reason: "output" |
//     "exit" | "section"`).
//     MR: in parallel with the reading of the row, at most MR_DEADLINE_MS for both GitLab calls together; above that
//     `{ state: "error" }`.
//   GET /api/projects/:pid/gitView/diff?repo=&instance=&name=&file=
//     → 200 { file, diff, clipped }  — `git diff <main>...<branch> -- <file>` (without external diff/textconv programs,
//       path literal), at most DIFF_MAX bytes (`clipped: true`, cut at a line boundary); 409 NO_MAIN_BRANCH without a main
//       branch; deadline and failure as above (504 READ_TIME, 409 READ_FAILED) — never 404 for a branch the script did not
//       even look for
//
// `repo` (both routes) is checked by repos.js repoChoice: only a code repo of the project (400 REPO_INVALID, 404
// UNKNOWN_REPO).
//
// `name` is the name of the row: a local branch (`feature/x`, `cbase/agent-…`, `copy/k1/main`), else a remote branch
// (`origin/x`), or "detached @ <sha>" (the name groups.js gives a detached HEAD). Read in ONE `sh -c` per request via
// runtime/git-run.js commandRun in the ready instance (instance-choice.js — never wakes); the script also reads the remote
// URL for the MR: it stays in the backend, only `{ host, path }` goes out (git.js remoteLocation — a URL can carry a
// token).
//
// MAIN BRANCH: ONE rule for reading and detail — the shell piece MAIN_SH from mainBranch.js (`origin/HEAD` → `main` →
// `master` → none, per name first `origin/<name>`, then local) is in the header of both scripts (with "local first" a
// local `main` standing still after a merge on GitLab would make the detail compute differently from the list).
//
// Guard: server/backend/test/git-view-detail.test.js.
import crypto from "node:crypto";
import path from "node:path";
import { T } from "../i18n.js";
import { READ_SH, commandRun } from "../runtime/git-run.js";
import { PROJECT_REPO_SECTION, PROJECT_REPO_KEY, remoteLocation } from "../git.js";
import { mergeRequestFor } from "./merge-request.js";
import { DETAIL_COMMITS_MAX } from "./contract.js";
import { readyInstance, instanceDisplay } from "./instance-choice.js";
import { userOf, isCbaseBranch } from "./user.js";
import { MAIN_SH } from "./mainBranch.js";
import { rowFor } from "./overview.js";
import { repoChoice } from "./repos.js";

/** At most this many files in the detail; above that `clipped.files`. */
export const FILES_MAX = 1000;
/** At most this many bytes of diff per file; above that `clipped: true`. */
export const DIFF_MAX = 2 * 1024 * 1024;
const CAP_MS = 20_000;
// The deadline of a script (tunable CBASE_GIT_VIEW_DETAIL_MS — the guard sets it small to hit a deadline IN THE MIDDLE of the script).
const deadline = () => { const n = Number(process.env.CBASE_GIT_VIEW_DETAIL_MS); return Number.isInteger(n) && n > 0 ? n : CAP_MS; };
/** Both GitLab calls of the MR together at most this long (tunable CBASE_GIT_VIEW_MR_MS). Above that `{ state: "error" }`. */
export const MR_DEADLINE_MS = 4_000;
const DETACHED = /^detached @ ([0-9a-f]{4,40})$/;

const error = (status, code, text, extra = {}) => Object.assign(new Error(text), { status, code, ...extra });

// The common header of both scripts: $1 marker, $2 branch name, $3 commit (only for a detached HEAD, else empty). Every
// section ends with a line "<marker> <name> <exit>" (section), its text stands before it. Afterwards in `$top`; `h` = ref of the
// main branch, `r` = ref of the branch.
// The first line: git without programs from the repo (fsmonitor, hooks, gpg — runtime/git-run.js READ_SH).
const HEADER_SCRIPT = `${READ_SH}
m=$1; b=$2; sha=$3
section() { printf '\\n%s %s %s\\n' "$m" "$1" "$2"; }
top=$(git rev-parse --show-toplevel 2>/dev/null) && cd "$top" 2>/dev/null; rc=$?; section top $rc; [ $rc -eq 0 ] || exit 0
git config --bool --get ${PROJECT_REPO_SECTION}.${PROJECT_REPO_KEY}; section projectRepo $?
${MAIN_SH}
printf '%s\\t%s' "$hq" "$h"; section main 0
r=
if [ -n "$sha" ]; then git rev-parse --verify --quiet "$sha^{commit}" >/dev/null && r=$sha
elif git rev-parse --verify --quiet "refs/heads/$b^{commit}" >/dev/null; then r=refs/heads/$b
elif git rev-parse --verify --quiet "refs/remotes/$b^{commit}" >/dev/null; then r=refs/remotes/$b
fi
printf '%s' "$r"; section ref 0
[ -n "$r" ] || exit 0
`;

/** The detail script: header, then upstream and remote URL (for the MR), count and list of the commits ahead, numstat,
 *  reflog. $4 = at most this many commits. */
export const DETAIL_SCRIPT = `${HEADER_SCRIPT}max=$4
rem=; upstream_ref=
case "$r" in
  refs/heads/*) rem=$(git config --get "branch.$b.remote" 2>/dev/null); mg=$(git config --get "branch.$b.merge" 2>/dev/null)
    upstream_ref=\${mg#refs/heads/}; [ -n "$rem" ] || rem=origin; [ -n "$upstream_ref" ] || upstream_ref=$b ;;
  refs/remotes/*) rem=\${b%%/*}; upstream_ref=\${b#*/} ;;
esac
printf '%s\\t%s' "$rem" "$upstream_ref"; section upstream 0
if [ -n "$rem" ] && [ "$rem" != "." ]; then git remote get-url "$rem" 2>/dev/null; section url $?; fi
if [ -n "$h" ]; then
  git rev-list --count "$h..$r"; section count $?
  git log --no-color --format='%H%x1f%ct%x1f%an%x1f%s' -n "$max" "$h..$r"; section commits $?
  git diff --no-color --no-ext-diff --no-textconv --no-renames --numstat -z "$h...$r"; section files $?
fi
case "$r" in refs/heads/*) git reflog show --date=unix --format='%gd%x1f%gs' "$r" 2>/dev/null | tail -n 1; section reflog 0 ;; esac
`;

/** The diff script: header, then `git diff <main>...<branch> -- <file>` as the LAST part (without a marker after it — the
 *  output cap can cut it off). $4 = the file. */
export const DIFF_SCRIPT = `${HEADER_SCRIPT}[ -n "$h" ] || exit 0
section diff 0
git --literal-pathspecs diff --no-color --no-ext-diff --no-textconv "$h...$r" -- "$4"
`;

/** The sections of an output → `{ parts: Map<name, { text, code }>, rest }` (`rest` = what stands after the last marker). */
export function sections(out, marker) {
  const re = new RegExp(`\\n${marker} ([a-z]+) (\\d+)\\n`, "g");
  const parts = new Map();
  let start = 0;
  let m;
  while ((m = re.exec(out))) {
    parts.set(m[1], { text: out.slice(start, m.index), code: Number(m[2]) });
    start = m.index + m[0].length;
  }
  return { parts, rest: out.slice(start) };
}

/** A branch name of the seam → `{ name, sha }` or throws 400. Lets through only ref names git itself would take as a
 *  branch (roughly: no control characters, spaces, `..`, `~^:?*[\\`, no leading `-`); "detached @ <sha>" carries the commit. */
export function branchName(raw) {
  const name = typeof raw === "string" ? raw : "";
  const detached = DETACHED.exec(name);
  if (detached) return { name, sha: detached[1] };
  if (!name || name.length > 255 || name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".lock")
    || name.includes("..") || name.includes("//") || name.includes("@{") || /[\x00-\x20\x7f~^:?*[\\]/.test(name)) {
    throw error(400, "NAME_INVALID", T`"${name.slice(0, 80)}" is not a branch name`);
  }
  return { name, sha: "" };
}

// The repo of the request (repos.js repoChoice: only a code repo of the project) → `{ rel, cwd }`, cwd = the working
// folder in the container (computed from `proj.path` + rel, not from the search's `root` — the same string commandRun knows).
function repoFolder(proj, repo) {
  const r = repoChoice(proj, repo, { required: true });
  return { rel: r.rel, cwd: r.rel ? path.join(proj.path, r.rel) : proj.path };
}

async function run(inst, cwd, script, args, maxBuffer) {
  const marker = `cbase-${crypto.randomBytes(8).toString("hex")}`;
  const r = await commandRun(inst, cwd, "sh", ["-c", script, "sh", marker, ...args], {
    env: { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" }, envAlways: ["GIT_OPTIONAL_LOCKS"], timeout: deadline(), maxBuffer,
  });
  const out = String(r.stdout || "");
  const { parts, rest } = sections(out, marker);
  // The deadline FIRST: expired in the middle of the script, every later section would be empty — and an empty `ref` would mean 404.
  if (r.cap === "deadline") throw failed(r, "time");
  const top = parts.get("top");
  if (!top) {
    // The call itself failed (container stopped, cap before the first part): no waking, the message as it came.
    throw failed(r, r.cap === "output" ? "output" : "exit");
  }
  if (top.code !== 0) throw error(404, "NO_REPO", T("No git repository at this path"));
  if (parts.get("projectRepo")?.text.trim() === "true") {
    throw error(404, "NO_REPO", T("No git repository at this path (cbase keeps the project repository itself; it is not a code repository)"));
  }
  const [hq, href] = (parts.get("main")?.text || "").split("\t");
  const ref = (parts.get("ref")?.text || "").trim();
  return { parts, rest, r, main: href ? { source: hq, ref: href } : null, ref };
}

const notFound = (name) => error(404, "BRANCH_UNKNOWN", T`Branch "${name}" does not exist in this instance`);

// The script failed (see header): `reason` "time" ⇒ 504 READ_TIME, else 409 READ_FAILED ("output", "exit", "section").
function failed(r, reason) {
  const stderr = String(r?.stderr || "").trim().slice(0, 500);
  if (reason === "time") {
    return error(504, "READ_TIME", stderr || T`Reading in the project container: ${deadline() / 1000} s limit reached`, { reason });
  }
  const text = reason === "output" ? T("Reading in the project container: output cap reached")
    : reason === "section" ? T("Reading in the project container: the script stopped early")
      : T`Reading in the project container: exit ${r?.code ?? "?"}`;
  return error(409, "READ_FAILED", stderr ? `${text}: ${stderr}` : text, { reason });
}

// Ref section: if it is missing, the script never got to the lookup — a failure, never "unknown"; if it is empty, the branch does not exist.
function refOrError(l, name) {
  if (!l.parts.has("ref")) throw failed(l.r, l.r.cap === "output" ? "output" : l.r.code !== 0 ? "exit" : "section");
  if (!l.ref) throw notFound(name);
}

// The MR with a deadline: both GitLab calls together at most MR_DEADLINE_MS, then `{ state: "error" }`. Never throws.
async function mrWithDeadline(query) {
  const n = Number(process.env.CBASE_GIT_VIEW_MR_MS);
  const ms = Number.isInteger(n) && n > 0 ? n : MR_DEADLINE_MS;
  const tooLate = { state: "error", error: T`GitLab did not answer within ${ms / 1000} s` };
  const signal = AbortSignal.timeout(ms);
  let tick;
  const expired = new Promise((resolve) => { tick = setTimeout(() => resolve(tooLate), ms); tick.unref?.(); });
  try {
    const mr = await Promise.race([mergeRequestFor({ ...query, signal }), expired]);
    // An abort via the signal comes from merge-request.js as `error` with the abort's text: the same situation, the same wording.
    return signal.aborted && mr?.state === "error" ? tooLate : mr;
  } catch (e) {
    return { state: "error", error: String(e?.message || e).slice(0, 300) };
  } finally { clearTimeout(tick); }
}

/** numstat -z → `{ list, total }` (at most FILES_MAX in `list`). */
export function filesFrom(text) {
  const parts = String(text || "").split("\0");
  const list = [];
  let total = 0;
  for (const t of parts) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(t.replace(/^\n+/, ""));
    if (!m) continue;
    total += 1;
    if (list.length >= FILES_MAX) continue;
    const binary = m[1] === "-" && m[2] === "-";
    list.push({ file: m[3], plus: binary ? null : Number(m[1]), minus: binary ? null : Number(m[2]), binary });
  }
  return { list, total };
}

/** The oldest reflog line → origin "reflog" or null. */
export function originFromReflog(row) {
  const t = String(row || "").trim();
  const [sel, subject] = t.split("\x1f");
  const from = /^branch: Created from (.+)$/.exec(subject || "");
  if (!from) return null;
  const at = /@\{(\d+)\}$/.exec(sel || "");
  return { source: "reflog", from: from[1].trim(), at: at ? Number(at[1]) * 1000 : null };
}

/** The detail of a branch (see header). Query = `{ repo, instance, name }`. Throws with `status`/`code` (and `reason`). */
export async function branchDetail(proj, { repo, instance, name } = {}) {
  const b = branchName(name);
  const { rel, cwd } = repoFolder(proj, repo);
  const { inst, internalName } = readyInstance(proj.id, instance);
  // The row (the reading of the large view, often from the cache) runs NEXT TO the script and the MR; it never throws.
  const rowPromise = rowFor(proj, { repo: rel, instance: instanceDisplay(internalName), name: b.name });
  const l = await run(inst, cwd, DETAIL_SCRIPT, [b.name, b.sha, String(DETAIL_COMMITS_MAX)], 32 * 1024 * 1024);
  refOrError(l, b.name);
  // An output cap or an exit ≠ 0 in the middle of the script: better no response than half a one that would look like a whole one.
  if (l.r.cap) throw failed(l.r, l.r.cap === "deadline" ? "time" : "output");
  if (l.r.code !== 0) throw failed(l.r, "exit");
  // MR: via the remote of the upstream (else origin); without a readable project path no GitLab. The URL itself never leaves this line.
  const [, source] = (l.parts.get("upstream")?.text || "").split("\t");
  const url = l.parts.get("url");
  const location = url && url.code === 0 ? remoteLocation(url.text.trim().split("\n")[0]) : null;
  const mrPromise = location && source && !b.sha ? mrWithDeadline({ host: location.host, projectPath: location.path, sourceBranch: source }) : Promise.resolve({ state: "no-gitlab" });
  const clipped = { commits: null, files: null };
  const failedPart = { commits: null, files: null };
  const partError = (what, t) => T`${what}: exit ${t?.code ?? "missing"}`;
  let commits = null;
  let files = null;
  if (l.main) {
    const z = l.parts.get("commits");
    const a = l.parts.get("count");
    if (z?.code === 0 && a?.code === 0) {
      commits = z.text.split("\n").filter(Boolean).map((row) => {
        const [sha, ct, author, subject] = row.split("\x1f");
        return { sha, t: Number(ct) * 1000, author: author ?? "", subject: subject ?? "" };
      });
      const count = Number(a.text.trim());
      if (Number.isSafeInteger(count) && count > commits.length) clipped.commits = { shown: commits.length, total: count };
    } else failedPart.commits = a?.code !== 0 ? partError("git rev-list --count", a) : partError("git log", z);
    const d = l.parts.get("files");
    if (d?.code === 0) {
      const { list, total } = filesFrom(d.text);
      files = list;
      if (total > list.length) clipped.files = { shown: list.length, total };
    } else failedPart.files = partError("git diff --numstat", d);
  }
  // Origin: a cbase branch from its row (user.js), else the reflog, else unknown.
  let origin = null;
  if (isCbaseBranch(b.name)) {
    const bz = userOf(proj.id, b.name);
    if (bz.user) origin = { source: "cbase", user: bz.user, state: bz.state };
  }
  if (!origin) origin = originFromReflog(l.parts.get("reflog")?.text) || { source: "unknown" };
  const [mr, row] = await Promise.all([mrPromise, rowPromise]);
  return {
    row, commits, files, mr, origin,
    clipped: clipped.commits || clipped.files ? clipped : null,
    failed: failedPart.commits || failedPart.files ? failedPart : null,
  };
}

/** The diff of a file `<main>...<branch>` (see header). Query = `{ repo, instance, name, file }`. Throws with `status`/`code`. */
export async function fileDiff(proj, { repo, instance, name, file } = {}) {
  const b = branchName(name);
  if (typeof file !== "string" || !file || file.includes("\0") || file.length > 4096) {
    throw error(400, "FILE_INVALID", T("file is missing (path relative to the repository)"));
  }
  const { cwd } = repoFolder(proj, repo);
  const { inst } = readyInstance(proj.id, instance);
  const l = await run(inst, cwd, DIFF_SCRIPT, [b.name, b.sha, file], DIFF_MAX + 64 * 1024);
  refOrError(l, b.name);
  if (!l.main) throw error(409, "NO_MAIN_BRANCH", T("No main branch detected (origin/HEAD, main, master) — without it there is no diff."));
  if (!l.parts.has("diff")) throw failed(l.r, l.r.cap === "output" ? "output" : l.r.code !== 0 ? "exit" : "section");
  let diff = l.rest;
  // The output cap (commandRun maxBuffer) ends git in the middle of the diff: then cut at the last whole line.
  const clipped = l.r.cap === "output" || Buffer.byteLength(diff) > DIFF_MAX;
  if (clipped) {
    diff = Buffer.from(diff).subarray(0, DIFF_MAX).toString("utf8");
    const nl = diff.lastIndexOf("\n");
    diff = nl >= 0 ? diff.slice(0, nl + 1) : "";
  } else if (l.r.code !== 0) {
    throw failed(l.r, "exit");
  }
  return { file, diff, clipped };
}
