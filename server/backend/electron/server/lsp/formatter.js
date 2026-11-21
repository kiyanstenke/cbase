// The project's formatter — registered in server.js through lsp/actions.js `setFormatter(projectFormatter)` and
// `setStatusAddition(statusAddition)`.
//
// WHICH. JS/TS/JSON/YAML: Prettier, if `node_modules/.bin/prettier` exists from the file upward to the project folder (nearest
// first). Python: ruff (`ruff format … -`), otherwise black (`black -q … -`) — searched in the `bin/` of the effective interpreter
// (lsp/interpreter.js: the project's choice or automatic) and in every `.venv`/`venv` from the file upward. If there is none, the
// result is null and lsp/actions.js formatDocument takes the server's formatter (JSON and YAML can, basedpyright cannot) —
// otherwise `{ supported: false, reason: "missing" }`.
//
// WHERE. Whether a candidate is executable is decided by THE CONTAINER: one process in the instance (lsp/run.js, `sh -c`) names
// the first executable one; a second starts it with the text on stdin, `--stdin-filepath` (Prettier) or `--stdin-filename` (ruff,
// black) with the file's path for the configuration, `cwd` = project folder. The answer is ONE edit over the whole document (or
// none if nothing changes); a range is passed as `--range-start/--range-end` (Prettier, UTF-16 offsets like JS), `--range` (ruff,
// 1-based, columns in characters) or `--line-ranges` (black, whole lines). If the formatter fails (syntax error) that is a 400
// with its message, not a silent fallback to the server.
//
// WHAT THE STATUS SAYS (statusAddition, synchronous — `status` starts nothing): for paths INSIDE the project folder B looks itself
// (lstat, follows no link); a formatter outside (ruff in the container's /usr/local/bin) cannot be seen there — the status then
// names the server's or none, `format` still finds it (execution in the container). `features` gets `format` if a project
// formatter is visible (Python without ruff/black and without server formatting ⇒ no `format`). Plus `interpreter` for Python,
// even without a running session.
import fs from "node:fs";
import path from "node:path";
import { T } from "../i18n.js";
import { LspError } from "./documents.js";
import { interpreterFor, venvsOfTheFile } from "./interpreter.js";
import { runInProject } from "./run.js";
import { offsetOf, positionOf, relativeUnder, lineBeginnings } from "./text.js";

const PRETTIER_LANGUAGES = new Set(["ts", "json", "yaml"]);
const FORMAT_DEADLINE_MS = 30_000;

// The folders from `abs` upward to `root` (both inclusive), nearest first; if `abs` is not below it, only the root.
function folderUpward(abs, root) {
  const base = path.resolve(String(root || ""));
  let folder = abs ? path.dirname(path.resolve(String(abs))) : base;
  if (folder !== base && relativeUnder(base, folder) === null) folder = base;
  const out = [];
  for (;;) { out.push(folder); if (folder === base) break; folder = path.dirname(folder); }
  return out;
}

/**
 * The candidates in the order in which they apply: `[{ name, path }]` — Prettier per folder upward; Python ruff before black,
 * each in the interpreter's `bin/`, then in the venvs of the file.
 */
export function formatterCandidates(target, language, abs) {
  const root = path.resolve(String(target.root));
  if (PRETTIER_LANGUAGES.has(language)) return folderUpward(abs, root).map((o) => ({ name: "prettier", path: path.join(o, "node_modules", ".bin", "prettier") }));
  if (language !== "python") return [];
  const bins = [];
  let interp = null;
  try { interp = interpreterFor({ projectId: target.projectId, instance: target.instance || null, root }); } catch { interp = null; }
  if (interp && path.isAbsolute(interp)) bins.push(path.dirname(interp));
  for (const v of venvsOfTheFile(abs || path.join(root, "_"), root)) bins.push(path.join(v, "bin"));
  const unique = [...new Set(bins)];
  return ["ruff", "black"].flatMap((name) => unique.map((b) => ({ name, path: path.join(b, name) })));
}

// Does B see the candidate in the project folder? (Header: only there, and without following a link.)
function inBVisible(target, filePath) {
  if (relativeUnder(path.resolve(String(target.root)), filePath) === null) return false;
  try { const st = fs.lstatSync(filePath); return st.isFile() || st.isSymbolicLink(); } catch { return false; }
}

/** The project's formatter as B sees it (synchronous, for the status) — name or null. */
export function formatterView(target, language, abs = null) {
  return formatterCandidates(target, language, abs).find((k) => inBVisible(target, k.path))?.name || null;
}

// The first candidate the container can execute — ONE process.
const FIND_SCRIPT = "for p in \"$@\"; do if [ -f \"$p\" ] && [ -x \"$p\" ]; then printf '%s\\n' \"$p\"; exit 0; fi; done; exit 1";
async function firstExecutable(target, candidates) {
  if (!candidates.length) return null;
  const r = await runInProject(target.instance || null, "sh", ["-c", FIND_SCRIPT, "sh", ...candidates.map((k) => k.path)], { cwd: target.root, deadlineMs: 10_000, maxBytes: 64 * 1024 });
  const filePath = r.code === 0 ? String(r.stdout || "").split("\n")[0].trim() : "";
  return filePath ? candidates.find((k) => k.path === filePath) || null : null;
}

// Column in characters (code points), 1-based — for ruff `--range`.
function characterColumn(text, pos) {
  const anf = lineBeginnings(text);
  const o = offsetOf(text, pos, anf);
  const p = positionOf(text, o, anf);
  return [...String(text).slice(anf[p.line], o)].length + 1;
}

function args(name, abs, text, range) {
  if (name === "prettier") {
    const r = range ? ["--range-start", String(offsetOf(text, range.start)), "--range-end", String(offsetOf(text, range.end))] : [];
    return ["--stdin-filepath", abs, ...r];
  }
  if (name === "ruff") {
    const r = range ? [`--range=${range.start.line + 1}:${characterColumn(text, range.start)}-${range.end.line + 1}:${characterColumn(text, range.end)}`] : [];
    return ["format", "--stdin-filename", abs, ...r, "-"];
  }
  const r = range ? [`--line-ranges=${range.start.line + 1}-${Math.max(range.start.line, range.end.line) + 1}`] : [];
  return ["-q", "--stdin-filename", abs, ...r, "-"];
}

/**
 * The formatter (lsp/actions.js setFormatter): `{ target, language, abs, text, range }` → `{ edits, formatter }` or null (no
 * formatter in the project ⇒ the server's). Throws LspError if the formatter fails.
 */
export async function projectFormatter({ target, language, abs, text, range }) {
  const k = await firstExecutable(target, formatterCandidates(target, language, abs));
  if (!k) return null;
  const r = await runInProject(target.instance || null, k.path, args(k.name, abs, text, range), { cwd: target.root, stdin: text, deadlineMs: FORMAT_DEADLINE_MS });
  if (r.cap) {
    throw new LspError(r.cap === "deadline" ? 504 : 400, { error: T`${k.name}: limit reached (${r.cap === "deadline" ? `${FORMAT_DEADLINE_MS / 1000} s` : T("output")}) — nothing formatted` });
  }
  if (r.code !== 0) {
    const notice = String(r.stderr || "").trim().split("\n").slice(-6).join("\n") || `Exit ${r.code}`;
    throw new LspError(400, { error: `${k.name}: ${notice}` });
  }
  const fresh = String(r.stdout ?? "");
  if (fresh === text) return { edits: [], formatter: k.name };
  return { edits: [{ range: { start: { line: 0, character: 0 }, end: positionOf(text, text.length) }, newText: fresh }], formatter: k.name };
}

/** The addition to an entry of `status` (lsp/actions.js setStatusAddition; header "WHAT THE STATUS SAYS"). */
export function statusAddition(target, e) {
  const z = {};
  if (e.language === "python" && !e.interpreter) {
    let i = null;
    try { i = interpreterFor({ projectId: target.projectId, instance: target.instance || null, root: target.root }); } catch { i = null; }
    if (i) z.interpreter = i;
  }
  if (e.state === "ready") {
    const f = formatterView(target, e.language, target.abs || null);
    const features = Array.isArray(e.features) ? e.features : [];
    if (f) { z.formatter = f; if (!features.includes("format")) z.features = [...features, "format"]; }
    else if (features.includes("format")) z.formatter = "server";
  }
  return z;
}
