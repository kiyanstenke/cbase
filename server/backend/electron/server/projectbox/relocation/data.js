// The data steps of the relocation: steps 9, 11, 13 and the data part of 15; return-path steps 1, 3, 5.
//
// All functions take the ONE context object of the procedure (./procedure.js):
//   ctx = { projectId, project (store row), workspace, plan (planRelocation), journal (../journal.js, THIS relocation),
//           relocationLocation (the relocation location of this run under <data>, 0700, never mounted), inst, docker, log(text) }
// They are async, idempotent (a second call resumes instead of acting twice) and write what they change into the journal
// BEFORE the effect (`ctx.journal.note`, the sections of store/project-relocations.js). They read their own sections back
// through `ctx.journal.snapshot()` — a section already noted is NEVER overwritten: after a crash the already changed values
// would otherwise stand there as "old". An error throws `RelocationDataError` with the field `step`.
// WHO CALLS A STEP TWICE: for the forward steps 9, 11 and 13 NOBODY today. They lie before the turnaround (`start`), and
// journal.js `decide` drives every abort before it — error, crash, restart grace, `…/relocation/resume` — into the return
// path; forward resumption only begins at the turnaround (step 15 and the return paths, by contrast, really run twice). The
// "second run" branches in portDismantling (backup already there), projectRepoStep ("running", "created", "not") and
// copyEntry (the own half copy at the target) are therefore a SAFEGUARD, not a path of the product. They stay: a procedure
// that resumes forward before the turnaround (a moved turnaround in RELOCATION_JOURNAL, procedure.js) would act twice
// without them — the backup of an already changed `.env` as the "original", a second project repo. Only the guards enter
// them (relocation-data.test.js), which call the functions twice directly; whoever changes them changes the tests too.
//
//   portDismantling(ctx)         Step 9: the override file of cbase aside (into the relocation location), the deviating port
//                                and URL keys in `.env*` to the repo default of the plan (`plan.dismantling.env` — the plan
//                                takes a `.env.example` only if git knows it; otherwise the case is a hint in the plan), the
//                                original of every changed file byte-exact (0600) in the relocation location; start commands
//                                in `project_services`/`service_start_commands` without port override and the field `port`
//                                to the repo default (`plan.dismantling.services`; without a recognisable default start
//                                command and field stay, and the report names the service). Journal BEFOREHAND: `services`
//                                (old values, "no row" as null), `dismantling` (key names only), `override`.
//                                Only what cbase overrode is changed: in the start command only `-p N`/`--port N`/
//                                `[X_]PORT=N` with N = the registered port of the service and a separator after it, also
//                                inside quotes (./port-command.js, ONE rule shared with the plan; a docker `-p 3100:3000`
//                                or an `ssh -p 2222` stay; the report names which port numbers remain — `commandStays`,
//                                and the field `port` stays if the dismantling did not change the port of the service at
//                                all), in a URL only the port field (`host:<port>` before `/`, `?`, `#`, quotes, whitespace,
//                                `,`, `;` or the end — never a `:<port>` inside a password).
//                                The backup is written atomically (`.tmp`, fsync, rename, fsync of the folder) together with
//                                a checksum next to it (`<name>.check`: size and sha256 of the original, 0600 — no value, and
//                                not in the journal: its section `dismantling` carries names only); a backup that does not
//                                match its checksum is never written over the `.env`.
//   portDismantlingBack(ctx)     Return-path step 3 and the `.env`/override part of 5: everything byte-equal from journal and
//                                backup (the backup checked against its checksum — if it deviates the `.env` stays untouched).
//   projectRepoStep(ctx)         Step 11, only AFTER the dismantling (without the section `services` it throws): the project
//                                repo through ../projectRepo.js, with the instance of the relocation (`ctx.inst`) — the
//                                container has been running since step 3, so readability is checked where commits happen later.
//   projectRepoBack(ctx)         Return-path step 5: remove a project repo created in THIS relocation (only with the marker,
//                                only if HEAD is the own first commit). The `rev-parse` runs in B: the return path can come
//                                after the project container is removed, and cbase created the repo itself in this run.
//                                HALF CREATED (a death between `git init` and the marker, projectRepo.js): "running" notes
//                                `gitPrior` (was there a `.git` before creating?). Only with `gitPrior: false`, a real
//                                folder `.git` without marker and without a single object does it fall — forward (step 11
//                                then creates anew) as well as back; a foreign `.git` (gitPrior true or unknown) always stays.
//   relocateRuntime(ctx)         Step 13: COPY the files of the project's chats into the runtime folder, plus the traces of
//                                the PROJECT (`browser-profiles/proj-<id>` without the lock files of a running instance, the
//                                service logs `<id>_<svc>.log` as `main_<svc>.log`). PREFILLED TARGET (an earlier relocation
//                                whose return path left the runtime folder standing — `runtimeStays`): before the turnaround
//                                no run reads or writes there, so the version at the target is an old copy and the living
//                                one lies flat. It is neither overwritten nor deleted but put ASIDE
//                                (`<relocationLocation>/prefilled/<field>/<name>`, journal `aside`), then copied like any
//                                other; the return path puts it back, step 15 leaves it and names it;
//                                MOVE every worktree from `plan.worktrees.move` into the worktree root of the runtime folder
//                                (`git worktree move`; a run folder of a graph workflow that is not itself a worktree by
//                                rename, then `git worktree repair` for every worktree in it) and rewrite every stored
//                                worktree reference — `graph_starts.worktree_path`/`worktree_info` (`dir`, `repos[].target`,
//                                `own[].path`; a missing `projectId` is added) and in the image of the subagents
//                                `cwd`/`worktree` plus `instance = <pid>/main` (a key missing from the image stays missing —
//                                forward and back, `hasCwd`/`hasWorktree`); then `~/.local` by the assignment of the plan,
//                                last the sessions (target slug from the NEW path: runs/system-prompt.js resolveCwd with the
//                                instance of the relocation). Journal BEFOREHAND: `copies`, the section of the worktrees
//                                (repo, old and new path, the old columns raw).
//   runtimeBack(ctx)             Return-path step 1 and the copies from 5: FIRST the worktrees back (in reverse order) and
//                                the references to the old values (byte-equal); only when ALL are back do the copies under
//                                the runtime folder of the project fall (chat files, ~/.local, sessions — exactly what this
//                                relocation added). If moving one back fails, the runtime folder stays: the result carries
//                                `runtimeStays` (its path) and the errors, and the procedure removes NOTHING there.
//   cleanUpAfterStart(ctx)       The data part of step 15: the `.env` backup, the override file put aside, the old copies of
//                                the chat and project files in the flat location (ONLY what step 13 itself copied — `fresh`
//                                or `aside` —, whose copy lies at the target and whose fingerprint has not changed since the
//                                copy: an attachment stored flat after step 13 would otherwise fall with the whole folder; a
//                                browser profile whose lock is still alive stays; everything that stays is in `stays`) and
//                                the old session copies in B (only where the new one lies at the target).
//
// GIT ON THE REPO OF A PROJECT. Step 13 lies BEFORE step 14 (only there `converted_at`), the return path likewise before
// the turnaround: `runInstance(pid)` is null at both moments, and runtime/git-run.js takes the path in B. It MUST be B —
// the old location (the flat runtime folder) is mounted in no project container. If the project is already converted the
// step throws (a construction error of the procedure, not "then in B after all"). Hardened with
// `core.hooksPath=/dev/null` and `core.fsmonitor=false`: both commands need neither — and `git worktree move` reads the
// index of the worktree, so a `core.fsmonitor` of the repo WOULD RUN. The hardening sits at the ONE bottleneck `gitInB`;
// guard: relocation-data.test.js, statically and with an fsmonitor bait.
//
// NO ENV VALUE leaves a `.env*` file except into its backup (0600, in the never-mounted relocation location): not into the
// journal (names only there, the table enforces it), not into the log, not into a report. Computation is on the bytes
// (latin1: every byte stays where it was); only the port number in the row of the key is changed.
//
// Guards: server/backend/test/relocation-data.test.js, server/backend/test/relocation-end.test.js (with the real procedure
// and plan).
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import * as store from "../../store.js";
import { profileLockAlive } from "../../browser-profiles.js";
import { isProjectRepo } from "../../git.js";
import { gitRun } from "../../runtime/git-run.js";
import { renameInArea, realRoots, createFolderInArea, openInArea } from "../../runtime/real-path.js";
import { chatTraces, removeTrace, createLocation, locationFor, worktreeRoot } from "../../runs/runtime-location.js";
import { bClaudeDir, bCodexDir, projectClaudeDir, projectCodexDir, pullSessionsOfTheProject } from "../../runs/session-location.js";
import { claudeCopies, codexCopies } from "../../runs/session-transfer.js";
import { resolveCwd } from "../../runs/system-prompt.js";
import { cliHomeFolder, copyLocal } from "../cli-home.js";
import { runInstance } from "../run-instance.js";
import { FIRST_COMMIT, removeProjectRepo, createProjectRepo } from "../projectRepo.js";
import { withoutPortOverride, portStillInCommand, overriddenPorts } from "./port-command.js";

const pexec = promisify(execFile);

/** The error of a data step — `step` says which one (contract of the relocation modules). */
export class RelocationDataError extends Error {
  constructor(step, text, { cause } = {}) {
    super(`relocation, ${step}: ${text}`, cause ? { cause } : undefined);
    this.name = "RelocationDataError";
    this.code = "RELOCATION_DATA";
    this.step = step;
  }
}

export const STEPS = Object.freeze({
  port: "port-dismantling", portBack: "port-dismantling-back", repo: "project-repo", repoBack: "project-repo-back",
  runtime: "runtime", runtimeBack: "runtime-back", cleanUp: "cleanUp",
});

/** The subfolders of the relocation location (never mounted, 0700): backup of the `.env*` originals, overrides put aside. */
export const LOCATION_ENV = "env-backup";
export const LOCATION_OVERRIDE = "override";
/** The subfolder of the relocation location where step 13 puts a PREFILLED version at the target (see header) — step 15 leaves it. */
export const LOCATION_PREFILLED = "prefilled";
/** The extension of the checksum next to a `.env` backup (`{ size, sha256 }` of the original). */
export const ENV_CHECK = ".check";
// The files of a RUNNING Chromium instance (browser-profiles.js LOCK_FILES): a copy containing them would block the next
// browser at the new location; without a process they are worthless.
const LOCK_FILES = new Set(["SingletonLock", "SingletonSocket", "SingletonCookie", "DevToolsActivePort"]);
const PROFILE_FIELDS = new Set(["playwrightProfiles", "browserProfiles"]);
/** At most this many entries are read for the state of a copied entry (its fingerprint) — above that it is unknown (the
 *  flat entry stays in step 15). Estimated, not measured (like LOCAL_CAP in collect.js). */
export const STATUS_CAP = 200_000;
/** At most this many entries go into the inventory of a target (sessions, ~/.local) — above that it throws with a message. */
export const INVENTORY_CAP = 20_000;
/** The deadline of a git call of this module: that of a HANGING git, as in workflows/worktree.js. */
const GIT_DEADLINE_MS = 120_000;
const HARDENING = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const FOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const O = fs.constants;
const lstat = (p) => { try { return fs.lstatSync(p); } catch (e) { if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return null; throw e; } };
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const relUnder = (p, root) => {
  const r = path.relative(root, p);
  return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)) ? r : null;
};
const log = (ctx, text) => { try { ctx?.log?.(text); } catch { /* the log must not topple a step */ } };

function checkCtx(ctx, step) {
  if (!ctx || typeof ctx !== "object") throw new RelocationDataError(step, "without a context");
  if (!VALID_ID.test(String(ctx.projectId || ""))) throw new RelocationDataError(step, `invalid project id "${ctx.projectId}"`);
  if (!ctx.plan || typeof ctx.plan !== "object") throw new RelocationDataError(step, "without a plan");
  if (typeof ctx.journal?.snapshot !== "function" || typeof ctx.journal?.note !== "function") throw new RelocationDataError(step, "without a journal");
  if (typeof ctx.relocationLocation !== "string" || !path.isAbsolute(ctx.relocationLocation)) throw new RelocationDataError(step, "without an absolute relocation location");
  return String(ctx.projectId);
}

// The project folder: the store row, otherwise the one of the plan. Absolute and existing, otherwise the step throws.
function projectPathOf(ctx, step) {
  const p = ctx.project?.path || ctx.plan?.projectPath || "";
  if (!p || !path.isAbsolute(p)) throw new RelocationDataError(step, "no absolute project folder");
  const st = lstat(p);
  if (!st?.isDirectory()) throw new RelocationDataError(step, `the project folder ${p} is missing`);
  return p;
}

const state = (ctx) => ctx.journal.snapshot() || {};

// A relative path in the project (from plan or journal) — never absolute, never with `..`.
function projectFile(projectPath, rel, step) {
  if (typeof rel !== "string" || !rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) {
    throw new RelocationDataError(step, `"${rel}" is not a path in the project`);
  }
  return path.join(projectPath, rel);
}

function locationUnder(ctx, name) {
  const d = path.join(ctx.relocationLocation, name);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(d);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${d} is not a folder`);
  fs.chmodSync(d, 0o700);
  return d;
}
// The name of a file in the relocation location: the relative path, encoded flat (no separator, no `..`).
const flat = (rel) => encodeURIComponent(rel).replace(/\./g, "%2E");

// ── byte access to a file in the project (runtime/real-path.js: opened, checked at the descriptor, no link) ──────────

function readBytes(abs, realW) {
  const fd = openInArea(abs, realW, O.O_RDONLY | O.O_NOFOLLOW | O.O_NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) throw Object.assign(new Error(`not a regular file: ${abs}`), { code: "ENOFILE" });
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

function writeBytes(abs, buf, realW) {
  const fd = openInArea(abs, realW, O.O_RDWR | O.O_NOFOLLOW | O.O_NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) throw Object.assign(new Error(`not a regular file: ${abs}`), { code: "ENOFILE" });
    fs.ftruncateSync(fd, 0);
    let n = 0;
    while (n < buf.length) n += fs.writeSync(fd, buf, n, buf.length - n, n);
  } finally { fs.closeSync(fd); }
}

// ── step 9: port dismantling ────────────────────────────────────────────────────────────────────────────────────────

const PORT_KEY = /(?:^|_)PORT$/i;
const ENV_ROW = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.-]*)(\s*[=:]\s?)(.*)$/;

// The port field of a `host:port` (URL or bare): before the `:` a character of a host name (or `]` of an IPv6 address),
// after the number a separator or the end. A `:<port>` inside a password (`app:3100secret@`, `app:3100@`) never matches —
// no separator follows there.
const urlPortPattern = (port) => new RegExp(`(?<=[A-Za-z0-9._\\]-]):${port}(?=$|[/?#"'\\s,;)])`, "g");

/**
 * PURE: the port number of the named keys in a `.env*` text to the default (see header). `changes`:
 * `[{ key, port, standard }]`. A `*_PORT` key changes the number itself, every other one only the port field of a
 * `host:<port>` (see urlPortPattern).
 * → `{ buf, hit: [key], missed: [key] }` — names only, never values.
 */
export function envWithDefault(buf, changes) {
  const text = Buffer.from(buf).toString("latin1");
  const byKey = new Map();
  for (const a of changes || []) {
    if (!Number.isInteger(a?.port) || !Number.isInteger(a?.standard)) continue;
    if (!byKey.has(a.key)) byKey.set(a.key, []);
    byKey.get(a.key).push(a);
  }
  const hit = new Set();
  const rows = text.split("\n").map((row) => {
    // A `\r` at the end of the row stays where it is — the `.` of the pattern would not match it (JS counts it as a line end).
    const cr = row.endsWith("\r") ? "\r" : "";
    const z = cr ? row.slice(0, -1) : row;
    const m = z.match(ENV_ROW);
    if (!m || !byKey.has(m[2])) return row;
    let value = m[4];
    for (const a of byKey.get(m[2])) {
      const prior = value;
      value = PORT_KEY.test(a.key)
        ? value.replace(new RegExp(`(^|[^0-9])${a.port}(?![0-9])`), `$1${a.standard}`)
        : value.replace(urlPortPattern(a.port), `:${a.standard}`);
      if (value !== prior) hit.add(a.key);
    }
    return `${m[1]}${m[2]}${m[3]}${value}${cr}`;
  });
  return {
    buf: Buffer.from(rows.join("\n"), "latin1"),
    hit: [...hit].sort(),
    missed: [...byKey.keys()].filter((k) => !hit.has(k)).sort(),
  };
}

// The port override in the start command: ONE rule for plan and dismantling, in the leaf ./port-command.js — only passed
// on here (the guards and the header of this file name it under this module).
export { withoutPortOverride, overriddenPorts };

// A file in the relocation location ATOMICALLY (0600): `.tmp` exclusive, written in full, fsync, renamed, fsync of the
// folder. Under its name there is never a half or empty version — not even after SIGKILL or a machine crash.
function writeAtomic(target, buf) {
  const tmp = `${target}.tmp`;
  fs.rmSync(tmp, { force: true });
  const fd = fs.openSync(tmp, O.O_WRONLY | O.O_CREAT | O.O_EXCL | O.O_NOFOLLOW, 0o600);
  try {
    let n = 0;
    while (n < buf.length) n += fs.writeSync(fd, buf, n, buf.length - n, n);
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, target);
  const d = fs.openSync(path.dirname(target), O.O_RDONLY);
  try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
}
const checksum = (buf) => ({ size: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("hex") });
function readCheck(file) {
  try {
    const p = JSON.parse(fs.readFileSync(file, "utf8"));
    return Number.isInteger(p?.size) && /^[0-9a-f]{64}$/.test(String(p?.sha256)) ? p : { broken: true };
  } catch (e) { return e?.code === "ENOENT" ? null : { broken: true }; }
}
// Does `buf` match the checksum? Without a checksum (null: a backup from before checksums existed) "yes"; an unreadable one never.
const matches = (buf, p) => p === null || (!p.broken && buf.length === p.size && checksum(buf).sha256 === p.sha256);

export async function portDismantling(ctx) {
  const S = STEPS.port;
  const pid = checkCtx(ctx, S);
  const projectPath = projectPathOf(ctx, S);
  const rb = ctx.plan.dismantling || {};
  const envList = Array.isArray(rb.env) ? rb.env : [];
  const serviceList = Array.isArray(rb.services) ? rb.services : [];
  const overrides = (Array.isArray(rb.overrides) ? rb.overrides : []).filter((o) => o?.ofCbase);
  const report = { env: [], services: [], withoutDefault: [], overrides: [], commandStays: [] };

  // (a) Journal BEFORE every effect — every section exactly once.
  let j = state(ctx);
  if (j.services == null) {
    const old = serviceList.map((d) => {
      const row = store.getProjectService(d.id);
      if (!row || String(row.projectId) !== pid || row.name !== d.name) {
        throw new RelocationDataError(S, `service ${d.id} ("${d.name}") does not belong to project ${pid} (any more) — the plan is outdated`);
      }
      return { id: row.id, name: row.name, startCommand: row.startCommand, port: row.port ?? null, startRow: store.serviceStartRow(pid, row.name) };
    });
    await ctx.journal.note({ services: old });
  }
  const files = [...new Set(envList.map((e) => e.file))].sort();
  if (j.dismantling == null) {
    const dismantling = files.map((file) => ({ file, key: [...new Set(envList.filter((e) => e.file === file).map((e) => e.key))].sort() }));
    for (const r of dismantling) projectFile(projectPath, r.file, S);
    await ctx.journal.note({ dismantling });
  }
  if (j.override == null) {
    const location = overrides.length ? locationUnder(ctx, LOCATION_OVERRIDE) : null;
    await ctx.journal.note({ override: overrides.map((o) => ({ file: o.file, location: path.join(location, flat(o.file)) })) });
  }
  j = state(ctx);

  // (b) Override aside — renamed through the opened parent folders (a link in the path is never followed).
  const realW = realRoots([projectPath], [projectPath]);
  for (const o of j.override || []) {
    const source = projectFile(projectPath, o.file, S);
    const q = lstat(source);
    const z = lstat(o.location);
    if (q && z) throw new RelocationDataError(S, `override ${o.file}: in place AND in the relocation location — nothing overwritten`);
    if (!q && !z) throw new RelocationDataError(S, `override ${o.file} is missing`);
    if (q) {
      if (!q.isFile()) throw new RelocationDataError(S, `override ${o.file} is not a regular file`);
      renameInArea(source, o.location, realW, null);
    }
    report.overrides.push(o.file);
  }

  // (c) `.env*`: backup (once, of the original), then computed from the BACKUP — a second run computes the same.
  if (files.length) locationUnder(ctx, LOCATION_ENV);
  for (const file of files) {
    const abs = projectFile(projectPath, file, S);
    const backup = path.join(ctx.relocationLocation, LOCATION_ENV, flat(file));
    const checkFile = `${backup}${ENV_CHECK}`;
    let original;
    try {
      if (lstat(backup)) {
        // A second run (safeguard, unreachable today — see header): the backup is the original — if it matches its
        // checksum. Otherwise only anew from the file if THAT is still the original (then it was never changed); otherwise
        // hold and write nothing.
        const s = fs.readFileSync(backup);
        const p = readCheck(checkFile);
        if (matches(s, p)) original = s;
        else {
          const now = readBytes(abs, realW);
          if (p === null || !matches(now, p)) {
            throw new RelocationDataError(S, `${file}: the backup does not match its checksum, and the file is no longer the original — nothing written (backup and checksum stay in ${path.dirname(backup)})`);
          }
          writeAtomic(backup, now);
          original = now;
        }
      } else {
        // First the checksum, then the backup (both atomic): where a backup lies, its checksum lies too.
        original = readBytes(abs, realW);
        writeAtomic(checkFile, Buffer.from(JSON.stringify(checksum(original))));
        writeAtomic(backup, original);
      }
      const r = envWithDefault(original, envList.filter((e) => e.file === file));
      writeBytes(abs, r.buf, realW);
      report.env.push({ file, key: r.hit, missed: r.missed });
      if (r.missed.length) log(ctx, `port dismantling: ${file} — keys without a port number in their row: ${r.missed.join(", ")}`);
    } catch (e) {
      if (e instanceof RelocationDataError) throw e;
      throw new RelocationDataError(S, `${file}: ${e?.code || "Error"}`, { cause: e });
    }
  }

  // (d) Services — computed from the OLD values of the journal. Only the override of the registered port falls from the
  // start command (see ./port-command.js) — and only if the plan knows a default: without one start command AND field
  // stay, the old port is free in the project container's own namespace; the report names the service (`withoutDefault`).
  // The field `port` goes to the default if the dismantling changes the port of the service (command or `.env*`) AND none
  // of the old ports is left in the command (a docker `-p 3100:3000` would stay, and the port with it) — otherwise it
  // stays, and `commandStays` names the numbers.
  for (const old of j.services || []) {
    const d = serviceList.find((x) => String(x.id) === String(old.id)) || {};
    const standard = Number.isInteger(d.portStandard) ? d.portStandard : null;
    const command = Boolean(d.command) && standard !== null;
    const ports = [...new Set([old.port, d.portOld].filter(Number.isInteger))];
    const newCommand = command ? withoutPortOverride(old.startCommand, ports) : old.startCommand;
    const newRow = command && old.startRow ? withoutPortOverride(old.startRow.startCommand, ports) : null;
    const row = old.startRow
      ? (command && newRow !== old.startRow.startCommand ? { startCommand: newRow, updatedAt: Date.now() } : old.startRow)
      : null;
    const commandChanged = newCommand !== old.startCommand || Boolean(row && row !== old.startRow);
    if (standard === null) report.withoutDefault.push(old.name);
    const leftOver = (b) => overriddenPorts(b).filter((n) => ports.includes(n));
    if (command && (leftOver(newCommand).length || (row && leftOver(row.startCommand).length))) {
      throw new RelocationDataError(S, `service "${old.name}": the port override could not be removed`);
    }
    // What remains of port numbers (only name and numbers, never the command): the overrides of other ports and every old
    // port that is still there as a number. The report names it, step 14 measures again.
    const commands = [newCommand, ...(row ? [row.startCommand] : [])];
    const stay = [...new Set([...commands.flatMap(overriddenPorts), ...ports.filter((p) => commands.some((b) => portStillInCommand(b, p)))])].sort((a, b) => a - b);
    const oldPresent = ports.some((p) => commands.some((b) => portStillInCommand(b, p)));
    const port = standard ?? old.port;
    const changed = commandChanged || Boolean(d.env);
    const portNew = changed && !oldPresent ? port : old.port; // if the dismantling did not change the port, the field stays
    if ((command || (changed && oldPresent)) && stay.length) report.commandStays.push({ name: old.name, ports: stay });
    if (!store.setService(old.id, { startCommand: newCommand, port: portNew, startRow: row })) {
      throw new RelocationDataError(S, `service ${old.id} ("${old.name}") is missing`);
    }
    report.services.push({ id: old.id, name: old.name, portOld: old.port, portNew, command: commandChanged });
  }
  log(ctx, `port dismantling: ${report.env.length} .env file(s), ${report.services.length} service(s), ${report.overrides.length} override(s)`
    + (report.withoutDefault.length ? `; without a recognisable repo default (field stays): ${report.withoutDefault.join(", ")}` : "")
    + (report.commandStays.length ? `; port numbers stay in the start command: ${report.commandStays.map((b) => `${b.name} (${b.ports.join(", ")})`).join(", ")}` : ""));
  return report;
}

export async function portDismantlingBack(ctx) {
  const S = STEPS.portBack;
  checkCtx(ctx, S);
  const j = state(ctx);
  const error = [];
  const report = { services: 0, env: 0, overrides: 0 };
  for (const old of j.services || []) {
    try {
      if (store.setService(old.id, { startCommand: old.startCommand, port: old.port, startRow: old.startRow })) report.services++;
      else error.push(`service ${old.id} ("${old.name}") is missing`);
    } catch (e) { error.push(`service ${old.id}: ${e?.message || e}`); }
  }
  const entries = [...(j.dismantling || []), ...(j.override || [])];
  const projectPath = entries.length ? projectPathOf(ctx, S) : null;
  const realW = projectPath ? realRoots([projectPath], [projectPath]) : [];
  for (const r of j.dismantling || []) {
    const backup = path.join(ctx.relocationLocation, LOCATION_ENV, flat(r.file));
    const checkFile = `${backup}${ENV_CHECK}`;
    if (!lstat(backup)) continue; // never backed up (so never changed) or already back — the backup only falls afterwards
    try {
      const abs = projectFile(projectPath, r.file, S);
      const original = fs.readFileSync(backup);
      const p = readCheck(checkFile);
      if (!matches(original, p)) {
        // A backup that does not match its checksum is NEVER written over the file. If the file itself is already the
        // original there is nothing to do; otherwise everything stays, and the error names the place (never a value).
        if (!matches(readBytes(abs, realW), p)) {
          error.push(`${r.file}: the backup does not match its checksum — the file is untouched, backup and checksum stay in ${path.dirname(backup)}`);
          continue;
        }
      } else {
        writeBytes(abs, original, realW);
        if (!readBytes(abs, realW).equals(original)) throw new Error("not byte-equal after writing");
      }
      fs.rmSync(backup, { force: true });
      fs.rmSync(checkFile, { force: true });
      report.env++;
    } catch (e) { error.push(`${r.file}: ${e?.code || e?.message || e}`); }
  }
  for (const o of j.override || []) {
    try {
      const target = projectFile(projectPath, o.file, S);
      const z = lstat(o.location);
      if (!z) continue; // never put aside or already back
      if (lstat(target)) { error.push(`override ${o.file}: a file lies in place by now — the one put aside stays in ${o.location}`); continue; }
      renameInArea(o.location, target, null, realW);
      report.overrides++;
    } catch (e) { error.push(`override ${o.file}: ${e?.code || e?.message || e}`); }
  }
  if (error.length) throw new RelocationDataError(S, error.join(" · "));
  log(ctx, `port dismantling back: ${report.services} service(s), ${report.env} .env file(s), ${report.overrides} override(s)`);
  return report;
}

// ── step 11: project repo ──────────────────────────────────────────────────────────────────────────────────────────

export async function projectRepoStep(ctx) {
  const S = STEPS.repo;
  checkCtx(ctx, S);
  const projectPath = projectPathOf(ctx, S);
  let j = state(ctx);
  if (j.services == null) throw new RelocationDataError(S, "before the port dismantling (step 9) — the first commit is meant to carry the new values");
  const plan = ctx.plan.projectRepo;
  if (!plan?.arises) {
    if (j.projectRepo == null) await ctx.journal.note({ projectRepo: { path: projectPath, state: "not", reason: plan?.reason || "plan" } });
    return { created: false, reason: plan?.reason || "plan" };
  }
  const instance = ctx.inst || null;
  // The branches for a second run (up to `if (j.projectRepo == null)`): safeguard, unreachable today (see header).
  if (j.projectRepo?.state === "created") return { created: true, commit: j.projectRepo.commit, alreadyThere: true };
  if (j.projectRepo?.state === "not") return { created: false, reason: j.projectRepo.reason };
  if (j.projectRepo?.state === "running" && isProjectRepo(projectPath)) {
    // An earlier run died in the middle of creating: the repo carries the marker, so it is ours. With a commit it counts
    // as created (nobody else commits during the relocation — lock); without one it falls and is created anew.
    const head = await gitWithoutInstance(projectPath, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    const commit = head.code === 0 ? head.stdout.trim() : "";
    if (/^[0-9a-f]{40,64}$/.test(commit)) {
      await ctx.journal.note({ projectRepo: { path: projectPath, state: "created", commit } });
      return { created: true, commit, resumed: true };
    }
    fs.rmSync(path.join(projectPath, ".git"), { recursive: true, force: true });
  } else if (j.projectRepo?.state === "running" && halfCreated(projectPath, j.projectRepo)) {
    // An earlier run died between `git init` and the marker: the `.git` is provably ours (see halfCreated) — it falls,
    // and creating begins anew (otherwise createProjectRepo would take it for a code repo).
    fs.rmSync(path.join(projectPath, ".git"), { recursive: true, force: true });
  }
  if (j.projectRepo == null) {
    await ctx.journal.note({ projectRepo: { path: projectPath, state: "running", gitPrior: Boolean(lstat(path.join(projectPath, ".git"))) } });
  }
  let r;
  try { r = await createProjectRepo(projectPath, { instance }); } catch (e) {
    throw new RelocationDataError(S, e?.message || String(e), { cause: e });
  }
  if (!r.created) {
    await ctx.journal.note({ projectRepo: { path: projectPath, state: "not", reason: r.reason } });
    log(ctx, `project repo: not created (${r.reason})`);
    return { created: false, reason: r.reason };
  }
  await ctx.journal.note({ projectRepo: { path: projectPath, state: "created", commit: r.commit } });
  log(ctx, `project repo: created, first commit "${FIRST_COMMIT}" (${(r.repos || []).length} code repo(s) excluded, ${(r.unreadable || []).length} unreadable)`);
  return { created: true, commit: r.commit, repos: (r.repos || []).length, unreadable: (r.unreadable || []).length };
}

export async function projectRepoBack(ctx) {
  const S = STEPS.repoBack;
  checkCtx(ctx, S);
  const pr = state(ctx).projectRepo;
  if (!pr || pr.state === "not") return { removed: false, reason: "not-created" };
  const filePath = pr.path;
  if (!isProjectRepo(filePath)) {
    if (pr.state === "running" && halfCreated(filePath, pr)) {
      fs.rmSync(path.join(filePath, ".git"), { recursive: true, force: true });
      return { removed: !lstat(path.join(filePath, ".git")), reason: "half-created" };
    }
    return { removed: false, reason: "without-marker" };
  }
  let commit = pr.commit || "";
  if (pr.state === "running") {
    // Announced but not confirmed: the marker says it is ours; a repo without HEAD falls, and so does one with exactly
    // one commit (the own first one).
    const head = await gitWithoutInstance(filePath, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    if (head.code !== 0 || !head.stdout.trim()) {
      fs.rmSync(path.join(filePath, ".git"), { recursive: true, force: true });
      return { removed: !lstat(path.join(filePath, ".git")) };
    }
    const count = await gitWithoutInstance(filePath, ["rev-list", "--count", "HEAD"]);
    if (count.stdout.trim() !== "1") return { removed: false, reason: "head-continue" };
    commit = head.stdout.trim();
  }
  const r = await removeProjectRepo(filePath, { commit, instance: null });
  if (!r.removed) log(ctx, `project repo stays (${r.reason})`);
  return r;
}

// A HALF created project repo (see header): "running" with `gitPrior: false` (proof: no `.git` lay there before creating —
// a journal without the field proves nothing), plus a real folder `.git` (no link) without marker, without `packed-refs`
// and without a single object. Only that can be a `git init` that died before the marker; it is read without git and
// without following a link (a link below the object folder counts as content — then it stays).
function halfCreated(projectPath, pr) {
  if (pr?.gitPrior !== false) return false;
  const g = path.join(projectPath, ".git");
  const st = lstat(g);
  if (!st || st.isSymbolicLink() || !st.isDirectory() || isProjectRepo(projectPath)) return false;
  if (lstat(path.join(g, "packed-refs"))) return false;
  const hasContent = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return e?.code !== "ENOENT"; }
    return entries.some((e) => !e.isDirectory() || hasContent(path.join(dir, e.name)));
  };
  return !hasContent(path.join(g, "objects"));
}

// ── git on the repo of a project before converting (see header) ────────────────────────────────────────────────────

// The starter in B — reachable ONLY as the fallback of the ONE starter runtime/git-run.js (without an instance; guard
// server/backend/test/in-project-start-places.test.js, GIT_STARTER).
async function gitInB(cwd, args) {
  try {
    const { stdout, stderr } = await pexec("git", [...HARDENING, ...args], {
      cwd, timeout: GIT_DEADLINE_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: typeof e?.code === "number" ? e.code : null, stdout: String(e?.stdout || ""), stderr: String(e?.stderr || e?.message || e) };
  }
}

// Without an instance, i.e. in B: the worktrees BEFORE converting (see header) and the questions to the project repo that
// cbase created itself in THIS relocation (step 11 and its return path).
const gitWithoutInstance = (cwd, args) => gitRun(null, cwd, args, { fallback: () => gitInB(cwd, args) });

async function gitBeforeConvert(projectId, repo, args, step) {
  if (runInstance(projectId)) {
    throw new RelocationDataError(step, `project ${projectId} is already converted — worktrees only move BEFORE step 14 (the old location is in no project container)`);
  }
  return gitWithoutInstance(repo, args);
}

// ── inventory of a target: what the return path may remove ─────────────────────────────────────────────────────────

/** The relative paths under `root` (folders with "/"), without following links; null: the root does not exist. */
export function inventoryOf(root, cap = INVENTORY_CAP) {
  const st = lstat(root);
  if (!st) return null;
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${root} is not a folder`);
  const out = [];
  const go = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      out.push(e.isDirectory() ? `${r}/` : r);
      if (out.length > cap) throw new Error(`${root}: more than ${cap} entries — cap of the inventory`);
      if (e.isDirectory()) go(path.join(dir, e.name), r);
    }
  };
  go(root, "");
  return out;
}

/** Remove everything under `root` that was not in the `inventory` (null: the whole root). → number of removed entries. */
export function removeNew(root, inventory) {
  const st = lstat(root);
  if (!st) return 0;
  if (inventory == null) { fs.rmSync(root, { recursive: true, force: true }); return 1; }
  const old = new Set(inventory);
  let n = 0;
  const go = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory() && old.has(`${r}/`)) go(abs, r);
      else if (!old.has(e.isDirectory() ? `${r}/` : r)) { fs.rmSync(abs, { recursive: true, force: true }); n++; }
    }
  };
  go(root, "");
  return n;
}

// ── step 13: runtime folder and transcripts ────────────────────────────────────────────────────────────────────────

// What a relocation copies of a chat: only files, folders and links (as links) — a socket or FIFO in the browser profile
// would otherwise make cpSync fail.
const onlyCopyable = (src) => { const s = lstat(src); return Boolean(s) && (s.isFile() || s.isDirectory() || s.isSymbolicLink()); };

// Copy one entry of the copy list (step 13) — idempotent. Only what this relocation may copy (`fresh` or `aside`); a
// prefilled version at the target first goes to `aside` by rename (never overwritten, never deleted), and only as long as
// it does not lie there yet — in a second run (safeguard, unreachable today — see header) the own half copy already lies
// at the target. A browser profile goes without the lock files of a running instance. → whether something was copied.
// Renaming and creating the parents run INSIDE THE AREA (runtime/real-path.js) — the runtime folder of the project or the
// relocation location. A parent folder below the runtime folder that is a link to the outside throws
// (RelocationDataError) instead of pulling a file from outside into the relocation location or copying there.
function copyEntry(ctx, k, step = STEPS.runtime) {
  if (!k.fresh && !k.aside) return false; // an entry from before `aside` existed: already lay there, stays untouched
  if (!lstat(k.from)) return false;
  const realTarget = targetArea(ctx);
  if (k.aside && !lstat(k.aside) && lstat(k.to)) {
    locationUnder(ctx, LOCATION_PREFILLED);
    try { renameInArea(k.to, k.aside, realTarget, realRoots([ctx.relocationLocation])); } catch (e) {
      throw new RelocationDataError(step, `${k.to} → aside: ${e?.code || e?.message || e} — nothing moved`, { cause: e });
    }
  }
  const profile = PROFILE_FIELDS.has(k.field);
  const filter = (src) => onlyCopyable(src) && !(profile && path.dirname(src) === k.from && LOCK_FILES.has(path.basename(src)));
  try { createFolderInArea(path.dirname(k.to), realTarget); } catch (e) {
    throw new RelocationDataError(step, `${path.dirname(k.to)}: ${e?.code || e?.message || e} — nothing copied`, { cause: e });
  }
  fs.cpSync(k.from, k.to, { recursive: true, force: true, preserveTimestamps: true, verbatimSymlinks: true, filter });
  return true;
}

// The area of the targets of step 13: the runtime folder of the project, after realpath.
const targetArea = (ctx) => realRoots([locationFor({ projectId: ctx.projectId, converted: true }).root]);

// The fingerprint of a tree through lstat — per entry (the root first) relative path, kind, size, mtime, ctime and inode,
// as sha256. No link is followed, no content is read. A new, a removed, a renamed and a changed file all change it — even
// if the clock jumped back or a writer resets the mtime (no writer resets the ctime, and reading does not change it).
// Above STATUS_CAP entries, without the tree or on a read error: null (unknown — the entry stays in step 15). LIMIT: the
// ctime ONLY prevents deletion in step 15. What happens afterwards to a file changed in place whose copy lies at the
// target is not decided by this fingerprint: the readers take the current location first (attachmentPath;
// copyAttachmentsTo copies only what is missing), and the next turn (runs/runtime-location.js bringAlongChat) takes the
// flat version only with a NEWER mtime — with an equal one it discards it.
function fingerprint(root, cap = STATUS_CAP) {
  try {
    const st = lstat(root);
    if (!st) return null;
    const h = crypto.createHash("sha256");
    const kind = (s) => (s.isDirectory() ? "d" : s.isSymbolicLink() ? "l" : s.isFile() ? "f" : "x");
    const row = (rel, s) => h.update(`${rel}\0${kind(s)}\0${s.size}\0${s.mtimeMs}\0${s.ctimeMs}\0${s.ino}\n`);
    row(".", st);
    if (st.isDirectory()) {
      let count = 0;
      const stack = [[root, ""]];
      while (stack.length) {
        const [dir, rel] = stack.pop();
        for (const name of fs.readdirSync(dir).sort()) {
          if (++count > cap) return null;
          const r = rel ? `${rel}/${name}` : name;
          const s = lstat(path.join(dir, name));
          if (!s) { h.update(`${r}\0gone\n`); continue; }
          row(r, s);
          if (s.isDirectory()) stack.push([path.join(dir, name), r]);
        }
      }
    }
    return h.digest("hex");
  } catch { return null; }
}

// Copy the entries of a copy list; per copied entry the state BEFORE the copy (`fingerprint`) with its time goes into the
// journal (`copies.<kind>[].beforeCopy`) — step 15 leaves a flat entry that changed afterwards. That also covers an attachment
// that the upload route, a channel (channels/messages.js), a capture (captures.js) or a graph start
// (workflows/graph-start.js) stores flat AFTER step 13 — until `converted_at` the attachment location points there —,
// which would otherwise fall in step 15 with the whole folder. A NEW file that stays flat this way (it is missing at the
// target) is brought along by the next turn of the chat (runs/runtime-location.js bringAlongChat); until then the readers
// find it there (attachmentPath, copyAttachmentsTo). A file changed in place whose copy lies at the target is thus only
// safe from step 15, not from being brought along (limit at `fingerprint`).
async function copyList(ctx, kind, copies) {
  let n = 0;
  const fresh = [];
  for (const k of copies()[kind] || []) {
    const prior = fingerprint(k.from);
    if (!copyEntry(ctx, k)) { fresh.push(k); continue; }
    n++;
    fresh.push({ ...k, beforeCopy: { copiedAt: Date.now(), fingerprint: prior } });
  }
  if (n) await ctx.journal.note({ copies: { ...copies(), [kind]: fresh } });
  return n;
}

/** The sources of step 13 — the files of the chats and the traces of the project in the flat location, each with its
 *  target in the runtime folder; only what exists flat. ONE list for step 13 and the plan (collect.js `runtimePrefilled`).
 *  → { chat: [{ fields, field, name, from, nach }], project: [...] } */
export function runtimeSources(pid, { flatLocation = locationFor({}), projectLocation = locationFor({ projectId: pid, converted: true }) } = {}) {
  const q = (fields, field, name, from) => ({ fields, field, name, from, to: path.join(projectLocation[field], name) });
  const chat = [];
  for (const chatId of store.chatIdsInProject(pid)) for (const s of chatTraces(flatLocation, chatId)) chat.push(q({ chatId }, s.field, s.name, s.path));
  const project = [];
  const profile = `proj-${pid}`;
  if (lstat(path.join(flatLocation.browserProfiles, profile))) project.push(q({ kind: "browser" }, "browserProfiles", profile, path.join(flatLocation.browserProfiles, profile)));
  for (const svc of store.listProjectServices(pid)) {
    const from = path.join(flatLocation.serviceLogs, `${pid}_${svc.id}.log`);
    if (lstat(from)) project.push(q({ kind: "log" }, "serviceLogs", `main_${svc.id}.log`, from));
  }
  return { chat, project };
}

// The table of the worktree moves (purely from plan and store): run folders (`tops`), every worktree in them, the affected
// rows raw. Paths that lie under a run folder by their wording OR by their real place count.
function worktreeTable(pid, plan, step) {
  const oldRoot = worktreeRoot(locationFor({}));
  const newRoot = worktreeRoot(locationFor({ projectId: pid, converted: true }));
  const oldReal = real(oldRoot);
  const tops = new Map();
  const list = [];
  for (const w of plan.worktrees?.move || []) {
    if (!w?.path || !w?.repo) throw new RelocationDataError(step, "worktree without path or repo in the plan");
    const rel = relUnder(real(w.path), oldReal) ?? relUnder(path.resolve(w.path), path.resolve(oldRoot));
    if (!rel) throw new RelocationDataError(step, `worktree ${w.path} does not lie under the worktree root ${oldRoot}`);
    const parts = rel.split(path.sep);
    if (parts.some((t) => !FOLDER_NAME.test(t))) throw new RelocationDataError(step, `worktree ${w.path}: invalid path part`);
    const seg = parts[0];
    if (!tops.has(seg)) tops.set(seg, { seg, old: path.join(oldRoot, seg), oldReal: path.join(oldReal, seg), fresh: path.join(newRoot, seg), kind: "folder", repo: null });
    if (parts.length === 1) Object.assign(tops.get(seg), { kind: "worktree", repo: w.repo });
    list.push({ seg, repo: w.repo, old: path.join(oldRoot, rel), fresh: path.join(newRoot, rel), depth: parts.length });
  }
  const topList = [...tops.values()].sort((a, b) => (a.seg < b.seg ? -1 : 1));
  const projection = (p) => {
    if (typeof p !== "string" || !p) return null;
    for (const t of topList) {
      const r = relUnder(path.resolve(p), t.old) ?? relUnder(path.resolve(p), t.oldReal);
      if (r !== null) return { seg: t.seg, path: r ? path.join(t.fresh, r) : t.fresh };
    }
    return null;
  };
  const graph = [];
  for (const z of store.graphWorktreeRows()) {
    let info = null;
    try { info = z.info ? JSON.parse(z.info) : null; } catch { info = null; }
    const a = projection(z.path) || projection(info?.dir);
    if (a) graph.push({ id: z.id, seg: a.seg, path: z.path, info: z.info });
  }
  const subagents = [];
  for (const s of store.subagentsLocations()) {
    const a = projection(s.worktreeDir) || projection(s.cwd);
    if (!a) continue;
    const old = store.readSubagentLocation(s.chatId, s.agentId);
    if (old) subagents.push({ chatId: s.chatId, agentId: s.agentId, seg: a.seg, ...old });
  }
  return {
    oldRoot, newRoot,
    tops: topList,
    list: list.sort((a, b) => a.depth - b.depth || (a.old < b.old ? -1 : 1)),
    graph, subagents,
  };
}

// The new values of the rows — deterministic from the OLD ones (journal), so that a second run writes the same.
function withNewPaths(pid, table) {
  const tops = table.tops;
  const projection = (p) => {
    if (typeof p !== "string" || !p) return p;
    for (const t of tops) {
      const r = relUnder(path.resolve(p), t.old) ?? relUnder(path.resolve(p), t.oldReal);
      if (r !== null) return r ? path.join(t.fresh, r) : t.fresh;
    }
    return p;
  };
  const graph = table.graph.map((z) => {
    let info = null;
    try { info = z.info ? JSON.parse(z.info) : null; } catch { info = null; }
    let infoNew = z.info;
    if (info && typeof info === "object") {
      const n = { ...info, dir: projection(info.dir) };
      if (Array.isArray(info.repos)) n.repos = info.repos.map((r) => (r && typeof r === "object" ? { ...r, target: projection(r.target) } : r));
      if (Array.isArray(info.own)) n.own = info.own.map((e) => (e && typeof e === "object" ? { ...e, path: projection(e.path) } : e));
      if (!n.projectId) n.projectId = pid; // old graph worktrees without an identifier
      infoNew = JSON.stringify(n);
    }
    return { id: z.id, seg: z.seg, path: projection(z.path), info: infoNew };
  });
  const subagents = table.subagents.map((s) => ({
    chatId: s.chatId, agentId: s.agentId, seg: s.seg,
    fields: {
      // A key the image did not carry stays absent (`undefined` removes the key, store/subagents.js) — otherwise `"cwd":null` would stand there afterwards.
      cwd: s.hasCwd === false ? undefined : projection(s.cwd),
      worktree: s.hasWorktree === false ? undefined
        : s.worktree && typeof s.worktree === "object" ? { ...s.worktree, dir: projection(s.worktree.dir) } : s.worktree,
      instance: `${pid}/main`, // its next git runs in the project container
    },
  }));
  return { graph, subagents };
}

// Move a run folder (see header) and bring every worktree in it along. Idempotent: if it already lies at the target, only
// the repair remains.
async function moveTop(pid, top, worktrees, { from, to, pathIn }, step) {
  const q = lstat(from);
  const z = lstat(to);
  if (q && z) throw new RelocationDataError(step, `${from} AND ${to} exist — nothing moved`);
  if (!q && !z) throw new RelocationDataError(step, `${from} is missing (and does not lie in ${to} either)`);
  if (q) {
    if (q.isSymbolicLink() || !q.isDirectory()) throw new RelocationDataError(step, `${from} is not a folder`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (top.kind === "worktree") {
      const r = await gitBeforeConvert(pid, top.repo, ["worktree", "move", from, to], step);
      if (r.code !== 0) throw new RelocationDataError(step, `git worktree move ${from} → ${to}: ${String(r.stderr || "").trim()}`);
    } else {
      fs.renameSync(from, to);
    }
  }
  for (const w of worktrees) {
    const r = await gitBeforeConvert(pid, w.repo, ["worktree", "repair", pathIn(w)], step);
    if (r.code !== 0) throw new RelocationDataError(step, `git worktree repair ${pathIn(w)}: ${String(r.stderr || "").trim()}`);
  }
}

function writeRows(fresh, onlySegs = null) {
  for (const z of fresh.graph) if (!onlySegs || onlySegs.has(z.seg)) store.changeGraphStart(z.id, { worktreePath: z.path, worktreeInfo: z.info });
  for (const s of fresh.subagents) if (!onlySegs || onlySegs.has(s.seg)) store.setSubagentFields(s.chatId, s.agentId, s.fields);
}

export async function relocateRuntime(ctx) {
  const S = STEPS.runtime;
  const pid = checkCtx(ctx, S);
  const flatLocation = locationFor({});
  const projectLocation = createLocation(locationFor({ projectId: pid, converted: true }));
  fs.mkdirSync(worktreeRoot(projectLocation), { recursive: true });
  const report = { chat: 0, project: 0, aside: 0, worktrees: 0, graph: 0, subagents: 0, local: null, sessions: [] };
  const copies = () => state(ctx).copies || {};
  // An entry of the copy list: `fresh` = the target was free; otherwise an old copy lay there (see header) — it goes to `aside`.
  const entry = (fields, field, name, from) => {
    const to = path.join(projectLocation[field], name);
    const occupied = Boolean(lstat(to));
    return { ...fields, field, from, to, fresh: !occupied, aside: occupied ? path.join(ctx.relocationLocation, LOCATION_PREFILLED, field, name) : null };
  };

  // (a) The files of the chats — COPIED (removal only happens in step 15) — and (a2) the traces of the PROJECT: the
  // browser profile of the "Browser" tab and the service logs (flat `<id>_<svc>.log`, in the runtime folder
  // `main_<svc>.log` — runs/runtime-location.js serviceLogFile). Only what exists flat (runtimeSources).
  const sources = !copies().chat || !copies().project ? runtimeSources(pid, { flatLocation, projectLocation }) : null;
  if (!copies().chat) await ctx.journal.note({ copies: { ...copies(), chat: sources.chat.map((x) => entry(x.fields, x.field, x.name, x.from)) } });
  report.chat = await copyList(ctx, "chat", copies);
  if (!copies().project) await ctx.journal.note({ copies: { ...copies(), project: sources.project.map((x) => entry(x.fields, x.field, x.name, x.from)) } });
  report.project = await copyList(ctx, "project", copies);
  report.aside = [...copies().chat, ...copies().project].filter((k) => k.aside && lstat(k.aside)).length;

  // (b) MOVE worktrees and rewrite every stored reference (journal beforehand: repo, old and new path, the old columns
  // raw).
  if (state(ctx).worktrees == null) await ctx.journal.note({ worktrees: worktreeTable(pid, ctx.plan, S) });
  const table = state(ctx).worktrees;
  for (const top of table.tops) {
    const inside = table.list.filter((w) => w.seg === top.seg);
    await moveTop(pid, top, inside, { from: top.old, to: top.fresh, pathIn: (w) => w.fresh }, S);
    report.worktrees += inside.length;
  }
  const fresh = withNewPaths(pid, table);
  writeRows(fresh);
  report.graph = fresh.graph.length;
  report.subagents = fresh.subagents.length;

  // (c) ~/.local by the assignment of the plan.
  const localRoot = cliHomeFolder(pid).local;
  if (!copies().local) await ctx.journal.note({ copies: { ...copies(), local: { root: localRoot, inventory: inventoryOf(localRoot) } } });
  try {
    const r = copyLocal(pid, ctx.plan.local?.assignment || {});
    report.local = { copied: r.copied.length, existing: r.existing.length, withoutAssignment: r.withoutAssignment, otherProject: r.otherProject };
  } catch (e) { throw new RelocationDataError(S, `~/.local: ${e?.message || e}`, { cause: e }); }

  // (d) Last the sessions — the target slug from the NEW working folder (resolveCwd with the instance of the relocation:
  // the project folder or the moved worktree of a graph child chat; the subagents carry their already rewritten cwd).
  if (!copies().sessions) {
    const claude = path.join(projectClaudeDir(pid), "projects");
    const codex = path.join(projectCodexDir(pid), "sessions");
    await ctx.journal.note({ copies: { ...copies(), sessions: { claude: { root: claude, inventory: inventoryOf(claude) }, codex: { root: codex, inventory: inventoryOf(codex) } } } });
  }
  const inst = ctx.inst || { projectId: pid, instance: "main", identifier: `${pid}/main` };
  const list = pullSessionsOfTheProject(pid, { cwdFor: (chat) => resolveCwd(chat, { instance: inst }) });
  await ctx.journal.note({ copies: { ...copies(), sessions: { ...copies().sessions, list: list.map(({ chatId, agentId, provider, status, target }) => ({ chatId, agentId, provider, status, target })) } } });
  report.sessions = list.map(({ chatId, agentId, provider, status }) => ({ chatId, agentId, provider, status }));
  const missing = list.filter((z) => z.status === "error");
  if (missing.length) throw new RelocationDataError(S, `sessions: ${missing.map((z) => `${z.chatId}${z.agentId ? `/${z.agentId}` : ""}: ${z.error}`).join(" · ")}`);
  log(ctx, `runtime folder: ${report.chat} chat file(s) and ${report.project} project file(s) copied${report.aside ? ` (${report.aside} prefilled version(s) aside to ${path.join(ctx.relocationLocation, LOCATION_PREFILLED)})` : ""}, ${report.worktrees} worktree(s) moved, ${report.graph} graph start(s) and ${report.subagents} subagent(s) rewritten, ${list.length} session(s)`);
  return report;
}

export async function runtimeBack(ctx) {
  const S = STEPS.runtimeBack;
  const pid = checkCtx(ctx, S);
  const j = state(ctx);
  const projectLocation = locationFor({ projectId: pid, converted: true });
  const report = { worktrees: 0, back: [], runtimeStays: null, error: [], removed: 0 };

  // (1) FIRST the worktrees back, in reverse order, and the references to the old values — only for those that returned.
  const table = j.worktrees;
  if (table) {
    const back = new Set();
    for (const top of [...table.tops].reverse()) {
      const inside = table.list.filter((w) => w.seg === top.seg);
      try {
        if (!lstat(top.fresh) && lstat(top.old)) {
          // never moved (or already back): only repair
          for (const w of inside) {
            const r = await gitBeforeConvert(pid, w.repo, ["worktree", "repair", w.old], S);
            if (r.code !== 0) throw new RelocationDataError(S, `git worktree repair ${w.old}: ${String(r.stderr || "").trim()}`);
          }
        } else {
          await moveTop(pid, top, inside, { from: top.fresh, to: top.old, pathIn: (w) => w.old }, S);
        }
        back.add(top.seg);
        report.worktrees += inside.length;
      } catch (e) {
        report.error.push(`${top.fresh}: ${e?.message || e}`);
      }
    }
    for (const z of table.graph) if (back.has(z.seg)) store.changeGraphStart(z.id, { worktreePath: z.path, worktreeInfo: z.info });
    for (const s of table.subagents) {
      if (!back.has(s.seg)) continue;
      store.setSubagentFields(s.chatId, s.agentId, {
        cwd: s.hasCwd === false ? undefined : s.cwd,
        worktree: s.hasWorktree === false ? undefined : s.worktree,
        instance: s.hasInstance ? s.instance : undefined,
      });
    }
    report.back = [...back].sort();
  }
  if (report.error.length) {
    // The runtime folder stays: worktrees that did not come back lie there — including uncommitted changes.
    report.runtimeStays = projectLocation.root;
    log(ctx, `return path: ${report.error.length} worktree(s) not back — the runtime folder ${projectLocation.root} stays, nothing is removed there`);
    return report;
  }

  // (2) The copies from 13 — exactly what this relocation added; a version put aside comes back to its place (only if it
  // LIES aside — otherwise what lies at the target is still itself and stays).
  const k = j.copies || {};
  for (const c of [...(k.chat || []), ...(k.project || [])]) {
    if (c.fresh) {
      if (!lstat(c.to)) continue;
      const w = removeTrace(c.to, projectLocation);
      if (w) report.error.push(w); else report.removed++;
      continue;
    }
    if (!c.aside || !lstat(c.aside)) continue;
    if (lstat(c.to)) {
      const w = removeTrace(c.to, projectLocation);
      if (w) { report.error.push(w); continue; }
      report.removed++;
    }
    // Back through the opened parent folders, inside the area — never through a link below the runtime folder.
    try { renameInArea(c.aside, c.to, realRoots([ctx.relocationLocation]), targetArea(ctx)); }
    catch (e) { report.error.push(`${c.aside} → ${c.to}: ${e?.code || e?.message || e}`); }
  }
  try {
    if (k.local) report.removed += removeNew(k.local.root, k.local.inventory);
    for (const kind of ["claude", "codex"]) {
      const s = k.sessions?.[kind];
      if (s) report.removed += removeNew(s.root, s.inventory);
    }
  } catch (e) { report.error.push(String(e?.message || e)); }
  if (report.error.length) throw new RelocationDataError(S, report.error.join(" · "));
  log(ctx, `return path runtime folder: ${report.worktrees} worktree(s) back, ${report.removed} copy/copies removed`);
  return report;
}

// ── step 15, the data part ─────────────────────────────────────────────────────────────────────────────────────────

const ROLLOUT = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/;
function sessionIdFrom(provider, target) {
  const name = path.basename(String(target || ""));
  if (provider === "claude") return name.endsWith(".jsonl") ? name.slice(0, -6) : null;
  return name.match(ROLLOUT)?.[1] || null;
}

export async function cleanUpAfterStart(ctx) {
  const S = STEPS.cleanUp;
  const pid = checkCtx(ctx, S);
  const j = state(ctx);
  const report = { backups: 0, overrides: 0, chat: 0, project: 0, sessions: 0, stays: [], aside: [], error: [] };
  for (const [name, field] of [[LOCATION_ENV, "backups"], [LOCATION_OVERRIDE, "overrides"]]) {
    const d = path.join(ctx.relocationLocation, name);
    const st = lstat(d);
    if (!st) continue;
    if (st.isSymbolicLink() || !st.isDirectory()) { report.error.push(`${d} is not a folder`); continue; }
    report[field] = fs.readdirSync(d).filter((n) => !n.endsWith(ENV_CHECK) && !n.endsWith(".tmp")).length;
    fs.rmSync(d, { recursive: true, force: true });
  }
  // The old chat and project files in the flat location — ONLY what step 13 itself copied (`fresh` or `aside`), whose copy
  // lies at the new location AND which has not changed since the copy. Whatever is not proven that way stays and is in
  // `stays` (path and reason, never content). A browser profile whose lock is still alive stays too: its Chromium keeps
  // writing there.
  const flatLocation = locationFor({});
  const k = j.copies || {};
  for (const [list, field] of [[k.chat || [], "chat"], [k.project || [], "project"]]) {
    for (const c of list) {
      if (!lstat(c.from)) continue;
      const who = c.chatId ? { chatId: c.chatId } : { kind: c.kind };
      if (!c.fresh && !c.aside) { report.stays.push({ ...who, path: c.from, reason: "target-prefilled" }); continue; }
      if (!lstat(c.to) || (c.aside && !lstat(c.aside))) { report.stays.push({ ...who, path: c.from, reason: "not-copied" }); continue; }
      if (PROFILE_FIELDS.has(c.field) && await profileLockAlive(c.from)) { report.stays.push({ ...who, path: c.from, reason: "in-use" }); continue; }
      // An entry that changed since the copy — a Chromium kept writing flat after step 13 (its lock is dead by now), an
      // attachment was added flat (the upload route writes to the flat attachment location until `converted_at`, likewise
      // channel, capture and graph start) — the copy at the target is older; it stays. Without a state (an older journal,
      // above the cap, unreadable) that is unknown, and it stays too. "Stays" means: this step does not delete it — what
      // bringing along does with it later is the limit noted at `fingerprint`.
      const prior = typeof c.beforeCopy?.fingerprint === "string" ? c.beforeCopy.fingerprint : null;
      const now = prior === null ? null : fingerprint(c.from);
      if (prior === null || now === null || now !== prior) {
        report.stays.push({ ...who, path: c.from, reason: prior !== null && now !== null ? "since-copy-changed" : "status-unknown" });
        continue;
      }
      const w = removeTrace(c.from, flatLocation);
      if (w) report.error.push(w); else report[field]++;
    }
  }
  report.aside = [...(k.chat || []), ...(k.project || [])].filter((c) => c.aside && lstat(c.aside)).map((c) => c.aside);
  // The old session copies in B — only where the new one lies at the target.
  for (const z of j.copies?.sessions?.list || []) {
    if (!(z.status === "copied" || z.status === "present") || !z.target || !lstat(z.target)) continue;
    const sid = sessionIdFrom(z.provider, z.target);
    if (!sid) continue;
    const old = z.provider === "claude"
      ? claudeCopies(sid, [bClaudeDir()]).filter((x) => x.file !== z.target).flatMap((x) => [x.file, ...(x.folder ? [x.folder] : [])])
      : codexCopies(sid, [bCodexDir()]).filter((x) => x.file !== z.target).map((x) => x.file);
    for (const p of old) {
      try { fs.rmSync(p, { recursive: true, force: true }); report.sessions++; } catch (e) { report.error.push(`${p}: ${e?.code || e?.message || e}`); }
    }
  }
  log(ctx, `clean-up (data) for ${pid}: ${report.backups} .env backup(s), ${report.overrides} override(s), ${report.chat} old chat file(s), ${report.project} old project file(s), ${report.sessions} old session copy/copies`
    + (report.stays.length ? `; stay flat: ${report.stays.map((b) => `${b.path} (${b.reason})`).join(", ")}` : "")
    + (report.aside.length ? `; prefilled versions lie aside: ${report.aside.join(", ")}` : "")
    + (report.error.length ? ` — ${report.error.length} error(s)` : ""));
  return report;
}
