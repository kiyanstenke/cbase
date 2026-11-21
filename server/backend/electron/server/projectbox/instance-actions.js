// The actions on an instance: the logic behind the routes of the "Instances" tab, and the sub-table of the owner `projectRoutes`
// (projects/routes.js; ctx carries `pid`, `sub`, `proj` there).
//
//   GET  /api/projects/:pid/instances/:instance/repos         → 200 `{ loaded: true, repos: [repo row] }` — per code repo of
//                                                             the instance (the same list as the git view: git.js projectRepos;
//                                                             a copy from its snapshot). Read in ONE `sh -c` IN the instance
//                                                             (runtime/git-run.js commandRun: never git in B). A repo whose part
//                                                             fails carries `error` (the rest stays). If the instance is not ready
//                                                             or the whole call failed: 200 `{ loaded: false, error, state? }` —
//                                                             never an empty list, which would look like "no repos" (empty is not
//                                                             unknown).
//   POST …/instances/:instance/branch { repo, branch }        first the work lock (409 INSTANCE_WORKING), then open changes in the
//                                                             repo (409 OPEN_CHANGES `{ files (cap 50), count }`), then `checkout`
//                                                             IN the instance. A branch that exists only remotely (`origin/x`)
//                                                             creates the local `x` with `--track` (if `x` already exists locally:
//                                                             409 BRANCH_LOCAL_EXISTS — the local one is to be chosen). Both checkouts
//                                                             use `--no-overwrite-ignore`: an IGNORED file (`.env`) that the target
//                                                             branch tracks is not silently overwritten (and deleted when switching
//                                                             back) — 409 IGNORED_FILES `{ files (cap 50), count }`, nothing
//                                                             switched. → 200 `{ repo: <repo row after the switch> }`.
//   POST …/instances/:instance/dismiss { repo, files }        work lock; discards EXACTLY the named files (index and working tree;
//                                                             an untracked one is removed). A path that is not in the CURRENT open
//                                                             list (read without a cap) is 400 UNKNOWN_FILES — and nothing is
//                                                             touched. Paths go after `--` and under `--literal-pathspecs` (no `*`
//                                                             as a pattern, never an option). → 200 `{ repo: <repo row after> }`.
//   POST …/instances/:instance/stack-restart                  work lock; per compose project of the instance (detected like the
//                                                             restore: the labels of the inner containers, compose-config.js) ONE
//                                                             `docker compose … up -d --build` IN the instance (docker.js dockerIn,
//                                                             argument arrays, cap), one after the other. ASYNCHRONOUS: → 202
//                                                             `{ instance, action }` at once, the run goes on; progress and result
//                                                             `{ stacks: [{ project, ok, error }] }` (a failed stack does not drag
//                                                             the others down) are carried by the event `project/instance` (field
//                                                             `action`) and the tree (`action` per instance). A synchronous request
//                                                             would wait for the whole build — a 524 with an empty body behind the
//                                                             100 s tunnel, and a second click would start a second `compose up`.
//   POST …/instances/:instance/stop                           work lock as above (main included), then `ready → stopping → stopped`
//                                                             (projectbox/instance-stop.js instanceStop: fresh desired state,
//                                                             sessions with a notice, `docker stop -t 30` by id over the seam).
//                                                             → 202 `{ instance: <row in stopping> }`; the end is reported by the
//                                                             event `project/instance`.
//   POST …/instances/:instance/start                          only from `stopped` (409 INSTANCE_NOT_STOPPED), through the storage
//                                                             gate. → 202 `{ instance, kind: "start" | "waiting", wait: { since,
//                                                             reason } | null }` — `start`: the row is in `start` and boots;
//                                                             `waiting`: it stays `stopped` with the phase `waiting_storage` and
//                                                             starts by itself as soon as the gate opens.
//   POST …/instances/:instance/start-abort                    withdraws the waiting (409 NO_WAITING_START if none waits).
//                                                             → 200 `{ instance }`.
//
// COMMON: without projectboxOps() 404 "only in server operation" (like the copy routes), before anything is read; a project that is
// not converted 409 NOT_CONVERTED; `:instance` is "main" or "copy-<name>" of a LIVING instance row, else 404 UNKNOWN_INSTANCE.
// The three writing actions and stop demand a READY instance (409 INSTANCE_NOT_READY with `state`), no explicit lock (409
// INSTANCE_LOCKED — relocation, recreate, delete, freeze, layout) and no procedure on it (409 OCCUPIED — fetch, clear away,
// restore …). A body with an unknown field or without a required one is 400 (a missing field is no statement). Every error
// answers `{ error, code, … }`.
//
// THE WORK LOCK is projectbox/idle.js instanceWork — the same computation as before clearing away a copy and in DELETE. Main is
// included. From project networks the seven routes are NOT reachable (fence rows "project-instance-…", projectbox/fence-table.js):
// agents have no tool for them.
//
// THE OCCUPANCY: branch switch, dismiss and stack restart run under the instance occupancy "branch" | "dismiss" | "stack-restart"
// (projectbox/instance.js withInstanceOccupancy, sets in OCCUPANCY_SET) — set in the SAME step as the check (checkAction), so
// without a window. While it stands, stop, start, a copy (project occupancy) and every second action on the same instance are 409
// OCCUPIED. Checking only BEFORE the action let a stop in the middle of a rebuild through (the build aborted, the desired state was
// half), a stop in the middle of `git checkout` left `.git/index.lock` behind, a second restart ran in parallel. The running
// action is kept in projectbox/instance-action-status.js — /api/runs/active counts it as project work (`state: "action"`, the kind
// as phase), the deploy gate and the idle reaper wait for it; the tree shows it (`action`). Branch switch and dismiss stay
// SYNCHRONOUS in the request: one `git checkout`/`restore` each under the cap of the git run (GIT_RUN_CAP_MS) — if the tunnel
// tears the request down, the action runs to its end under its occupancy, a second click is 409, and the tree then shows the branch.
// LIMIT: a TURN that begins during the action runs — the occupancy locks procedures on the instance, not starts (projectLocks has
// no reason for that). STOP closes this window: `stop` counts as work (PROJECT_WORK_STATES).
//
// Guards: server/backend/test/instance-actions.test.js and instance-stop.test.js (fake docker, real server); the sub-table in
// server/backend/test/dispatcher.test.js, the fence rows in server/backend/test/fence.test.js.
import crypto from "node:crypto";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { NEXT, readBody, send } from "../runtime/http.js";
import { CONTAINER_PAUSED, CONTAINER_STANDS, GIT_RUN_CAP_MS, commandRun, gitRun } from "../runtime/git-run.js";
import { STATUS_OUTPUT, projectRepos } from "../git.js";
import { ONLY_IN_OPS, projectboxOps } from "./ops.js";
import { MAIN, copyNameOf } from "./creation.js";
import { containerOf, runInstance } from "./run-instance.js";
import { instanceStartAbort, waitForInstanceStart, instanceStart, instanceStop, checkAction } from "./instance-stop.js";
import { withInstanceOccupancy } from "./instance.js";
import { actionBegins, actionEnds, actionStatus, actionBetween } from "./instance-action-status.js";
import { broadcast } from "../runtime/sse.js";
import { dockerIn } from "./docker.js";
import { ComposeConfigError, LABEL, composeConfig, configKey, labelsOf } from "./compose-config.js";
import { insideInspect } from "./restore.js";

/** How many open files a repo row and a 409 OPEN_CHANGES name; the count stands next to it (cap with number). */
export const OPEN_CAP = 50;
// The cap of a `compose up -d --build`. ESTIMATED, NOT MEASURED: a build with dependencies takes minutes; 30 min is a multiple.
// Knob CBASE_STACK_RESTART_MS (integer > 0), read at run time. The message of the cap comes from docker.js.
export const STACK_RESTART_CAP_MS = 30 * 60_000;
const stackCapMs = () => {
  const n = Number(process.env.CBASE_STACK_RESTART_MS);
  return Number.isInteger(n) && n > 0 ? n : STACK_RESTART_CAP_MS;
};

const error = (status, code, text, extra = {}) => Object.assign(new Error(text), { status, code, ...extra });

// ── The instance ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** `:instance` → the instance row (see header: 409 NOT_CONVERTED, 404 UNKNOWN_INSTANCE). Rethrows read failures (unreadable ⇒ 500). */
export function instanceOf(projectId, raw) {
  const pid = String(projectId ?? "");
  const name = String(raw ?? "");
  let valid = true;
  try { copyNameOf(name); } catch { valid = false; }
  if (!valid || !name) throw error(404, "UNKNOWN_INSTANCE", T`No instance "${name}" — "main" or "copy-<name>".`);
  if (!store.converted(pid)) throw error(409, "NOT_CONVERTED", T`Project ${pid} has not been moved — it has no instances.`);
  const inst = runInstance(pid, name);
  if (!inst) throw error(404, "UNKNOWN_INSTANCE", T`No living instance "${name}" in project ${pid}.`, { instance: name });
  return inst;
}

// The check of every writing action (ready, lock, occupancy, work lock) lives in projectbox/instance-stop.js checkAction — ONE
// place for branch, dismiss, stack restart and stop.

// ── git in the instance ───────────────────────────────────────────────────────────────────────────────────────────────────

// A git call IN the instance that throws on exit ≠ 0 — a stopped/paused container as 409 CONTAINER_STANDS.
async function g(inst, cwd, args, opts = {}) {
  const r = await gitRun(inst, cwd, args, opts);
  if (r.code === 0) return r.stdout;
  const text = String(r.stderr || "").trim() || `git ${args[0]}: Exit ${r.code}`;
  if (CONTAINER_STANDS.test(text) || CONTAINER_PAUSED.test(text)) throw error(409, "CONTAINER_STANDS", text);
  throw error(500, "GIT", text);
}

// The files that a `checkout --no-overwrite-ignore` refused to overwrite (or delete) — the tab-indented lines under "The following
// untracked working tree files would be overwritten|removed by checkout:". The run uses LC_ALL=C (the wording is the English one,
// independent of the container's language). Untracked files never appear there: the open check before (`status
// --untracked-files=all`) has already turned them away — what stands here is ignored.
export function ignoredFromCheckout(stderr) {
  const out = [];
  let inside = false;
  for (const z of String(stderr || "").split("\n")) {
    if (/^error: The following untracked working tree files would be (overwritten|removed) by checkout:/.test(z)) { inside = true; continue; }
    if (!inside) continue;
    if (z.startsWith("\t")) out.push(z.slice(1));
    else inside = false;
  }
  return [...new Set(out)];
}
const CHECKOUT_ENV = { env: { LC_ALL: "C" }, envAlways: ["LC_ALL"] };
// A checkout that overwrites no ignored file: 409 IGNORED_FILES with list and count, otherwise like g().
async function checkoutWithoutOverwrite(inst, root, args, { repo, branch }) {
  try { return await g(inst, root, ["checkout", "--no-overwrite-ignore", ...args], CHECKOUT_ENV); }
  catch (e) {
    const files = e?.code === "GIT" ? ignoredFromCheckout(e.message) : [];
    if (!files.length) throw e;
    const named = files.slice(0, 10).join(", ");
    throw error(409, "IGNORED_FILES", T`${files.length} ignored file(s) in repository "${repo}" are tracked by branch "${branch}" (${named}${files.length > 10 ? ", …" : ""}) — switching would overwrite them, and switching back would delete them. Nothing switched: back them up or move them first, then switch.`,
    { files: files.slice(0, OPEN_CAP), count: files.length });
  }
}

// The read commands of a repo row (ONE `sh -c` per instance, pattern of git.js). `-z`: paths raw, never quoted.
const READ = Object.freeze([
  ["branch", ["symbolic-ref", "--quiet", "--short", "HEAD"]],
  ["short", ["rev-parse", "--short", "HEAD"]],
  ["status", ["status", "--porcelain=v1", "-z", "--untracked-files=all"]],
  ["local", ["for-each-ref", "--format=%(refname)", "refs/heads"]],
  ["removed", ["for-each-ref", "--format=%(refname)", "refs/remotes"]],
]);
const shWord = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
export const REPOS_SCRIPT = [
  "m=$1; shift; i=0",
  "for r in \"$@\"; do",
  ...READ.map(([, args], j) => `  (cd "$r" && exec git ${args.map(shWord).join(" ")}) 2>/dev/null; printf '\\n%s %s %s %s\\n' "$m" "$i" ${j} "$?"`),
  "  i=$((i+1))",
  "done",
].join("\n");

/** `git status --porcelain=v1 -z` → `[{ x, y, path }]`; for rename/copy the old path stands next to it as its own row
 *  (`old: true`) — it is just as "open" (discarded it comes back from HEAD). Ignored files never appear in it. */
export function openFrom(text) {
  const parts = String(text || "").split("\0");
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const t = parts[i];
    if (t.length < 4) continue;
    const x = t[0];
    const y = t[1];
    out.push({ x, y, path: t.slice(3) });
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      const old = parts[++i];
      if (old) out.push({ x, y, path: old, old: true });
    }
  }
  return out;
}
const refsFrom = (text, front) => String(text || "").split("\n").map((z) => z.trim()).filter((z) => z.startsWith(front))
  .map((z) => z.slice(front.length)).filter((z) => z && z !== "HEAD" && !z.endsWith("/HEAD")).sort();

// The row from the results of ONE repo: a failed part stands as `error`, the rest stays.
function rowFrom({ name, relPath }, w) {
  const z = { rel: relPath || "", name, branch: "", detached: false, open: null, openCount: null, branches: null, remotes: null };
  const problems = [];
  const branch = w.get("branch");
  const short = w.get("short");
  if (branch?.code === 0) z.branch = branch.stdout.trim();
  else { z.detached = true; z.branch = short?.code === 0 ? short.stdout.trim() : ""; }
  const st = w.get("status");
  if (st?.code === 0) {
    const open = openFrom(st.stdout);
    z.open = open.slice(0, OPEN_CAP).map((o) => o.path);
    z.openCount = open.length;
  } else problems.push(T`Status not readable (exit ${st?.code ?? "?"})`);
  const local = w.get("local");
  if (local?.code === 0) z.branches = refsFrom(local.stdout, "refs/heads/");
  else problems.push(T("Local branches not readable"));
  const removed = w.get("removed");
  if (removed?.code === 0) z.remotes = refsFrom(removed.stdout, "refs/remotes/");
  else problems.push(T("Remote branches not readable"));
  if (problems.length) z.error = problems.join("; ");
  return z;
}

/** The repo rows of these repos in ONE call. Throws if the call itself fails (container stopped, cap). */
async function readRepos(inst, repos) {
  if (!repos.length) return [];
  const marker = `cbase-${crypto.randomBytes(8).toString("hex")}`;
  const r = await commandRun(inst, "/", "sh", ["-c", REPOS_SCRIPT, "sh", marker, ...repos.map((x) => x.root)], {
    // Reading takes no optional locks: a `git status` in a repo where an agent is working would otherwise create an `index.lock`
    // that makes its next step fail. `envAlways` so that it is passed even if B carries it itself.
    env: { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    envAlways: ["GIT_OPTIONAL_LOCKS"],
    timeout: GIT_RUN_CAP_MS,
    // One MiB per repo for branches and head, plus ONCE the room for a large status (like git.js).
    maxBuffer: STATUS_OUTPUT + 1024 * 1024 * repos.length,
  });
  if (r.code !== 0) {
    const text = String(r.stderr || "").trim() || `reading the repos in the project container: exit ${r.code}`;
    throw error(CONTAINER_STANDS.test(text) || CONTAINER_PAUSED.test(text) ? 409 : 500, "REPOS_UNREADABLE", text);
  }
  return repoRowsFrom(r.stdout, marker, repos);
}

/** The output of REPOS_SCRIPT (from the start of the first repo) → the repo rows in the order of `repos`. Also used for the tree
 *  (projectbox/instances-tree.js), which runs the same script behind `docker ps` in the SAME call. */
export function repoRowsFrom(stdout, marker, repos) {
  const text = String(stdout || "");
  const values = repos.map(() => new Map());
  const re = new RegExp(`\\n${marker} (\\d+) (\\d+) (\\d+)\\n`, "g");
  let from = 0;
  for (const t of text.matchAll(re)) {
    const target = values[Number(t[1])];
    const read = READ[Number(t[2])];
    if (target && read) target.set(read[0], { code: Number(t[3]), stdout: text.slice(from, t.index) });
    from = t.index + t[0].length;
  }
  return repos.map((x, i) => rowFrom(x, values[i]));
}

// The code repos of the instance (git.js projectRepos — a copy from its snapshot).
async function reposTheInstance(proj, inst) {
  return projectRepos(proj.path, { instance: inst });
}

/** GET …/repos. Never throws for read errors — they stand in the response. */
export async function instanceRepos(proj, inst) {
  if (inst.state !== "ready") {
    return { loaded: false, state: inst.state, error: T`Instance ${inst.instance} is not ready (${inst.state}).` };
  }
  try {
    const repos = await reposTheInstance(proj, inst);
    return { loaded: true, repos: await readRepos(inst, repos) };
  } catch (e) {
    return { loaded: false, error: String(e?.message || e) };
  }
}

// The repo of a body: `repo` is the `rel` of a row of GET …/repos ("" = the project folder itself).
async function repoFrom(proj, inst, rel) {
  const repos = await reposTheInstance(proj, inst);
  const r = repos.find((x) => (x.relPath || "") === rel);
  if (!r) throw error(400, "UNKNOWN_REPO", T`No code repository "${rel}" in instance ${inst.instance}.`);
  return r;
}
const statusOf = async (inst, root) => openFrom(await g(inst, root, READ[2][1], { maxBuffer: STATUS_OUTPUT }));
const rowOf = async (inst, r) => (await readRepos(inst, [r]))[0];

// ── Bodies ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

function bodyWith(d, fields) {
  if (!d || typeof d !== "object" || Array.isArray(d)) throw error(400, "BODY", T("The body is not a JSON object."));
  const unknown = Object.keys(d).filter((k) => !fields.includes(k));
  if (unknown.length) throw error(400, "BODY", T`Unknown fields: ${unknown.join(", ")} (allowed: ${fields.join(", ")}).`);
  for (const f of fields) if (d[f] === undefined) throw error(400, "BODY", T`The field "${f}" is missing.`);
  return d;
}
// A value that goes into an argv must never look like an option and must carry no line break/NUL.
const noOption = (s, what) => {
  if (typeof s !== "string" || !s || s.startsWith("-") || /[\0\r\n]/.test(s)) throw error(400, "BODY", T`Invalid ${what}: "${String(s).slice(0, 80)}".`);
  return s;
};
export function branchFromBody(d) {
  const { repo, branch } = bodyWith(d, ["repo", "branch"]);
  if (typeof repo !== "string") throw error(400, "BODY", T("`repo` is a string (the row's `rel`)."));
  return { repo, branch: noOption(branch, T("branch##invalid value")) };
}
export function dismissFromBody(d) {
  const { repo, files } = bodyWith(d, ["repo", "files"]);
  if (typeof repo !== "string") throw error(400, "BODY", T("`repo` is a string (the row's `rel`)."));
  if (!Array.isArray(files) || !files.length || files.some((p) => typeof p !== "string" || !p || /[\0]/.test(p))) {
    throw error(400, "BODY", T("`files` is a non-empty list of paths."));
  }
  return { repo, files: [...new Set(files)] };
}

// ── The actions ─────────────────────────────────────────────────────────────────────────────────────────────────────────

// ── Under the occupancy (header "THE OCCUPANCY") ──────────────────────────────────────────────────────────────────────────────

// The event of an action: the row of the instance as projectbox/instances.js reports it, plus `action`
// (instance-action-status.js). The same kind as every state change — the clients load the tree on `project/instance` anyway.
// NEVER throws: a throw here (read error of the row) would stand before the `try` of asAction — the status would stay on running,
// and `busy` would be true until the next start of B.
function reportAction(pid, name) {
  let z = null;
  try { z = store.projectInstance(pid, name); } catch { /* report only: the action itself does not depend on it */ }
  try {
    broadcast({ type: "project/instance", projectId: pid, instance: name, state: z?.state ?? null, phase: z?.phase ?? "", error: z?.error ?? "", action: actionStatus(pid, name) });
  } catch { /* likewise */ }
}

/**
 * `fn` as action `kind` on the instance: check (checkAction) and occupancy in the SAME step, the status from begin to end
 * (instance-action-status.js), one event each at begin and end. `result(r)` makes `{ ok, error, stacks }` from the return value
 * (default: succeeded). → `{ state, finished }`: `state` is the beginning (set synchronously), `finished` the promise of `fn` (it
 * throws its error — the status then carries it as `error`).
 */
function asAction(inst, kind, fn, result = () => ({ ok: true })) {
  checkAction(inst);
  const pid = String(inst.projectId);
  const name = inst.instance || MAIN;
  let state = null;
  const finished = withInstanceOccupancy(pid, name, kind, async () => {
    state = actionBegins(pid, name, kind);
    reportAction(pid, name);
    let end = { ok: false, error: "" };
    try {
      const r = await fn();
      end = result(r);
      return r;
    } catch (e) {
      end = { ok: false, error: String(e?.message || e) };
      throw e;
    } finally {
      actionEnds(pid, name, end);
      reportAction(pid, name);
    }
  });
  if (!state) finished.catch(() => {}); // occupied in the same step (cannot be after checkAction) — the throw comes via `finished`
  return { state, finished };
}

/** POST …/branch. → `{ repo }` */
export async function branchSwitch(proj, inst, body) {
  return asAction(inst, "branch", () => branchRun(proj, inst, body)).finished;
}
async function branchRun(proj, inst, { repo, branch }) {
  const r = await repoFrom(proj, inst, repo);
  const open = await statusOf(inst, r.root);
  if (open.length) {
    throw error(409, "OPEN_CHANGES", T`${open.length} file(s) are open in repository "${repo || r.name}" — discard or commit them first, then switch the branch.`, { files: open.slice(0, OPEN_CAP).map((o) => o.path), count: open.length });
  }
  const local = refsFrom(await g(inst, r.root, READ[3][1]), "refs/heads/");
  const removed = refsFrom(await g(inst, r.root, READ[4][1]), "refs/remotes/");
  if (local.includes(branch)) {
    // `--`: a branch named like a file stays a branch.
    await checkoutWithoutOverwrite(inst, r.root, [branch, "--"], { repo: repo || r.name, branch });
  } else if (removed.includes(branch)) {
    const name = branch.slice(branch.indexOf("/") + 1);
    if (!name) throw error(400, "UNKNOWN_BRANCH", T`"${branch}" names no branch.`);
    if (local.includes(name)) {
      throw error(409, "BRANCH_LOCAL_EXISTS", T`A local branch "${name}" already exists — choose it instead of "${branch}".`, { local: name });
    }
    noOption(name, T("branch##invalid value"));
    await checkoutWithoutOverwrite(inst, r.root, ["--track", "-b", name, `refs/remotes/${branch}`], { repo: repo || r.name, branch });
  } else {
    throw error(400, "UNKNOWN_BRANCH", T`No branch "${branch}" in repository "${repo || r.name}" (local or remote).`);
  }
  return { repo: await rowOf(inst, r) };
}

/** POST …/dismiss. → `{ repo }` */
export async function filesDismiss(proj, inst, body) {
  return asAction(inst, "dismiss", () => dismissRun(proj, inst, body)).finished;
}
async function dismissRun(proj, inst, { repo, files }) {
  const r = await repoFrom(proj, inst, repo);
  const open = await statusOf(inst, r.root);
  const perPath = new Map(open.map((o) => [o.path, o]));
  const unknown = files.filter((p) => !perPath.has(p));
  if (unknown.length) {
    throw error(400, "UNKNOWN_FILES", T`Not open in "${repo || r.name}": ${unknown.slice(0, OPEN_CAP).join(", ")} — nothing discarded.`, { files: unknown.slice(0, OPEN_CAP), count: unknown.length });
  }
  const untracked = files.filter((p) => perPath.get(p).x === "?");
  const tracked = files.filter((p) => perPath.get(p).x !== "?");
  if (tracked.length) {
    let withHead = true;
    try { await g(inst, r.root, ["rev-parse", "--verify", "--quiet", "HEAD"]); } catch (e) { if (e?.code === "CONTAINER_STANDS") throw e; withHead = false; }
    // With HEAD: index and working tree from HEAD (a file new only in the index drops out of both). Without a commit there is no
    // HEAD: every tracked file is new in the index — removed from index and working tree.
    await g(inst, r.root, withHead
      ? ["--literal-pathspecs", "restore", "--source=HEAD", "--staged", "--worktree", "--", ...tracked]
      : ["--literal-pathspecs", "rm", "-q", "-f", "--", ...tracked]);
  }
  // Untracked: git itself removes them (only untracked, never ignored, only in the repo) — no `rm` with a path from the body.
  if (untracked.length) await g(inst, r.root, ["--literal-pathspecs", "clean", "-f", "-q", "--", ...untracked]);
  return { repo: await rowOf(inst, r) };
}

/** The compose projects of the instance from the labels of its inner containers → `[{ project, config | error }]`. */
export function stacksFrom(inspect) {
  const groups = new Map();
  for (const c of inspect || []) {
    const l = labelsOf(c);
    if (!l[LABEL.project]) continue; // not a compose container
    if (String(l[LABEL.oneoff] || "").toLowerCase() === "true") continue; // `compose run` — no part of the stack
    let k;
    try { k = composeConfig(c); }
    catch (e) {
      if (!(e instanceof ComposeConfigError)) throw e;
      const key = `error:${l[LABEL.project]}`;
      if (!groups.has(key)) groups.set(key, { project: String(l[LABEL.project]), error: e.message });
      continue;
    }
    const key = configKey(k);
    if (!groups.has(key)) groups.set(key, { project: k.project, config: k });
  }
  return [...groups.values()].sort((a, b) => a.project.localeCompare(b.project));
}

const shorter = (s) => { const t = String(s || "").trim(); return t.length > 2000 ? `…${t.slice(-2000)}` : t; };

/**
 * POST …/stack-restart. Check and occupancy synchronous — throws the checks (status/code) —, then the restart runs in the
 * background. → `{ action, finished }`: `action` the status at the beginning (`running: true`), `finished` the promise of the run
 * (never throws; the result is in the status and the event).
 */
export function stackRestartNudge(inst) {
  const name = inst.instance || MAIN;
  const { state, finished } = asAction(inst, "stack-restart", () => stackRestartRun(inst), (r) => {
    const bad = r.stacks.filter((s) => !s.ok);
    return { ok: !bad.length, error: bad.map((s) => `${s.project}: ${s.error || "?"}`).join("; "), stacks: r.stacks };
  });
  const silent = finished.catch((e) => { console.error(`[instances] stack restart ${inst.projectId}/${name}:`, e?.message || e); return null; });
  // Without a status no occupancy (not reachable in the same step as checkAction) — never a 202 without a running action.
  if (!state) throw error(409, "OCCUPIED", T`Another procedure is running on instance ${name}.`);
  return { action: state, finished: silent };
}

// The run: per compose project ONE `up -d --build`, one after the other; after each stack an interim status with an event.
async function stackRestartRun(inst) {
  const pid = String(inst.projectId);
  const name = inst.instance || MAIN;
  const container = containerOf(inst);
  let inspect;
  try { inspect = await insideInspect(container); }
  catch (e) { throw error(500, "STACKS_UNREADABLE", T`The instance's containers cannot be read: ${e?.message || e}`); }
  const stacks = [];
  const between = () => { actionBetween(pid, name, { stacks }); reportAction(pid, name); };
  for (const s of stacksFrom(inspect)) {
    if (!s.config) { stacks.push({ project: s.project, ok: false, error: s.error }); between(); continue; }
    try {
      await dockerIn(container, ["compose", ...s.config.args, "up", "-d", "--build"], { capMs: stackCapMs() });
      stacks.push({ project: s.project, ok: true, error: null });
    } catch (e) {
      stacks.push({ project: s.project, ok: false, error: shorter([e?.message, e?.stderr].filter(Boolean).join("\n")) });
    }
    between();
  }
  return { stacks };
}

// ── The sub-table ─────────────────────────────────────────────────────────────────────────────────────────────────────

const responseError = (res, e, where) => {
  const status = Number.isInteger(e?.status) && e.status >= 400 && e.status < 600 ? e.status : 500;
  if (status === 500) console.error(`[instances] ${where}:`, e?.message || e);
  const { status: _s, message: _m, stack: _st, name: _n, ...extra } = Object.assign({}, e);
  const text = String(e?.message || e);
  return send(res, status, { ...extra, error: text, ...(e?.code ? { code: String(e.code) } : {}) });
};

export async function instanceProjectRoutes(ctx) {
  const { req, res, m, pid, sub, proj } = ctx;
  const t = sub.match(/^\/instances\/([^/]+)\/(repos|branch|dismiss|stack-restart|stop|start|start-abort)$/);
  if (!t) return NEXT;
  const action = t[2];
  if (action === "repos" ? m !== "GET" : m !== "POST") return NEXT;
  if (!projectboxOps()) return send(res, 404, { error: ONLY_IN_OPS });
  let name;
  try { name = decodeURIComponent(t[1]); } catch { return send(res, 400, { error: "instance: malformed encoding" }); }
  let response;
  try { response = await instanceAction(req, proj, pid, name, action); }
  catch (e) { return responseError(res, e, `${action} ${pid}/${name}`); }
  if (response) return send(res, response.status || 200, response.body || response);
  return NEXT;
}

// One action of the sub-table → its body (200). The request body first (400 before any question to instance and container) —
// a missing field is no statement.
async function instanceAction(req, proj, pid, name, action) {
  let body = null;
  if (action === "branch") body = branchFromBody(await readBody(req));
  else if (action === "dismiss") body = dismissFromBody(await readBody(req));
  else if (action !== "repos") bodyWith(await readBody(req), []); // stack-restart, stop, start, start-abort: no field
  const inst = instanceOf(pid, name);
  if (action === "repos") return instanceRepos(proj, inst);
  if (action === "branch") return branchSwitch(proj, inst, body);
  if (action === "dismiss") return filesDismiss(proj, inst, body);
  if (action === "stop") return { status: 202, body: { instance: instanceStop(inst).row } };
  if (action === "start") {
    const r = instanceStart(pid, inst.instance, { cause: "human" });
    if (r.kind === "denied") await r.promise; // throws the refusal (OCCUPIED, …) with status/code
    return { status: 202, body: { instance: r.row, kind: r.kind, wait: r.kind === "waiting" ? waitForInstanceStart(pid, inst.instance) : null } };
  }
  if (action === "start-abort") return { instance: instanceStartAbort(pid, inst.instance) };
  return { status: 202, body: { instance: inst.instance, action: stackRestartNudge(inst).action } };
}
