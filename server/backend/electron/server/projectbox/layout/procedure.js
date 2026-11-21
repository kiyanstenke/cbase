// Executing a layout: what was rearranged and taken over in the project tab happens here — move and leave out folders,
// create code repos, bring docker, services, knowledge, worktrees and links along.
//
// ONE journal (../journal.js, stored in `project_layout.journal`), under the project occupancy "layout" (../instance.js
// withProjectOccupancy) and behind the lock "layout" (./job.js — it stands since the take-over). Started by job.js
// (`setLayoutExecution`, server.js): after the quiet (`resume: false`), after a restart at the instance's transition to
// `ready` and after "Try again" (`resume: true`).
//
// THE STEPS (forward; the point of no return is `docker-away` — before it nothing is changed on the tree, after it the
// procedure only goes forward):
//    1 prior         the inventory, ONLY with an empty column (`setLayoutPrior`): affected containers with restart rule and
//                    state, stacks with their kind (moved · gone · reference), running native services, the desired state
//                    of the instance, the blocks of the tree, the linked worktrees per repo (worktree list, hardened,
//                    `--no-optional-locks`), the alternates per repo, the fresh knowledge entries (staleInfo)
//    2 marker        the rebuild marker of the monitor (services.js setRebuildMarker — it does not report the stopped services)
//    3 stop          the running native services, then the affected containers (`update --restart no` + `stop` per id);
//                    the desired state of the instance without them (a restart in the middle of the rebuild would
//                    otherwise start them in a half tree)
//    4 postWork      the git post-work of the project to its end (runs/git-post-work.js — it works with the old paths)
//    5 foreign       (a) a process in B below an affected path that belongs to no terminal (the turn of a chat, a
//                    subagent, the bash of the loop engine, a background server — ./processes-in-b.js, the same
//                    computation as the quiet, two looks) ⇒ WORKSPACE_CHAT (back to `waiting`); (b) every other process
//                    in the project container below an affected path — SIGTERM, after `CBASE_LAYOUT_TERM_MS` SIGKILL; if
//                    one stays, the step fails. The terminals of the project are taken by step 6. The search goes by the
//                    wording below the root: a moved link counts itself, never its target
//    6 terminals     end project terminals and those of the chat rail with a notice; the editor sessions on the project
//                    container (VS Code, proc-program.js EDITOR_LOCATIONS — SIGTERM/SIGKILL, sentence in the report); a
//                    workspace terminal in B only if a process of its session works below an affected path
//    7 repack        a repo that borrows objects from a left-out place (alternates) fetches them to itself (`repack -a -d`)
//    8 crossCheck    the tree of NOW against the check: the same computation (plan.js), the same final mapping, no rule
//                    errors; otherwise LAYOUT_CHANGED. The parking spot `.cbase-layout` is free (otherwise
//                    PARKING_SPOT_OCCUPIED — the interface hides it, and after the point of no return every "Try again"
//                    would fail at it). Docker must be readable
//    9 docker-away   THE POINT OF NO RETURN. What belongs to the left-out folders now, by id (what was not confirmed is in
//                    the report); the old containers of renamed stacks go to the superseded table, with a fixed
//                    `container_name` `docker rename` (only if the name of now is a different one — repeatable). If the
//                    step fails BEFORE anything took effect, it counts as before the point of no return
//   10 parking       left-out worktrees of a staying repo: worktree remove; then every way of the final mapping (deepest
//                    first) to `.cbase-layout/<n>` — the root hides `.cbase-*`, the computation forbids the name
//   11 leaveOut      the left-out paths at their place of now; refused ⇒ as root (../cleanUp.js removeAsRoot); worktrees
//                    of a left-out repo in the runtime folder likewise
//   12 place         the parked paths to their target (shallowest first), the parking spot falls (empty)
//   13 code-repos    the newly marked code repos (../setup/code-repos.js createCodeRepo); the report after each one, a
//                    repo with our empty commit from an earlier pass counts too
//   14 project-repo  with the marker: `info/exclude` and the index of the project repo (no commit)
//   15 worktrees     git worktree repair from the main repo (never prune); bring along graph runs (a left-out repo drops
//                    out of the row, the others stay; the linked dependencies point to the new place —
//                    rebuild-program.js `links`), subagents, git post-work
//   16 alternates    the lines that point to a moved place
//   17 db            services (`dir`; one below a left-out path falls with its log) and knowledge (prefix, anchor); the
//                    affected entries that were fresh before get their anchor anew (verifyAnchors, the date stays)
//   18 compose       create every moved stack with the new paths (docker-rebuild.js composeNew); reference stacks and
//                    containers without compose stay stopped; a renamed stack that stayed stopped takes its old
//                    containers back out of the superseded table
//   19 startUp       the desired state of now (new containers whose old ones ran, run) and the start sequence
//                    (../restore.js runStartSequence, without a state change of the instance)
//   20 recheck       foreign containers at the old place, missing files from the labels, a folder that reappeared at the
//                    old place, worktrees git does not read — one warning each in the report
//   21 completion    marker gone, the language services below the root ended, a silent hint to every chat of the project
//                    and every workspace chat without a project, event `project/layout` with `kind: "finished"`
// THE RETURN PATH (before the point of no return): rw-rules (the old restart rules), rw-start-up (the desired state from
// the state of now, what ran runs again; the native services), rw-marker. Afterwards: a return path out of the restart
// or because of a workspace chat ⇒ back to `waiting` (job.js backToWaiting); every other reason ⇒ `error` before the
// point of no return, the lock falls (an error that comes back would otherwise run in circles). If the return path
// itself fails: `error`, `backward` set, the journal stays, "Try again" completes it.
// AFTER THE POINT OF NO RETURN a step fails ⇒ `error` with `turned` set: the lock stays, the marker stays, the report
// names what happened; "Try again" resumes at the step.
// THE SERVER IS ENDING (runs/server-end.js serverEnds) ⇒ no further step and no return path: the row stays `running`,
// the restart (job.js) and `ready` resume.
//
// Every effect in the project folder runs in the project container (container programs ./rebuild-program.js,
// ./program.js, ./proc-program.js through `commandRun`, git through `gitRun` with GIT_HARDENING); B does not touch the
// mounted folder through path names. Removal goes by id. Foreign text (names, paths) is only data in the report and in
// the fenced hint.
//
// Test seam: `setLayoutServices({ status, stop, start })` (the native services — state, stop, start). Controls:
// CBASE_LAYOUT_TERM_MS (default 5 s: SIGTERM → SIGKILL in steps 5 and 6), CBASE_LAYOUT_B_QUIET_MS (default 2 s: the
// distance between the two looks at B in step 5, ./processes-in-b.js).

import fs from "node:fs";
import path from "node:path";

import { BOOT_ID } from "../../app-state.js";
import * as store from "../../store.js";
import { T } from "../../i18n.js";
import { broadcast } from "../../runtime/sse.js";
import { commandRun, gitRun } from "../../runtime/git-run.js";
import { serverEnds } from "../../runs/server-end.js";
import { depositHint } from "../../runs/hints.js";
import { gitPostWork, openGitJobs, openGitJobsOf } from "../../runs/git-post-work.js";
import { locationFor } from "../../runs/runtime-location.js";
import { endTerminalWithNotice, terminalSessions } from "../../terminal.js";
import { removeServiceLog, setRebuildMarker, stopService } from "../../services.js";
import { staleInfo, verifyAnchors } from "../../okf.js";
import { MAIN } from "../creation.js";
import { projectboxOps } from "../ops.js";
import { removeAsRoot } from "../cleanUp.js";
import { nativeServicesStatus } from "../services.js";
import { withProjectOccupancy } from "../instance.js";
import { containerOf, runInstance } from "../run-instance.js";
import { endInstanceSessions, endLanguageServices } from "../idle.js";
import { creationOptionsFor } from "../recreate.js";
import { GIT_HARDENING, takeFromTheIndex, upkeepExclude, carriesProjectRepoMarker } from "../projectRepo.js";
import { DESIRED_RUNNING, withServicesOfNow, withoutSuperseded, desiredFromInspect, carryForwardDesired } from "../serverEnd.js";
import { runStartSequence, insideInspect, desiredAfterRestore } from "../restore.js";
import { processSeamRoot } from "../relocation/processes.js";
import { rulesResponse } from "../setup/rules.js";
import { CODE_REPO_MESSAGE, CODE_REPO_MESSAGE_BEFORE, createCodeRepo } from "../setup/code-repos.js";
import { JournalTurned, JournalReturnPathFailed, createJournal, run, journalPlan } from "../journal.js";
import { affectedPaths, report, releaseLock, setLock, backToWaiting } from "./job.js";
import { supersede, composeNew, removeAway, recheckDocker, rulesBack, stopContainer, priorDocker } from "./docker-rebuild.js";
import { dockerInventory, underAbs } from "./docker-read.js";
import { treeCap, program } from "./read.js";
import {
  projections, servicesPlan, graphPlan, bringAlongPostWork, writeServices, writeGraph, writeSubagents, writeKnowledge,
  subagentsPlan, knowledgePlan,
} from "./bringAlong.js";
import { computePlan, under, compare } from "./plan.js";
import { EDITOR_LOCATIONS, procInB, searchInProject } from "./proc-program.js";
import { remainingInB } from "./processes-in-b.js";
import { REBUILD_PROGRAM } from "./rebuild-program.js";

export const LAYOUT_JOURNAL = journalPlan({
  forward: [
    "prior", "marker", "stop", "postWork", "foreign", "terminals", "repack", "crossCheck", "docker-away", "parking",
    "leaveOut", "place", "code-repos", "project-repo", "worktrees", "alternates", "db", "compose", "startUp",
    "recheck", "completion",
  ],
  backward: ["rw-rules", "rw-start-up", "rw-marker"],
  pivot: "docker-away",
});
export const PARK = ".cbase-layout";
export const TERM_MS = 5_000;
const OUTPUT = 64 * 1024 * 1024;
const PATHS_IN_TEXT = 5;

export function termMs() {
  const raw = process.env.CBASE_LAYOUT_TERM_MS;
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : TERM_MS;
}

const short = (s, n = 300) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const pause = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
const depth = (rel) => String(rel).split("/").length;
const uniq = (list) => [...new Set(list)];
const errorWith = (code, message, fields = {}) => Object.assign(new Error(message), { code, ...fields });
const idOf = (d) => Number(typeof d === "object" && d !== null ? (d.id ?? d.svcId) : d);

// ── Test seam: the native services ─────────────────────────────────────────────────────────────────────────────────

async function serviceStop(pid, id) {
  const s = store.getProjectService(id);
  return stopService({ projectId: pid, serviceId: id, port: s?.port ?? null, container: s?.container || "", dir: s?.dir || "", instance: MAIN });
}
const DEFAULT_SERVICES = { status: (pid) => nativeServicesStatus(pid), stop: serviceStop, start: undefined };
let services = DEFAULT_SERVICES;
/** Test seam (header). Without arguments back to the default; `start` undefined = the starter of the restore. */
export function setLayoutServices({ status = null, stop = null, start } = {}) {
  services = {
    status: typeof status === "function" ? status : DEFAULT_SERVICES.status,
    stop: typeof stop === "function" ? stop : DEFAULT_SERVICES.stop,
    start: typeof start === "function" ? start : undefined,
  };
}

// ── Journal and report ─────────────────────────────────────────────────────────────────────────────────────────────

const PIVOT_FROM = LAYOUT_JOURNAL.forward.indexOf(LAYOUT_JOURNAL.pivot);

function journalWrite(pid, f) {
  const a = store.layoutJob(pid);
  const old = a?.journal && typeof a.journal === "object" ? a.journal : {};
  const fresh = { ...old };
  for (const k of ["direction", "step", "done"]) if (f[k] !== undefined) fresh[k] = f[k];
  if (f.data) fresh.data = { ...(old.data || {}), ...f.data };
  const fields = { journal: fresh };
  if (f.step) {
    fields.step = f.step;
    if (f.direction === "forward" && LAYOUT_JOURNAL.forward.indexOf(f.step) >= PIVOT_FROM) fields.turned = true;
    if (f.direction === "backward") fields.backward = true;
  }
  store.layoutSet(pid, fields);
  if (f.step && f.done !== f.step) report(pid);
}
const journalFor = (pid) => createJournal({
  read: () => {
    const j = store.layoutJob(pid)?.journal;
    return j?.step ? { direction: j.direction || "forward", step: j.step, done: j.done || "" } : null;
  },
  write: (f) => journalWrite(pid, f),
});
// Synchronous (for `beforeEffect` in docker-rebuild.js removeAway, which does not wait).
const noteNow = (pid, data) => journalWrite(pid, { data });

const emptyReport = () => ({
  warnings: [], foreign: [], removed: { container: [], volumes: [], networks: [], images: [] }, add: [], superseded: [],
  codeRepos: [], compose: [], services: { rewritten: [], dropped: [] }, knowledge: 0, findings: [], end: null,
});

function context(pid, { fresh }) {
  const a = store.layoutJob(pid);
  if (!a?.plan?.finalMapping) throw errorWith("NO_JOB", T("The order is missing or has no plan."));
  const proj = store.getProject(pid);
  if (!proj?.path) throw errorWith("NO_PROJECT", T("The project is missing."));
  const inst = runInstance(pid);
  if (!inst) throw errorWith("NOT_CONVERTED", T("The project has no project container."));
  if (inst.state !== "ready") throw errorWith("NOT_READY", T("The project container is not ready."));
  const root = path.resolve(String(proj.path));
  if (a.plan.root && path.resolve(a.plan.root) !== root) throw errorWith("ROOT_DIFFERENT", T("The project folder differs from the one at apply time."));
  const ctx = {
    pid, proj, inst, root, container: containerOf(inst), plan: a.plan, end: a.plan.finalMapping, confirmed: a.confirmed || {},
    report: fresh || !a.report ? emptyReport() : { ...emptyReport(), ...a.report },
  };
  ctx.prior = () => store.layoutJob(pid)?.prior || null;
  ctx.data = () => store.layoutJob(pid)?.journal?.data || {};
  ctx.projectionNow = () => projections(ctx.plan, root, ctx.prior()?.rootReal || root);
  ctx.journal = journalFor(pid);
  ctx.reports = () => store.layoutSet(pid, { report: ctx.report });
  ctx.warn = (text) => { if (text && !ctx.report.warnings.includes(text)) ctx.report.warnings.push(text); };
  return ctx;
}

// ── The container programs ─────────────────────────────────────────────────────────────────────────────────────────

/** The writing program (./rebuild-program.js) in the project container; `root` only for the fallback after EACCES/EPERM. */
async function rebuild(ctx, op, o, { root = false } = {}) {
  const r = await commandRun(ctx.inst, "/", process.execPath, ["-e", REBUILD_PROGRAM, "--", op, JSON.stringify({ root: ctx.root, ...o })], { withoutDeadline: true, maxBuffer: OUTPUT, ...(root ? { asUser: "root" } : {}) });
  let a = null;
  try { a = JSON.parse(String(r.stdout || "").trim().split("\n").pop() || "null"); } catch { a = null; }
  if (!a) throw errorWith("PROGRAM", `${op} in the project container: ${short(String(r.stderr || "").split("\n").slice(-3).join(" "), 200) || `exit ${r.code}`}`);
  if (a.ok === false) throw errorWith(a.code || "EERROR", short(a.message || `${op} failed`), Array.isArray(a.turns) ? { turns: a.turns } : {});
  return a;
}
async function movesRun(ctx, turns) {
  if (!turns.length) return [];
  let r = await rebuild(ctx, "turns", { turns });
  if (r.turns.some((z) => z.outcome === "refused")) r = await rebuild(ctx, "turns", { turns }, { root: true });
  const open = r.turns.filter((z) => z.outcome === "refused");
  if (open.length || r.turns.length !== turns.length) {
    const z = open[0] || turns[r.turns.length];
    throw errorWith("TRANSACTION_REFUSED", T`“${z?.from}” could not be moved to “${z?.to}” even as root (${open[0]?.code || "?"}).`);
  }
  return r.turns;
}
const git = (ctx, cwd, args, { reading = false } = {}) => gitRun(ctx.inst, cwd, [...GIT_HARDENING, ...(reading ? ["--no-optional-locks"] : []), ...args], { withoutDeadline: true, maxBuffer: OUTPUT });
const repoAbs = (ctx, rel) => (rel === "." || rel === "" ? ctx.root : path.join(ctx.root, rel));
// The root of the project in both forms (as taken over and real) — the limits of the /proc search (proc-program.js).
const rootsOf = (ctx) => uniq([ctx.root, ctx.prior()?.rootReal || ctx.root]);
// The process groups of the project's terminals in the container (step 6 takes them; step 5 leaves them out).
const terminalGroups = (pid) => terminalSessions().filter((s) => s.inContainer && String(s.identifier || "").startsWith(`${pid}/`) && s.pgid).map((s) => s.pgid);

/** End every hit of the search `search` (`{ paths, roots?, exempt }`) in the project container: SIGTERM, after `termMs()`
 *  SIGKILL; if one stays for ten SIGKILL rounds, throws `stay(names)`, a truncated search `tooMany(n)`. Step 5 (the
 *  affected paths) and step 6 (the editor locations) — one loop. */
async function endInProject(inst, search, { hits, tooMany, stay }) {
  const until = Date.now() + termMs();
  let kill = false;
  let killRounds = 0;
  for (;;) {
    const r = await searchInProject(inst, "processes", search);
    if (r.truncated) throw tooMany(r.truncated);
    if (!r.processes.length) return;
    for (const x of r.processes) hits(x);
    if (kill && killRounds >= 10) throw stay(r.processes.map((x) => x.name));
    await searchInProject(inst, "end", { ...search, pids: r.processes.map((x) => x.pid), signal: kill ? "SIGKILL" : "SIGTERM" });
    if (kill) killRounds++;
    else if (Date.now() >= until) kill = true;
    await pause(kill ? 100 : 200);
  }
}

/** The parking spots: per way of the final mapping (deepest `old` first — so an inner way leaves its parent folder
 *  before that one moves) `${PARK}/<n>`. Deterministic from the plan (a second pass finds the same ones). */
export function parkPlan(end) {
  return [...(end?.ways || [])]
    .sort((x, y) => depth(y.old) - depth(x.old) || compare(x.old, y.old))
    .map((w, i) => ({ old: w.old, fresh: w.fresh, park: `${PARK}/${i}` }));
}
/** Where `rel` (a starting path) lies after parking: below the deepest parked ancestor — or where it was. */
export function locationAfterParking(parks, rel) {
  let best = null;
  for (const p of parks) if (under(rel, p.old) && (!best || p.old.length > best.old.length)) best = p;
  return best ? `${best.park}${rel.slice(best.old.length)}` : rel;
}

/** `worktree list --porcelain` → the linked paths (without the main tree). */
function linked(text) {
  const out = [];
  for (const block of String(text || "").split(/\n\n+/).slice(1)) {
    const z = block.split("\n").find((x) => x.startsWith("worktree "));
    if (z && !block.split("\n").includes("bare")) out.push(z.slice("worktree ".length));
  }
  return out;
}

// The key of a rule error (as in ./read.js).
const errorKey = (f) => `${f.code}\0${f.path ?? ""}\0${f.second ?? ""}`;

// ── The steps ──────────────────────────────────────────────────────────────────────────────────────────────────────

function effects(ctx) {
  const { pid, inst, root, container, end, confirmed } = ctx;
  const notice = T("Ended: the project structure is being rebuilt.");
  const paths = () => affectedPaths({ plan: ctx.plan }, ctx.proj);
  const hold = () => { if (serverEnds()) throw errorWith("SERVER_ENDS", "the server is ending — the rebuild resumes after the restart."); };
  const step = (fn) => async () => { hold(); return fn(); };

  return {
    prior: step(async () => {
      if (ctx.prior()) return;
      const b = await program(inst, "tree", { root, cap: treeCap() });
      const affected = [
        ...end.ways.map((w) => ({ kind: "move", old: w.old, fresh: w.fresh, abs: path.join(root, w.old) })),
        ...end.gone.map((p) => ({ kind: "leaveOut", old: p, abs: path.join(root, p) })),
      ];
      const docker = affected.length ? await priorDocker(container, affected, confirmed) : { container: [], stacks: [] };
      const natives = (await services.status(pid)).filter((s) => s.running).map((s) => ({ id: Number(s.id), name: s.name }));
      const blocks = b.node.filter((k) => k.kind === "code-repo" || k.kind === "worktree").map((k) => ({
        path: k.path, kind: k.kind, ...(k.worktreeOf !== undefined ? { worktreeOf: k.worktreeOf } : {}), ...(k.gitFile ? { gitFile: true } : {}),
      }));
      const repos = [...blocks.filter((k) => k.kind === "code-repo" && !k.gitFile).map((k) => k.path), ...(b.rootGit === "folder" ? ["."] : [])];
      const worktrees = [];
      for (const rel of repos) {
        const r = await git(ctx, repoAbs(ctx, rel), ["worktree", "list", "--porcelain"], { reading: true });
        if (r.code !== 0) { ctx.warn(T`The worktrees of “${rel}” could not be read — they are not updated.`); continue; }
        const v = linked(r.stdout);
        if (v.length) worktrees.push({ repo: rel, paths: v });
      }
      const d = await program(inst, "details", { root, sizes: [], venv: [], alternates: repos });
      const okfFresh = [];
      let knowledge = [];
      try { knowledge = store.listProjectContext(pid, { withBody: false }); } catch { knowledge = []; }
      for (const c of knowledge) {
        if (!(c.codePaths || []).length) continue;
        const si = await staleInfo(root, c, { instance: inst });
        if (si && si.stale === false) okfFresh.push(c.id);
      }
      ctx.reports();
      store.setLayoutPrior(pid, {
        time: Date.now(), rootReal: typeof b.rootReal === "string" ? b.rootReal : root, rootGit: b.rootGit ?? null,
        docker, natives, desired: store.projectInstance(pid, MAIN)?.desired ?? null, blocks, worktrees, alternates: d.alternates || {}, okfFresh,
      });
    }),

    marker: step(async () => { setRebuildMarker(pid, true); }),

    stop: step(async () => {
      const v = ctx.prior();
      for (const n of v.natives) {
        try { await services.stop(pid, n.id); } catch (e) { throw errorWith("SERVICE_STOP", T`The service “${n.name}” could not be stopped: ${short(e?.message || e, 200)}`); }
      }
      await stopContainer(container, v.docker.container);
      const row = store.projectInstance(pid, MAIN);
      if (row?.desired) {
        const gone = new Set(v.docker.container.flatMap((c) => [c.id, c.name]));
        const nat = new Set(v.natives.map((n) => n.id));
        store.changeProjectInstance(pid, MAIN, { desired: {
          ...row.desired,
          container: (row.desired.container || []).filter((c) => !gone.has(c.id) && !gone.has(c.name)),
          services: (row.desired.services || []).filter((x) => !nat.has(idOf(x))),
        } });
      }
    }),

    postWork: step(async () => {
      const r = await gitPostWork(inst);
      for (const f of r?.error || []) ctx.warn(T`Git follow-up: ${short(f, 200)}`);
      if (openGitJobsOf(pid) > 0) await openGitJobs();
    }),

    foreign: step(async () => {
      const p = paths();
      const roots = rootsOf(ctx);
      // (a) in B: a process below an affected path that belongs to no terminal — the turn of a chat or a process without
      //     a known run (subagent, bash of the loop engine, background server of a chat). The same computation as the
      //     quiet (./processes-in-b.js), with two looks: a short process does not send the job into the return path.
      //     Whoever stays, holds ⇒ back to `waiting` (the code stays WORKSPACE_CHAT — afterReturnPath reads it).
      const situation = await remainingInB({ paths: p, roots });
      if (situation.holders.length) {
        throw errorWith("WORKSPACE_CHAT", T`Something in B is still working in an affected folder (${situation.holders.map((h) => h.name || h.id).slice(0, PATHS_IN_TEXT).join(", ")}) — the order waits for quiet again.`);
      }
      // (b) in the project container: everything except the terminals (step 6).
      const exempt = terminalGroups(pid);
      await endInProject(inst, { paths: p, roots, exempt }, {
        hits: (x) => { if (!ctx.report.foreign.some((f) => f.name === x.name)) ctx.report.foreign.push({ name: x.name }); },
        tooMany: (n) => errorWith("TOO_MANY_PROCESSES", T`${n} processes work in affected folders in the project container — too many to end one by one.`),
        stay: (names) => errorWith("PROCESSES_STAY", T`Processes in the project container do not end even after SIGKILL: ${names.slice(0, PATHS_IN_TEXT).join(", ")}.`),
      });
      ctx.reports();
    }),

    terminals: step(async () => {
      endInstanceSessions(pid, MAIN, notice, { chats: true });
      const p = paths();
      // The editor sessions on the project container: the server of VS Code usually does not hold the files open and
      // has its cwd outside the folder — the path search of step 5 does not hit it, and an unsaved buffer would recreate
      // the old folder after the move. Ended hard as in the recreate, searched at the places of its installation
      // (proc-program.js EDITOR_LOCATIONS), with a sentence in the report.
      if (p.length) {
        const editor = [];
        await endInProject(inst, { paths: [...EDITOR_LOCATIONS], exempt: terminalGroups(pid) }, {
          hits: (x) => { if (!editor.includes(x.name)) editor.push(x.name); },
          tooMany: (n) => errorWith("TOO_MANY_PROCESSES", T`${n} editor processes run in the project container — too many to end one by one.`),
          stay: (names) => errorWith("PROCESSES_STAY", T`Editor processes in the project container do not end even after SIGKILL: ${names.slice(0, PATHS_IN_TEXT).join(", ")}.`),
        });
        if (editor.length) {
          ctx.warn(T("An editor session on the project container (VS Code) was ended — an open window reconnects; unsaved changes there are lost, and saving under the old path would recreate the old folder."));
          ctx.reports();
        }
      }
      const inB = terminalSessions().filter((s) => !s.inContainer && s.pid);
      if (!inB.length || !p.length) return;
      // The search paths by their wording below the root: a moved link pulls no terminal below its target along.
      const findings = procInB(fs, "processes", { paths: p, roots: rootsOf(ctx) }, processSeamRoot()).processes || [];
      for (const s of inB) {
        if (findings.some((x) => x.pid === s.pid || x.sid === s.pid || (x.chain || []).includes(s.pid))) endTerminalWithNotice(s.id, notice);
      }
    }),

    repack: step(async () => {
      const v = ctx.prior();
      const goneAbs = end.gone.flatMap((p) => uniq([path.join(root, p), path.join(v.rootReal || root, p)]));
      for (const [repo, targets] of Object.entries(v.alternates || {})) {
        if (repo !== "." && end.gone.some((w) => under(repo, w))) continue; // the repo itself falls
        const loaned = targets.filter((z) => goneAbs.some((w) => underAbs(z, w)));
        if (!loaned.length) continue;
        const r = await git(ctx, repoAbs(ctx, repo), ["repack", "-a", "-d", "-q"]);
        if (r.code !== 0) throw errorWith("REPACK", T`“${repo}” could not fetch the borrowed objects: ${short(r.stderr, 200)}`);
        await rebuild(ctx, "alternates", { repos: [{ rel: repo, replace: [], remove: loaned }] });
      }
    }),

    crossCheck: step(async () => {
      const b = await program(inst, "tree", { root, cap: treeCap() });
      const tree = b.node.map((k) => ({ path: k.path, kind: k.kind })).sort((x, y) => compare(x.path, y.path));
      const rules = rulesResponse();
      delete rules.reserveBytes;
      const p = computePlan(tree, ctx.plan.steps, rules, "inventory");
      const now = p.finalMapping;
      const entries = (e) => new Set([...(e.ways || []).map((w) => `w\0${w.old}\0${w.fresh}`), ...(e.gone || []).map((x) => `x\0${x}`), ...(e.codeRepos || []).map((x) => `c\0${x}`)]);
      const a = entries(end);
      const n = entries(now);
      const different = uniq([...[...a].filter((x) => !n.has(x)), ...[...n].filter((x) => !a.has(x))].map((x) => x.split("\0")[1]));
      const errorPaths = p.error.map((f) => f.path).filter(Boolean);
      if (p.error.length || different.length) {
        const list = uniq([...different, ...errorPaths]).sort(compare);
        throw errorWith("LAYOUT_CHANGED", T`The structure changed since the check${list.length ? ` (${list.slice(0, PATHS_IN_TEXT).join(", ")}${list.length > PATHS_IN_TEXT ? ", …" : ""})` : ""} — please check again.`, {
          paths: list.slice(0, PATHS_IN_TEXT), errorCodes: uniq(p.error.map(errorKey)).slice(0, PATHS_IN_TEXT),
        });
      }
      // The parking spot: view and tree hide `.cbase-*` at the root — an entry under that name (created by hand or by an
      // agent) would make `parking` or `place` fail AFTER the point of no return (conflict, ENOTDIR, not empty), every
      // "Try again" the same. An earlier pass of this job never created it before the point of no return.
      if ((await rebuild(ctx, "exists", { paths: [PARK] })).exists.length) {
        throw errorWith("PARKING_SPOT_OCCUPIED", T`“${PARK}” already exists at the root — the name is reserved for the rebuild. Please remove it (it is hidden in the interface) and check again.`, { paths: [PARK] });
      }
      if (end.ways.length || end.gone.length) await dockerInventory(container); // docker must be readable (throws otherwise)
    }),

    "docker-away": async () => {
      let takenEffect = false;
      const applies = () => { if (!takenEffect) { takenEffect = true; noteNow(pid, { dockerAwayTakenEffect: true }); } };
      try {
        hold();
        const r = await removeAway(container, end.gone.map((p) => path.join(root, p)), confirmed, { beforeEffect: applies });
        const e = ctx.report.removed;
        for (const k of Object.keys(e)) for (const x of r.removed[k] || []) if (!e[k].some((y) => JSON.stringify(y) === JSON.stringify(x))) e[k].push(x);
        for (const h of r.add) if (!ctx.report.add.some((y) => y.kind === h.kind && y.name === h.name)) ctx.report.add.push(h);
        ctx.reports();
        const v = ctx.prior();
        if (v.docker.stacks.some((s) => s.p48)) {
          applies();
          ctx.report.superseded = await supersede(pid, MAIN, container, v.docker.stacks, { warn: ctx.warn });
          ctx.reports();
        }
      } catch (e) {
        // Before the first effect (also in no earlier pass) the point of no return is not reached: the return path runs (journal.js).
        if (!takenEffect && !ctx.data().dockerAwayTakenEffect) e.turnaroundNotReached = true;
        throw e;
      }
    },

    parking: step(async () => {
      const v = ctx.prior();
      // A left-out worktree of a staying repo: take it out of the repo (otherwise it would be listed there as missing).
      for (const k of v.blocks.filter((x) => x.kind === "worktree" && x.worktreeOf !== undefined)) {
        if (!end.gone.some((w) => under(k.path, w))) continue;
        const main = String(k.worktreeOf);
        if (main !== "." && end.gone.some((w) => under(main, w))) continue;
        const r = await git(ctx, repoAbs(ctx, main), ["worktree", "remove", "--force", "--force", "--", path.join(root, k.path)]);
        if (r.code !== 0 && (await rebuild(ctx, "exists", { paths: [k.path] })).exists.length) {
          ctx.warn(T`The worktree “${k.path}” could not be removed from “${main}” (${short(r.stderr, 120)}) — it is only deleted.`);
        }
      }
      await movesRun(ctx, parkPlan(end).map((p) => ({ from: p.old, to: p.park })));
    }),

    leaveOut: step(async () => {
      const parks = parkPlan(end);
      const r = await rebuild(ctx, "gone", { paths: end.gone.map((p) => locationAfterParking(parks, p)) });
      for (const x of r.paths.filter((y) => y.outcome === "refused")) {
        const rr = await removeAsRoot({ projectId: pid, path: path.join(root, x.rel), area: "project", inst });
        if (!rr?.ok) throw errorWith("WAY_REFUSED", T`“${x.rel}” could not be removed even as root: ${short(rr?.text, 200)}`);
      }
      // Worktrees of a left-out repo: gone in the runtime folder (as root, like every rest there); in the project folder,
      // if they are not left out themselves, a warning (they point to a repo that no longer exists).
      const v = ctx.prior();
      let lz = null;
      try { lz = locationFor({ projectId: pid, converted: true }).root; } catch { lz = null; }
      // git names worktrees with realpath — if the runtime folder lies behind a link ABOVE it (macOS: /var →
      // /private/var), the comparison would never find them. Both forms; removal uses the form of B (cleanUp.js checks
      // the path against it).
      const lzRevisions = lz ? uniq([lz, (() => { try { return fs.realpathSync(lz); } catch { return lz; } })()]) : [];
      const roots = uniq([root, v.rootReal || root]);
      for (const w of v.worktrees) {
        if (w.repo === "." || !end.gone.some((p) => under(w.repo, p))) continue;
        for (const p of w.paths) {
          const rel = roots.map((x) => (underAbs(p, x) ? path.relative(x, p).split(path.sep).join("/") : null)).find((x) => x !== null);
          if (rel !== undefined && rel !== null) {
            if (!end.gone.some((x) => under(rel, x))) ctx.warn(T`The worktree “${rel}” belongs to the omitted repository “${w.repo}” and no longer works.`);
            continue;
          }
          const f = lzRevisions.find((x) => underAbs(p, x));
          if (f !== undefined) await removeAsRoot({ projectId: pid, path: path.join(lz, path.relative(f, p)), area: "runtime" });
        }
      }
      ctx.reports();
    }),

    place: step(async () => {
      const parks = parkPlan(end).sort((x, y) => depth(x.fresh) - depth(y.fresh) || compare(x.fresh, y.fresh));
      await movesRun(ctx, parks.map((p) => ({ from: p.park, to: p.fresh })));
      await rebuild(ctx, "empty", { rel: PARK });
    }),

    "code-repos": step(async () => {
      const home = creationOptionsFor(pid).home;
      for (const rel of end.codeRepos || []) {
        if (ctx.report.codeRepos.includes(rel)) continue; // an earlier pass (the report is written after EVERY repo)
        const r = await createCodeRepo(inst, root, rel, { home });
        let our = r.created;
        // In a repetition a repo the first pass created reports "already a repo" — it would silently be missing in
        // report and hint. Before the point of no return there was none (plan.js: a mark on a repo is invalid, and
        // `crossCheck` held the tree against the plan), so it is ours if its commit is our empty one. A `.git` without a
        // commit (B died between `init` and the marker) stays, as createCodeRepo wants it, without a commit — with a warning.
        if (!our && r.reason === "repo") {
          const l = await git(ctx, path.join(root, rel), ["--git-dir=.git", "log", "-1", "--format=%s"], { reading: true });
          our = l.code === 0 && [CODE_REPO_MESSAGE, CODE_REPO_MESSAGE_BEFORE].includes(String(l.stdout || "").trim());
        }
        if (our) { ctx.report.codeRepos.push(rel); ctx.reports(); continue; }
        ctx.warn(T`Code repository “${rel}”: ${short(r.notice, 200)}`);
      }
      ctx.reports();
    }),

    "project-repo": step(async () => {
      const v = ctx.prior();
      if (v.rootGit !== "folder" || !carriesProjectRepoMarker(root)) return;
      const { repos, unreadable } = await upkeepExclude(root, { instance: inst, inContainer: true, withoutDeadline: true });
      await takeFromTheIndex(root, [...repos, ...unreadable], { instance: inst, withoutDeadline: true, harden: true });
    }),

    worktrees: step(async () => {
      const v = ctx.prior();
      const projector = ctx.projectionNow();
      for (const w of v.worktrees) {
        const repoNew = w.repo === "." ? "." : projector.rel(w.repo);
        if (repoNew === null) continue;
        const pairs = w.paths.map((p) => [p, projector.abs(p)]).filter(([, n]) => n !== null);
        if (!pairs.length || (repoNew === w.repo && pairs.every(([a, n]) => a === n))) continue;
        // From the main repo, with the places of now: git rewrites both sides (`.git` of the worktree, `gitdir` in the repo).
        const r = await git(ctx, repoAbs(ctx, repoNew), ["worktree", "repair", ...pairs.map(([, n]) => n)]);
        if (r.code !== 0) ctx.warn(T`The worktrees of “${repoNew}” could not be repaired: ${short(r.stderr, 200)}`);
      }
      // Graph runs, subagents, git post-work: the plan ONCE into the journal (a second pass replays it, see bringAlong.js).
      let plans = ctx.data().plans;
      if (!plans) {
        const chats = uniq([...store.chatIdsInProject(pid), ...store.chatIdsInWorkspace(ctx.proj.workspaceId)]);
        plans = { graph: graphPlan(pid, projector), subagents: subagentsPlan(pid, projector, chats) };
        await ctx.journal.note({ plans });
      }
      writeGraph(plans.graph);
      // The linked dependencies of the graph worktrees: workflows/worktree.js creates ABSOLUTE links to the main folder
      // (`node_modules`, `.venv`) — after the move they would point to the old place. In the project container, only
      // below the runtime folder (the worktrees live there), repeatable.
      const links = plans.graph.flatMap((g) => g.links || []);
      if (links.length) {
        let lz = null;
        try { lz = locationFor({ projectId: pid, converted: true }).root; } catch { lz = null; }
        const r = lz ? await rebuild(ctx, "links", { links, limits: [lz] }) : { links: links.map((l) => ({ path: l.path, outcome: "outside" })) };
        for (const x of r.links.filter((y) => y.outcome === "no-reference" || y.outcome === "outside")) {
          ctx.warn(T`The link “${path.basename(x.path)}” in a graph worktree could not be pointed to the new location (${x.outcome}).`);
        }
      }
      writeSubagents(plans.subagents);
      if (!ctx.data().postWorkBroughtAlong) {
        bringAlongPostWork(pid, projector);
        await ctx.journal.note({ postWorkBroughtAlong: true });
      }
      ctx.reports();
    }),

    alternates: step(async () => {
      const v = ctx.prior();
      const projector = ctx.projectionNow();
      const roots = uniq([root, v.rootReal || root]);
      const replace = end.ways.flatMap((w) => roots.map((x) => ({ old: path.join(x, w.old), fresh: path.join(root, w.fresh) })))
        .sort((x, y) => y.old.split(path.sep).length - x.old.split(path.sep).length || compare(x.old, y.old));
      const repos = [];
      for (const [repo, targets] of Object.entries(v.alternates || {})) {
        const fresh = repo === "." ? "." : projector.rel(repo);
        if (fresh === null || !targets.some((z) => replace.some((e) => underAbs(z, e.old)))) continue;
        repos.push({ rel: fresh, replace, remove: [] });
      }
      if (repos.length) await rebuild(ctx, "alternates", { repos });
    }),

    db: step(async () => {
      const projector = ctx.projectionNow();
      let plan = ctx.data().db;
      if (!plan) {
        plan = { services: servicesPlan(pid, projector), knowledge: knowledgePlan(pid, projector) };
        await ctx.journal.note({ db: plan });
      }
      const dropped = writeServices(pid, plan.services, { instance: MAIN, deleteLog: (id) => removeServiceLog(pid, id, { instance: MAIN }) });
      writeKnowledge(pid, plan.knowledge);
      // The anchor of the entries that were fresh before and that the layout touches (path moved or below a new code
      // repo): set anew, the date of the last check stays (nobody verified the content anew — only the place of the
      // commits differs).
      const v = ctx.prior();
      const affected = new Set(plan.knowledge.map((w) => w.id));
      let list = [];
      try { list = store.listProjectContext(pid, { withBody: false }); } catch { list = []; }
      for (const c of list) {
        if (!(v.okfFresh || []).includes(c.id)) continue;
        if (!affected.has(c.id) && !(c.codePaths || []).some((p) => (end.codeRepos || []).some((r) => under(String(p).replace(/^\.\//, ""), r)))) continue;
        const a = await verifyAnchors(root, c.codePaths || [], { instance: inst });
        if (a.containerStands) continue;
        store.updateProjectContext(pid, c.id, { lastVerified: { commits: a.commits, at: c.lastVerified?.at ?? a.at } });
      }
      const all = uniq([...(ctx.data().dropped || []), ...dropped.map((g) => g.id)]);
      await ctx.journal.note({ dropped: all });
      ctx.report.services = {
        rewritten: plan.services.filter((d) => d.fresh !== null).map((d) => ({ name: d.name, old: d.old, fresh: d.fresh })),
        dropped: plan.services.filter((d) => d.fresh === null).map((d) => ({ name: d.name })),
      };
      ctx.report.knowledge = plan.knowledge.length;
      ctx.reports();
    }),

    compose: step(async () => {
      const v = ctx.prior();
      const projector = ctx.projectionNow();
      const projection = (p) => { const n = projector.abs(p); return n === null ? p : n; };
      const results = [...(ctx.data().compose || [])];
      for (const s of v.docker.stacks.filter((x) => x.kind === "moved")) {
        if (results.some((e) => e.project === s.project)) continue;
        const e = await composeNew(container, s, projection);
        results.push(e);
        await ctx.journal.note({ compose: results });
        if (e.text) ctx.warn(e.text);
      }
      // If a renamed stack stayed stopped, its old containers are NOT superseded ones — "Remove old containers" would
      // otherwise take, with their volumes, the only thing left of the stack. They stay stopped like a reference stack
      // and drop out of the superseded table (repeatable: a missing row is done).
      for (const e of results.filter((x) => x.outcome !== "created")) {
        const s = v.docker.stacks.find((x) => x.project === e.project && x.p48);
        if (!s) continue;
        let dropped = false;
        for (const c of s.container) dropped = store.removeSuperseded(pid, MAIN, c.id) || dropped;
        const prior = ctx.report.superseded.length;
        ctx.report.superseded = ctx.report.superseded.filter((x) => x.stack !== s.project);
        if (dropped || prior !== ctx.report.superseded.length) ctx.warn(T`“${s.project}” stays under the old name (stopped): the new stack “${e.name}” could not be created — its old containers do not count as replaced.`);
      }
      ctx.report.compose = results.map((e) => ({ project: e.project, name: e.name, outcome: e.outcome }));
      ctx.reports();
    }),

    startUp: step(async () => {
      const v = ctx.prior();
      const d = ctx.data();
      const row = store.projectInstance(pid, MAIN);
      const inspect = withoutSuperseded(pid, await insideInspect(container));
      const dropped = new Set((d.dropped || []).map(Number));
      const known = new Set(store.listProjectServices(pid).map((s) => Number(s.id)));
      const ids = uniq([...(row?.desired?.services || []).map(idOf), ...v.natives.map((n) => n.id)]).filter((id) => !dropped.has(id) && known.has(id));
      const desired = carryForwardDesired(row?.desired, inspect, { services: ids });
      // A newly created container whose old one (same stack, same service) ran, runs again.
      const ran = new Set(v.docker.container.filter((c) => DESIRED_RUNNING.has(c.state) && c.compose).map((c) => `${c.compose}\0${c.service}`));
      const newFrom = new Map();
      for (const e of d.compose || []) for (const id of e.container || []) newFrom.set(id, e.project);
      for (const c of desired.container) {
        const old = newFrom.get(c.id);
        if (old && ran.has(`${old}\0${c.service}`)) c.state = "running";
      }
      store.changeProjectInstance(pid, MAIN, { desired });
      const { findings, notices } = await runStartSequence(pid, inst, { containerId: row?.containerId || container, desired, set: () => {}, starter: services.start });
      let to;
      try { to = desiredAfterRestore(desired, withoutSuperseded(pid, await insideInspect(container)), { notArrived: findings.flatMap((b) => [b.id, b.name]) }); }
      catch (e) { to = null; ctx.warn(T`The target state after starting could not be read: ${short(e?.message, 200)}`); }
      if (to) store.changeProjectInstance(pid, MAIN, { desired: withServicesOfNow(pid, MAIN, to) });
      ctx.report.findings = [...findings.map((b) => `${b.name} (${b.reason})`), ...notices];
      ctx.reports();
    }),

    recheck: step(async () => {
      const v = ctx.prior();
      const d = ctx.data();
      const projector = ctx.projectionNow();
      const kind = new Map(v.docker.stacks.map((s) => [s.project, s.kind]));
      const stoppedStack = new Set((d.compose || []).filter((e) => e.outcome !== "created").map((e) => e.project));
      const stayStopped = v.docker.container.filter((c) => !c.compose || kind.get(c.compose) === "reference" || stoppedStack.has(c.compose)).map((c) => c.id);
      const r = await recheckDocker(pid, container, {
        oldAbs: end.ways.map((w) => path.join(root, w.old)), stayStopped, newStacks: new Set((d.compose || []).flatMap((e) => e.container || [])),
      });
      for (const w of r.warnings) ctx.warn(w);
      // A folder that reappeared at the old place (a start that created an empty one there) — only places that are no target.
      const ghosts = end.ways.map((w) => w.old).filter((old) => !end.ways.some((w) => under(w.fresh, old) || under(old, w.fresh)));
      if (ghosts.length) {
        for (const p of (await rebuild(ctx, "exists", { paths: ghosts })).exists) ctx.warn(T`There is a folder at the old location “${p}” again.`);
      }
      for (const w of v.worktrees) {
        for (const p of w.paths) {
          const n = projector.abs(p);
          if (n === null) continue;
          const g = await git(ctx, n, ["rev-parse", "--git-dir"], { reading: true });
          if (g.code !== 0) ctx.warn(T`git no longer sees the worktree “${path.basename(n)}” as a repository (${short(g.stderr, 120)}).`);
        }
      }
      ctx.reports();
    }),

    completion: step(async () => {
      setRebuildMarker(pid, false);
      // The language service (lsp/) knows the old tree — its servers end, the next use starts them anew.
      endLanguageServices(pid, null, "layout");
      if (!ctx.data().hintDeposited) {
        const text = hintText(end, ctx.report);
        const chats = uniq([
          ...store.chatIdsInProject(pid),
          ...store.chatIdsInWorkspace(ctx.proj.workspaceId).filter((c) => { try { return !store.getChat(c)?.projectId; } catch { return false; } }),
        ]);
        for (const c of chats) depositHint(c, text, { source: "layout" });
        await ctx.journal.note({ hintDeposited: true });
      }
      ctx.report.end = { at: Date.now(), ways: end.ways, gone: end.gone, codeRepos: end.codeRepos || [] };
      ctx.reports();
      broadcast({ type: "project/layout", projectId: pid, kind: "finished", mapping: end.ways, gone: end.gone, codeRepos: end.codeRepos || [] });
    }),

    // ── The return path ──
    "rw-rules": async () => {
      hold();
      const v = ctx.prior();
      if (v?.docker?.container?.length) await rulesBack(container, v.docker.container);
    },
    "rw-start-up": async () => {
      hold();
      const v = ctx.prior();
      if (!v) return;
      const row = store.projectInstance(pid, MAIN);
      const inspect = withoutSuperseded(pid, await insideInspect(container));
      const known = new Set(store.listProjectServices(pid).map((s) => Number(s.id)));
      const ids = uniq([...((v.desired || row?.desired)?.services || []).map(idOf), ...v.natives.map((n) => n.id)]).filter((id) => known.has(id));
      const desired = desiredFromInspect(inspect, { services: ids });
      const ran = new Set(v.docker.container.filter((c) => DESIRED_RUNNING.has(c.state)).flatMap((c) => [c.id, c.name]));
      for (const c of desired.container) if (ran.has(c.id) || ran.has(c.name)) c.state = "running";
      store.changeProjectInstance(pid, MAIN, { desired });
      const { findings, notices } = await runStartSequence(pid, inst, { containerId: row?.containerId || container, desired, set: () => {}, starter: services.start });
      try {
        const after = desiredAfterRestore(desired, withoutSuperseded(pid, await insideInspect(container)), { notArrived: findings.flatMap((b) => [b.id, b.name]) });
        store.changeProjectInstance(pid, MAIN, { desired: withServicesOfNow(pid, MAIN, after) });
      } catch (e) { console.warn(`[layout] ${pid}: return path — desired state after starting up not read: ${short(e?.message)}`); }
      ctx.report.findings = [...findings.map((b) => `${b.name} (${b.reason})`), ...notices];
      ctx.reports();
    },
    "rw-marker": async () => { setRebuildMarker(pid, false); },
  };
}

/** The silent hint to the chats (step 21): what moved where, what fell, which code repos are new — capped. */
function hintText(end, report) {
  const ways = (end.ways || []).slice(0, 20).map((w) => `${w.old} → ${w.fresh}`);
  const parts = [T("The project structure was changed.")];
  if (ways.length) parts.push(T`Moved: ${ways.join("; ")}${(end.ways || []).length > 20 ? "; …" : ""}.`);
  if ((end.gone || []).length) parts.push(T`Deleted: ${end.gone.slice(0, 20).join(", ")}${end.gone.length > 20 ? ", …" : ""}.`);
  if ((report.codeRepos || []).length) parts.push(T`New code repository: ${report.codeRepos.join(", ")}.`);
  parts.push(T("Paths from earlier messages no longer apply."));
  return parts.join(" ");
}

// ── Exits ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const isServerEnd = (e) => e?.code === "SERVER_ENDS" || e?.cause?.code === "SERVER_ENDS";

/** atTurnAround (journal.js): the reason is in the journal BEFORE the first return-path step. No return path in an ending server. */
const returnPathBegins = (pid) => async ({ step, error, cause }) => {
  if (isServerEnd(error) || serverEnds()) throw error || errorWith("SERVER_ENDS", "the server is ending — no return path now.");
  const reason = error ? short(error.message, 500) : T("Restart before the point of no return — the rebuild is reverted.");
  noteNow(pid, { returnPath: { reason, step: step || null, cause, code: error?.code || null, paths: error?.paths || [], at: Date.now() } });
  store.layoutSet(pid, { turned: false, backward: true, error: reason });
  console.log(`[layout] ${pid}: return path (${cause}, ${step || "—"}): ${reason}`);
  report(pid);
};

function afterReturnPath(pid) {
  const a = store.layoutJob(pid);
  if (!a) return;
  const rw = a.journal?.data?.returnPath || {};
  store.clearLayoutPrior(pid);
  setRebuildMarker(pid, false);
  const empty = { journal: null, turned: false, backward: false, process: "", step: "" };
  if (rw.cause === "restartGrace" || rw.code === "WORKSPACE_CHAT") {
    backToWaiting(pid);
    console.log(`[layout] ${pid}: return path done — the job waits for quiet again`);
    return;
  }
  store.layoutSet(pid, { ...empty, state: "error", error: rw.reason || T("Failed before the point of no return — nothing changed.") });
  releaseLock(pid);
  console.log(`[layout] ${pid}: return path done — error before the point of no return (${rw.code || "?"})`);
  report(pid);
}

// `error`: what held the return path up; `cause`: why it ran (the reason from the journal, otherwise "restart").
function returnPathFailed(pid, error, cause) {
  const text = T`The way back failed (${short(error, 200)}); cause: ${short(cause || T("restart##cause"), 200)}. “Retry” completes it.`;
  store.layoutSet(pid, { state: "error", turned: false, backward: true, process: "", error: text });
  releaseLock(pid);
  setRebuildMarker(pid, false);
  console.error(`[layout] ${pid}: ${text}`);
  report(pid);
}

function errorAfterTurnaround(pid, e) {
  const text = short(e?.message || e, 500) || T("A step failed.");
  store.layoutSet(pid, { state: "error", process: "", error: text });
  const v = setLock(pid, store.layoutJob(pid));
  if (!v.ok) console.error(`[layout] ${pid}: lock in "error" not set: ${short(v.error || v.open?.[0]?.text)}`);
  console.error(`[layout] ${pid}: failed after the point of no return (${e?.code || "?"}): ${text}`);
  report(pid);
}

function finished(pid) {
  store.clearLayoutPrior(pid);
  store.layoutSet(pid, { state: "finished", journal: null, process: "", step: "", error: "", backward: false });
  releaseLock(pid);
  setRebuildMarker(pid, false);
  console.log(`[layout] ${pid}: finished`);
  report(pid);
}

// ── The entry ──────────────────────────────────────────────────────────────────────────────────────────────────────

const runs = new Map(); // projectId → { again: null | { resume }, promise }
const retry = new Map(); // projectId → timer (OCCUPIED: once more later)

/** Is a procedure running for this project right now? (Tests: wait for the end instead of a duration.) */
export const layoutProcedureAlive = (pid) => runs.has(String(pid));

/** The execution (job.js setLayoutExecution). Never throws; a second call during a run runs afterwards. */
export function layoutProcedure(projectId, { resume = false } = {}) {
  const pid = String(projectId ?? "");
  if (!pid || !projectboxOps()) return Promise.resolve();
  const l = runs.get(pid);
  if (l) { l.again = { resume: Boolean(l.again?.resume) || resume }; return l.promise; }
  const entry = { again: null, promise: null };
  runs.set(pid, entry);
  entry.promise = (async () => {
    let next = { resume };
    while (next) {
      entry.again = null;
      try { await oneRun(pid, next); } catch (e) { console.error(`[layout] ${pid}: procedure: ${short(e?.stack || e?.message || e, 800)}`); }
      next = entry.again;
    }
  })().finally(() => runs.delete(pid));
  return entry.promise;
}

function laterAgain(pid) {
  if (retry.has(pid)) return;
  const raw = Number(process.env.CBASE_LAYOUT_CHECK_BACK_MS);
  const t = setTimeout(() => {
    retry.delete(pid);
    const a = store.layoutJob(pid);
    if (a?.state === "running" && a.process !== BOOT_ID) layoutProcedure(pid, { resume: true });
  }, Number.isSafeInteger(raw) && raw >= 50 ? raw : 30_000);
  t.unref?.();
  retry.set(pid, t);
}

// Transient (nothing begun): the row stays `running` without a process. OCCUPIED/LOCKED tries again later, NOT_READY is
// resumed by the instance's transition to `ready` (server.js atReady → job.js layoutAtReady).
const TRANSIENT = new Set(["OCCUPIED", "LOCKED", "NOT_READY"]);

async function oneRun(pid, { resume }) {
  const a0 = store.layoutJob(pid);
  if (!a0 || a0.state !== "running") return;
  if (serverEnds()) return; // the row stays `running`, the restart resumes
  let begun = false;
  try {
    await withProjectOccupancy(pid, "layout", async () => {
      const snapshot0 = journalFor(pid).snapshot();
      const fresh = !resume && !snapshot0?.step;
      const ctx = context(pid, { fresh });
      store.layoutSet(pid, { process: BOOT_ID, ...(fresh ? { report: ctx.report } : {}) });
      const v = setLock(pid, store.layoutJob(pid));
      if (!v.ok) throw errorWith("LOCKED", `the lock "layout" could not be set: ${short(v.error || v.open?.[0]?.text)}`);
      // The marker stands from step 2 on — and for every resumed return path (the restart sets it too, job.js).
      if (snapshot0 && (snapshot0.direction === "backward" || LAYOUT_JOURNAL.forward.indexOf(snapshot0.step) >= LAYOUT_JOURNAL.forward.indexOf("marker"))) setRebuildMarker(pid, true);
      console.log(`[layout] ${pid}: procedure ${fresh ? "begins" : `resumes (${snapshot0?.direction || "—"} ${snapshot0?.step || "—"})`}`);
      begun = true;
      const r = await run(LAYOUT_JOURNAL, ctx.journal, effects(ctx), { fresh, atTurnAround: returnPathBegins(pid) });
      if (r.direction === "backward") afterReturnPath(pid);
      else finished(pid);
    });
  } catch (e) {
    if (isServerEnd(e)) { console.log(`[layout] ${pid}: the server is ending — the procedure resumes after the restart`); return; }
    if (e instanceof JournalTurned) { afterReturnPath(pid); return; }
    if (e instanceof JournalReturnPathFailed) {
      if (isServerEnd(e.cause)) return;
      returnPathFailed(pid, e.cause?.message || e.message, e.origin?.message);
      return;
    }
    const a = store.layoutJob(pid);
    if (!a) return;
    if (!begun && TRANSIENT.has(e?.code)) {
      // Nothing begun in THIS run. A later run resumes (an empty journal then runs the return path — nothing took
      // effect — and ends in `waiting`, see afterReturnPath).
      store.layoutSet(pid, { process: "" });
      console.warn(`[layout] ${pid}: procedure not begun (${e.code}): ${short(e?.message || e)} — again later`);
      if (e.code !== "NOT_READY") laterAgain(pid);
      report(pid);
      return;
    }
    if (a.turned) { errorAfterTurnaround(pid, e); return; }
    // Before the point of no return, and the return path did not run (to its end): a resumed return path failed (`run`
    // throws the step's own error there), a journal could not be read, the context is missing (no project, a different
    // root, no instance). If there is something in the journal (it may have taken effect), the return path stays open
    // (`backward`) — "Try again" runs it; otherwise it is an error before the point of no return without any change.
    if (a.journal?.step) { returnPathFailed(pid, e?.message || e, a.journal?.data?.returnPath?.reason); return; }
    store.layoutSet(pid, { state: "error", turned: false, backward: false, process: "", journal: null, error: short(e?.message || e, 500) || T("The run could not start.") });
    store.clearLayoutPrior(pid);
    releaseLock(pid);
    setRebuildMarker(pid, false);
    console.error(`[layout] ${pid}: procedure not begun (${e?.code || "?"}): ${short(e?.message || e)}`);
    report(pid);
  }
}

/** Only for tests: forget waiting retries. */
export function forgetProcedures() {
  for (const t of retry.values()) clearTimeout(t);
  retry.clear();
}
