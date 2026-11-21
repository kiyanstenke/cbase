// The start folder of a terminal: "Open in Integrated Terminal" starts a NEW shell in the chosen folder (VS Code
// `openInTerminal`). `POST …/terminal` takes `cwd` for that — relative to the root of the route (project or workspace)
// like every path under /files; empty or missing means the root.
//
// THE PROMISE: the folder lies INSIDE the root — lexically (no ".." out of it) AND at its real location (a link that
// leads outside is no start folder). The question is asked WHERE the shell runs: without an instance in the backend
// (realpath), with an instance (main or copy of a converted project) in the project container via
// runtime/fileAccess.js `stat` (→ `real`) — a copy sees its overlay view there, the backend would see main. A folder that
// is missing, is not a folder or leads outside is a 400 (`code: "TERMINAL_FOLDER"`) — never silently the root instead.
//
// → the absolute folder as the user chose it (lexical; the shell shows it that way, a link INSIDE stays visible).
// Deliberately open: between check and start a folder can become a link — the shell may go anywhere anyway (`cd`); the
// check keeps the promise "starts in the chosen folder of the root", it is not a boundary for the user.
// Guard: server/backend/test/terminal-folder.test.js.
import fs from "node:fs";
import path from "node:path";
import { T } from "../i18n.js";
import { stat as statInContainer } from "../runtime/fileAccess.js";

const error = (text) => Object.assign(new Error(text), { status: 400, code: "TERMINAL_FOLDER" });
const inside = (root, location) => location === root || location.startsWith(root + path.sep);

/** `stat` is replaceable only for the test (the instance without a container). */
export async function terminalFolder(root, cwd, inst = null, { stat = statInContainer } = {}) {
  const base = path.resolve(root);
  if (cwd !== undefined && cwd !== null && typeof cwd !== "string") throw error(T("The terminal folder is not a path."));
  const rel = String(cwd ?? "").replace(/^[/\\]+/, "");
  if (!rel) return base;
  const abs = path.resolve(base, rel);
  if (!inside(base, abs)) throw error(T("The folder is outside the root."));
  if (abs === base) return base;
  const missing = () => error(T`The folder “${rel}” does not exist.`);
  let isFolder = false, real = null, rootReal = null;
  if (inst) {
    const [s, w] = await Promise.all([stat(inst, abs), stat(inst, base)]);
    if (!s) throw missing();
    isFolder = s.kind === "folder" || (s.kind === "reference" && s.target?.kind === "folder");
    real = typeof s.real === "string" ? s.real : null;
    rootReal = typeof w?.real === "string" ? w.real : null;
  } else {
    try { isFolder = fs.statSync(abs).isDirectory(); } catch (e) { if (e?.code === "ENOENT" || e?.code === "ENOTDIR" || e?.code === "ELOOP") throw missing(); throw e; }
    try { real = fs.realpathSync(abs); rootReal = fs.realpathSync(base); } catch { real = null; }
  }
  if (!isFolder) throw error(T`“${rel}” is not a folder.`);
  if (!real || !rootReal || !inside(rootReal, real)) throw error(T`The folder “${rel}” leads outside the root through a link.`);
  return abs;
}
