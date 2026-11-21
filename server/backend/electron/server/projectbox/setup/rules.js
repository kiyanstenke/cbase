// The ONE list of the rules of project creation: what is left out at upload, which names are forbidden, where a code repo may stand
// and how much space must stay free. Delivered via `GET /api/projectCreation/rules` — the one version for web and iOS; the server
// computes the same rules again at the POST and at placing and is the boundary.
//
// The limits of the code-repo places come from the SAME constants as findRepos (git.js SCAN_SKIP, SCAN_MAX_DEPTH, SCAN_MAX_REPOS,
// repoLocationVisible) — a code repo at a place the search does not see would otherwise silently be missing in the git tab, worktree
// choice and graph worktrees. `dependencies` from projectRepo.js DEPENDENCIES (warning: falls silently out of the project repo).
// A leaf without server state: only git.js (constants), projectRepo.js (constant), ops.js (the marker, at run time) and the reserve
// from the environment.
//
// THE CREATION WAY (`creationMode`): "container" in operations, else "folder" — ONE computation for the field `mode` at
// `GET /api/projectCreation/rules` (./routes.js) and the field `projectCreation` at `GET /api/health` (server.js). The clients read
// `mode` at the rules route: `/api/health` is answered by the gateway itself in server mode (server/gateway/index.js, without login,
// before any forwarding) — there `projectCreation` never arrived, and both clients stayed on the old name dialog (400
// SOURCES_MISSING). `mode` is NOT in `rulesResponse`: those are the rules that the fixtures of the layout mirror
// (web/test/project-layout-plan.test.mjs, `_rules.json`); the mode is a situation of the server, no rule.
import { T } from "../../i18n.js";
import { SCAN_MAX_DEPTH, SCAN_MAX_REPOS, SCAN_SKIP, repoLocationVisible } from "../../git.js";
import { projectboxOps } from "../ops.js";
import { DEPENDENCIES } from "../projectRepo.js";

/** The creation way of this server: "container" (operations: project container and setup) or "folder" (today's way). */
export const creationMode = () => (projectboxOps() ? "container" : "folder");

// Folders that never come along at upload (ballast that can be regenerated), and `__MACOSX/` of a ZIP.
export const OMIT_FOLDER = Object.freeze(["node_modules", ".next", ".turbo", ".cache", "__pycache__", ".venv", "venv", "__MACOSX"]);
export const OMIT_FILES = Object.freeze([".DS_Store"]);
// Forbidden names: `.`/`..` (path parts), `.git` (a node may not be called so — a `.git` folder comes only as part of an uploaded
// repo), plus every name with the prefix `.cbase-` (the provisions).
export const FORBIDDEN_NAMES = Object.freeze([".", "..", ".git"]);
export const FORBIDDEN_PREFIX = ".cbase-";
// The reserve that must stay free after a source — default 5 GB, knob CBASE_SPACE_RESERVE_BYTES.
export const RESERVE_BYTES = 5_000_000_000;
export function reserveBytes() {
  const raw = process.env.CBASE_SPACE_RESERVE_BYTES;
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : RESERVE_BYTES;
}

/** The answer of `GET /api/projectCreation/rules` (also without operations). */
export function rulesResponse() {
  return {
    omit: { folder: [...OMIT_FOLDER], files: [...OMIT_FILES] },
    limits: { depth: SCAN_MAX_DEPTH, repos: SCAN_MAX_REPOS, skip: [...SCAN_SKIP], dependencies: DEPENDENCIES.map((a) => a.replace(/\/$/, "")) },
    names: { forbidden: [...FORBIDDEN_NAMES], prefix: FORBIDDEN_PREFIX },
    reserveBytes: reserveBytes(),
  };
}

// Control characters (C0, DEL, C1) and line breaks: an own commit of the project repo throws on them (info/exclude cannot exclude
// them), and no UI shows them honestly.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/** PURE: why `name` does not do as ONE path part — or null. */
export function nameError(name) {
  if (typeof name !== "string" || !name) return "empty";
  if (FORBIDDEN_NAMES.includes(name)) return T`“${name}” is not an allowed name`;
  if (name.includes("/") || name.includes("\\")) return T("contains a slash");
  if (CONTROL_CHARACTERS.test(name)) return T("contains a control character or a line break");
  if (name.toLowerCase().startsWith(FORBIDDEN_PREFIX)) return T`begins with “${FORBIDDEN_PREFIX}” (belongs to cbase)`;
  if (name.isWellFormed && !name.isWellFormed()) return T("is not valid UTF-8");
  return null;
}

/** PURE: a relative path (`a/b/c`, empty = root) — `{ parts }` or `{ error }`. */
export function relPath(rel, { emptyAllowed = true } = {}) {
  if (rel === undefined || rel === null) rel = "";
  if (typeof rel !== "string") return { error: T("not a text") };
  if (rel === "") return emptyAllowed ? { parts: [] } : { error: "empty" };
  if (rel.startsWith("/")) return { error: "absolute" };
  const parts = rel.split("/");
  for (const t of parts) {
    const f = nameError(t);
    if (f) return { error: T`“${t}”: ${f}` };
  }
  return { parts };
}

/**
 * PURE: the path of an uploaded file (relative to the root, in the provision) — `{ parts }` or `{ error }`. Like relPath, except that
 * `.git` and the prefix `.cbase-` are allowed as INNER parts: a `.git` FOLDER comes as part of an uploaded repo (`x/.git/HEAD`), and a
 * file may be called anything deep in the tree. As FIRST part both stay forbidden — the root carries the project repo (`.git`) and the
 * provisions (`.cbase-*`).
 */
export function uploadPath(rel) {
  if (typeof rel !== "string") return { error: T("not a text") };
  if (rel === "") return { error: "empty" };
  if (rel.startsWith("/")) return { error: "absolute" };
  const parts = rel.split("/");
  for (const [i, t] of parts.entries()) {
    const insideAllowed = i > 0 && (t === ".git" || t.toLowerCase().startsWith(FORBIDDEN_PREFIX));
    const f = insideAllowed ? nameError(`x${t}`) : nameError(t); // inside: only slash, control characters, UTF-8 remain
    if (f) return { error: T`“${t}”: ${f}` };
  }
  return { parts };
}

/** PURE: does `a` lie under `b` (or is it)? Both relative, `/` as separator. */
export const under = (a, b) => b === "" || a === b || a.startsWith(`${b}/`);

/**
 * PURE: the code-repo marks of the plan against the rules (no repo inside a repo) and the limits of findRepos — `[error]` (empty = fine). A
 * place the search does not see (depth, dot folder, SCAN_SKIP), more than SCAN_MAX_REPOS, repo inside a repo, duplicate.
 */
export function codeRepoError(codeRepos) {
  const error = [];
  if (!Array.isArray(codeRepos)) return [T("codeRepos is not a list")];
  if (codeRepos.length > SCAN_MAX_REPOS) error.push(T`more than ${SCAN_MAX_REPOS} code repos (${codeRepos.length})`);
  const seen = new Set();
  for (const rel of codeRepos) {
    const r = relPath(rel, { emptyAllowed: false });
    if (r.error) { error.push(T`Code repo “${rel}”: ${r.error}`); continue; }
    if (seen.has(rel)) { error.push(T`Code repo “${rel}” twice`); continue; }
    seen.add(rel);
    if (!repoLocationVisible(rel)) error.push(T`Code repo “${rel}” lies at a place the repo search does not see (depth > ${SCAN_MAX_DEPTH}, dot folder or skipped name)`);
  }
  const list = [...seen];
  for (const a of list) for (const b of list) {
    if (a !== b && under(a, b)) error.push(T`Code repo “${a}” lies in code repo “${b}” (repo inside a repo)`);
  }
  return error;
}
