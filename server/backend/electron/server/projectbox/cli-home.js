// The CLI home per project. No route: the callers are the relocation (steps 1, 3, 13) and the recreation. The creation
// (projectbox/instance.js) only checks that it exists.
//
// THE PLACE, fixed: `<runtime>/home/.claude` (with `CLAUDE_CONFIG_DIR` `.claude.json` lies there too), `<runtime>/home/.codex`,
// `<runtime>/home/.local` — the same paths that projectbox/creation.js gives the container as environment (`CLAUDE_CONFIG_DIR`,
// `CODEX_HOME`) and as mount (`~/.local`, exception `cli-local`). Only the login is shared (`~/.claude-login`, `~/.codex/auth.json` —
// mounts of the creation), not here.
// Next to it lies `<runtime>/home/.vscode-server` (mount `~/.vscode-server`, exception `cli-vscode-server`) — NOT created by this
// module but by the creation itself (instance.js, without reference, before the reference check): the rule is always in the list with
// `condition: "create"`, and no older project has the folder. The old versions in it are cleared by projectbox/vscode-server.js.
//
//   createCliHome(projectId, { home })   the three folders, plus ONCE `.claude/.claude.json` with `oauthAccount`, `userID`,
//                                        `hasCompletedOnboarding` from the user's (no tokens; tmp + rename, 0600).
//   enterCodexTrust({ configPath, wsPath, projectPath })
//                                        the project folder with the level of the workspace entry in B's `~/.codex/config.toml` — IN
//                                        PLACE (the creation binds the file read-only, and a bind holds the inode; Codex itself replaces
//                                        by rename), idempotent, the rest of the file byte-equal. `codexTrustText` is the pure
//                                        computation for it.
//   copyLocal(projectId, assignment, { home, cp })
//                                        `cp -a` (symlinks stay — the venv links point absolutely to `~/.local/share/uv`) from B's
//                                        `~/.local`, but NOT all of it: everything except `state/` and the folders under `share/`, plus
//                                        `share/uv`. Every entry under `state/` and every other under `share/` goes only to the project
//                                        the assignment gives it to; without an assignment it is in the report (one project's state is
//                                        not readable for another). An existing target stays (once at relocation; a second run overwrites
//                                        nothing). The creation (setup/procedure.js) also calls it without an assignment — a new project
//                                        would otherwise get an empty `~/.local`.
//   localReferences(projectPath, { home }) the assignment of a project from its files (relocation step 1): a `.env*` value, a venv link
//                                        or an MCP command that points under `~/.local/state/<x>` or `~/.local/share/<x>`.
//
// Without the ops marker every writing function throws (`code: NO_OPS`, 404 — the same wording as every route).
//
// IN THE RUNTIME FOLDER. The CLI home lies in `<runtime>/home`, and every container of the project mounts the runtime folder rw — an
// earlier one (before a return path, a copy) may have replaced `home`, `home/.claude` or `home/.local` by a reference, and a reference
// survives the return path. A recursive `mkdirSync`, writing `.claude.json` (temp file + rename) and `cp -a` would follow it: the
// folders and `.claude.json` would arise in B, and B's `~/.local` would land in an arbitrary folder of B (`home/.local → <runtime folder
// of another project>/home/.local` — one project's state at another's). So both functions create their folders through
// runs/runtime-write.js (no reference outward, `EOUTSIDE`) and write `.claude.json` through the descriptor; `cp -a` gets a target
// folder only afterwards, whose path is checked. Residual window: between the check and `cp` — the relocation calls copyLocal while no
// process of the project runs (the container is created, its stack not started). Outside a runtime folder as before (the CLI home never
// lies there). `enterCodexTrust` writes B's config.toml — a place in B, in no container.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { locationFor } from "../runs/runtime-location.js";
import { createFolderInRuntimeFolder, writeInRuntimeFolder } from "../runs/runtime-write.js";
import { ONLY_IN_OPS, projectboxOps } from "./ops.js";

export class CliHomeError extends Error {
  constructor(message, { code, status = 409 } = {}) {
    super(message);
    this.name = "CliHomeError";
    this.code = code;
    this.status = status;
  }
}
const opsNeeded = () => {
  if (!projectboxOps()) throw new CliHomeError(ONLY_IN_OPS, { code: "NO_OPS", status: 404 });
};

/** A project's CLI home and its three folders (regardless of whether it is already converted). */
export function cliHomeFolder(projectId) {
  const home = locationFor({ projectId, converted: true }).home;
  return { home, claude: path.join(home, ".claude"), codex: path.join(home, ".codex"), local: path.join(home, ".local") };
}

// The fields of the user's `.claude.json` that a project home takes over: account and onboarding — no tokens (they are in the
// shared login), no project list, no history.
export const CLAUDE_JSON_FIELDS = Object.freeze(["oauthAccount", "userID", "hasCompletedOnboarding"]);

function writeAtomic(target, text, mode) {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, text, { mode });
    fs.renameSync(tmp, target);
  } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* leftover */ } throw e; }
}

/**
 * Create a project's CLI home. `home`: the user's home in B (test seam). The user's `.claude.json` lies under
 * `$CLAUDE_CONFIG_DIR/.claude.json` if B sets the variable, else under `<home>/.claude.json`.
 * @returns {{ home: string, created: string[], prefilled: boolean, reason?: string }}
 */
export function createCliHome(projectId, { home = os.homedir() } = {}) {
  opsNeeded();
  const o = cliHomeFolder(projectId);
  const created = [];
  for (const d of [o.claude, o.codex, o.local]) {
    if (!fs.existsSync(d)) created.push(d);
    if (!createFolderInRuntimeFolder(d)) fs.mkdirSync(d, { recursive: true });
  }
  const target = path.join(o.claude, ".claude.json");
  if (fs.existsSync(target)) return { home: o.home, created, prefilled: false, reason: "existing" };
  const source = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(home, ".claude.json");
  let user;
  try { user = JSON.parse(fs.readFileSync(source, "utf8")); } catch { return { home: o.home, created, prefilled: false, reason: "no readable .claude.json of the user" }; }
  const before = {};
  for (const f of CLAUDE_JSON_FIELDS) if (user && Object.prototype.hasOwnProperty.call(user, f)) before[f] = user[f];
  const text = `${JSON.stringify(before, null, 2)}\n`;
  if (!writeInRuntimeFolder(target, text, { mode: 0o600 })) {
    writeAtomic(target, text, 0o600);
  }
  return { home: o.home, created, prefilled: true };
}

// ── Codex-Trust ────────────────────────────────────────────────────────────────────────────────────────────────────

const HEADER = /^\s*\[\s*projects\s*\.\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*\]\s*(?:#.*)?$/;
const DECRYPTED = (s) => s.replace(/\\(["\\])/g, "$1");
const tomlKey = (p) => `"${String(p).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// The sections `[projects."<path>"]` of a config.toml: path → line range.
function projectSections(rows) {
  const out = new Map();
  let open = null;
  rows.forEach((z, i) => {
    if (/^\s*\[/.test(z)) {
      if (open) open.until = i;
      const m = HEADER.exec(z);
      open = m ? { path: m[1] !== undefined ? DECRYPTED(m[1]) : m[2], from: i, until: rows.length } : null;
      if (open && !out.has(open.path)) out.set(open.path, open);
    }
  });
  return out;
}

/**
 * The pure computation: what to append to `text` so that `projectPath` is trusted with the level of the workspace entry (default
 * "trusted") — `null` if the entry already exists.
 * @returns {{ attachment: string|null, stage: string }}
 */
export function codexTrustText(text, { wsPath, projectPath }) {
  const rows = String(text || "").split("\n");
  const sections = projectSections(rows);
  const ws = wsPath ? sections.get(String(wsPath)) : null;
  let stage = "trusted";
  if (ws) {
    for (let i = ws.from + 1; i < ws.until; i++) {
      const m = /^\s*trust_level\s*=\s*"([^"]*)"/.exec(rows[i]);
      if (m) { stage = m[1]; break; }
    }
  }
  if (sections.has(String(projectPath))) return { attachment: null, stage };
  const separator = !text || String(text).endsWith("\n") ? "" : "\n";
  return { attachment: `${separator}\n[projects.${tomlKey(projectPath)}]\ntrust_level = "${stage}"\n`, stage };
}

/**
 * Write the project folder's trust entry into B's config.toml — appended, the same inode.
 * @returns {{ status: "entered"|"present"|"no-file", stage?: string }}
 */
export function enterCodexTrust({ configPath = path.join(os.homedir(), ".codex", "config.toml"), wsPath, projectPath }) {
  opsNeeded();
  if (!projectPath) throw new CliHomeError("enterCodexTrust: no project path", { code: "NO_PROJECT", status: 400 });
  let text;
  try { text = fs.readFileSync(configPath, "utf8"); } catch { return { status: "no-file" }; }
  const { attachment, stage } = codexTrustText(text, { wsPath, projectPath });
  if (attachment === null) return { status: "present", stage };
  fs.appendFileSync(configPath, attachment);
  return { status: "entered", stage };
}

// ── ~/.local ───────────────────────────────────────────────────────────────────────────────────────────────────────

// The entries that have to be assigned per project: everything under `state/`, under `share/` everything except `uv`.
export const SHARED_IN_SHARE = new Set(["uv"]);
const assigned = (assignment, rel, projectId) => {
  const z = assignment instanceof Map ? assignment.get(rel) : assignment?.[rel];
  const list = z instanceof Set ? [...z] : Array.isArray(z) ? z : z ? [z] : [];
  return { anyone: list.length > 0, current: list.map(String).includes(String(projectId)) };
};
const entriesOf = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return []; } };

/**
 * Copy B's `~/.local` into the project's home (header of the file).
 * @param {string} projectId
 * @param {Map<string, string|string[]|Set<string>>|Object} assignment  `"state/<x>"`/`"share/<x>"` → project id(s)
 * @param {{ home?: string, cp?: string }} o  `home`: the user's home in B; `cp`: the program (test seam)
 * @returns {{ target: string, copied: string[], existing: string[], withoutAssignment: string[], otherProject: string[] }}
 */
export function copyLocal(projectId, assignment = {}, { home = os.homedir(), cp = "cp" } = {}) {
  opsNeeded();
  const source = path.join(home, ".local");
  const target = cliHomeFolder(projectId).local;
  if (!createFolderInRuntimeFolder(target)) fs.mkdirSync(target, { recursive: true });
  const report = { target, copied: [], existing: [], withoutAssignment: [], otherProject: [] };
  const copy = (rel) => {
    const to = path.join(target, rel);
    // The target folder BEFORE the `lstat` and the `cp` (see header): a reference on the way throws instead of cp following it.
    if (!createFolderInRuntimeFolder(path.dirname(to))) fs.mkdirSync(path.dirname(to), { recursive: true });
    if (fs.lstatSync(to, { throwIfNoEntry: false })) { report.existing.push(rel); return; }
    execFileSync(cp, ["-a", path.join(source, rel), to], { stdio: ["ignore", "ignore", "pipe"] });
    report.copied.push(rel);
  };
  const perProject = (rel) => {
    const z = assigned(assignment, rel, projectId);
    if (z.current) copy(rel);
    else if (z.anyone) report.otherProject.push(rel);
    else report.withoutAssignment.push(rel);
  };
  for (const name of entriesOf(source)) {
    const full = path.join(source, name);
    const isFolder = fs.lstatSync(full).isDirectory();
    if (name === "state" && isFolder) {
      for (const c of entriesOf(full)) perProject(`state/${c}`);
    } else if (name === "share" && isFolder) {
      for (const c of entriesOf(full)) (SHARED_IN_SHARE.has(c) ? copy : perProject)(`share/${c}`);
    } else {
      copy(name);
    }
  }
  return report;
}

// Which entries under `~/.local/state` and `~/.local/share` a text names (absolute, with `~` or `$HOME`). Exported for the
// relocation plan (projectbox/relocation/plan.js: the project's MCP commands point into it).
export function referencesIn(text, home) {
  const out = new Set();
  const preambles = [path.join(home, ".local"), "~/.local", "$HOME/.local", "${HOME}/.local"];
  for (const v of preambles) {
    const preamble = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(preamble + "/(state|share)/([A-Za-z0-9._@+-]+)", "g");
    for (const m of String(text).matchAll(pattern)) {
      if (m[1] === "share" && SHARED_IN_SHARE.has(m[2])) continue;
      out.add(`${m[1]}/${m[2]}`);
    }
  }
  return out;
}

const SKIP = new Set(["node_modules", ".git", ".next", "dist", "build", "__pycache__"]);

/**
 * The entries under `~/.local/state|share` a project points to (relocation step 1): `.env*` files and `.mcp.json` up to depth 3, the
 * links in `bin/` of a venv (`.venv`, `venv`, `env`) up to depth 3. Returns a sorted list.
 */
export function localReferences(projectPath, { home = os.homedir(), depth = 3 } = {}) {
  const hits = new Set();
  const take = (s) => { for (const v of referencesIn(s, home)) hits.add(v); };
  const go = (dir, t) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isFile() && (e.name.startsWith(".env") || e.name === ".mcp.json")) {
        try { take(fs.readFileSync(p, "utf8")); } catch { /* unreadable */ }
      } else if (e.isDirectory() && [".venv", "venv", "env"].includes(e.name)) {
        for (const b of entriesOf(path.join(p, "bin"))) {
          try { take(fs.readlinkSync(path.join(p, "bin", b))); } catch { /* no link */ }
        }
        try { take(fs.readFileSync(path.join(p, "pyvenv.cfg"), "utf8")); } catch { /* without pyvenv.cfg */ }
      } else if (e.isDirectory() && !SKIP.has(e.name) && t < depth) {
        go(p, t + 1);
      }
    }
  };
  go(projectPath, 0);
  return [...hits].sort();
}
