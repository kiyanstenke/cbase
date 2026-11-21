// The Python interpreter of the language service.
//
// THE CHOICE is stored PER PROJECT in the server (setting `lsp.python.<projectId>`, store getSetting/setSetting; empty =
// automatic) and applies to editor, formatter and agents in EVERY instance of the project — copies inherit it. Without a choice,
// automatic detection: the shallowest `.venv`/`venv` in the project folder (down to depth VENV_DEPTH, `.venv` before `venv` on the
// same level).
//
// WHO ASKS.
//   - lsp/sessions.js through `setInterpreterSupplier(interpreterFor)` (server.js): SYNCHRONOUSLY at the start of a Python session
//     (`python.pythonPath` in `workspace/configuration` and in the settings), in the status and in the status event. That is why
//     detection searches in B (fs, without following links — Dirent or lstat, no open of a file: a FIFO stalls nothing) and
//     remembers the result for AUTO_HOLD_MS per project folder. It runs synchronously in B's event loop — hence the caps: at most
//     FOLDER_CAP folders, ENTRY_CAP entries per folder and ENTRIES_TOTAL overall (otherwise a folder with 100,000 files would be
//     read and sorted in full on every status). B sees the project folder of the main instance — a venv that exists only in a copy
//     is not found by detection (copies inherit the main instance's).
//   - the editor's `interpreter` action through `setInterpreterMachine(interpreterAction)` (server.js): `{ set? }` → `{ selected,
//     effective, candidates: [{ path, version?, source }] }`. The candidates are checked by ONE process in the instance (lsp/run.js,
//     `sh -c`): the detected venvs, the container's Pythons (`/usr/bin/python3*`, `/usr/local/bin/python3*`, deduplicated by
//     realpath) and the choice — only what is executable there and reports a version is in the list (the choice is always there,
//     as `chosen`, if it is otherwise missing). `set` (only on the project level: `base` = project folder) takes an absolute path
//     that is executable IN THE CONTAINER (otherwise 400, nothing stored), or null/"" (back to automatic). A change ends the Python
//     sessions of ALL instances of the project (lsp/sessions.js endSessions with a language) — the next use starts them with the
//     new one.
//   - lsp/formatter.js: the `bin/` of the effective interpreter is the first place for ruff and black.
//
// Missing packages are NOT downgraded — no `diagnosticSeverityOverrides`; "Import could not be resolved" shows as an error as in
// VS Code when the packages exist only in a Compose service.
import fs from "node:fs";
import path from "node:path";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { LspError } from "./documents.js";
import { endSessions } from "./sessions.js";
import { runInProject } from "./run.js";

export const VENV_DEPTH = 3;
export const VENV_NAMES = Object.freeze([".venv", "venv"]);
const AUTO_HOLD_MS = 60_000;
export const FOLDER_CAP = 2000;
export const ENTRY_CAP = 2000;
export const ENTRIES_TOTAL = 20_000;
// Folders that hold no venv of a project — and that are large.
const NOT_IN = new Set(["node_modules", ".git", "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".tox", ".nox", "site-packages", ".next", "dist", "build", "target"]);

/** The settings key of the choice per project. */
export const settingOf = (projectId) => `lsp.python.${projectId}`;

/** A project's stored choice — or null (automatic). */
export function selectedInterpreter(projectId) {
  let v = "";
  try { v = String(store.getSetting(settingOf(projectId), "") || ""); } catch { v = ""; }
  return v.trim() || null;
}

// Is there a venv below `folder`? (`bin/python` as a file or a link — its target often lies outside, B does not follow it.)
function pythonOfVenv(folder) {
  const py = path.join(folder, "bin", "python");
  try { const st = fs.lstatSync(py); return st.isFile() || st.isSymbolicLink() ? py : null; } catch { return null; }
}

// Is `p` a folder (not a link)?
const isFolder = (p) => { try { return fs.lstatSync(p).isDirectory(); } catch { return false; } };

/**
 * The venvs below `root` down to depth VENV_DEPTH, shallowest first — `[{ folder, python }]`. Follows no link. Per folder it
 * checks `.venv`/`venv` directly (lstat — a full folder does not hide them) and reads at most ENTRY_CAP entries for the next
 * level (opendir, not readdir: no whole folder in memory), ENTRIES_TOTAL overall and FOLDER_CAP folders (see the header).
 */
export function venvsIn(root) {
  const base = path.resolve(String(root || ""));
  const out = [];
  let level = [base];
  let folderSeen = 0;
  let entriesSeen = 0;
  for (let depth = 1; depth <= VENV_DEPTH && level.length; depth++) {
    const next = [];
    for (const folder of level) {
      for (const n of VENV_NAMES) {
        const full = path.join(folder, n);
        if (isFolder(full)) { const py = pythonOfVenv(full); if (py) out.push({ folder: full, python: py }); }
      }
      if (depth === VENV_DEPTH || folderSeen >= FOLDER_CAP || entriesSeen >= ENTRIES_TOTAL) continue;
      let dir;
      try { dir = fs.opendirSync(folder); } catch { continue; }
      const children = [];
      try {
        for (let i = 0; i < ENTRY_CAP && entriesSeen < ENTRIES_TOTAL; i++) {
          const e = dir.readSync();
          if (!e) break;
          entriesSeen += 1;
          if (e.isDirectory() && !VENV_NAMES.includes(e.name) && !NOT_IN.has(e.name)) children.push(e.name);
        }
      } catch { /* a folder that vanishes while being read */ } finally { try { dir.closeSync(); } catch { /* closed */ } }
      children.sort((a, b) => a.localeCompare(b));
      for (const k of children) {
        if (folderSeen >= FOLDER_CAP) break;
        folderSeen += 1;
        next.push(path.join(folder, k));
      }
    }
    level = next;
  }
  return out;
}

const remembered = new Map(); // project folder → { at, list }
function venvsRemembered(root, fresh = false) {
  const k = path.resolve(String(root || ""));
  const g = remembered.get(k);
  if (!fresh && g && Date.now() - g.at < AUTO_HOLD_MS) return g.list;
  const list = venvsIn(k);
  remembered.set(k, { at: Date.now(), list });
  return list;
}
/** Test seam: forget the remembered detections. */
export function forgetDetection() { remembered.clear(); }

/** The automatic choice: the Python of the shallowest venv in the project folder — or null (the server takes its `python` from PATH). */
export function automatic(root) {
  return venvsRemembered(root)[0]?.python || null;
}

/** The supplier for lsp/sessions.js (synchronous, see the header): the project's choice, otherwise the automatic one. */
export function interpreterFor({ projectId, root }) {
  return selectedInterpreter(projectId) || automatic(root);
}

/** The venvs from the file upward to the project folder (nearest first) — `[folder]` (for the file's ruff/black, lsp/formatter.js). */
export function venvsOfTheFile(abs, root) {
  const base = path.resolve(String(root || ""));
  const out = [];
  let folder = path.dirname(path.resolve(String(abs || "")));
  for (;;) {
    const rel = path.relative(base, folder);
    if (rel.startsWith("..") || path.isAbsolute(rel)) break;
    for (const n of VENV_NAMES) { const v = path.join(folder, n); if (pythonOfVenv(v)) out.push(v); }
    if (folder === base) break;
    folder = path.dirname(folder);
  }
  return out;
}

// ONE process in the instance: per candidate (arguments), then per Python of the container, a line `kind \t path \t real \t version`
// — only what is a regular, executable file and reports a version. The arguments come as `kind=path`.
const CHECK_SCRIPT = [
  "check() {",
  "  [ -f \"$2\" ] && [ -x \"$2\" ] || return 0",
  "  v=$(\"$2\" -c 'import sys; print(\"%d.%d.%d\" % sys.version_info[:3])' 2>/dev/null) || return 0",
  "  [ -n \"$v\" ] || return 0",
  "  e=$(readlink -f \"$2\" 2>/dev/null) || e=\"$2\"",
  "  printf '%s\\t%s\\t%s\\t%s\\n' \"$1\" \"$2\" \"$e\" \"$v\"",
  "}",
  "for a in \"$@\"; do check \"${a%%=*}\" \"${a#*=}\"; done",
  "for p in /usr/bin/python3 /usr/bin/python3.[0-9]* /usr/local/bin/python3 /usr/local/bin/python3.[0-9]*; do",
  "  case \"${p##*/}\" in python3|python3.[0-9]|python3.[0-9][0-9]) ;; *) continue ;; esac",
  "  check container \"$p\"",
  "done",
].join("\n");

/**
 * Check the candidates in the target's instance: `kinds` = `[[kind, path], …]`. → `{ rows: [{ kind, path, real, version }], error? }`.
 * If the process fails (container down, cap), no rows come back and `error` says why.
 */
export async function checkInProject(target, kinds) {
  const args = kinds.filter(([, p]) => typeof p === "string" && path.isAbsolute(p) && !/[\0\n\t]/.test(p)).map(([a, p]) => `${a}=${p}`);
  let r;
  try { r = await runInProject(target.instance || null, "sh", ["-c", CHECK_SCRIPT, "sh", ...args], { cwd: target.root, deadlineMs: 15_000, maxBytes: 256 * 1024 }); }
  catch (e) { return { rows: [], error: String(e?.message || e) }; }
  const rows = String(r.stdout || "").split("\n").map((z) => z.split("\t")).filter((t) => t.length === 4 && t[1])
    .map(([kind, p, real, version]) => ({ kind, path: p, real, version }));
  if (r.cap) return { rows, error: T`Checking the interpreters hit its limit (${r.cap})` };
  if (r.code !== 0 && !rows.length) return { rows, error: String(r.stderr || "").trim().split("\n").slice(-2).join(" ") || `Exit ${r.code}` };
  return { rows };
}

const isProjectLevel = (target) => Boolean(target?.base) && path.resolve(String(target.base)) === path.resolve(String(target.root));

/** The `interpreter` action (see the header). */
export async function interpreterAction(target, body = {}) {
  const pid = String(target.projectId);
  if (body && Object.hasOwn(body, "set")) {
    if (!isProjectLevel(target)) throw new LspError(400, { error: T("The interpreter is chosen on the project level (it applies to the whole project).") });
    const raw = body.set;
    if (raw !== null && raw !== undefined && typeof raw !== "string") throw new LspError(400, { error: T("`set` is a path or null") });
    const fresh = typeof raw === "string" && raw.trim() ? raw.trim() : null;
    if (fresh !== null) {
      if (!path.isAbsolute(fresh) || /[\0\n\t]/.test(fresh)) throw new LspError(400, { error: T("The interpreter is an absolute path") });
      const p = await checkInProject(target, [["chosen", fresh]]);
      if (!p.rows.some((z) => z.kind === "chosen")) {
        throw new LspError(400, { error: T`${fresh} is not an executable Python interpreter in the project container${p.error ? ` (${p.error})` : ""} — nothing changed.` });
      }
    }
    const old = selectedInterpreter(pid);
    store.setSetting(settingOf(pid), fresh ?? "");
    if (old !== fresh) endSessions(pid, null, "interpreter", "python");
  }
  const venvs = venvsRemembered(target.root, true);
  const selected = selectedInterpreter(pid);
  const effective = selected || venvs[0]?.python || null;
  const p = await checkInProject(target, [...venvs.map((v) => ["venv", v.python]), ...(selected ? [["chosen", selected]] : [])]);
  const candidates = [];
  const paths = new Set();
  const real = new Set();
  for (const z of p.rows) {
    if (paths.has(z.path)) continue;
    if (z.kind === "container" && real.has(z.real) && z.path !== selected) continue;
    if (z.kind === "chosen" && p.rows.some((x) => x.kind !== "chosen" && x.path === z.path)) continue;
    paths.add(z.path);
    if (z.kind === "container") real.add(z.real);
    candidates.push({ path: z.path, version: z.version, source: z.kind === "venv" ? "venv" : z.kind === "chosen" ? "chosen" : "container" });
  }
  if (selected && !paths.has(selected)) candidates.push({ path: selected, source: "chosen" });
  return { selected, effective, candidates, ...(p.error ? { error: p.error } : {}) };
}
