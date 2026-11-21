// The processes in B that work in the project folder (relocation steps 1 and 4). A leaf: node:* and runtime/real-path.js; no
// docker, no store, no writing.
//
// WHY: a native service ran in B, a second start through the route was admitted (the start guard checks the REGISTERED port, the
// service listened on another), the duplicate died of EADDRINUSE and overwrote pid/pgid of the run. The real process was then
// invisible to cbase: the relocation ended only the run, moved, and the process kept running in B — at the old port, with its
// working folder in the now converted project. The same case without a cbase service: a dev server from a terminal of B, one that
// falls back to another port. So the relocation no longer asks only its bookkeeping (RUNS) but /proc: WHO works here?
//
//   processesInProject({ projectPath, additional, anchor, exempt, root, itself })  → [{ pid, start, program, pgid, sid,
//       descendant? }] | null
//       ONE look at `root` (default /proc; test seam setProcessSeam). Reported is every process that
//       (a) runs in the SAME mount namespace as B (`<root>/<pid>/ns/mnt` == `<root>/self/ns/mnt`). In B the processes of the inner
//           containers and the project containers are in /proc too — own namespaces, and the project folder is mounted there under
//           the SAME path: a comparison only through the path of the cwd would hit them;
//       (b) is not B itself (`itself`, default process.pid) and no ancestor of B (chain via ppid, cap 64);
//       (c) works in the project folder OR in one of the `additional` places (the worktrees that step 13 moves — plan.js
//           movingWorktrees): its working folder (`readlink <root>/<pid>/cwd`), its program (`readlink exe`), the path column of
//           `maps` or an open descriptor (`readlink fd/*`) — each ONLY absolute paths (a `socket:[…]`, `pipe:[…]`, `[heap]` does not
//           count), never command line or environment. Every path after realPath inside the place — realpath WITH separator
//           (runtime/real-path.js inArea: `/ws/p-2` is not in `/ws/p`); the project folder itself via `realRoot(projectPath,
//           anchor)` (default `anchor` = [the project folder] — it is the mount point, so its realpath counts; with a higher anchor
//           it does not count if a link stands between anchor and it), every further place via `realRoot(place, [place])`. A place
//           whose location cannot be determined makes the result UNKNOWN;
//       (d) and whose process group is NOT in `exempt` — the groups of the native runs that the relocation ends itself
//           (services.js nativeRuns: only groups whose leader by start time is still the entry's, or whose leader has ended while a
//           member lives and the boot marker matches). A process in its OWN group whose ancestor chain (ppid, cap 64) meets a process
//           of an exempt group carries `descendant: true` — reported, but as a descendant of a service the relocation ends (the plan
//           only names it, the first look in step 4 does not count it, the second after ending exempts nobody).
//       Per process ONLY pid, start time (`proc:<field 22>` — the same form as services.js processStart), program name from `comm`
//       (at most 16 characters, no control characters), group and session. NEVER command line or environment: they can carry values.
//       What cannot be read per process (vanished; EACCES — a process of another user, B runs as agent; a non-"dumpable" one) is
//       skipped, never thrown. If `root` itself, the own namespace or the project folder cannot be determined, the result is
//       `null` = UNKNOWN — never "none" (empty is not unknown): the plan then holds with `data-missing`, step 4 rolls back.
//   remainingProcesses(opts, { quietMs, wait })  → same shape | null: two looks `quietMs` apart (default QUIET_MS; `wait(ms)` is the
//       test seam between) — reported is only who is in BOTH with the same pid AND start time. B itself starts short processes in the
//       project folder (a `git status` of the UI, git.js); they are gone after the gap. Excluded by DURATION, never by program name.
//       Without a hit in the first look there is no second and no waiting.
//   setProcessSeam({ root, quietMs })  the test seam (a fake /proc from server/backend/test/fake-proc.mjs; macOS has none). NO
//       environment variable: a variable would silently steer the check in operation to an empty directory. Without an argument back
//       to the default.
//
// What this check does NOT see (residual risk): a process that uses the project folder only through paths in arguments or
// environment without holding a file in it right now (it deliberately never reads those); a process of another user in B (EACCES on
// `cwd`, `exe`, `fd`, `maps`); a process with more than FD_CAP descriptors or more than MAPS_CAP bytes of `maps` (read up to the
// cap); a descendant whose ancestor chain is deeper than 64 or runs via an already ended parent (ppid 1 — it then counts strictly,
// never as a descendant).
// Guards: server/backend/test/relocation-processes.test.js (fake /proc), relocation-procedure.test.js "(18)" (step 4, real child).
import fs from "node:fs";
import path from "node:path";
import { realRoot, realPath, inArea } from "../../runtime/real-path.js";

export const PROC = "/proc";
/** Gap between the two looks in remainingProcesses — estimated, not measured (a `git status` of the UI usually ends far below;
 *  a longer one holds and names itself — plan again). */
export const QUIET_MS = 2_000;
const ANCESTORS_CAP = 64;
/** How many descriptors per process are read (`fd/*`) — estimated, not measured. */
export const FD_CAP = 4096;
/** How many bytes of `maps` per process are read — estimated, not measured. */
export const MAPS_CAP = 4 * 1024 * 1024;

let seam = { root: null, quietMs: null };
/** Test seam (see header). `root` replaces /proc, `quietMs` the gap between the two looks; without an argument the default. */
export function setProcessSeam({ root = null, quietMs = null } = {}) {
  seam = { root: root ? String(root) : null, quietMs: Number.isInteger(quietMs) && quietMs >= 0 ? quietMs : null };
}

/** The root that currently applies (the seam's, else /proc) — for readers that need the same seam (projectbox/layout/job.js:
 *  workspace terminals and workspace chats in B). */
export const processSeamRoot = () => seam.root || PROC;

const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
function readCapped(p, cap) {
  let fd = null;
  try {
    fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(cap);
    let n = 0;
    for (let r = 1; r > 0 && n < cap; n += r) r = fs.readSync(fd, buf, n, cap - n, null);
    return buf.subarray(0, n).toString("utf8");
  } catch { return null; } finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } } }
}
const reference = (p) => { try { return fs.readlinkSync(p); } catch { return null; } };

/** The fields of `/proc/<pid>/stat` that count here — counted after the LAST `)` (the name in field 2 can carry parentheses and
 *  spaces). → { ppid, pgid, sid, start } or null. */
export function statFields(text) {
  const t = String(text ?? "");
  const i = t.lastIndexOf(")");
  if (i < 0) return null;
  const f = t.slice(i + 2).trim().split(/\s+/); // f[0] = field 3 (state), f[1] = ppid, f[2] = pgrp, f[3] = session, f[19] = starttime
  const count = (x) => (/^-?\d+$/.test(x || "") ? Number(x) : null);
  const [ppid, pgid, sid] = [count(f[1]), count(f[2]), count(f[3])];
  if (ppid === null || pgid === null || sid === null || !/^\d+$/.test(f[19] || "")) return null;
  return { ppid, pgid, sid, start: `proc:${f[19]}` };
}

const programFrom = (text) => String(text ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 16);

// The path column of a `maps` line (`addr perms offset dev inode   path`) — only an absolute path, without " (deleted)".
function mapsPaths(text) {
  const out = new Set();
  for (const z of String(text || "").split("\n")) {
    const m = z.match(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\/.*)$/);
    if (m) out.add(m[1].replace(/ \(deleted\)$/, ""));
  }
  return out;
}

// Does the process work in one of the places (header, (c))? cwd, exe, maps, fd/* — in this order, stop at the first hit; only
// absolute paths, never cmdline or environ.
function workingIn(location, inLocation) {
  const hits = (p) => Boolean(p) && path.isAbsolute(p) && inLocation(p);
  for (const n of ["cwd", "exe"]) if (hits(reference(path.join(location, n)))) return true;
  for (const p of mapsPaths(readCapped(path.join(location, "maps"), MAPS_CAP))) if (hits(p)) return true;
  let fds = [];
  try { fds = fs.readdirSync(path.join(location, "fd")).slice(0, FD_CAP); } catch { /* not readable */ }
  for (const f of fds) if (hits(reference(path.join(location, "fd", f)))) return true;
  return false;
}

/** The processes in B that work in the project folder or one of the `additional` places (see header) — `null` = unknown. */
export function processesInProject({ projectPath, additional = [], anchor = [], exempt = [], root = seam.root || PROC, itself = process.pid } = {}) {
  if (!projectPath) throw new TypeError("processesInProject: projectPath missing");
  const project = realRoot(projectPath, anchor?.length ? anchor : [projectPath]);
  if (!project) return null;
  const locations = [project];
  for (const w of additional || []) {
    const e = w ? realRoot(w, [w]) : null;
    if (!e) return null; // a place whose location is unknown: unknown, never "none"
    locations.push(e);
  }
  const ownSpace = reference(path.join(root, "self", "ns", "mnt"));
  if (!ownSpace) return null;
  let names;
  try { names = fs.readdirSync(root); } catch { return null; }

  const ancestors = new Set([itself]);
  for (let p = itself, n = 0; n < ANCESTORS_CAP; n++) {
    const st = statFields(read(path.join(root, String(p), "stat")));
    if (!st || st.ppid <= 0 || ancestors.has(st.ppid)) break;
    ancestors.add(st.ppid);
    p = st.ppid;
  }
  const result = new Set([...(exempt || [])].map(Number).filter((x) => Number.isInteger(x) && x > 1));
  // Does `st` descend (via the ppid chain) from a process of an exempt group?
  const descendant = (st) => {
    if (!result.size) return false;
    const seen = new Set();
    for (let p = st.ppid, n = 0; p > 1 && n < ANCESTORS_CAP && !seen.has(p); n++) {
      seen.add(p);
      const a = statFields(read(path.join(root, String(p), "stat")));
      if (!a) return false;
      if (result.has(a.pgid)) return true;
      p = a.ppid;
    }
    return false;
  };
  const inLocation = (p) => {
    let real;
    try { real = realPath(p); } catch { real = path.resolve(p); } // not resolvable: by its wording (stricter, never looser)
    return inArea(real, locations);
  };

  const out = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (ancestors.has(pid)) continue;
    const location = path.join(root, name);
    if (reference(path.join(location, "ns", "mnt")) !== ownSpace) continue; // (a) — also: not readable
    if (!workingIn(location, inLocation)) continue; // (c)
    const st = statFields(read(path.join(location, "stat")));
    if (!st || result.has(st.pgid)) continue; // vanished · (d)
    const comm = read(path.join(location, "comm"));
    if (comm === null) continue;
    out.push({ pid, start: st.start, program: programFrom(comm), pgid: st.pgid, sid: st.sid, ...(descendant(st) ? { descendant: true } : {}) });
  }
  return out.sort((a, b) => a.pid - b.pid);
}

/** Two looks `quietMs` apart: only who is in both with the same pid AND start time (see header). */
export async function remainingProcesses(opts = {}, { quietMs = seam.quietMs ?? QUIET_MS, wait = (ms) => new Promise((r) => { setTimeout(r, ms); }) } = {}) {
  const first = processesInProject(opts);
  if (first === null || first.length === 0) return first;
  await wait(quietMs);
  const then = processesInProject(opts);
  if (then === null) return null;
  const prior = new Set(first.map((p) => `${p.pid}:${p.start}`));
  return then.filter((p) => prior.has(`${p.pid}:${p.start}`));
}

/** One row per process for messages: pid, program, start time — never more (see header). */
export const processRow = (p) => `pid ${p.pid} (${p.program || "?"}, Start ${p.start})`;
