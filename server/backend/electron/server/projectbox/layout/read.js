// Reading and checking the layout of an existing project.
//
// READ-ONLY. Nothing here moves, deletes, stops or writes in the project: the tree comes from the container program
// (`./program.js`, via `commandRun` in the project container — B never reads the mounted folder by path names), git runs in the
// container with `GIT_HARDENING` and `--no-optional-locks` (no `git status` writes the index), Docker only with reading
// commands (`./docker-read.js`), the citations only from the database (`./citations.js`). Executing is the procedure's job
// (procedure.js), quiet and holders are job.js.
//
//   layoutSituation(pid, proj, rootGit)  → { rootIsRepo, copyOpen, locked } — when the layout is view-only
//   layoutLevel(pid, proj, path)         GET …/layout — one level (see program.js `level`) with the situation
//   startCheck(pid, proj, steps)         POST …/layout/check — the operation; → id
//   checkView(pid, id)                   GET …/layout/check/:id — the state, or null (unknown/expired)
//   layoutCheck(pid, id)                 for job.js/procedure.js: the entry with `steps` and `result.confirmable`, or null
//   normalizeSteps(body)                 the body → `{ steps }` or `{ error }` (400)
//
// THE OPERATION is asynchronous because counting sizes (an lstat run in the container instead of `du -sb`, which macOS does not
// know) and git over all refs of large repos take longer than the 100 s Cloudflare keeps a request open. The result lives in
// the memory of THIS process: `checkMs()` (default 30 min, knob `CBASE_LAYOUT_CHECK_MS`, 0 = expired at once) after the end,
// then 404 and the client checks again. Expiry happens on read (no timer). A new check of the same project aborts the running
// one (`aborted`, its result is dropped). At most PER_PROJECT entries stay per project. Event `project/layout` with
// `kind: "check"` at the start and at the end — only id, project and state (no paths, no names).
//
// ERRORS OF THE COMPUTATION THAT ALREADY APPLIED BEFORE: the server computes the plan on the WHOLE tree (it is the boundary). A
// violation the tree already carries without steps (a repo under `vendor/`, a file name with a line break) appears in `error`
// with `prior: true` — the computation itself (plan.js) does not distinguish it; whether it blocks "take over" is decided by
// job.js.

import crypto from "node:crypto";
import path from "node:path";

import * as store from "../../store.js";
import { T } from "../../i18n.js";
import { broadcast } from "../../runtime/sse.js";
import { commandRun, gitRun } from "../../runtime/git-run.js";
import { MAIN } from "../creation.js";
import { ComposeConfigError, LABEL, composeConfig, configKey } from "../compose-config.js";
import { rulesResponse } from "../setup/rules.js";
import { setupOpen } from "../setup/status.js";
import { containerOf, runInstance } from "../run-instance.js";
import { projectLocked } from "../idle.js";
import { GIT_HARDENING, carriesProjectRepoMarker } from "../projectRepo.js";
import {
  affectedContainer, referencesOf, composeNameWithoutP, containerRow, dockerInventory, fixedContainerName, deleteSet, setPerPath,
  modelReferences, normalizeProjectName, relInside, underAbs,
} from "./docker-read.js";
import { collectCitations } from "./citations.js";
import { mappingFromEnd, nameOf, computePlan, under, compare, targetOf } from "./plan.js";
import { PROGRAM } from "./program.js";

export const CHECK_MS = 30 * 60_000;
export const LEVEL_CAP = 5_000; // entries per level (GET) — above it `truncated` with the number
export const TREE_CAP = 500_000; // nodes of the whole tree (check) — above it the check fails with a message
export const FINAL_TREE_CAP = 20_000; // nodes of the final tree in the response — above it `finalTree: null` with the number
export const REF_CAP = 200; // refs per repo whose unpushed commits are counted individually
export const PER_PROJECT = 5;
export const NAMES_PER_LIST = 5;
const OUTPUT = 64 * 1024 * 1024;

const slider = (name, preset, min = 0) => {
  const raw = process.env[name];
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isSafeInteger(n) && n >= min ? n : preset;
};
export const checkMs = () => slider("CBASE_LAYOUT_CHECK_MS", CHECK_MS);
export const treeCap = () => slider("CBASE_LAYOUT_TREE_CAP", TREE_CAP, 1);

export class LayoutError extends Error {
  constructor(code, status, message, fields = {}) {
    super(message);
    this.name = "LayoutError";
    this.code = code;
    this.status = status;
    Object.assign(this, fields);
  }
}
const short = (s, n = 300) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const rows = (s) => String(s || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const relTo = (root, abs) => { const r = path.relative(root, abs); return relInside(r) ? r : null; }; // by whole path parts

// ── Situation: when the layout is view-only ──────────────────────────────────────────────────────────────────────────────────────

// Like projects/routes.js relocationInProgress (private there; the same three sources): lock "relocation", open relocation, an
// instance in `relocation`. Exported because "remove old containers" (./superseded.js) asks the same computation (409).
export const relocationInProgress = (pid) => projectLocked(pid)?.reason === "relocation" || Boolean(store.openRelocation(pid))
  || store.projectInstancesOf(pid).some((i) => i.state === "relocation");

/** The situation of the layout: `rootIsRepo` (the root carries a `.git` that is not the project repo), `copyOpen` (with name),
 *  `locked` ({ reason, code, text, name? } — relocation · setup · copy · root-is-repo · not-ready; the order is that of the
 *  response, only the first reason is there). `rootGit` comes from the container program. */
export function layoutSituation(pid, proj, rootGit) {
  const copies = store.liveStackCopies(pid);
  const copyOpen = copies.length ? { name: copies[0].name, count: copies.length } : null;
  const rootIsRepo = rootGit != null && !(rootGit === "folder" && carriesProjectRepoMarker(proj.path));
  let locked = null;
  if (relocationInProgress(pid)) {
    locked = { reason: "relocation", code: "RELOCATION", text: T("The project is moving — the structure is view-only.") };
  } else if (setupOpen(pid)) {
    locked = { reason: "setup", code: "SETUP_OPEN", text: T("The project is still being set up — the structure is view-only.") };
  } else if (copyOpen) {
    locked = { reason: "copy", code: "COPY_OPEN", name: copyOpen.name, text: T`The copy “${copyOpen.name}” is open — the structure is view-only until it is removed.` };
  } else if (rootIsRepo) {
    locked = { reason: "root-is-repo", code: "ROOT_IS_REPO", text: T("This project is itself a code repository — the structure is view-only here.") };
  } else if (store.projectInstance(pid, MAIN)?.state !== "ready") {
    locked = { reason: "not-ready", code: "NOT_READY", text: T("The project container is not ready.") };
  }
  return { rootIsRepo, copyOpen, locked };
}

// ── The container program ─────────────────────────────────────────────────────────────────────────────────────────────

// Also used for the take-over (the fresh situation) and the counter-check before the turn point (the tree of NOW).
export async function program(inst, op, o, { signal = null, withoutDeadline = true } = {}) {
  const r = await commandRun(inst, "/", process.execPath, ["-e", PROGRAM, "--", op, JSON.stringify(o)], {
    maxBuffer: OUTPUT, ...(withoutDeadline ? { withoutDeadline: true } : {}), ...(signal ? { signal } : {}),
  });
  if (r.aborted) throw new LayoutError("ABORTED", 409, `${op}: aborted`);
  if (r.cap) throw new LayoutError("CAP", 500, `${op} in the project container: cap of the ${r.cap === "deadline" ? "deadline" : "output"} reached — aborted, nothing truncated`);
  let a = null;
  try { a = JSON.parse(String(r.stdout || "").trim().split("\n").pop() || "null"); } catch { a = null; }
  if (!a) throw new LayoutError("PROGRAM", 500, `${op} in the project container: ${short(String(r.stderr || "").split("\n").slice(-3).join(" "), 200) || `Exit ${r.code}`}`);
  if (a.ok === false) throw new LayoutError(a.code || "EERROR", 500, short(a.message || `${op} failed`), { ...(a.block ? { block: a.block } : {}), ...(a.cap ? { cap: a.cap } : {}) });
  return a;
}

export function instanceOrError(pid) {
  const inst = runInstance(pid);
  if (!inst) throw new LayoutError("NOT_CONVERTED", 409, T("This project has no project container — the structure view exists only there."));
  if (inst.state !== "ready") throw new LayoutError("NOT_READY", 409, T("The project container is not ready."));
  return inst;
}

// The path of a level: relative, no empty parts, no `.`/`..`, no NUL. Names with control characters ARE allowed — they exist in
// existing projects, and whoever wants to rename them must be able to open them (rules.js relPath is the rule for NEW names).
export function levelsPathError(filePath) {
  if (typeof filePath !== "string") return T("not text");
  if (filePath === "") return null;
  if (filePath.startsWith("/") || filePath.endsWith("/")) return T("absolute or with “/” at the end");
  for (const t of filePath.split("/")) if (!t || t === "." || t === ".." || t.includes("\0")) return T`Part “${short(t, 40)}” is invalid`;
  return null;
}

/** GET …/layout: one level, read in the container — no sizes (`check` computes them). Throws LayoutError. */
export async function layoutLevel(pid, proj, filePath) {
  const inst = instanceOrError(pid);
  let a;
  try {
    a = await program(inst, "level", { root: path.resolve(proj.path), path: filePath, cap: LEVEL_CAP }, { withoutDeadline: false });
  } catch (e) {
    if (!(e instanceof LayoutError)) throw e;
    if (e.code === "ENOENT") throw new LayoutError("PATH_MISSING", 404, T("This folder does not exist (any more)."));
    if (e.code === "ENOTDIR") throw new LayoutError("NO_FOLDER", 400, T("This is not a folder."));
    if (e.code === "REFERENCE") throw new LayoutError("REFERENCE", 409, T("Part of the path is a symbolic link — the structure view follows no links."));
    if (e.code === "IN_CODE_REPO") throw new LayoutError("IN_CODE_REPO", 409, T("The path lies inside a code repository — the Code tab shows its contents."), { block: e.block });
    if (e.code === "EARG") throw new LayoutError("PATH", 400, T("“path” is invalid."));
    throw e;
  }
  const situation = layoutSituation(pid, proj, a.rootGit);
  return {
    path: filePath, entries: a.entries,
    ...(a.total > LEVEL_CAP ? { truncated: { cap: LEVEL_CAP, total: a.total } } : {}),
    ...situation,
  };
}

// ── Steps ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export const STEPS_MAX = 500;
const PATH_MAX = 4096;

/** The body of a POST (`{ steps }`) → `{ steps }` (only the known fields per kind) or `{ error }`. An unknown kind stays — the
 *  computation reports it as STEP_UNKNOWN with its number (as in the preview). A missing field is no statement: without `steps`
 *  400. */
export function normalizeSteps(body) {
  const raw = body && typeof body === "object" ? body.steps : undefined;
  if (!Array.isArray(raw)) return { error: T("“steps” is required (list).") };
  if (raw.length > STEPS_MAX) return { error: T`At most ${STEPS_MAX} steps.` };
  const steps = [];
  for (const [i, s] of raw.entries()) {
    if (!s || typeof s !== "object" || typeof s.kind !== "string") return { error: T`Step ${i}: “kind” is missing.` };
    const fields = s.kind === "move" ? ["from", "to"] : ["leaveOut", "code-repo", "code-repo-off"].includes(s.kind) ? ["path"] : [];
    const n = { kind: s.kind };
    for (const f of fields) {
      if (typeof s[f] !== "string" || s[f].length > PATH_MAX) return { error: T`Step ${i}: “${f}” is required (text).` };
      n[f] = s[f];
    }
    steps.push(n);
  }
  return { steps };
}

// ── git in the container (read-only) ──────────────────────────────────────────────────────────────────────────────────────

const git = (inst, cwd, args, signal) => gitRun(inst, cwd, [...GIT_HARDENING, "--no-optional-locks", ...args], {
  withoutDeadline: true, maxBuffer: OUTPUT, ...(signal ? { signal } : {}),
});
const count = (r) => (r.code === 0 && /^\d+\s*$/.test(String(r.stdout)) ? Number(String(r.stdout).trim()) : null);

/** `status --porcelain -z --ignored` → { changes, ignored: { count, names } } (renames carry a second entry). */
function readStatus(text) {
  const parts = String(text || "").split("\0");
  let changes = 0;
  const ignored = [];
  for (let i = 0; i < parts.length; i++) {
    const t = parts[i];
    if (t.length < 4) continue;
    const xy = t.slice(0, 2);
    if (xy === "!!") { ignored.push(t.slice(3)); continue; }
    changes += 1;
    if (xy[0] === "R" || xy[0] === "C") i += 1;
  }
  return { changes, ignored: { count: ignored.length, names: ignored.slice(0, NAMES_PER_LIST) } };
}

/** The linked worktrees of a repo (`worktree list --porcelain`, without the main tree). */
function readWorktrees(text) {
  const out = [];
  for (const block of String(text || "").split(/\n\n+/)) {
    const z = block.split("\n").filter(Boolean);
    const filePath = z.find((x) => x.startsWith("worktree "))?.slice("worktree ".length);
    if (!filePath) continue;
    const branch = z.find((x) => x.startsWith("branch "))?.slice("branch ".length).replace(/^refs\/heads\//, "") ?? null;
    out.push({ path: filePath, branch, prunable: z.some((x) => x.startsWith("prunable")), bare: z.includes("bare") });
  }
  return out.slice(1);
}

/** The leave-out details of a code repo: refs, remote, upstream, backups of earlier copies, stashes, status, ignored files,
 *  linked worktrees. What could not be read is in `unreadable` and null (never 0). */
async function repoDetails(inst, abs, rel, signal, roots) {
  const out = {
    path: rel, kind: "code-repo", branch: null, noRemote: null, unpushed: null, commits: null, withoutUpstream: [],
    copyBackups: [], stashes: null, changes: null, ignored: null, worktrees: [], unreadable: [],
  };
  const zw = await git(inst, abs, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal);
  if (zw.code === 0) out.branch = String(zw.stdout).trim();
  const rem = await git(inst, abs, ["remote"], signal);
  if (rem.code === 0) out.noRemote = rows(rem.stdout).length === 0; else out.unreadable.push("remote");
  const fer = await git(inst, abs, ["for-each-ref", "--format=%(refname)%00%(upstream)", "refs/heads", "refs/tags", "refs/cbase"], signal);
  let refs = [];
  if (fer.code === 0) {
    refs = rows(fer.stdout).map((z) => { const [ref, up] = z.split("\0"); return { ref, up: up || "" }; }).filter((r) => r.ref?.startsWith("refs/"));
    const copies = new Map();
    for (const { ref, up } of refs) {
      if (!ref.startsWith("refs/heads/")) continue;
      const shortRef = ref.slice("refs/heads/".length);
      if (!up) out.withoutUpstream.push(shortRef);
      const m = /^copy\/([^/]+)\/(.+)$/.exec(shortRef);
      if (m) { if (!copies.has(m[1])) copies.set(m[1], []); copies.get(m[1]).push(shortRef); }
    }
    out.copyBackups = [...copies].map(([name, branches]) => ({ name, branches }));
  } else out.unreadable.push("refs");
  const names = refs.map((r) => r.ref);
  if (names.length) {
    const all = await git(inst, abs, ["rev-list", "--count", ...names, ...(out.noRemote === false ? ["--not", "--remotes"] : [])], signal);
    if (out.noRemote === false) {
      const total = count(all);
      if (total === null) out.unreadable.push("unpushed");
      else {
        const byKey = [];
        for (const ref of names.slice(0, REF_CAP)) {
          const n = count(await git(inst, abs, ["rev-list", "--count", ref, "--not", "--remotes"], signal));
          if (n === null) { out.unreadable.push(`unpushed:${ref}`); continue; }
          if (n > 0) byKey.push({ ref, commits: n });
        }
        out.unpushed = { total, refs: byKey, ...(names.length > REF_CAP ? { cap: { refs: names.length, counted: REF_CAP } } : {}) };
      }
    } else {
      // No remote (a fresh repo): nothing is "unpushed", but nothing is backed up — the number of all commits.
      out.commits = count(all);
      if (out.commits === null) out.unreadable.push("commits");
    }
  } else if (fer.code === 0) out.commits = 0;
  const st = await git(inst, abs, ["stash", "list", "--format=%H"], signal);
  if (st.code === 0) out.stashes = rows(st.stdout).length; else out.unreadable.push("stash");
  const status = await git(inst, abs, ["status", "--porcelain=v1", "-z", "--ignored", "--untracked-files=normal"], signal);
  if (status.code === 0) Object.assign(out, readStatus(status.stdout)); else out.unreadable.push("status");
  const wt = await git(inst, abs, ["worktree", "list", "--porcelain"], signal);
  if (wt.code === 0) {
    for (const w of readWorktrees(wt.stdout)) {
      if (w.bare) continue;
      let changes = null;
      if (!w.prunable) {
        const s = await git(inst, w.path, ["status", "--porcelain=v1", "-z"], signal);
        if (s.code === 0) changes = readStatus(s.stdout).changes;
      }
      // Relative to the root if it lies inside (git names the REAL path — both versions of the root, see program.js).
      const r = roots.map((x) => relTo(x, w.path)).find((x) => x !== null && x !== undefined);
      out.worktrees.push({ path: r ?? w.path, ...(r === undefined ? { outside: true } : {}), branch: w.branch, missing: w.prunable, changes });
    }
  } else out.unreadable.push("worktrees");
  return out;
}

/** A worktree block that goes away (`git worktree remove` + `prune`): branch, changes, unpushed commits. */
async function worktreeDetails(inst, abs, k, signal) {
  const out = { path: k.path, kind: "worktree", worktreeOf: k.worktreeOf ?? null, branch: null, changes: null, unpushed: null, unreadable: [] };
  const zw = await git(inst, abs, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal);
  if (zw.code === 0) out.branch = String(zw.stdout).trim();
  const s = await git(inst, abs, ["status", "--porcelain=v1", "-z"], signal);
  if (s.code === 0) out.changes = readStatus(s.stdout).changes; else out.unreadable.push("status");
  const n = count(await git(inst, abs, ["rev-list", "--count", "HEAD", "--not", "--remotes"], signal));
  if (n === null) out.unreadable.push("unpushed"); else out.unpushed = n;
  return out;
}

/** What the project repo tracks under `old` ("stays in the creation commit") — only with the marker. */
async function tracked(inst, root, old, signal) {
  const r = await git(inst, root, ["ls-files", "-z", "--", `:(literal)${old}`], signal);
  if (r.code !== 0) return null;
  const names = String(r.stdout).split("\0").filter(Boolean);
  return { count: names.length, names: names.slice(0, NAMES_PER_LIST) };
}

// ── The check ────────────────────────────────────────────────────────────────────────────────────────────────────────

const errorKey = (f) => `${f.code}\0${f.path ?? ""}\0${f.second ?? ""}`;
const normPath = (p) => String(p ?? "").replace(/^\.\//, "").replace(/\/+$/, "");

async function check(pid, proj, steps, signal) {
  const hold = () => { if (signal?.aborted) throw new LayoutError("ABORTED", 409, "aborted"); };
  const inst = instanceOrError(pid);
  const root = path.resolve(proj.path);
  const rules = rulesResponse();
  delete rules.reserveBytes;

  // 1. The tree and the plan (the ONE computation) — plus the plan without steps for `prior`.
  const b = await program(inst, "tree", { root, cap: treeCap() }, { signal });
  hold();
  const tree = b.node.map((k) => ({ path: k.path, kind: k.kind })).sort((x, y) => compare(x.path, y.path));
  const info = new Map(b.node.map((k) => [k.path, k]));
  const roots = [...new Set([root, typeof b.rootReal === "string" && path.isAbsolute(b.rootReal) ? b.rootReal : root])];
  const plan = computePlan(tree, steps, rules, "inventory");
  const prior = new Set(computePlan(tree, [], rules, "inventory").error.map(errorKey));
  const error = plan.error.map((f) => (f.step === undefined && prior.has(errorKey(f)) ? { ...f, prior: true } : f));
  const situation = layoutSituation(pid, proj, b.rootGit);
  const end = plan.finalMapping;
  const abb = mappingFromEnd(end);
  const affected = [
    ...end.ways.map((w) => ({ old: w.old, fresh: w.fresh, kind: "move", abs: path.join(root, w.old) })),
    ...end.gone.map((a) => ({ old: a, kind: "leaveOut", abs: path.join(root, a) })),
  ];
  const warnings = [...plan.warnings];

  // 2. Files in the container: sizes of the left-out paths, virtual environments of the moved ones, alternates of all repos.
  const repoBlocks = b.node.filter((k) => k.kind === "code-repo" && !k.gitFile).map((k) => k.path);
  const movedFolder = affected.filter((x) => x.kind === "move" && ["folder", "code-repo", "worktree"].includes(info.get(x.old)?.kind));
  const d = await program(inst, "details", {
    root, sizes: end.gone, venv: movedFolder.map((x) => ({ rel: x.old, old: x.abs })), alternates: repoBlocks,
  }, { signal });
  hold();
  for (const v of d.venv) {
    warnings.push({ code: "VENV", path: v.folder, file: v.file, text: T`The virtual environment “${v.folder}” contains absolute paths — recreate it after applying.` });
  }
  const borrowedObjects = [];
  for (const [repo, targets] of Object.entries(d.alternates || {})) {
    for (const z of targets) {
      const x = affected.find((y) => underAbs(z, y.abs));
      if (x) borrowedObjects.push({ repo, target: relTo(root, z) ?? z, path: x.old });
    }
  }
  for (const g of borrowedObjects) {
    warnings.push({ code: "BORROWED", path: g.repo, second: g.path, text: T`The repository “${g.repo}” borrows objects from “${g.target}” (alternates) — that location changes.` });
  }

  // 3. Docker in the inner daemon (read-only).
  let inv = null;
  let dockerError = null;
  if (affected.length) {
    try { inv = await dockerInventory(containerOf(inst)); } catch (e) { dockerError = short(e?.message || e, 200); }
  }
  hold();
  const container = containerOf(inst);
  const withDocker = (x) => (inv ? affectedContainer(inv, x.abs) : []);

  // 4. Leave out, per path.
  const markerProjectRepo = b.rootGit === "folder" && carriesProjectRepoMarker(root);
  const services = store.listProjectServices(pid);
  let knowledge = [];
  try { knowledge = store.listProjectContext(pid, { withBody: false }); } catch { knowledge = null; }
  const leaveOut = [];
  const confirmable = { container: new Map(), volumes: new Map(), networks: new Map(), images: new Map() };
  // ONE delete set over all left-out containers — the same computation as step 9 (docker-rebuild.js); per path cut to size only
  // for display (setPerPath). Computed per path, the container of ANOTHER left-out path held a shared volume: the question showed
  // "stays", step 9 deleted it.
  const leftOutX = affected.filter((y) => y.kind === "leaveOut");
  const perOld = new Map(leftOutX.map((x) => [x.old, withDocker(x)]));
  const total = inv ? deleteSet(inv, [...new Set([...perOld.values()].flatMap((l) => l.map((y) => y.c.id)))]) : null;
  if (total) {
    for (const v of total.volumes) confirmable.volumes.set(v.name, v);
    for (const n of total.networks) confirmable.networks.set(n.id, n);
    for (const i of total.images) confirmable.images.set(i.id, { id: i.id, size: i.size });
  }
  for (const x of leftOutX) {
    const k = info.get(x.old);
    const repos = [];
    for (const r of b.node.filter((y) => (y.kind === "code-repo" || y.kind === "worktree") && under(y.path, x.old))) {
      hold();
      const abs = path.join(root, r.path);
      repos.push(r.kind === "worktree" ? await worktreeDetails(inst, abs, r, signal) : await repoDetails(inst, abs, r.path, signal, roots));
    }
    const bet = perOld.get(x.old);
    const set = total ? setPerPath(inv, total, bet.map((y) => y.c.id)) : null;
    if (set) for (const y of bet) confirmable.container.set(y.c.id, { id: y.c.id, name: y.c.name });
    leaveOut.push({
      path: x.old, kind: k?.kind ?? null, size: d.sizes?.[x.old] ?? null, repos,
      projectRepo: markerProjectRepo ? await tracked(inst, root, x.old, signal) : null,
      services: services.filter((s) => underAbs(s.dir ? path.resolve(root, s.dir) : root, x.abs)).map((s) => ({ id: s.id, name: s.name })),
      knowledge: knowledge === null ? null : knowledge.filter((c) => (c.codePaths || []).length && c.codePaths.every((p) => under(normPath(p), x.old))).length,
      docker: inv ? { container: bet.map(containerRow), ...set } : null,
    });
  }

  // 5. Moving per path, containers without Compose, references between stacks.
  const move = [];
  for (const x of affected.filter((y) => y.kind === "move")) {
    const bet = withDocker(x);
    move.push({ old: x.old, fresh: x.fresh, kind: info.get(x.old)?.kind ?? null, container: inv ? bet.map(containerRow) : null });
    for (const y of bet) {
      if (y.c.labels[LABEL.project] || !y.kinds.includes("bind")) continue;
      warnings.push({ code: "WITHOUT_COMPOSE", container: y.c.name, path: x.old, text: T`“${y.c.name}” binds “${x.old}” — it will be stopped and not recreated (there is no configuration cbase could rebuild it from); a later “docker start” would create an empty folder at the old location.` });
    }
  }
  const stacks = [];
  if (inv) {
    const groups = new Map();
    for (const c of inv.container) {
      if (c.own || !c.labels[LABEL.project]) continue;
      let k;
      try { k = composeConfig({ Config: { Labels: c.labels } }); } catch (e) {
        if (e instanceof ComposeConfigError) { warnings.push({ code: "STACK_UNREADABLE", container: c.name, text: T`The Compose labels of “${c.name}” cannot be read (${e.code}).` }); continue; }
        throw e;
      }
      const s = configKey(k);
      if (!groups.has(s)) groups.set(s, { k, container: [] });
      groups.get(s).container.push(c);
    }
    for (const { k, container: cs } of groups.values()) {
      hold();
      const relFolder = relTo(root, k.folder);
      const inside = affected.find((x) => underAbs(k.folder, x.abs));
      if (inside) {
        if (inside.kind === "leaveOut" || relFolder === null) continue;
        const fresh = targetOf(abb, relFolder);
        if (typeof fresh !== "string" || nameOf(fresh) === path.basename(k.folder)) continue; // only a new folder name changes the name
        let name;
        try { name = await composeNameWithoutP(container, k); } catch (e) {
          warnings.push({ code: "STACK_NAME_UNKNOWN", stack: k.project, path: relFolder, text: T`Whether “${k.project}” gets a different name after the rename could not be read (${short(e?.message, 120)}).` });
          continue;
        }
        const follows = name === normalizeProjectName(path.basename(k.folder));
        const newName = normalizeProjectName(nameOf(fresh));
        const entry = { stack: k.project, name, path: relFolder, fresh, followsFolder: follows, newName: follows ? newName : name };
        stacks.push(entry);
        if (!follows || newName === name) continue;
        const volNames = new Set(cs.flatMap((c) => c.mounts.filter((m) => m.type === "volume" && m.name).map((m) => m.name)));
        const volumes = inv.volumes.filter((v) => volNames.has(v.name) || String(v.labels[LABEL.project] || "") === k.project).map((v) => ({ name: v.name, size: v.size }));
        const fixed = cs.filter(fixedContainerName).map((c) => ({ name: c.name, afterwards: `${c.name}-old-${c.id.slice(0, 12)}` }));
        const vol = volumes.map((v) => `${v.name}${v.size === null ? "" : ` (${v.size} B)`}`).join(", ");
        warnings.push({
          code: "STACK_NAME", stack: k.project, path: relFolder, fresh: newName, volumes, containerName: fixed,
          text: T`“${k.project}” will be named “${newName}” and start with empty data${vol ? T` (${vol} stays under “${name}”)` : ""}; the old containers are stopped, not deleted — they can be removed later on the Services page with “Remove old containers”.${fixed.length ? T` The old containers will be named ${fixed.map((f) => T`“${f.afterwards}”`).join(", ")}.` : ""}`,
        });
        continue;
      }
      // A stack OUTSIDE every affected folder: does it point in?
      if (!affected.length) continue;
      const references = [...cs.flatMap(referencesOf)];
      try { references.push(...(await modelReferences(container, k))); } catch (e) {
        warnings.push({ code: "STACK_MODEL_UNREADABLE", stack: k.project, text: T`The Compose model of “${k.project}” could not be read (${short(e?.message, 120)}) — references into moved folders are not checked.` });
      }
      const seen = new Set();
      for (const bz of references) {
        const x = affected.find((y) => underAbs(bz.path, y.abs));
        if (!x || seen.has(x.old)) continue;
        seen.add(x.old);
        const file = relTo(root, k.files[0]) ?? k.files[0];
        warnings.push({ code: "REFERENCE", stack: k.project, file, path: x.old, kind: bz.kind, text: T`“${file}” points to “${x.old}” — a start would create an empty folder there; the stack “${k.project}” is stopped and starts again only once someone adjusts the file.` });
      }
    }
  }

  // 6. Citations — a list only.
  hold();
  const citations = collectCitations({ projectId: pid, workspaceId: proj.workspaceId, paths: affected.map((x) => x.old) });

  return {
    ...(plan.finalTree.length > FINAL_TREE_CAP ? { finalTree: null, finalTreeTruncated: { cap: FINAL_TREE_CAP, node: plan.finalTree.length } } : { finalTree: plan.finalTree }),
    mapping: plan.mapping, finalMapping: end, codeRepos: plan.codeRepos, repos: plan.repos,
    error, warnings, leaveOut, move, stacks, borrowedObjects, citations,
    docker: inv ? { read: true } : affected.length ? { read: false, error: dockerError } : { read: false },
    // Without docker read there is no confirmable set (null, never "nothing" — empty is not unknown).
    confirmable: affected.length && !inv ? null : Object.fromEntries(Object.entries(confirmable).map(([k, m]) => [k, [...m.values()]])),
    situation,
    // Holders (turns, agents, terminals, …) and VS Code windows are computed by `layoutQuiet` (job.js) — not here.
    notChecked: ["holders", "vscode"],
  };
}

// ── The operation ────────────────────────────────────────────────────────────────────────────────────────────────────────

const checks = new Map(); // id → { id, projectId, steps, state, begin, finishedAt, result, error, abort }
const expired = (e, now) => e.finishedAt !== null && now - e.finishedAt >= checkMs();
function clean(now = Date.now()) { for (const [id, e] of checks) if (expired(e, now)) checks.delete(id); }
const report = (e) => broadcast({ type: "project/layout", projectId: e.projectId, kind: "check", check: e.id, state: e.state });

/** The situation of NOW (the take-over checks it fresh — a copy may have arisen between check and take-over): ONE level of the
 *  root in the container (small, with a deadline) for `rootGit`, then layoutSituation. Throws LayoutError like instanceOrError. */
export async function currentSituation(pid, proj) {
  const inst = instanceOrError(pid);
  const level = await program(inst, "level", { root: path.resolve(proj.path), path: "", cap: 1 }, { withoutDeadline: false });
  return layoutSituation(pid, proj, level.rootGit);
}

/** POST …/layout/check — creates the operation and returns its id; the result comes by event and GET. Throws LayoutError
 *  (NOT_CONVERTED, NOT_READY, and the codes of the situation) BEFORE creating. */
export async function startCheck(pid, proj, steps) {
  // The situation needs `rootGit` — ONE level of the root in the container (small, with a deadline).
  const situation = await currentSituation(pid, proj);
  if (situation.locked) throw new LayoutError(situation.locked.code, 409, situation.locked.text, situation.locked.name ? { name: situation.locked.name } : {});
  clean();
  for (const e of checks.values()) if (e.projectId === pid && e.state === "running") e.abort.abort();
  const e = { id: crypto.randomUUID(), projectId: pid, steps, state: "running", begin: Date.now(), finishedAt: null, result: null, error: null, abort: new AbortController() };
  checks.set(e.id, e);
  const own = [...checks.values()].filter((x) => x.projectId === pid && x.state !== "running").sort((a, b2) => a.begin - b2.begin);
  while (own.length >= PER_PROJECT) checks.delete(own.shift().id);
  report(e);
  (async () => {
    try {
      const result = await check(pid, proj, steps, e.abort.signal);
      if (e.abort.signal.aborted) e.state = "aborted";
      else { e.result = result; e.state = "finished"; }
    } catch (x) {
      e.state = e.abort.signal.aborted ? "aborted" : "error";
      if (e.state === "error") {
        e.error = { code: x?.code || "ERROR", text: short(x?.message || x) };
        console.error(`[layout] check ${e.id} (${pid}) failed: ${e.error.code} ${e.error.text}`);
      }
    } finally {
      e.finishedAt = Date.now();
      report(e);
    }
  })().catch((x) => console.error(`[layout] check ${e.id}: ${short(x?.message || x)}`));
  return e.id;
}

/** The entry of a check of this project — or null (unknown, expired, foreign project). For job.js/procedure.js (`steps`,
 *  `confirmed`: `result.confirmable`). */
export function layoutCheck(pid, id) {
  clean();
  const e = checks.get(String(id));
  return e && e.projectId === pid ? e : null;
}

/** GET …/layout/check/:id — the view (without the abort handle) or null. */
export function checkView(pid, id) {
  const e = layoutCheck(pid, id);
  if (!e) return null;
  return {
    check: e.id, state: e.state, steps: e.steps, since: e.begin, finishedAt: e.finishedAt,
    ...(e.result ? { result: e.result } : {}), ...(e.error ? { error: e.error } : {}),
  };
}

/** For tests only: forget all operations (module state, which would otherwise survive into the next test of the file). */
export function forgetChecks() {
  for (const e of checks.values()) e.abort.abort();
  checks.clear();
}
