// The container program of the /proc search. `processesInProject` (projectbox/relocation/processes.js) reads the /proc of B — it does
// not run in the project container. For the background server of an agent in the project container and the terminal detection (does a
// command run in the foreground of a session?) there is therefore this program, of the kind `program.js`: ONE pure core
// `procCore(fs, path, mode, o)`, given as text in `node -e <PROC_SEARCH> -- <mode>`, the input as JSON on stdin, the answer ONE JSON
// row. Run via `commandRun(inst, "/", node, ["-e", PROC_SEARCH, "--", mode], { stdin, withoutDeadline: true, signal })`
// (`searchInProject` below).
//
// MODES
//   processes   { paths: [abs], exempt: [pgid], roots?: [abs], root? } → { processes: [{ pid, pgid, sid, name, chain }], truncated? }
//               every process in the SAME mount namespace as the program (the processes of the inner containers run in their own —
//               their cwd is a path of their file system and would otherwise hit by chance) that is not the program itself or one of
//               its ancestors, whose group is not in `exempt` (terminals and services — they have their own ways), and whose cwd, exe
//               or an open descriptor lies under one of the `paths` (whole path parts: `/a/b` is no ancestor of `/a/bc`). A search path
//               never follows its LAST part (a moved link moves itself, its target not): with `roots` it must lie lexically under one
//               of them (otherwise it drops out) and counts as the realpath of the root plus the rest by wording (no link in the
//               project is evaluated); without `roots` realpath of the parent folder plus the last part. `chain`: the ancestors (ppid,
//               cap 64). Never command line or environment.
//   foreground  { pids: [pid], root? } → { sessions: [{ pid, pgid, tpgid, foreground, name? }] }
//               per session pid (the shell of a terminal in the container, its group = its pid) the foreground group of the terminal
//               (`tpgid`, field 8 of stat) — `foreground` true if it is NOT the shell's (a command runs), `name` then the `comm` of its
//               leader. A vanished pid is missing in the answer.
//   end         { pids: [pid], signal, paths, exempt, roots?, root? } → { ended: [pid] }   (a background server of an agent, no
//               terminal, no service) — only to pids that the search `processes` STILL finds under the paths NOW; `signal` SIGTERM or
//               SIGKILL. With the test seam never a real signal (see core).
// Cap 2,000 entries (`truncated` with the number — a truncated result counts as "works" for the caller), names to 80 characters.
// `root` replaces /proc — ONLY via the test seam `setProcSearchSeam` (never the real /proc of a test machine); an environment variable
// would silently steer the check in operation to an empty directory.
//
// `procCore` also runs IN B (`procInB`, `procCore` directly): for the workspace terminals (PTYs in B) the job code reads the /proc of B
// through the same computation — with the root of the seam of projectbox/relocation/processes.js (`processSeamRoot`).

import path from "node:path";
import { commandRun } from "../../runtime/git-run.js";

export const PROC_CAP = 2_000;
export const NAME_MAX = 80;
// Where the VS Code server (Dev Containers, "Attach to Running Container") lies in the project container: in the home of the user the
// window connects with (agent or root; Dockerfile: HOME=/home/agent), or in the volume `/vscode`. Every process whose program, working
// folder or open file lies below belongs to a window: server, extension host, ptyHost, the helper scripts of Dev Containers.
export const EDITOR_LOCATIONS = Object.freeze([
  "/home/agent/.vscode-server", "/home/agent/.vscode-server-insiders", "/home/agent/.vscode-remote-containers",
  "/root/.vscode-server", "/root/.vscode-server-insiders", "/root/.vscode-remote-containers", "/vscode",
]);

/* eslint-disable no-control-regex */
export function procCore(fs, path, mode, o) {
  const root = typeof o.root === "string" && o.root ? o.root : "/proc";
  const CAP = 2000;
  const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
  const reference = (p) => { try { return fs.readlinkSync(p); } catch { return null; } };
  const name = (pid) => String(read(path.join(root, String(pid), "comm")) || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
  // stat: after the LAST ")" — field 3 state, 4 ppid, 5 pgrp, 6 session, 7 tty_nr, 8 tpgid.
  const stat = (pid) => {
    const t = read(path.join(root, String(pid), "stat"));
    if (t === null) return null;
    const i = t.lastIndexOf(")");
    if (i < 0) return null;
    const f = t.slice(i + 2).trim().split(/\s+/);
    const z = (x) => (/^-?\d+$/.test(x || "") ? Number(x) : null);
    const s = { ppid: z(f[1]), pgid: z(f[2]), sid: z(f[3]), tpgid: z(f[5]) };
    return s.ppid === null || s.pgid === null || s.sid === null ? null : s;
  };
  if (mode === "foreground") {
    const sessions = [];
    for (const raw of Array.isArray(o.pids) ? o.pids.slice(0, CAP) : []) {
      const pid = Number(raw);
      if (!Number.isInteger(pid) || pid <= 1) continue;
      const s = stat(pid);
      if (!s) continue;
      const foreground = s.tpgid !== null && s.tpgid > 0 && s.tpgid !== s.pgid;
      sessions.push({ pid, pgid: s.pgid, tpgid: s.tpgid, foreground, ...(foreground ? { name: name(s.tpgid) } : {}) });
    }
    return { sessions };
  }
  if (mode === "end") {
    // The same search as `processes`, restricted to the given pids — only whoever still hits NOW gets the signal (a pid that another
    // process has taken meanwhile does not lie under the paths). With the test seam (`o.root`) a real signal never goes out: it is
    // written to `<root>/signals.jsonl`, and the fake process ends (its folder falls), unless `<root>/<pid>/ignored` names the signal.
    const sig = o.signal === "SIGKILL" ? "SIGKILL" : "SIGTERM";
    const seam = typeof o.root === "string" && o.root;
    const hits = new Set(procCore(fs, path, "processes", { paths: o.paths, exempt: o.exempt, roots: o.roots, ...(seam ? { root: o.root } : {}) }).processes.map((p) => p.pid));
    const ended = [];
    for (const raw of Array.isArray(o.pids) ? o.pids.slice(0, CAP) : []) {
      const pid = Number(raw);
      if (!Number.isInteger(pid) || pid <= 1 || !hits.has(pid)) continue;
      if (seam) {
        fs.appendFileSync(path.join(root, "signals.jsonl"), JSON.stringify({ pid, signal: sig }) + "\n");
        const ign = String(read(path.join(root, String(pid), "ignored")) || "").split(/\s+/);
        if (!ign.includes(sig)) fs.rmSync(path.join(root, String(pid)), { recursive: true, force: true });
      } else {
        try { process.kill(pid, sig); } catch (e) { if (!e || e.code !== "ESRCH") throw e; }
      }
      ended.push(pid);
    }
    return { ended };
  }
  if (mode !== "processes") throw Object.assign(new Error(`Unknown mode ${mode}`), { code: "EOP" });
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  // A SEARCH PATH never follows its last part: a link is moved or left out itself, its target stays — `tools -> /usr/local` as a search
  // path would otherwise hit every process under /usr/local. With `roots` (the root of the project, both versions) a search path lies
  // LEXICALLY under one of them (otherwise it drops out) and is computed as the realpath of the root + the rest by wording: no link IN
  // the project is evaluated, not even one that stepped into the place of a folder between check and search. Without `roots` only
  // the parent folder via realpath, the last part literally.
  const inside = (r) => r === "" || (r !== ".." && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r));
  const limits = (Array.isArray(o.roots) ? o.roots : []).filter((w) => typeof w === "string" && path.isAbsolute(w)).map((w) => path.resolve(w));
  const searchPath = (p) => {
    const abs = path.resolve(p);
    if (limits.length) {
      const w = limits.find((g) => inside(path.relative(g, abs)));
      return w === undefined ? null : path.join(real(w), path.relative(w, abs));
    }
    const parent = path.dirname(abs);
    return parent === abs ? abs : path.join(real(parent), path.basename(abs));
  };
  const paths = (Array.isArray(o.paths) ? o.paths : []).filter((p) => typeof p === "string" && path.isAbsolute(p)).map(searchPath).filter((p) => p !== null);
  const inLocation = (p) => {
    if (typeof p !== "string" || !path.isAbsolute(p)) return false;
    const e = real(p.replace(/ \(deleted\)$/, ""));
    return paths.some((o2) => e === o2 || e.startsWith(o2.endsWith("/") ? o2 : `${o2}/`));
  };
  const out = new Set((Array.isArray(o.exempt) ? o.exempt : []).map(Number).filter((x) => Number.isInteger(x) && x > 1));
  const selfName = reference(path.join(root, "self"));
  const itself = selfName && /^\d+$/.test(selfName) ? Number(selfName) : process.pid;
  const space = reference(path.join(root, "self", "ns", "mnt")) ?? reference(path.join(root, String(itself), "ns", "mnt"));
  const ancestors = new Set([itself]);
  for (let p = itself, n = 0; n < 64; n++) {
    const s = stat(p);
    if (!s || s.ppid <= 0 || ancestors.has(s.ppid)) break;
    ancestors.add(s.ppid);
    p = s.ppid;
  }
  let names;
  try { names = fs.readdirSync(root); } catch (e) { throw Object.assign(new Error(`${root} not readable: ${e.code || e.message}`), { code: "EPROC" }); }
  const processes = [];
  let total = 0;
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    const pid = Number(n);
    if (ancestors.has(pid)) continue;
    const location = path.join(root, n);
    if (space !== null && reference(path.join(location, "ns", "mnt")) !== space) continue;
    let hits = inLocation(reference(path.join(location, "cwd"))) || inLocation(reference(path.join(location, "exe")));
    if (!hits) {
      let fds = [];
      try { fds = fs.readdirSync(path.join(location, "fd")).slice(0, 4096); } catch { /* not readable */ }
      hits = fds.some((f) => inLocation(reference(path.join(location, "fd", f))));
    }
    if (!hits) continue;
    const s = stat(pid);
    if (!s || out.has(s.pgid)) continue;
    total++;
    if (processes.length >= CAP) continue;
    // The ancestor chain (ppid, cap 64) — who descends from whom (a process of a workspace chat in B).
    const chain = [];
    for (let p = s.ppid, k = 0; p > 1 && k < 64 && !chain.includes(p); k++) { chain.push(p); const a = stat(p); if (!a) break; p = a.ppid; }
    processes.push({ pid, pgid: s.pgid, sid: s.sid, name: name(pid), chain });
  }
  processes.sort((a, b) => a.pid - b.pid);
  return { processes, ...(total > processes.length ? { truncated: total } : {}) };
}

export const PROC_SEARCH = `"use strict";
const fs = require("node:fs");
const path = require("node:path");
${procCore.toString()}
const [mode] = process.argv.slice(1);
let response;
try {
  let input = "";
  try { input = fs.readFileSync(0, "utf8"); } catch { input = ""; }
  response = { ok: true, ...procCore(fs, path, mode, JSON.parse(input || "{}")) };
} catch (e) {
  response = { ok: false, code: (e && e.code) || "EERROR", message: String((e && e.message) || e) };
}
process.stdout.write(JSON.stringify(response) + "\\n");
`;

// ── The test seam (see header) ──────────────────────────────────────────────────────────────────────────────────────────
let seam = { root: null };
/** Test seam: `root` replaces /proc in the project container (the program gets it on stdin); without an argument back to /proc. */
export function setProcSearchSeam({ root = null } = {}) { seam = { root: root ? String(root) : null }; }

/** Run the program in the project container → the answer (without `ok`); throws with `code` on an error of the program. */
export async function searchInProject(inst, mode, input, { signal = null } = {}) {
  const r = await commandRun(inst, "/", process.execPath, ["-e", PROC_SEARCH, "--", mode], {
    stdin: JSON.stringify({ ...input, ...(seam.root ? { root: seam.root } : {}) }), withoutDeadline: true, maxBuffer: 8 * 1024 * 1024,
    ...(signal ? { signal } : {}),
  });
  if (r.aborted) throw Object.assign(new Error(`${mode}: aborted`), { code: "ABORTED" });
  let a = null;
  try { a = JSON.parse(String(r.stdout || "").trim().split("\n").pop() || "null"); } catch { a = null; }
  if (!a) throw Object.assign(new Error(`/proc search (${mode}) in the project container: ${String(r.stderr || "").trim().split("\n").slice(-2).join(" ").slice(0, 200) || `Exit ${r.code}`}`), { code: "PROGRAM" });
  if (a.ok === false) throw Object.assign(new Error(String(a.message || `${mode} failed`).slice(0, 300)), { code: a.code || "EERROR" });
  const { ok: _ok, ...rest } = a;
  return rest;
}

/** The same computation in B (the workspace terminals, workspace chats): `root` is B's (default /proc). */
export function procInB(fs, mode, input, root) {
  return procCore(fs, path, mode, { ...input, ...(root ? { root } : {}) });
}
